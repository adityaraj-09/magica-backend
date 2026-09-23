import { ToolError } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  cropImageInputSchema,
  cropImageOutputSchema,
  gptImage2InputSchema,
  gptImage2OutputSchema,
  mergeVideosInputSchema,
  mergeVideosOutputSchema,
  type CropImageInput,
  type CropImageOutput,
  type GptImage2Input,
  type GptImage2Output,
  type MergeVideosInput,
  type MergeVideosOutput,
} from "../schemas";
import type { MagicaAdapter } from "./types";
import {
  isAbortError,
  providerHttpError,
  safeErrorDetail,
  sleep,
  throwIfAborted,
  withTimeout,
} from "./http";

const DEFAULT_BASE_URL = "https://inference.magica.com";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 8 * 60_000;
const SCHEMA_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MICROCREDITS_PER_CREDIT = 1_000_000;
const SUCCEEDED = new Set(["COMPLETED", "COMPLETE", "SUCCESS", "SUCCEEDED", "DONE", "FINISHED"]);
const FAILED = new Set(["FAILED", "ERROR", "ERRORED"]);
const CANCELLED = new Set(["CANCELED", "CANCELLED"]);
const MAX_POLL_GAPS = 8;

type MagicaField = {
  name: string;
  required?: boolean;
  dataType?: string;
};

type MagicaSchema = {
  modelId?: string;
  fields?: MagicaField[];
};

type MagicaRun = {
  id?: string;
  runId?: string;
  nodeType?: string;
  subModelId?: string | null;
  status: string;
  output?: unknown;
  error?: string | null;
  userMessage?: string | null;
  creditUsed?: number | null;
  createdAt?: string;
};

export type MagicaAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export class MagicaApiAdapter implements MagicaAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly schemaCache = new Map<string, { expiresAt: number; schema: MagicaSchema }>();

  constructor(options: MagicaAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  async cropImage(
    raw: CropImageInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult<CropImageOutput>> {
    const input = cropImageInputSchema.parse(raw);
    // Schema for crop_image is incomplete / 403s; the node wants image_url + percent or pixel fields.
    const payload = buildCropPayload(input, []);
    const run = await this.startAndWait("crop_image", payload, undefined, ctx);
    const imageUrl = extractMediaUrl(run.output, ["image_url", "images", "image", "url"]);
    if (!imageUrl) {
      throw new ToolError("FAILED", "Crop Image finished without an image URL");
    }
    return this.toResult(run, ctx, cropImageOutputSchema.parse({ image_url: imageUrl }), imageUrl);
  }

  async gptImage2(
    raw: GptImage2Input,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult<GptImage2Output>> {
    const input = gptImage2InputSchema.parse(raw);
    // Schema for gpt-image-2-text/edit 403s on Magica; the node only needs prompt + optional image.
    const payload = buildGptImagePayload(input, []);
    const run = await this.startAndWait("gpt_image_2", payload, input.mode, ctx);
    const imageUrl = extractMediaUrl(run.output, ["image_url", "images", "image", "url"]);
    if (!imageUrl) {
      throw new ToolError("FAILED", "GPT Image 2 finished without an image URL");
    }
    return this.toResult(
      run,
      ctx,
      gptImage2OutputSchema.parse({
        image_url: imageUrl,
        mode: input.mode,
        prompt: input.prompt,
      }),
      imageUrl,
    );
  }

  async mergeVideos(
    raw: MergeVideosInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult<MergeVideosOutput>> {
    const input = mergeVideosInputSchema.parse(raw);
    const schema = await this.getSchema("merge_videos", ctx.signal);
    const payload = buildMergeVideosPayload(input, schema.fields ?? []);
    const run = await this.startAndWait("merge_videos", payload, undefined, ctx);
    const videoUrl = extractMediaUrl(run.output, ["video_url", "videos", "video", "url"]);
    if (!videoUrl) {
      throw new ToolError("FAILED", "Merge Videos finished without a video URL");
    }
    return this.toResult(run, ctx, mergeVideosOutputSchema.parse({ video_url: videoUrl }), videoUrl);
  }

  private toResult<T>(
    run: MagicaRun,
    ctx: ToolExecutionContext,
    output: T,
    assetUrl: string,
  ): ToolExecutionResult<T> {
    const createdAt = run.createdAt ? Date.parse(run.createdAt) : undefined;
    return {
      output,
      creditCost: microcreditsToCredits(run.creditUsed),
      providerRunId: run.id ?? run.runId ?? ctx.toolCallId,
      durationMs: createdAt ? Math.max(0, Date.now() - createdAt) : 0,
      assets: [
        {
          url: assetUrl,
          mimeType: assetUrl.includes(".mp4") || assetUrl.includes("video") ? "video/mp4" : "image/png",
        },
      ],
    };
  }

  private async startAndWait(
    nodeType: string,
    input: Record<string, unknown>,
    subModelId: string | undefined,
    ctx: ToolExecutionContext,
  ): Promise<MagicaRun> {
    throwIfAborted(ctx.signal, "Magica run cancelled");
    const started = Date.now();
    const startedRun = await this.startRun(nodeType, input, subModelId, ctx.signal);
    if (runOutcome(startedRun, nodeType) === "succeeded") return startedRun;
    const runId = startedRun.runId ?? startedRun.id;
    if (!runId) {
      throw new ToolError("FAILED", "Magica did not return a runId");
    }
    return this.waitForRun(runId, nodeType, ctx.signal, started);
  }

  private async startRun(
    nodeType: string,
    input: Record<string, unknown>,
    subModelId: string | undefined,
    signal: AbortSignal,
  ): Promise<MagicaRun> {
    const body: Record<string, unknown> = { input };
    if (subModelId) body.subModelId = subModelId;

    const response = await this.request(
      "POST",
      `/v1/nodes/${encodeURIComponent(nodeType)}/run`,
      { body, signal, expected: [200, 202] },
    );
    const run = parseMagicaRun(await response.json());
    if (!run || !(run.runId || run.id)) {
      throw new ToolError("FAILED", "Magica did not return a runId");
    }
    return run;
  }

  private async waitForRun(
    runId: string,
    nodeType: string,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<MagicaRun> {
    let gaps = 0;
    while (Date.now() - startedAt < this.pollTimeoutMs) {
      throwIfAborted(signal, "Magica run cancelled");
      let run: MagicaRun | null = null;
      try {
        run = await this.getRun(runId, signal);
      } catch (error) {
        if (error instanceof ToolError && error.retryable) {
          gaps += 1;
          if (gaps > MAX_POLL_GAPS) throw error;
          await sleep(this.pollIntervalMs, signal);
          continue;
        }
        throw error;
      }

      if (!run) {
        gaps += 1;
        if (gaps > MAX_POLL_GAPS) {
          throw new ToolError("FAILED", "Magica run could not be loaded");
        }
        await sleep(this.pollIntervalMs, signal);
        continue;
      }

      gaps = 0;
      const outcome = runOutcome(run, nodeType);
      if (outcome === "succeeded") return run;
      if (outcome === "failed") {
        throw new ToolError(
          "FAILED",
          run.userMessage ?? safeErrorDetail({ message: run.error }) ?? "Magica run failed",
        );
      }
      if (outcome === "cancelled") {
        throw new ToolError("CANCELLED", "Magica run was cancelled");
      }
      await sleep(this.pollIntervalMs, signal);
    }
    throw new ToolError("TIMEOUT", "Magica run timed out", { retryable: false });
  }

  private async getRun(runId: string, signal: AbortSignal): Promise<MagicaRun | null> {
    const response = await this.request("GET", `/v1/nodes/runs/${encodeURIComponent(runId)}`, {
      signal,
      expected: [200, 404],
    });
    if (response.status === 404) return null;
    return parseMagicaRun(await response.json());
  }

  private async getSchema(
    modelId: string,
    signal: AbortSignal,
    fallbackId?: string,
  ): Promise<MagicaSchema> {
    const cached = this.schemaCache.get(modelId);
    if (cached && cached.expiresAt > Date.now()) return cached.schema;

    try {
      const schema = await this.fetchSchema(modelId, signal);
      this.schemaCache.set(modelId, { schema, expiresAt: Date.now() + SCHEMA_TTL_MS });
      return schema;
    } catch (error) {
      if (fallbackId && fallbackId !== modelId) {
        return this.getSchema(fallbackId, signal);
      }
      if (error instanceof ToolError && error.code === "FAILED") {
        return { modelId, fields: [] };
      }
      throw error;
    }
  }

  private async fetchSchema(modelId: string, signal: AbortSignal): Promise<MagicaSchema> {
    const response = await this.request("GET", `/v1/models/${encodeURIComponent(modelId)}/schema`, {
      signal,
      expected: [200],
    });
    return (await response.json()) as MagicaSchema;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: {
      body?: unknown;
      signal: AbortSignal;
      expected: number[];
    },
  ): Promise<Response> {
    throwIfAborted(options.signal, "Magica request cancelled");
    const signal = withTimeout(options.signal, REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal,
      });
    } catch (cause) {
      if (isAbortError(cause) || options.signal.aborted) {
        throw new ToolError("CANCELLED", "Magica request cancelled", { cause });
      }
      throw new ToolError("FAILED", "Magica is temporarily unavailable", {
        retryable: true,
        cause,
      });
    }

    if (!options.expected.includes(response.status)) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      throw providerHttpError(response.status, "Magica", body);
    }
    return response;
  }
}

export function createMagicaAdapter(env: NodeJS.ProcessEnv = process.env): MagicaAdapter {
  const apiKey = env.MAGICA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("MAGICA_API_KEY is required for the Magica adapter");
  }
  return new MagicaApiAdapter({
    apiKey,
    baseUrl: env.MAGICA_BASE_URL ?? DEFAULT_BASE_URL,
    pollIntervalMs: optionalNumber(env.MAGICA_POLL_INTERVAL_MS),
    pollTimeoutMs: optionalNumber(env.MAGICA_POLL_TIMEOUT_MS),
  });
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function microcreditsToCredits(microcredits: number | null | undefined): string {
  if (!microcredits || microcredits <= 0) return "0";
  return (microcredits / MICROCREDITS_PER_CREDIT).toFixed(6);
}

function fieldName(fields: MagicaField[], candidates: string[]): string | undefined {
  const available = new Map(fields.map((field) => [field.name.toLowerCase(), field.name]));
  for (const candidate of candidates) {
    const match = available.get(candidate.toLowerCase());
    if (match) return match;
  }
  return undefined;
}

export function buildCropPayload(input: CropImageInput, fields: MagicaField[] = []): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    [fieldName(fields, ["image_url", "image", "url", "imageUrl"]) ?? "image_url"]: input.image_url,
  };
  const rect = normalizeCropRect(input);
  if (rect.kind === "percent") {
    assignIfPresent(payload, fields, "x_percent", rect.x, ["x_percent", "xPercent"]);
    assignIfPresent(payload, fields, "y_percent", rect.y, ["y_percent", "yPercent"]);
    assignIfPresent(payload, fields, "width_percent", rect.width, ["width_percent", "widthPercent"]);
    assignIfPresent(payload, fields, "height_percent", rect.height, ["height_percent", "heightPercent"]);
    return payload;
  }
  assignIfPresent(payload, fields, "x", rect.x);
  assignIfPresent(payload, fields, "y", rect.y);
  assignIfPresent(payload, fields, "width", rect.width);
  assignIfPresent(payload, fields, "height", rect.height);
  return payload;
}

function normalizeCropRect(input: CropImageInput): {
  kind: "percent" | "pixel";
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (
    input.x_percent !== undefined &&
    input.y_percent !== undefined &&
    input.width_percent !== undefined &&
    input.height_percent !== undefined
  ) {
    return {
      kind: "percent",
      x: input.x_percent,
      y: input.y_percent,
      width: input.width_percent,
      height: input.height_percent,
    };
  }
  if (input.crop) {
    const { x, y, width, height } = input.crop;
    return {
      kind: looksLikePercent(x, y, width, height) ? "percent" : "pixel",
      x,
      y,
      width,
      height,
    };
  }
  return {
    kind: "pixel",
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: input.width ?? 0,
    height: input.height ?? 0,
  };
}

function looksLikePercent(x: number, y: number, width: number, height: number): boolean {
  return [x, y, width, height].every((value) => value >= 0 && value <= 100);
}

function buildGptImagePayload(input: GptImage2Input, fields: MagicaField[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    [fieldName(fields, ["prompt", "text", "instruction"]) ?? "prompt"]: input.prompt,
  };
  if (input.image_url) {
    payload[fieldName(fields, ["image_url", "image", "input_image", "imageUrl"]) ?? "image_url"] =
      input.image_url;
  }
  return payload;
}

function buildMergeVideosPayload(input: MergeVideosInput, fields: MagicaField[]): Record<string, unknown> {
  return {
    [fieldName(fields, ["video_urls", "videos", "urls", "videoUrls"]) ?? "video_urls"]: input.video_urls,
    [fieldName(fields, ["transition", "transition_type", "transitionType"]) ?? "transition"]:
      input.transition,
  };
}

function assignIfPresent(
  payload: Record<string, unknown>,
  fields: MagicaField[],
  fallback: string,
  value: unknown,
  candidates: string[] = [fallback],
): void {
  if (value === undefined) return;
  payload[fieldName(fields, candidates) ?? fallback] = value;
}

function parseMagicaRun(raw: unknown): MagicaRun | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const nested = record.data;
  const inner =
    nested && typeof nested === "object" && !record.status && !record.runId && !record.id
      ? (nested as Record<string, unknown>)
      : record;
  const status =
    (typeof inner.status === "string" && inner.status) ||
    (typeof inner.state === "string" && inner.state) ||
    "";
  const runId =
    (typeof inner.runId === "string" && inner.runId) ||
    (typeof inner.id === "string" && inner.id) ||
    undefined;
  if (!status && !runId && inner.output == null && inner.result == null) return null;
  return {
    id: typeof inner.id === "string" ? inner.id : undefined,
    runId: typeof inner.runId === "string" ? inner.runId : runId,
    nodeType: typeof inner.nodeType === "string" ? inner.nodeType : undefined,
    subModelId: typeof inner.subModelId === "string" ? inner.subModelId : null,
    status,
    output: inner.output ?? inner.result,
    error: typeof inner.error === "string" ? inner.error : null,
    userMessage: typeof inner.userMessage === "string" ? inner.userMessage : null,
    creditUsed: typeof inner.creditUsed === "number" ? inner.creditUsed : null,
    createdAt: typeof inner.createdAt === "string" ? inner.createdAt : undefined,
  };
}

function runOutcome(run: MagicaRun, nodeType: string): "succeeded" | "failed" | "cancelled" | "pending" {
  const status = run.status.toUpperCase();
  if (SUCCEEDED.has(status)) return "succeeded";
  if (FAILED.has(status)) return "failed";
  if (CANCELLED.has(status)) return "cancelled";
  const keys =
    nodeType === "merge_videos"
      ? ["video_url", "videos", "video", "url"]
      : ["image_url", "images", "image", "url"];
  if (extractMediaUrl(run.output, keys)) return "succeeded";
  return "pending";
}

function extractMediaUrl(output: unknown, preferredKeys: string[]): string | undefined {
  if (typeof output === "string" && isHttpUrl(output)) return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = extractMediaUrl(item, preferredKeys);
      if (found) return found;
    }
    return undefined;
  }
  if (!output || typeof output !== "object") return undefined;

  const record = output as Record<string, unknown>;
  for (const key of preferredKeys) {
    if (key in record) {
      const found = extractMediaUrl(record[key], preferredKeys);
      if (found) return found;
    }
  }
  for (const value of Object.values(record)) {
    const found = extractMediaUrl(value, preferredKeys);
    if (found) return found;
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
