import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../errors";
import { gptImage2InputSchema } from "../schemas";
import type { ToolExecutionContext } from "../types";
import { MagicaApiAdapter } from "./magica";

const ctxBase = {
  chatId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
  messageId: "44444444-4444-4444-4444-444444444444",
  toolCallId: "call_crop",
  traceId: "trace_1",
};

const cropInput = {
  image_url: "https://cdn.example/in.png",
  x_percent: 0,
  y_percent: 0,
  width_percent: 50,
  height_percent: 50,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function magicaCompleteFetch(resultUrl: string, options: { video?: boolean } = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/schema")) {
      return json(200, {
        fields: options.video
          ? [{ name: "video_urls" }, { name: "transition" }]
          : [{ name: "image_url" }, { name: "prompt" }],
      });
    }
    if (method === "POST" && url.includes("/run")) {
      return json(202, { runId: "magica_ok" });
    }
    return json(200, {
      id: "magica_ok",
      status: "COMPLETED",
      createdAt: new Date().toISOString(),
      creditUsed: 1_000_000,
      output: options.video ? { video_url: resultUrl } : { image_url: resultUrl },
    });
  });
}

function adapter() {
  return new MagicaApiAdapter({
    apiKey: "test-key",
    baseUrl: "https://inference.magica.com",
    pollIntervalMs: 5,
    pollTimeoutMs: 40,
  });
}

function ctx(signal = new AbortController().signal): ToolExecutionContext {
  return { ...ctxBase, signal };
}

describe("MagicaApiAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes crop_image and returns a generated image asset", async () => {
    vi.stubGlobal("fetch", magicaCompleteFetch("https://cdn.magica.test/crop.png"));
    const result = await adapter().cropImage(cropInput, ctx());
    expect(result.output).toEqual({ image_url: "https://cdn.magica.test/crop.png" });
    expect(result.assets).toEqual([
      expect.objectContaining({
        url: "https://cdn.magica.test/crop.png",
        mimeType: "image/png",
      }),
    ]);
    expect(result.creditCost).toBe("1.000000");
  });

  it("completes gpt_image_2 text generation", async () => {
    const fetchMock = magicaCompleteFetch("https://cdn.magica.test/gen.png");
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter().gptImage2(
      gptImage2InputSchema.parse({ prompt: "a red square on white" }),
      ctx(),
    );
    expect(result.output).toMatchObject({
      image_url: "https://cdn.magica.test/gen.png",
      mode: "gpt-image-2-text",
      prompt: "a red square on white",
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/schema"))).toBe(false);
  });

  it("finishes gpt_image_2 when Magica reports COMPLETE or already has an image", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/run")) {
        return json(200, { id: "magica_ok", status: "QUEUED" });
      }
      return json(200, {
        data: {
          id: "magica_ok",
          status: "COMPLETE",
          output: { images: ["https://cdn.magica.test/gen.png"] },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter().gptImage2(
      gptImage2InputSchema.parse({ prompt: "a red square" }),
      ctx(),
    );
    expect(result.output.image_url).toBe("https://cdn.magica.test/gen.png");
  });

  it("keeps polling after a transient 500 instead of restarting the Magica run", async () => {
    let polls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/run")) {
        return json(202, { runId: "magica_ok" });
      }
      polls += 1;
      if (polls === 1) return json(500, { message: "upstream blip" });
      return json(200, {
        id: "magica_ok",
        status: "RUNNING",
        output: { image_url: "https://cdn.magica.test/gen.png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter().gptImage2(
      gptImage2InputSchema.parse({ prompt: "a red square" }),
      ctx(),
    );
    expect(result.output.image_url).toBe("https://cdn.magica.test/gen.png");
    expect(fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? "GET") === "POST")).toHaveLength(1);
  });

  it("completes merge_videos", async () => {
    vi.stubGlobal(
      "fetch",
      magicaCompleteFetch("https://cdn.magica.test/merged.mp4", { video: true }),
    );
    const result = await adapter().mergeVideos(
      {
        video_urls: ["https://cdn.example/a.mp4", "https://cdn.example/b.mp4"],
        transition: "fade",
      },
      ctx(),
    );
    expect(result.output).toEqual({ video_url: "https://cdn.magica.test/merged.mp4" });
    expect(result.assets?.[0]?.mimeType).toBe("video/mp4");
  });

  it("chains gpt_image_2 into crop_image", async () => {
    const magica = adapter();
    vi.stubGlobal("fetch", magicaCompleteFetch("https://cdn.magica.test/gen.png"));
    const generated = await magica.gptImage2(
      gptImage2InputSchema.parse({ prompt: "a blue circle" }),
      ctx(),
    );
    vi.stubGlobal("fetch", magicaCompleteFetch("https://cdn.magica.test/crop.png"));
    const cropped = await magica.cropImage(
      {
        image_url: generated.output.image_url,
        x_percent: 10,
        y_percent: 10,
        width_percent: 80,
        height_percent: 80,
      },
      ctx(),
    );
    expect(cropped.output.image_url).toBe("https://cdn.magica.test/crop.png");
  });

  it("maps 401 to UNAUTHORIZED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { message: "invalid api key gx_secret" })),
    );
    await expect(adapter().cropImage(cropInput, ctx())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      retryable: false,
      message: "Magica rejected the request",
    });
  });

  it("maps 429 to retryable RATE_LIMITED", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/schema")) {
        return json(200, { modelId: "crop_image", fields: [{ name: "image_url" }] });
      }
      return json(429, { message: "slow down" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const error = await adapter()
      .cropImage(cropInput, ctx())
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });

  it("times out a run that never reaches COMPLETED", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/schema")) {
        return json(200, { modelId: "crop_image", fields: [{ name: "image_url" }] });
      }
      if (method === "POST" && url.includes("/run")) {
        return json(202, { runId: "magica_run_1" });
      }
      return json(200, { id: "magica_run_1", status: "RUNNING" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const error = await adapter()
      .cropImage(cropInput, ctx())
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({
      code: "TIMEOUT",
      retryable: false,
      message: "Magica run timed out",
    });
  });

  it("maps an aborted poll to CANCELLED", async () => {
    const abort = new AbortController();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/schema")) {
        return json(200, { modelId: "crop_image", fields: [{ name: "image_url" }] });
      }
      if (method === "POST" && url.includes("/run")) {
        return json(202, { runId: "magica_run_1" });
      }
      abort.abort();
      return json(200, { id: "magica_run_1", status: "RUNNING" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(adapter().cropImage(cropInput, ctx(abort.signal))).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});
