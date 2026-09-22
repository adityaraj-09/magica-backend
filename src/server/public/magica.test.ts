import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/server/http/errors";
import { ToolError } from "@/agent/tools/errors";

const execute = vi.hoisted(() => vi.fn());
const persist = vi.hoisted(() => vi.fn());
const emitWebhooks = vi.hoisted(() => vi.fn());

vi.mock("@/agent/runtime/create-runtime.js", () => ({
  createAgentRuntime: async () => ({ registry: { execute } }),
}));
vi.mock("@/server/storage/copy.js", () => ({
  createAssetGateway: () => ({ persist }),
}));
vi.mock("./webhooks.js", () => ({
  emitWebhooks,
}));

import { executePublicMagicaTool } from "./magica";

describe("executePublicMagicaTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persist.mockImplementation(async (input: { assets: unknown[] }) => input.assets);
    emitWebhooks.mockResolvedValue(undefined);
  });

  it("runs crop_image, copies assets, and emits tool.completed", async () => {
    execute.mockResolvedValue({
      output: { image_url: "https://cdn.example/out.png" },
      assets: [{ url: "https://cdn.example/out.png", mimeType: "image/png" }],
      creditCost: "0",
      durationMs: 12,
      providerRunId: "magica_1",
    });
    const result = await executePublicMagicaTool({
      userId: "22222222-2222-2222-2222-222222222222",
      toolName: "crop_image",
      body: {
        image_url: "https://cdn.example/in.png",
        x_percent: 0,
        y_percent: 0,
        width_percent: 50,
        height_percent: 50,
      },
    });
    expect(result.output).toEqual({ image_url: "https://cdn.example/out.png" });
    expect(persist).toHaveBeenCalled();
    expect(emitWebhooks).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tool.completed" }),
    );
  });

  it("maps Magica 401 to HttpError UNAUTHORIZED", async () => {
    execute.mockRejectedValue(new ToolError("UNAUTHORIZED", "Magica rejected the request"));
    await expect(
      executePublicMagicaTool({
        userId: "22222222-2222-2222-2222-222222222222",
        toolName: "gpt_image_2",
        body: { prompt: "a cat" },
      }),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      executePublicMagicaTool({
        userId: "22222222-2222-2222-2222-222222222222",
        toolName: "gpt_image_2",
        body: { prompt: "a cat" },
      }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });
});
