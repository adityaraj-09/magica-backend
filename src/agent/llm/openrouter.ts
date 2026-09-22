import { LlmError, isLlmAbortError } from "./errors";
import { iterateSseData } from "./sse";
import {
  applyFullToolCalls,
  applyToolCallDeltas,
  finalizeToolCalls,
  type ToolCallDelta,
} from "./tool-calls";
import type {
  ChatClient,
  ChatCompletionRequest,
  ChatCompletionResult,
  LlmFinishReason,
  LlmUsage,
} from "./types";
import { OPENROUTER_FREE_ROUTE } from "./types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 120_000;
const SENSITIVE = /api[_-]?key|authorization|bearer|sk-/i;

export type OpenRouterClientOptions = {
  apiKey: string;
  /** Must be `openrouter/free`. Rejected at construction. */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  referer?: string;
  title?: string;
};

type StreamChunk = {
  id?: string;
  model?: string;
  error?: { code?: unknown; message?: unknown } | string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number | string;
  };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    message?: {
      content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
  }>;
};

export class OpenRouterFreeClient implements ChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly referer: string;
  private readonly title: string;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
    this.referer = options.referer ?? "https://galaxy-agent.local";
    this.title = options.title ?? "Galaxy Agent";
    assertFreeRoute(options.model ?? OPENROUTER_FREE_ROUTE);
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const response = await this.send(request);
    if (!response.ok) {
      throw await httpError(response);
    }
    if (!response.body) {
      throw new LlmError("EMPTY_STREAM", "Free models returned no output. Try again.");
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return this.fromJson(await response.json(), request);
    }

    return this.fromSse(response.body, request.signal, request.onToken);
  }

  private async send(request: ChatCompletionRequest): Promise<Response> {
    const tools = request.tools?.length ? request.tools : undefined;
    const body: Record<string, unknown> = {
      model: OPENROUTER_FREE_ROUTE,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = request.toolChoice ?? "auto";
      body.provider = { require_parameters: true };
    }

    try {
      return await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": this.referer,
          "X-Title": this.title,
        },
        body: JSON.stringify(body),
        signal: withTimeout(request.signal, this.timeoutMs),
      });
    } catch (cause: unknown) {
      throw mapFetchError(cause, request.signal);
    }
  }

  private async fromSse(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    onToken?: (text: string) => void,
  ): Promise<ChatCompletionResult> {
    let text = "";
    let reasoning = "";
    let modelRouted: string | undefined;
    let finishReason: string | undefined;
    let usage: LlmUsage = { promptTokens: 0, completionTokens: 0, cost: 0 };
    const slots = new Map<number, { id?: string; name?: string; arguments: string }>();

    try {
      for await (const payload of iterateSseData(body, signal)) {
        const chunk = parseChunk(payload);
        if (!chunk) continue;
        if (chunk.error) {
          throw streamError(chunk.error, { partialText: text, modelRouted });
        }
        if (chunk.model) modelRouted = chunk.model;
        if (chunk.usage) usage = toUsage(chunk.usage);

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (choice.message) {
          if (typeof choice.message.content === "string" && choice.message.content) {
            text = choice.message.content;
            onToken?.(choice.message.content);
          }
          applyFullToolCalls(slots, choice.message.tool_calls);
          continue;
        }

        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.reasoning === "string" && delta.reasoning) {
          reasoning += delta.reasoning;
        }
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          onToken?.(delta.content);
        }
        applyToolCallDeltas(slots, delta.tool_calls);
      }
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (signal.aborted) throw mapFetchError(error, signal);
      throw error;
    }

    return this.finalize({
      text,
      reasoning,
      modelRouted,
      finishReason,
      usage,
      slots,
    });
  }

  private fromJson(body: unknown, request: ChatCompletionRequest): ChatCompletionResult {
    const chunk = (body ?? {}) as StreamChunk;
    if (chunk.error) {
      throw streamError(chunk.error);
    }
    const choice = chunk.choices?.[0];
    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (text) request.onToken?.(text);
    const slots = new Map<number, { id?: string; name?: string; arguments: string }>();
    applyFullToolCalls(slots, choice?.message?.tool_calls);
    return this.finalize({
      text,
      reasoning: "",
      modelRouted: chunk.model,
      finishReason: choice?.finish_reason ?? undefined,
      usage: toUsage(chunk.usage),
      slots,
    });
  }

  private finalize(input: {
    text: string;
    reasoning: string;
    modelRouted: string | undefined;
    finishReason: string | undefined;
    usage: LlmUsage;
    slots: Map<number, { id?: string; name?: string; arguments: string }>;
  }): ChatCompletionResult {
    const { toolCalls, malformedToolCalls } = finalizeToolCalls(input.slots);
    const hasTools = toolCalls.length > 0 || malformedToolCalls.length > 0;
    const text = input.text;
    const empty = !hasTools && text.trim() === "";

    if (!input.modelRouted) {
      if (empty) {
        throw new LlmError("EMPTY_STREAM", "Free models returned no output. Try again.");
      }
      throw new LlmError("FAILED", "OpenRouter did not report the routed model", {
        partialText: text,
      });
    }

    assertFreeRoutedModel(input.modelRouted);
    if (input.usage.cost > 0) {
      throw new LlmError("UNSUPPORTED_MODEL", "Paid model routes are not allowed", {
        modelRouted: input.modelRouted,
        partialText: text,
      });
    }

    if (input.finishReason === "error") {
      throw new LlmError("FAILED", "OpenRouter Free failed mid-stream", {
        retryable: true,
        partialText: text,
        modelRouted: input.modelRouted,
      });
    }

    if (empty) {
      throw new LlmError("EMPTY_STREAM", "Free models returned no output. Try again.", {
        modelRouted: input.modelRouted,
      });
    }

    if (input.finishReason === "tool_calls" && !hasTools) {
      throw new LlmError("MALFORMED_TOOL_CALL", "The model requested tools but sent none", {
        partialText: text,
        modelRouted: input.modelRouted,
      });
    }

    return {
      text,
      reasoning: input.reasoning,
      toolCalls,
      malformedToolCalls,
      finishReason: resolveFinishReason(input.finishReason, hasTools),
      modelRequested: OPENROUTER_FREE_ROUTE,
      modelRouted: input.modelRouted,
      usage: input.usage,
    };
  }
}

export function createOpenRouterClient(
  env: Record<string, string | undefined> = process.env,
): OpenRouterFreeClient {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
  return new OpenRouterFreeClient({
    apiKey,
    model: env.OPENROUTER_MODEL,
    baseUrl: env.OPENROUTER_BASE_URL,
    timeoutMs: optionalNumber(env.OPENROUTER_TIMEOUT_MS),
  });
}

export function assertFreeRoute(model: string): void {
  if (model.trim() !== OPENROUTER_FREE_ROUTE) {
    throw new LlmError(
      "UNSUPPORTED_MODEL",
      `Only ${OPENROUTER_FREE_ROUTE} is allowed. Paid fallbacks are disabled.`,
    );
  }
}

function assertFreeRoutedModel(model: string | undefined): asserts model is string {
  if (!model) {
    throw new LlmError("FAILED", "OpenRouter did not report the routed model");
  }
  if (model === OPENROUTER_FREE_ROUTE || model.endsWith(":free")) return;
  throw new LlmError("UNSUPPORTED_MODEL", "Paid model routes are not allowed", {
    modelRouted: model,
  });
}

function resolveFinishReason(raw: string | undefined, hasTools: boolean): LlmFinishReason {
  if (hasTools) return "tool_calls";
  if (raw === "length" || raw === "content_filter" || raw === "stop" || raw === "tool_calls") {
    return raw;
  }
  return "stop";
}

function parseChunk(payload: string): StreamChunk | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as StreamChunk;
  } catch {
    return undefined;
  }
}

function toUsage(usage: StreamChunk["usage"]): LlmUsage {
  const costRaw = usage?.cost;
  const cost =
    typeof costRaw === "number"
      ? costRaw
      : typeof costRaw === "string"
        ? Number(costRaw)
        : 0;
  return {
    promptTokens: Number(usage?.prompt_tokens) || 0,
    completionTokens: Number(usage?.completion_tokens) || 0,
    cost: Number.isFinite(cost) ? cost : 0,
  };
}

function streamError(
  error: StreamChunk["error"],
  extras?: { partialText?: string; modelRouted?: string },
): LlmError {
  const message = errorMessage(error) ?? "OpenRouter Free failed mid-stream";
  const friendly = /provider returned error/i.test(message)
    ? "The model provider failed. Try again."
    : message;
  return new LlmError("FAILED", friendly, {
    retryable: true,
    ...extras,
  });
}

async function httpError(response: Response): Promise<LlmError> {
  const body = await readBody(response);
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  const detail = errorMessage(body) ?? errorMessage((body as { error?: unknown })?.error);

  if (response.status === 401 || response.status === 403) {
    return new LlmError("UNAUTHORIZED", "OpenRouter rejected the request");
  }
  if (response.status === 429) {
    return new LlmError("RATE_LIMITED", "Free models are rate limited. Try again shortly.", {
      retryable: true,
      retryAfterMs,
    });
  }
  if (response.status === 402 || response.status === 503) {
    return new LlmError("UNAVAILABLE", "Free models are temporarily unavailable.", {
      retryable: response.status === 503,
    });
  }
  if (response.status >= 500 || /provider returned error/i.test(detail ?? "")) {
    return new LlmError("UNAVAILABLE", "The model provider failed. Try again.", {
      retryable: true,
    });
  }
  if (detail && /parameters['’]? schema|exclusiveMinimum|metaschema/i.test(detail)) {
    return new LlmError(
      "FAILED",
      "The model could not start this turn. Try sending the message again.",
    );
  }
  return new LlmError("FAILED", detail ?? "OpenRouter Free request failed");
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return SENSITIVE.test(value) ? undefined : value.slice(0, 280);
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.error;
  if (nested && nested !== value) {
    const fromNested = errorMessage(nested);
    if (fromNested) return fromNested;
  }
  const candidate =
    (typeof record.message === "string" && record.message) ||
    (typeof record.userMessage === "string" && record.userMessage) ||
    undefined;
  if (!candidate || SENSITIVE.test(candidate)) return undefined;
  return candidate.slice(0, 280);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function mapFetchError(cause: unknown, signal: AbortSignal): LlmError {
  if (cause instanceof LlmError) return cause;
  if (isTimeout(signal, cause)) {
    return new LlmError("TIMEOUT", "OpenRouter Free timed out", { retryable: true, cause });
  }
  if (isLlmAbortError(cause) || signal.aborted) {
    return new LlmError("CANCELLED", "OpenRouter Free request cancelled", {
      retryable: false,
      cause,
    });
  }
  return new LlmError("UNAVAILABLE", "Free models are temporarily unavailable.", {
    retryable: true,
    cause,
  });
}

function isTimeout(signal: AbortSignal, cause: unknown): boolean {
  const reason = signal.reason;
  return (
    (reason instanceof Error && reason.name === "TimeoutError") ||
    (cause instanceof Error && cause.name === "TimeoutError")
  );
}

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeout])
    : signal;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
