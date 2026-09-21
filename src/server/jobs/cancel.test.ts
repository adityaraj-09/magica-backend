import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  runs: { cancel: vi.fn() },
}));
vi.mock("@/server/db.js", () => ({
  prisma: {},
}));

import { cancelRun } from "./cancel.js";

const ids = {
  chatId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
  messageId: "44444444-4444-4444-4444-444444444444",
};

const {
  chatFindUnique,
  runFindUnique,
  runUpdate,
  waitpointUpdateMany,
} = vi.hoisted(() => ({
  chatFindUnique: vi.fn(),
  runFindUnique: vi.fn(),
  runUpdate: vi.fn(),
  waitpointUpdateMany: vi.fn(),
}));

function db() {
  return {
    chat: { findUnique: chatFindUnique },
    agentRun: { findUnique: runFindUnique, update: runUpdate },
    waitpoint: { updateMany: waitpointUpdateMany },
  };
}

function activeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.runId,
    chatId: ids.chatId,
    userMessageId: ids.messageId,
    traceId: "trace_1",
    status: "WORKING",
    triggerRunId: "tr_run_1",
    processId: "tr_run_1",
    ...overrides,
  };
}

describe("cancelRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatFindUnique.mockResolvedValue({ id: ids.chatId, userId: ids.userId, deletedAt: null });
    runFindUnique.mockResolvedValue(activeRun());
    runUpdate.mockResolvedValue({});
    waitpointUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("marks an owned active run STOPPING and cancels the Trigger run", async () => {
    const cancelTrigger = vi.fn(async () => undefined);
    const result = await cancelRun({
      userId: ids.userId,
      chatId: ids.chatId,
      runId: ids.runId,
      db: db() as never,
      cancelTrigger,
    });
    expect(result).toEqual({
      chatId: ids.chatId,
      runId: ids.runId,
      status: "STOPPING",
      replayed: false,
    });
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "STOPPING" }),
      }),
    );
    expect(waitpointUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentRunId: ids.runId, status: "WAITING" },
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
    expect(cancelTrigger).toHaveBeenCalledWith("tr_run_1");
  });

  it("cancels a queued run immediately when Trigger has not started", async () => {
    runFindUnique.mockResolvedValue(activeRun({ status: "QUEUED", triggerRunId: null, processId: null }));
    const cancelTrigger = vi.fn();
    const result = await cancelRun({
      userId: ids.userId,
      chatId: ids.chatId,
      runId: ids.runId,
      db: db() as never,
      cancelTrigger,
    });
    expect(result.status).toBe("CANCELLED");
    expect(cancelTrigger).not.toHaveBeenCalled();
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED", errorCode: "CANCELLED" }),
      }),
    );
  });

  it("replays a terminal run without calling Trigger again", async () => {
    runFindUnique.mockResolvedValue(activeRun({ status: "COMPLETE" }));
    const cancelTrigger = vi.fn();
    const result = await cancelRun({
      userId: ids.userId,
      chatId: ids.chatId,
      runId: ids.runId,
      db: db() as never,
      cancelTrigger,
    });
    expect(result).toMatchObject({ status: "COMPLETE", replayed: true });
    expect(runUpdate).not.toHaveBeenCalled();
    expect(cancelTrigger).not.toHaveBeenCalled();
  });

  it("hides another user's chat", async () => {
    chatFindUnique.mockResolvedValue({
      id: ids.chatId,
      userId: "99999999-9999-9999-9999-999999999999",
      deletedAt: null,
    });
    await expect(
      cancelRun({
        userId: ids.userId,
        chatId: ids.chatId,
        runId: ids.runId,
        db: db() as never,
      }),
    ).rejects.toMatchObject({ status: 404, code: "CHAT_NOT_FOUND" });
  });
});
