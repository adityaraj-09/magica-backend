import { ToolError } from "../errors.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";
import type { WebSearchAdapter } from "./types.js";
import {
  webSearchInputSchema,
  webSearchOutputSchema,
  type WebSearchInput,
  type WebSearchOutput,
} from "../schemas.js";
import { isAbortError, providerHttpError, throwIfAborted, withTimeout } from "./http.js";

type ExaSearchHit = {
  title?: string | null;
  url?: string | null;
  text?: string | null;
  highlights?: string[] | null;
  publishedDate?: string | null;
  author?: string | null;
};

type ExaSearchResponse = {
  requestId?: string;
  results?: ExaSearchHit[];
};

const DEFAULT_EXA_BASE_URL = "https://api.exa.ai";
const STUB_DELAY_MS = 400;
const REQUEST_TIMEOUT_MS = 30_000;

function snippetFromHit(hit: ExaSearchHit): string {
  const highlight = hit.highlights?.find((value) => value.trim().length > 0);
  if (highlight) return highlight.slice(0, 400);
  if (hit.text) return hit.text.slice(0, 400);
  return "";
}

export class ExaWebSearchAdapter implements WebSearchAdapter {
  readonly provider = "exa" as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = DEFAULT_EXA_BASE_URL,
  ) {}

  async search(
    raw: WebSearchInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult<WebSearchOutput>> {
    const input = webSearchInputSchema.parse(raw);
    throwIfAborted(ctx.signal, "Web search cancelled");
    const started = Date.now();

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        query: input.query,
        numResults: input.count,
        type: "auto",
        ...(input.category ? { category: input.category } : {}),
        contents: {
          highlights: true,
          text: { maxCharacters: 500 },
        },
      }),
      signal: withTimeout(ctx.signal, REQUEST_TIMEOUT_MS),
    }).catch((cause: unknown) => {
      if (isAbortError(cause) || ctx.signal.aborted) {
        throw new ToolError("CANCELLED", "Web search cancelled", { cause });
      }
      throw new ToolError("FAILED", "Web search is temporarily unavailable", {
        retryable: true,
        cause,
      });
    });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      throw providerHttpError(response.status, "Exa", body);
    }

    const body = (await response.json()) as ExaSearchResponse;
    const output = webSearchOutputSchema.parse({
      query: input.query,
      provider: "exa",
      results: (body.results ?? [])
        .filter((hit) => typeof hit.url === "string" && hit.url.length > 0)
        .map((hit) => ({
          title: hit.title?.trim() || hit.url || "Untitled",
          url: hit.url as string,
          snippet: snippetFromHit(hit),
          publishedDate: hit.publishedDate ?? null,
          author: hit.author ?? null,
        })),
    });

    return {
      output,
      creditCost: "0",
      providerRunId: body.requestId ?? ctx.toolCallId,
      durationMs: Date.now() - started,
    };
  }
}

export class StubWebSearchAdapter implements WebSearchAdapter {
  readonly provider = "stub" as const;

  async search(
    raw: WebSearchInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult<WebSearchOutput>> {
    const input = webSearchInputSchema.parse(raw);
    const started = Date.now();
    await delay(STUB_DELAY_MS, ctx.signal);

    const output = webSearchOutputSchema.parse({
      query: input.query,
      provider: "stub",
      results: [
        {
          title: `Stub result for “${input.query}”`,
          url: "https://example.com/stub-search",
          snippet:
            "Deterministic sample result used when EXA_API_KEY is not set. Shape matches the live Exa adapter.",
          publishedDate: "2026-01-15",
          author: "Galaxy Stub",
        },
      ].slice(0, input.count),
    });

    return {
      output,
      creditCost: "0",
      providerRunId: `stub_${ctx.toolCallId}`,
      durationMs: Date.now() - started,
    };
  }
}

export function createWebSearchAdapter(env: NodeJS.ProcessEnv = process.env): WebSearchAdapter | undefined {
  const mode = (env.WEB_SEARCH_PROVIDER ?? "exa").toLowerCase();
  if (mode === "off") return undefined;

  const apiKey = env.EXA_API_KEY?.trim();
  if (mode === "exa" && apiKey) {
    return new ExaWebSearchAdapter(apiKey, env.EXA_BASE_URL ?? DEFAULT_EXA_BASE_URL);
  }

  return new StubWebSearchAdapter();
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ToolError("CANCELLED", "Web search cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ToolError("CANCELLED", "Web search cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
