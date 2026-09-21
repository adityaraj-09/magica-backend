import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "./errors.js";
import { toAssistantToolCallMessage, toToolResultMessage } from "./messages.js";
import { OpenRouterFreeClient, createOpenRouterClient } from "./openrouter.js";
import { OPENROUTER_FREE_ROUTE } from "./types.js";
import type { LlmTool } from "./types.js";

const FREE_MODEL = "deepseek/deepseek-r1:free";

const tools: LlmTool[] = [
  {
    type: "function",
    function: {
      name: "crop_image",
      description: "Crop an image",
      parameters: { type: "object", properties: {} },
    },
  },
];

function sseResponse(events: Array<unknown | string>, init?: ResponseInit): Response {
  const lines = events.map((event) =>
    typeof event === "string" ? event : `data: ${JSON.stringify(event)}`,
  );
  lines.push("data: [DONE]");
  return new Response(`${lines.join("\n")}\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...init?.headers },
    ...init,
  });
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function client(fetchImpl: typeof fetch): OpenRouterFreeClient {
  return new OpenRouterFreeClient({
    apiKey: "test-key",
    fetch: fetchImpl,
  });
}

function complete(
  fetchImpl: typeof fetch,
  extras: { tools?: LlmTool[]; signal?: AbortSignal; onToken?: (t: string) => void } = {},
) {
  return client(fetchImpl).complete({
    messages: [{ role: "user", content: "hello" }],
    tools: extras.tools,
    signal: extras.signal ?? new AbortController().signal,
    onToken: extras.onToken,
  });
}

describe("OpenRouterFreeClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects any model other than openrouter/free at construction", () => {
    expect(
      () => new OpenRouterFreeClient({ apiKey: "k", model: "openai/gpt-4o" }),
    ).toThrow(LlmError);
    expect(() => createOpenRouterClient({ OPENROUTER_API_KEY: "k" })).not.toThrow();
    expect(() =>
      createOpenRouterClient({
        OPENROUTER_API_KEY: "k",
        OPENROUTER_MODEL: "openrouter/auto",
      }),
    ).toThrow(/openrouter\/free/);
  });

  it("requires OPENROUTER_API_KEY", () => {
    expect(() => createOpenRouterClient({})).toThrow(/OPENROUTER_API_KEY/);
  });

  it("streams tokens and records the routed free model", async () => {
    const tokens: string[] = [];
    let captured: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        ": OPENROUTER PROCESSING",
        {
          model: FREE_MODEL,
          choices: [{ index: 0, delta: { content: "Hel" } }],
        },
        {
          model: FREE_MODEL,
          choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
        },
        {
          model: FREE_MODEL,
          choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 2, cost: 0 },
        },
      ]);
    };

    const result = await complete(fetchImpl, { onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(result.text).toBe("Hello");
    expect(result.modelRequested).toBe(OPENROUTER_FREE_ROUTE);
    expect(result.modelRouted).toBe(FREE_MODEL);
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 2, cost: 0 });
    expect(captured?.model).toBe(OPENROUTER_FREE_ROUTE);
    expect(captured?.stream).toBe(true);
    expect(captured).not.toHaveProperty("models");
  });

  it("merges streamed tool-call deltas and never executes them", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        {
          model: FREE_MODEL,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "crop_image", arguments: "" },
                  },
                ],
              },
            },
          ],
        },
        {
          model: FREE_MODEL,
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"image_url":' } },
                ],
              },
            },
          ],
        },
        {
          model: FREE_MODEL,
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '"https://cdn.example/a.png"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
    };

    const result = await complete(fetchImpl, { tools });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "crop_image",
        arguments: { image_url: "https://cdn.example/a.png" },
        rawArguments: '{"image_url":"https://cdn.example/a.png"}',
      },
    ]);
    expect(result.malformedToolCalls).toEqual([]);
    expect(captured?.tools).toEqual(tools);
    expect(captured?.provider).toEqual({ require_parameters: true });
    expect(captured).not.toHaveProperty("models");
  });

  it("surfaces malformed tool-call JSON without throwing", async () => {
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        {
          model: FREE_MODEL,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_bad",
                    function: { name: "crop_image", arguments: "{not json" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);

    const result = await complete(fetchImpl, { tools });
    expect(result.toolCalls).toEqual([]);
    expect(result.malformedToolCalls).toEqual([
      {
        id: "call_bad",
        name: "crop_image",
        rawArguments: "{not json",
        error: "Tool arguments were not valid JSON",
      },
    ]);
  });

  it("maps 429 to a retryable rate-limit error", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { message: "Rate limit" } }, 429, { "retry-after": "7" });

    const error = await complete(fetchImpl).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      name: "LlmError",
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 7000,
    });
  });

  it("treats an empty stream as a terminal empty-stream failure", async () => {
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        ": OPENROUTER PROCESSING",
        {
          model: FREE_MODEL,
          choices: [{ delta: { content: "" }, finish_reason: "stop" }],
        },
      ]);

    await expect(complete(fetchImpl)).rejects.toMatchObject({ code: "EMPTY_STREAM" });
  });

  it("rejects a paid routed model even if the request asked for the free route", async () => {
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        {
          model: "openai/gpt-4o",
          choices: [{ delta: { content: "nope" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.002 },
        },
      ]);

    await expect(complete(fetchImpl)).rejects.toMatchObject({
      code: "UNSUPPORTED_MODEL",
      modelRouted: "openai/gpt-4o",
    });
  });

  it("rejects a :free model that reports a non-zero cost", async () => {
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        {
          model: FREE_MODEL,
          choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 },
        },
      ]);

    await expect(complete(fetchImpl)).rejects.toMatchObject({ code: "UNSUPPORTED_MODEL" });
  });

  it("maps mid-stream errors and keeps partial text", async () => {
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        {
          model: FREE_MODEL,
          choices: [{ delta: { content: "partial" } }],
        },
        {
          model: FREE_MODEL,
          error: { code: "server_error", message: "Provider disconnected unexpectedly" },
          choices: [{ delta: { content: "" }, finish_reason: "error" }],
        },
      ]);

    const error = await complete(fetchImpl).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "FAILED",
      retryable: true,
      partialText: "partial",
      modelRouted: FREE_MODEL,
    });
  });

  it("cancels when the abort signal fires", async () => {
    const abort = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => {
      abort.abort();
      const signal = init?.signal;
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return sseResponse([]);
    };

    await expect(complete(fetchImpl, { signal: abort.signal })).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});

describe("wire helpers", () => {
  it("round-trips tool proposals into OpenAI-shaped messages", () => {
    const assistant = toAssistantToolCallMessage([
      {
        id: "call_1",
        name: "crop_image",
        arguments: { image_url: "https://x" },
        rawArguments: '{"image_url":"https://x"}',
      },
    ]);
    expect(assistant.tool_calls?.[0]?.function.arguments).toBe('{"image_url":"https://x"}');
    expect(toToolResultMessage("call_1", { ok: true }).content).toBe('{"ok":true}');
  });
});
