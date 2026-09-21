import { ToolError } from "../errors.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";
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
} from "../schemas.js";
import type { MagicaAdapter } from "./types.js";
import {
  isAbortError,
  providerHttpError,
  safeErrorDetail,
  sleep,
  throwIfAborted,
  withTimeout,
} from "./http.js";

const DEFAULT_BASE_URL = "https://inference.magica.com";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 8 * 60_000;
const SCHEMA_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MICROCREDITS_PER_CREDIT = 1_000_000;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED", "CANCELLED"]);

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
    const schema = await this.getSchema("crop_image", ctx.signal);
    const payload = buildCropPayload(input, schema.fields ?? []);
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
    const subModelId = input.mode;
    const schema = await this.getSchema(subModelId, ctx.signal, "gpt_image_2");
    const payload = buildGptImagePayload(input, schema.fields ?? []);
    const run = await this.startAndWait("gpt_image_2", payload, subModelId, ctx);
    const imageUrl = extractMediaUrl(run.output, ["image_url", "images", "image", "url"]);
    if (!imageUrl) {
      throw new ToolError("FAILED", "GPT Image 2 finished without an image URL");
    }
    return this.toResult(
      run,
      ctx,
      gptImage2OutputSchema.parse({ image_url: imageUrl, mode: input.mode }),
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
    const runId = await this.startRun(nodeType, input, subModelId, ctx.signal);
    return this.waitForRun(runId, ctx.signal, started);
  }

  private async startRun(
    nodeType: string,
    input: Record<string, unknown>,
    subModelId: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const body: Record<string, unknown> = { input };
    if (subModelId) body.subModelId = subModelId;

    const response = await this.request(
      "POST",
      `/v1/nodes/${encodeURIComponent(nodeType)}/run`,
      { body, signal, expected: [202] },
    );
    const json = (await response.json()) as { runId?: string };
    if (!json.runId) {
      throw new ToolError("FAILED", "Magica did not return a runId");
    }
    return json.runId;
  }

  private async waitForRun(
    runId: string,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<MagicaRun> {
    let missing = 0;
    while (Date.now() - startedAt < this.pollTimeoutMs) {
      throwIfAborted(signal, "Magica run cancelled");
      const run = await this.getRun(runId, signal);
      if (!run) {
        missing += 1;
        if (missing > 5) {
          throw new ToolError("FAILED", "Magica run could not be loaded");
        }
        await sleep(this.pollIntervalMs, signal);
        continue;
      }

      const status = run.status.toUpperCase();
      if (status === "COMPLETED") return run;
      if (status === "FAILED") {
        throw new ToolError(
          "FAILED",
          run.userMessage ?? safeErrorDetail({ message: run.error }) ?? "Magica run failed",
        );
      }
      if (status === "CANCELED" || status === "CANCELLED") {
        throw new ToolError("CANCELLED", "Magica run was cancelled");
      }
      if (!TERMINAL.has(status)) {
        await sleep(this.pollIntervalMs, signal);
        continue;
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
    return (await response.json()) as MagicaRun;
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

function buildCropPayload(input: CropImageInput, fields: MagicaField[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    [fieldName(fields, ["image_url", "image", "url", "imageUrl"]) ?? "image_url"]: input.image_url,
  };

  if (input.crop) {
    const cropField = fieldName(fields, ["crop"]);
    if (cropField) {
      payload[cropField] = input.crop;
      return payload;
    }
    assignIfPresent(payload, fields, "x", input.crop.x);
    assignIfPresent(payload, fields, "y", input.crop.y);
    assignIfPresent(payload, fields, "width", input.crop.width);
    assignIfPresent(payload, fields, "height", input.crop.height);
    return payload;
  }

  if (input.x !== undefined && input.y !== undefined && input.width !== undefined && input.height !== undefined) {
    assignIfPresent(payload, fields, "x", input.x);
    assignIfPresent(payload, fields, "y", input.y);
    assignIfPresent(payload, fields, "width", input.width);
    assignIfPresent(payload, fields, "height", input.height);
    return payload;
  }

  assignIfPresent(payload, fields, "x_percent", input.x_percent, ["x_percent", "xPercent"]);
  assignIfPresent(payload, fields, "y_percent", input.y_percent, ["y_percent", "yPercent"]);
  assignIfPresent(payload, fields, "width_percent", input.width_percent, ["width_percent", "widthPercent"]);
  assignIfPresent(payload, fields, "height_percent", input.height_percent, ["height_percent", "heightPercent"]);
  return payload;
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
