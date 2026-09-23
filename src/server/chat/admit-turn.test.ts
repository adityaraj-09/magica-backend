import { Prisma, type User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/server/http/errors";

const {
  dispatchAgentTurn,
  createRunRealtimeToken,
  transaction,
  chatFindUnique,
  chatCreate,
  chatUpdate,
  messageFindUnique,
  messageCreate,
  runFindFirst,
  runCreate,
  runUpdate,
  runCount,
  userFindUniqueOrThrow,
  userUpdate,
  ledgerCreate,
  attachmentFindMany,
  attachmentFindFirst,
  attachmentCreate,
} = vi.hoisted(() => ({
  dispatchAgentTurn: vi.fn(),
  createRunRealtimeToken: vi.fn(),
  transaction: vi.fn(),
  chatFindUnique: vi.fn(),
  chatCreate: vi.fn(),
  chatUpdate: vi.fn(),
  messageFindUnique: vi.fn(),
  messageCreate: vi.fn(),
  runFindFirst: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  runCount: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  userUpdate: vi.fn(),
  ledgerCreate: vi.fn(),
  attachmentFindMany: vi.fn(),
  attachmentFindFirst: vi.fn(),
  attachmentCreate: vi.fn(),
}));

vi.mock("@/server/jobs/dispatch.js", () => ({ dispatchAgentTurn }));
vi.mock("@/server/realtime/token.js", () => ({ createRunRealtimeToken }));
vi.mock("@/server/db.js", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => transaction(fn),
    agentRun: { update: runUpdate },
    attachment: {
      findMany: attachmentFindMany,
      findFirst: attachmentFindFirst,
      create: attachmentCreate,
    },
  },
  TRANSACTION_OPTIONS: { maxWait: 10_000, timeout: 20_000 },
}));

import { admitTurn } from "./admit-turn";

const ids = {
  chatId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
  messageId: "44444444-4444-4444-4444-444444444444",
  clientMessageId: "55555555-5555-5555-5555-555555555555",
};

const user: User = {
  id: ids.userId,
  clerkUserId: "user_abc",
  email: "ada@example.com",
  creditBalance: new Prisma.Decimal("100"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function tx() {
  return {
    chat: { findUnique: chatFindUnique, create: chatCreate, update: chatUpdate },
    message: { findUnique: messageFindUnique, create: messageCreate },
    agentRun: { findFirst: runFindFirst, create: runCreate, count: runCount },
    user: { findUniqueOrThrow: userFindUniqueOrThrow, update: userUpdate },
    creditLedger: { create: ledgerCreate },
    attachment: {
      findMany: attachmentFindMany,
      findFirst: attachmentFindFirst,
      create: attachmentCreate,
    },
  };
}

describe("admitTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CREDIT_RESERVE_TURN = "10";
    process.env.SEND_RATE_LIMIT_PER_MINUTE = "20";
    transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx()));
    chatFindUnique.mockResolvedValue({ id: ids.chatId, userId: ids.userId, deletedAt: null });
    runFindFirst.mockResolvedValue(null);
    runCount.mockResolvedValue(0);
    attachmentFindMany.mockResolvedValue([]);
    attachmentFindFirst.mockResolvedValue(null);
    attachmentCreate.mockImplementation(async ({ data }: { data: { url: string; filename: string; mimeType: string } }) => ({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      filename: data.filename,
      mimeType: data.mimeType,
      url: data.url,
    }));
    userFindUniqueOrThrow.mockResolvedValue({ creditBalance: new Prisma.Decimal("100") });
    messageCreate.mockResolvedValue({ id: ids.messageId });
    runCreate.mockResolvedValue({ id: ids.runId });
    dispatchAgentTurn.mockResolvedValue({ id: "run_trigger" });
    createRunRealtimeToken.mockResolvedValue("pat_live");
    runUpdate.mockResolvedValue({});
    chatUpdate.mockResolvedValue({});
    userUpdate.mockResolvedValue({});
    ledgerCreate.mockResolvedValue({});
  });

  it("rejects an invalid body before writing", async () => {
    await expect(admitTurn({ user, chatId: ids.chatId, body: {} })).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("hides another user's chat", async () => {
    chatFindUnique.mockResolvedValue({
      id: ids.chatId,
      userId: "99999999-9999-9999-9999-999999999999",
      deletedAt: null,
    });
    await expect(
      admitTurn({ user, chatId: ids.chatId, body: { text: "hello" } }),
    ).rejects.toMatchObject({ status: 404, code: "CHAT_NOT_FOUND" });
  });

  it("rejects a second send while a run is active", async () => {
    runFindFirst.mockResolvedValue({ id: ids.runId });
    await expect(
      admitTurn({ user, chatId: ids.chatId, body: { text: "hello" } }),
    ).rejects.toMatchObject({ status: 409, code: "RUN_ACTIVE" });
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("rejects a second send while a run is STOPPING", async () => {
    runFindFirst.mockResolvedValue({ id: ids.runId, status: "STOPPING" });
    await expect(
      admitTurn({ user, chatId: ids.chatId, body: { text: "another" } }),
    ).rejects.toMatchObject({ status: 409, code: "RUN_ACTIVE" });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it("rejects when the send rate limit is exceeded", async () => {
    process.env.SEND_RATE_LIMIT_PER_MINUTE = "2";
    runCount.mockResolvedValue(2);
    await expect(
      admitTurn({ user, chatId: ids.chatId, body: { text: "hello" } }),
    ).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      details: { retryAfter: 60 },
    });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(dispatchAgentTurn).not.toHaveBeenCalled();
  });

  it("does not rate-limit a duplicate clientMessageId replay", async () => {
    process.env.SEND_RATE_LIMIT_PER_MINUTE = "1";
    runCount.mockResolvedValue(8);
    messageFindUnique.mockResolvedValue({
      id: ids.messageId,
      triggeredRun: {
        id: ids.runId,
        traceId: "trace_existing",
        triggerRunId: "run_trigger",
      },
    });
    const result = await admitTurn({
      user,
      chatId: ids.chatId,
      body: { text: "hello", clientMessageId: ids.clientMessageId },
    });
    expect(result.replayed).toBe(true);
    expect(runCount).not.toHaveBeenCalled();
  });

  it("links owned attachments in send order and writes asset blocks", async () => {
    const libraryId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const directId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    attachmentFindMany.mockResolvedValue([
      {
        id: libraryId,
        chatId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        filename: "lib.png",
        mimeType: "image/png",
        url: "https://cdn.example/lib.png",
        status: "COMPLETE",
        expiresAt: null,
      },
      {
        id: directId,
        chatId: ids.chatId,
        filename: "shot.png",
        mimeType: "image/png",
        url: "https://cdn.example/shot.png",
        status: "COMPLETE",
        expiresAt: null,
      },
    ]);
    await admitTurn({
      user,
      chatId: ids.chatId,
      body: { text: "crop this", attachmentIds: [libraryId, directId] },
    });
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          searchText: "crop this",
          contentBlocks: [
            { type: "text", text: "crop this" },
            {
              type: "asset",
              url: "https://cdn.example/lib.png",
              mimeType: "image/png",
              filename: "lib.png",
            },
            {
              type: "asset",
              url: "https://cdn.example/shot.png",
              mimeType: "image/png",
              filename: "shot.png",
            },
          ],
          attachments: {
            create: [
              expect.objectContaining({
                attachmentId: libraryId,
                source: "MEDIA_LIBRARY",
                sortOrder: 0,
              }),
              expect.objectContaining({
                attachmentId: directId,
                source: "DIRECT_UPLOAD",
                sortOrder: 1,
              }),
            ],
          },
        }),
      }),
    );
  });

  it("persists image URLs as asset blocks", async () => {
    await admitTurn({
      user,
      chatId: ids.chatId,
      body: { text: "what is this", image_urls: ["https://cdn.example/photo.jpg"] },
    });
    expect(attachmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          url: "https://cdn.example/photo.jpg",
          mimeType: "image/jpeg",
          origin: "UPLOAD",
        }),
      }),
    );
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contentBlocks: [
            { type: "text", text: "what is this" },
            {
              type: "asset",
              url: "https://cdn.example/photo.jpg",
              mimeType: "image/jpeg",
              filename: "photo.jpg",
            },
          ],
        }),
      }),
    );
  });

  it("maps a closed Prisma transaction to a retryable 503", async () => {
    transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Transaction not found", {
        code: "P2028",
        clientVersion: "6.19.3",
      }),
    );
    await expect(
      admitTurn({ user, chatId: ids.chatId, body: { text: "hello" } }),
    ).rejects.toMatchObject({ status: 503, code: "DATABASE_BUSY" });
  });

  it("rejects when the user cannot cover the reserve", async () => {
    userFindUniqueOrThrow.mockResolvedValue({ creditBalance: new Prisma.Decimal("1") });
    await expect(
      admitTurn({ user, chatId: ids.chatId, body: { text: "hello" } }),
    ).rejects.toMatchObject({ status: 402, code: "CREDITS_INSUFFICIENT" });
  });

  it("persists the user message, reserves credits, and dispatches", async () => {
    const result = await admitTurn({
      user,
      chatId: ids.chatId,
      body: { text: "hello", planMode: true },
    });
    expect(result).toEqual({
      chatId: ids.chatId,
      messageId: ids.messageId,
      runId: ids.runId,
      triggerRunId: "run_trigger",
      realtimeToken: "pat_live",
      replayed: false,
    });
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "USER",
          status: "SUCCESS",
          searchText: "hello",
        }),
      }),
    );
    expect(ledgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "RESERVE",
          amount: new Prisma.Decimal("-10"),
          balanceAfter: new Prisma.Decimal("90"),
          idempotencyKey: `run:${ids.runId}:reserve`,
        }),
      }),
    );
    expect(dispatchAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: ids.chatId,
        messageId: ids.messageId,
        runId: ids.runId,
        planMode: true,
      }),
    );
    expect(createRunRealtimeToken).toHaveBeenCalledWith({
      chatId: ids.chatId,
      runId: ids.runId,
      triggerRunId: "run_trigger",
    });
  });

  it("replays a duplicate clientMessageId without reserving again", async () => {
    messageFindUnique.mockResolvedValue({
      id: ids.messageId,
      triggeredRun: {
        id: ids.runId,
        traceId: "trace_existing",
        triggerRunId: "run_trigger",
      },
    });
    const result = await admitTurn({
      user,
      chatId: ids.chatId,
      body: { text: "hello", clientMessageId: ids.clientMessageId },
    });
    expect(result.replayed).toBe(true);
    expect(messageCreate).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(dispatchAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: ids.messageId, runId: ids.runId }),
    );
  });

  it("creates the chat when it does not exist yet", async () => {
    chatFindUnique.mockResolvedValue(null);
    chatCreate.mockResolvedValue({ id: ids.chatId, userId: ids.userId });
    await admitTurn({ user, chatId: ids.chatId, body: { text: "hello" } });
    expect(chatCreate).toHaveBeenCalledWith({
      data: { id: ids.chatId, userId: ids.userId },
      select: { id: true, userId: true },
    });
  });

  it("returns persisted ids when Trigger dispatch fails", async () => {
    dispatchAgentTurn.mockRejectedValue(new Error("trigger down"));
    createRunRealtimeToken.mockResolvedValue("pat_retry");
    await expect(
      admitTurn({ user, chatId: ids.chatId, body: { text: "hello" } }),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      admitTurn({ user, chatId: ids.chatId, body: { text: "hello" } }),
    ).rejects.toMatchObject({
      status: 503,
      code: "DISPATCH_FAILED",
      details: expect.objectContaining({
        chatId: ids.chatId,
        messageId: ids.messageId,
        runId: ids.runId,
        realtimeToken: "pat_retry",
      }),
    });
  });
});
