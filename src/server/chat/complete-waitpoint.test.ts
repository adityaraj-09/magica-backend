import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeWaitpoint } from "./complete-waitpoint.js";
import { HttpError } from "@/server/http/errors.js";

const ids = {
  chatId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
  waitpointId: "44444444-4444-4444-4444-444444444444",
};

const {
  chatFindUnique,
  waitpointFindUnique,
  waitpointFindUniqueOrThrow,
  waitpointUpdate,
  waitpointUpdateMany,
} = vi.hoisted(() => ({
  chatFindUnique: vi.fn(),
  waitpointFindUnique: vi.fn(),
  waitpointFindUniqueOrThrow: vi.fn(),
  waitpointUpdate: vi.fn(),
  waitpointUpdateMany: vi.fn(),
}));

function db() {
  return {
    chat: { findUnique: chatFindUnique },
    waitpoint: {
      findUnique: waitpointFindUnique,
      findUniqueOrThrow: waitpointFindUniqueOrThrow,
      update: waitpointUpdate,
      updateMany: waitpointUpdateMany,
    },
  };
}

function waitingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.waitpointId,
    agentRunId: ids.runId,
    chatId: ids.chatId,
    userId: ids.userId,
    type: "PLAN",
    status: "WAITING",
    triggerWaitpointId: "waitpoint_tok",
    publicAccessToken: "pat_wait",
    timeoutAt: new Date("2099-01-01T00:00:00.000Z"),
    payload: { text: "plan" },
    result: null,
    ...overrides,
  };
}

describe("completeWaitpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatFindUnique.mockResolvedValue({ id: ids.chatId, userId: ids.userId, deletedAt: null });
    waitpointFindUnique.mockResolvedValue(waitingRow());
    waitpointUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("completes a waiting token and clears the overlay", async () => {
    const completeToken = vi.fn(async () => ({ ok: true }));
    const result = await completeWaitpoint({
      userId: ids.userId,
      chatId: ids.chatId,
      waitpointId: ids.waitpointId,
      body: { decision: "approved" },
      db: db() as never,
      completeToken,
    });
    expect(completeToken).toHaveBeenCalledWith("waitpoint_tok", {
      status: "approved",
      approved: true,
    });
    expect(result).toMatchObject({
      decision: "approved",
      replayed: false,
      overlay: null,
    });
    expect(waitpointUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });

  it("replays a duplicate approve without completing again", async () => {
    waitpointFindUnique.mockResolvedValue(waitingRow({ status: "COMPLETED" }));
    const completeToken = vi.fn();
    const result = await completeWaitpoint({
      userId: ids.userId,
      chatId: ids.chatId,
      waitpointId: ids.waitpointId,
      body: { decision: "approved" },
      db: db() as never,
      completeToken,
    });
    expect(result.replayed).toBe(true);
    expect(completeToken).not.toHaveBeenCalled();
  });

  it("expires a stale overlay instead of completing it", async () => {
    waitpointFindUnique.mockResolvedValue(
      waitingRow({ timeoutAt: new Date("2020-01-01T00:00:00.000Z") }),
    );
    await expect(
      completeWaitpoint({
        userId: ids.userId,
        chatId: ids.chatId,
        waitpointId: ids.waitpointId,
        body: { decision: "approved" },
        db: db() as never,
        now: new Date("2026-09-21T00:00:00.000Z"),
        completeToken: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 409, code: "WAITPOINT_EXPIRED" });
    expect(waitpointUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXPIRED" }),
      }),
    );
  });

  it("hides another user's waitpoint", async () => {
    chatFindUnique.mockResolvedValue({
      id: ids.chatId,
      userId: "99999999-9999-9999-9999-999999999999",
      deletedAt: null,
    });
    await expect(
      completeWaitpoint({
        userId: ids.userId,
        chatId: ids.chatId,
        waitpointId: ids.waitpointId,
        body: { decision: "approved" },
        db: db() as never,
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
