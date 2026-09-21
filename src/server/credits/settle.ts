import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db.js";
import {
  runFinalizeIdempotencyKey,
  runRefundIdempotencyKey,
  toolSettleIdempotencyKey,
} from "./keys.js";

export class CreditsError extends Error {
  readonly code = "CREDITS_INSUFFICIENT" as const;

  constructor(message = "Not enough credits to continue this turn") {
    super(message);
    this.name = "CreditsError";
  }
}

export type SettleToolResult = {
  replayed: boolean;
  exhausted: boolean;
  charged: string;
  settledCredits: string;
};

export type FinalizeRunResult = {
  replayed: boolean;
  refunded: string;
  settledCredits: string;
};

export type CreditGateway = {
  spendable(run: { id: string; userId: string; reservedCredits: string }): Promise<Prisma.Decimal>;
  settleTool(input: {
    run: { id: string; chatId: string; userId: string };
    toolCallId: string;
    toolInvocationId: string;
    toolName: string;
    cost: string;
  }): Promise<SettleToolResult>;
  finalizeRun(input: {
    run: { id: string; chatId: string; userId: string };
    promptTokens: number;
    completionTokens: number;
    modelRouted?: string;
  }): Promise<FinalizeRunResult>;
};

export const noopCredits: CreditGateway = {
  async spendable() {
    return new Prisma.Decimal("1000000");
  },
  async settleTool() {
    return { replayed: false, exhausted: false, charged: "0", settledCredits: "0" };
  },
  async finalizeRun() {
    return { replayed: false, refunded: "0", settledCredits: "0" };
  },
};

export function createCreditGateway(db: PrismaClient = prisma): CreditGateway {
  return {
    spendable: (run) => remainingSpendable(run, db),
    settleTool: (input) => settleToolCharge(input, db),
    finalizeRun: (input) => finalizeRunCredits(input, db),
  };
}

export async function remainingSpendable(
  run: { id: string; userId: string; reservedCredits: string },
  db: PrismaClient = prisma,
): Promise<Prisma.Decimal> {
  const [user, agentRun] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: run.userId },
      select: { creditBalance: true },
    }),
    db.agentRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { reservedCredits: true, settledCredits: true },
    }),
  ]);
  const holdLeft = holdRemaining(agentRun.reservedCredits, agentRun.settledCredits);
  return holdLeft.plus(user.creditBalance);
}

export async function settleToolCharge(
  input: {
    run: { id: string; chatId: string; userId: string };
    toolCallId: string;
    toolInvocationId: string;
    toolName: string;
    cost: string;
  },
  db: PrismaClient = prisma,
): Promise<SettleToolResult> {
  const cost = parseCredit(input.cost);
  const key = toolSettleIdempotencyKey(input.toolCallId);

  return db.$transaction(async (tx) => {
    await lockUserAndRun(tx, input.run.userId, input.run.id);
    const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: key } });
    if (existing) {
      const agentRun = await tx.agentRun.findUniqueOrThrow({
        where: { id: input.run.id },
        select: { settledCredits: true },
      });
      return {
        replayed: true,
        exhausted: false,
        charged: existing.amount.abs().toString(),
        settledCredits: agentRun.settledCredits.toString(),
      };
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.run.userId },
      select: { creditBalance: true },
    });
    const agentRun = await tx.agentRun.findUniqueOrThrow({
      where: { id: input.run.id },
      select: { reservedCredits: true, settledCredits: true },
    });

    const fromHold = Prisma.Decimal.min(
      cost,
      holdRemaining(agentRun.reservedCredits, agentRun.settledCredits),
    );
    const cashNeeded = cost.minus(fromHold);
    let charged = new Prisma.Decimal(0);
    let exhausted = false;

    if (cashNeeded.gt(0)) {
      if (user.creditBalance.lt(cashNeeded)) {
        charged = user.creditBalance;
        exhausted = true;
      } else {
        charged = cashNeeded;
      }
    }

    const amount = charged.isZero() ? new Prisma.Decimal(0) : charged.negated();
    const balanceAfter = user.creditBalance.plus(amount);
    const settledCredits = agentRun.settledCredits.plus(cost);

    await appendLedger(tx, {
      userId: input.run.userId,
      chatId: input.run.chatId,
      agentRunId: input.run.id,
      toolInvocationId: input.toolInvocationId,
      type: "SETTLE",
      amount,
      balanceAfter,
      idempotencyKey: key,
      reason: `Settle ${input.toolName} (${cost.toString()} credits)`,
    });
    if (!amount.isZero()) {
      await tx.user.update({
        where: { id: input.run.userId },
        data: { creditBalance: balanceAfter },
      });
    }
    await tx.agentRun.update({
      where: { id: input.run.id },
      data: { settledCredits },
    });

    return {
      replayed: false,
      exhausted,
      charged: charged.toString(),
      settledCredits: settledCredits.toString(),
    };
  });
}

export async function finalizeRunCredits(
  input: {
    run: { id: string; chatId: string; userId: string };
    promptTokens: number;
    completionTokens: number;
    modelRouted?: string;
  },
  db: PrismaClient = prisma,
): Promise<FinalizeRunResult> {
  const finalizeKey = runFinalizeIdempotencyKey(input.run.id);
  const refundKey = runRefundIdempotencyKey(input.run.id);

  return db.$transaction(async (tx) => {
    await lockUserAndRun(tx, input.run.userId, input.run.id);

    const agentRun = await tx.agentRun.findUniqueOrThrow({
      where: { id: input.run.id },
      select: { reservedCredits: true, settledCredits: true },
    });
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.run.userId },
      select: { creditBalance: true },
    });

    const existingFinalize = await tx.creditLedger.findUnique({
      where: { idempotencyKey: finalizeKey },
    });
    const existingRefund = await tx.creditLedger.findUnique({
      where: { idempotencyKey: refundKey },
    });
    if (existingFinalize && existingRefund) {
      return {
        replayed: true,
        refunded: existingRefund.amount.toString(),
        settledCredits: agentRun.settledCredits.toString(),
      };
    }

    let balance = user.creditBalance;
    if (!existingFinalize) {
      await appendLedger(tx, {
        userId: input.run.userId,
        chatId: input.run.chatId,
        agentRunId: input.run.id,
        type: "SETTLE",
        amount: new Prisma.Decimal(0),
        balanceAfter: balance,
        idempotencyKey: finalizeKey,
        reason: openRouterReason(input),
      });
    }

    const refund = holdRemaining(agentRun.reservedCredits, agentRun.settledCredits);
    if (!existingRefund) {
      balance = balance.plus(refund);
      await appendLedger(tx, {
        userId: input.run.userId,
        chatId: input.run.chatId,
        agentRunId: input.run.id,
        type: "REFUND",
        amount: refund,
        balanceAfter: balance,
        idempotencyKey: refundKey,
        reason: refund.isZero()
          ? "No unused reserve to refund"
          : `Refund unused reserve (${refund.toString()} credits)`,
      });
      if (!refund.isZero()) {
        await tx.user.update({
          where: { id: input.run.userId },
          data: { creditBalance: balance },
        });
      }
    }

    return {
      replayed: false,
      refunded: refund.toString(),
      settledCredits: agentRun.settledCredits.toString(),
    };
  });
}

function holdRemaining(reserved: Prisma.Decimal, settled: Prisma.Decimal): Prisma.Decimal {
  const left = reserved.minus(settled);
  return left.isNegative() ? new Prisma.Decimal(0) : left;
}

function parseCredit(raw: string): Prisma.Decimal {
  try {
    const amount = new Prisma.Decimal(raw);
    if (amount.isNaN() || !amount.isFinite() || amount.lt(0)) {
      return new Prisma.Decimal(0);
    }
    return amount;
  } catch {
    return new Prisma.Decimal(0);
  }
}

function openRouterReason(input: {
  promptTokens: number;
  completionTokens: number;
  modelRouted?: string;
}): string {
  const model = input.modelRouted ?? "openrouter/free";
  return `OpenRouter ${model} at 0 application credits (${input.promptTokens} prompt / ${input.completionTokens} completion tokens)`;
}

async function lockUserAndRun(
  tx: Prisma.TransactionClient,
  userId: string,
  runId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${runId}::uuid FOR UPDATE`;
}

async function appendLedger(
  tx: Prisma.TransactionClient,
  data: {
    userId: string;
    chatId?: string;
    agentRunId?: string;
    toolInvocationId?: string;
    type: "SETTLE" | "REFUND";
    amount: Prisma.Decimal;
    balanceAfter: Prisma.Decimal;
    idempotencyKey: string;
    reason: string;
  },
): Promise<void> {
  try {
    await tx.creditLedger.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return;
    }
    throw error;
  }
}
