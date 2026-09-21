import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "@/agent/tools/errors.js";

const magicaSubscribe = vi.hoisted(() => vi.fn());
const e2bSubscribe = vi.hoisted(() => vi.fn());
const exaSubscribe = vi.hoisted(() => vi.fn());

vi.mock("./magica.js", () => ({
  executeMagicaTool: { triggerAndSubscribe: magicaSubscribe },
}));
vi.mock("./e2b.js", () => ({
  executeE2BSandbox: { triggerAndSubscribe: e2bSubscribe },
}));
vi.mock("./exa.js", () => ({
  executeExaSearch: { triggerAndSubscribe: exaSubscribe },
}));

import { triggerChildTasks } from "./child-runner.js";

function ctx(signal = new AbortController().signal) {
  return {
    chatId: "chat_1",
    userId: "user_1",
    runId: "run_1",
    messageId: "msg_1",
    toolCallId: "tool_1",
    traceId: "trace_1",
    signal,
  };
}

describe("triggerChildTasks", () => {
  beforeEach(() => {
    magicaSubscribe.mockReset();
    e2bSubscribe.mockReset();
    exaSubscribe.mockReset();
  });

  it("forwards the parent abort signal and cancels the child on abort", async () => {
    const abort = new AbortController();
    magicaSubscribe.mockResolvedValue({
      ok: true,
      output: { output: { image_url: "https://x/a.png" }, creditCost: "0", durationMs: 1 },
    });
    await triggerChildTasks.run({
      provider: "MAGICA",
      toolName: "crop_image",
      input: {},
      ctx: ctx(abort.signal),
    });
    expect(magicaSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "crop_image", ctx: expect.objectContaining({ toolCallId: "tool_1" }) }),
      expect.objectContaining({
        idempotencyKey: "tool_1",
        signal: abort.signal,
        cancelOnAbort: true,
      }),
    );
  });

  it("rebuilds a retryable ToolError instead of collapsing it to FAILED", async () => {
    magicaSubscribe.mockResolvedValue({
      ok: false,
      error: {
        type: "BUILT_IN_ERROR",
        name: "ToolError:RATE_LIMITED:retryable",
        message: "Magica is rate limited. Try again shortly.",
      },
    });
    await expect(
      triggerChildTasks.run({
        provider: "MAGICA",
        toolName: "crop_image",
        input: {},
        ctx: ctx(),
      }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      message: "Magica is rate limited. Try again shortly.",
    });
  });

  it("maps a cancelled child run to CANCELLED", async () => {
    magicaSubscribe.mockRejectedValue(
      new ToolError("CANCELLED", "The tool task was cancelled."),
    );
    await expect(
      triggerChildTasks.run({
        provider: "MAGICA",
        toolName: "crop_image",
        input: {},
        ctx: ctx(),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
