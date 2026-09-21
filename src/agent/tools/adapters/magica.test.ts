import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../errors.js";
import type { ToolExecutionContext } from "../types.js";
import { MagicaApiAdapter } from "./magica.js";

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
