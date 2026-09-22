import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeRunCredits, remainingSpendable, settleToolCharge } from "./settle";

const ids = {
  userId: "22222222-2222-2222-2222-222222222222",
  chatId: "11111111-1111-1111-1111-111111111111",
  runId: "33333333-3333-3333-3333-333333333333",
  invocationId: "44444444-4444-4444-4444-444444444444",
  toolCallId: "call_crop",
};

const {
  transaction,
  queryRaw,
  userFind,
  userUpdate,
  runFind,
  runUpdate,
  ledgerFind,
  ledgerCreate,
} = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  userFind: vi.fn(),
  userUpdate: vi.fn(),
  runFind: vi.fn(),
  runUpdate: vi.fn(),
  ledgerFind: vi.fn(),
  ledgerCreate: vi.fn(),
}));

function db() {
  return {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => transaction(fn),
    user: { findUniqueOrThrow: userFind },
    agentRun: { findUniqueOrThrow: runFind },
  };
}

function tx() {
  return {
    $queryRaw: queryRaw,
    user: { findUniqueOrThrow: userFind, update: userUpdate },
    agentRun: { findUniqueOrThrow: runFind, update: runUpdate },
    creditLedger: { findUnique: ledgerFind, create: ledgerCreate },
  };
}

const run = { id: ids.runId, chatId: ids.chatId, userId: ids.userId };

describe("settleToolCharge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx()));
    queryRaw.mockResolvedValue([{ id: ids.userId }]);
    ledgerFind.mockResolvedValue(null);
    ledgerCreate.mockResolvedValue({});
    userUpdate.mockResolvedValue({});
    runUpdate.mockResolvedValue({});
  });

  it("consumes the hold without a second wallet debit", async () => {
    userFind.mockResolvedValue({ creditBalance: new Prisma.Decimal("90") });
    runFind.mockResolvedValue({
      reservedCredits: new Prisma.Decimal("10"),
      settledCredits: new Prisma.Decimal("0"),
    });
    const result = await settleToolCharge(
      {
        run,
        toolCallId: ids.toolCallId,
        toolInvocationId: ids.invocationId,
        toolName: "crop_image",
        cost: "3",
      },
      db() as never,
    );
    expect(result).toMatchObject({ exhausted: false, charged: "0", settledCredits: "3" });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(ledgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "SETTLE",
          amount: new Prisma.Decimal("0"),
          idempotencyKey: "tool:call_crop:settle",
        }),
      }),
    );
  });

  it("debits the wallet for overage and blocks when it cannot cover the rest", async () => {
    userFind.mockResolvedValue({ creditBalance: new Prisma.Decimal("2") });
    runFind.mockResolvedValue({
      reservedCredits: new Prisma.Decimal("10"),
      settledCredits: new Prisma.Decimal("10"),
    });
    const result = await settleToolCharge(
      {
        run,
        toolCallId: ids.toolCallId,
        toolInvocationId: ids.invocationId,
        toolName: "gpt_image_2",
        cost: "8",
      },
      db() as never,
    );
    expect(result.exhausted).toBe(true);
    expect(result.charged).toBe("2");
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { creditBalance: new Prisma.Decimal("0") },
      }),
    );
  });

  it("replays a duplicate toolCallId without charging again", async () => {
    ledgerFind.mockResolvedValue({ amount: new Prisma.Decimal("-4") });
    runFind.mockResolvedValue({ settledCredits: new Prisma.Decimal("4") });
    const result = await settleToolCharge(
      {
        run,
        toolCallId: ids.toolCallId,
        toolInvocationId: ids.invocationId,
        toolName: "crop_image",
        cost: "4",
      },
      db() as never,
    );
    expect(result.replayed).toBe(true);
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("finalizeRunCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx()));
    queryRaw.mockResolvedValue([{ id: ids.userId }]);
    ledgerFind.mockResolvedValue(null);
    ledgerCreate.mockResolvedValue({});
    userUpdate.mockResolvedValue({});
  });

  it("refunds unused reserve once and records OpenRouter at zero", async () => {
    userFind.mockResolvedValue({ creditBalance: new Prisma.Decimal("90") });
    runFind.mockResolvedValue({
      reservedCredits: new Prisma.Decimal("10"),
      settledCredits: new Prisma.Decimal("3"),
    });
    const result = await finalizeRunCredits(
      { run, promptTokens: 11, completionTokens: 4, modelRouted: "deepseek/deepseek-r1:free" },
      db() as never,
    );
    expect(result.refunded).toBe("7");
    expect(ledgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "SETTLE",
          amount: new Prisma.Decimal("0"),
          idempotencyKey: `run:${ids.runId}:finalize`,
        }),
      }),
    );
    expect(ledgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "REFUND",
          amount: new Prisma.Decimal("7"),
          idempotencyKey: `run:${ids.runId}:refund`,
        }),
      }),
    );
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { creditBalance: new Prisma.Decimal("97") },
      }),
    );
  });

  it("replays finalize and refund keys", async () => {
    ledgerFind
      .mockResolvedValueOnce({ amount: new Prisma.Decimal("0") })
      .mockResolvedValueOnce({ amount: new Prisma.Decimal("7") });
    runFind.mockResolvedValue({
      reservedCredits: new Prisma.Decimal("10"),
      settledCredits: new Prisma.Decimal("3"),
    });
    userFind.mockResolvedValue({ creditBalance: new Prisma.Decimal("97") });
    const result = await finalizeRunCredits({ run, promptTokens: 1, completionTokens: 1 }, db() as never);
    expect(result.replayed).toBe(true);
    expect(ledgerCreate).not.toHaveBeenCalled();
  });
});

describe("remainingSpendable", () => {
  it("is unused hold plus wallet", async () => {
    userFind.mockResolvedValue({ creditBalance: new Prisma.Decimal("5") });
    runFind.mockResolvedValue({
      reservedCredits: new Prisma.Decimal("10"),
      settledCredits: new Prisma.Decimal("4"),
    });
    const left = await remainingSpendable(
      { id: ids.runId, userId: ids.userId, reservedCredits: "10" },
      db() as never,
    );
    expect(left.toString()).toBe("11");
  });
});
