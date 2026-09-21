import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "@/agent/tools/errors.js";
import { TASK_IDS } from "@/trigger/ids.js";
import { agentTurnPayloadSchema } from "@/trigger/payloads.js";
import { catchNonRetryableToolError } from "@/trigger/errors.js";

const trigger = vi.hoisted(() => vi.fn());

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger },
}));

import { dispatchAgentTurn } from "./dispatch.js";

const payload = {
  chatId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
  messageId: "44444444-4444-4444-4444-444444444444",
  traceId: "trace_1",
};

describe("dispatchAgentTurn", () => {
  beforeEach(() => {
    trigger.mockReset();
    trigger.mockResolvedValue({ id: "run_trigger" });
  });

  it("triggers the orchestrator with chatId concurrency and messageId idempotency", async () => {
    await expect(dispatchAgentTurn(payload)).resolves.toEqual({ id: "run_trigger" });
    expect(trigger).toHaveBeenCalledWith(
      TASK_IDS.orchestrateAgentTurn,
      payload,
      {
        idempotencyKey: payload.messageId,
        concurrencyKey: payload.chatId,
        tags: [payload.chatId, payload.runId],
      },
    );
  });

  it("rejects a malformed turn payload before contacting Trigger.dev", async () => {
    await expect(
      dispatchAgentTurn({ ...payload, chatId: "not-a-uuid" }),
    ).rejects.toThrow();
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("agentTurnPayloadSchema", () => {
  it("accepts a complete admission payload", () => {
    expect(agentTurnPayloadSchema.parse(payload).messageId).toBe(payload.messageId);
  });
});

describe("catchNonRetryableToolError", () => {
  it("skips retries for non-retryable tool failures", () => {
    expect(
      catchNonRetryableToolError({
        error: new ToolError("UNAUTHORIZED", "nope"),
      }),
    ).toEqual({ skipRetrying: true });
    expect(
      catchNonRetryableToolError({
        error: new ToolError("RATE_LIMITED", "slow down", { retryable: true }),
      }),
    ).toBeUndefined();
  });
});
