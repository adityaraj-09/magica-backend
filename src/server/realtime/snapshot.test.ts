import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRunSnapshot } from "./snapshot";

const ids = {
  chatId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
  messageId: "44444444-4444-4444-4444-444444444444",
  assistantId: "55555555-5555-5555-5555-555555555555",
  waitpointId: "66666666-6666-6666-6666-666666666666",
};

const { chatFindUnique, runFindUnique, waitpointUpdate, createRunRealtimeToken } = vi.hoisted(
  () => ({
    chatFindUnique: vi.fn(),
    runFindUnique: vi.fn(),
    waitpointUpdate: vi.fn(),
    createRunRealtimeToken: vi.fn(),
  }),
);

vi.mock("@/server/realtime/token.js", () => ({ createRunRealtimeToken }));

function db() {
  return {
    chat: { findUnique: chatFindUnique },
    agentRun: { findUnique: runFindUnique },
    waitpoint: { update: waitpointUpdate },
  };
}

describe("loadRunSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatFindUnique.mockResolvedValue({ id: ids.chatId, userId: ids.userId, deletedAt: null });
    createRunRealtimeToken.mockResolvedValue("pat_live");
    waitpointUpdate.mockResolvedValue({});
  });

  it("returns postgres state with an open waitpoint overlay", async () => {
    runFindUnique.mockResolvedValue({
      id: ids.runId,
      chatId: ids.chatId,
      userMessageId: ids.messageId,
      status: "WAITING",
      currentStep: "wait:plan",
      thinkingDurationMs: 40,
      errorCode: null,
      errorMessage: null,
      triggerRunId: "run_trigger",
      toolInvocations: [
        { toolCallId: "call_1", toolName: "crop_image", status: "RUNNING", errorMessage: null },
      ],
      messages: [
        {
          id: ids.assistantId,
          status: "STREAMING",
          contentBlocks: [{ type: "text", text: "I will crop" }],
        },
      ],
      waitpoints: [
        {
          id: ids.waitpointId,
          type: "PLAN",
          status: "WAITING",
          triggerWaitpointId: "waitpoint_tok",
          publicAccessToken: "pat_wait",
          timeoutAt: new Date("2099-01-01T00:00:00.000Z"),
          payload: { text: "I will crop" },
        },
      ],
    });

    const snapshot = await loadRunSnapshot({
      userId: ids.userId,
      chatId: ids.chatId,
      runId: ids.runId,
      db: db() as never,
    });

    expect(snapshot.status).toBe("WAITING");
    expect(snapshot.tools[0]?.toolName).toBe("crop_image");
    expect(snapshot.waitpoint).toMatchObject({
      waitpointId: ids.waitpointId,
      type: "PLAN",
      triggerWaitpointId: "waitpoint_tok",
    });
    expect(snapshot.assistant?.contentBlocks).toEqual([
      { type: "text", text: "I will crop" },
    ]);
    expect(snapshot.realtimeToken).toBe("pat_live");
    expect(snapshot.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      credits: "0",
      model: null,
      durationMs: 40,
    });
    expect(waitpointUpdate).not.toHaveBeenCalled();
  });

  it("expires a timed-out waitpoint so the overlay is gone", async () => {
    runFindUnique.mockResolvedValue({
      id: ids.runId,
      chatId: ids.chatId,
      userMessageId: ids.messageId,
      status: "WAITING",
      currentStep: "wait:plan",
      thinkingDurationMs: 40,
      errorCode: null,
      errorMessage: null,
      triggerRunId: "run_trigger",
      toolInvocations: [],
      messages: [],
      waitpoints: [
        {
          id: ids.waitpointId,
          type: "PLAN",
          status: "WAITING",
          triggerWaitpointId: "waitpoint_tok",
          publicAccessToken: "pat_wait",
          timeoutAt: new Date("2020-01-01T00:00:00.000Z"),
          payload: {},
        },
      ],
    });

    const snapshot = await loadRunSnapshot({
      userId: ids.userId,
      chatId: ids.chatId,
      runId: ids.runId,
      db: db() as never,
      now: new Date("2026-09-21T00:00:00.000Z"),
      mintToken: false,
    });

    expect(waitpointUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXPIRED" }),
      }),
    );
    expect(snapshot.waitpoint).toBeNull();
    expect(snapshot.realtimeToken).toBeUndefined();
  });

  it("auto-approves a leftover media waitpoint so Keep media never sticks", async () => {
    const completeToken = vi.fn(async () => undefined);
    runFindUnique.mockResolvedValue({
      id: ids.runId,
      chatId: ids.chatId,
      userMessageId: ids.messageId,
      status: "WAITING",
      currentStep: "wait:media",
      thinkingDurationMs: 40,
      errorCode: null,
      errorMessage: null,
      triggerRunId: "run_trigger",
      toolInvocations: [],
      messages: [
        {
          id: ids.assistantId,
          status: "STREAMING",
          contentBlocks: [{ type: "asset", url: "https://cdn.example/out.png", mimeType: "image/png" }],
        },
      ],
      waitpoints: [
        {
          id: ids.waitpointId,
          type: "MEDIA",
          status: "WAITING",
          triggerWaitpointId: "waitpoint_tok",
          publicAccessToken: "pat_wait",
          timeoutAt: new Date("2099-01-01T00:00:00.000Z"),
          payload: {},
        },
      ],
    });

    const snapshot = await loadRunSnapshot({
      userId: ids.userId,
      chatId: ids.chatId,
      runId: ids.runId,
      db: db() as never,
      mintToken: false,
      completeToken,
    });

    expect(completeToken).toHaveBeenCalledWith("waitpoint_tok");
    expect(waitpointUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
    expect(snapshot.waitpoint).toBeNull();
  });
});
