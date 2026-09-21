import { Prisma } from "@prisma/client";

export function parseTurnReserve(raw: string | undefined): Prisma.Decimal {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("CREDIT_RESERVE_TURN is required");
  }
  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(raw.trim());
  } catch {
    throw new Error("CREDIT_RESERVE_TURN must be a number");
  }
  if (amount.isNaN()) {
    throw new Error("CREDIT_RESERVE_TURN must be a number");
  }
  if (!amount.isFinite() || amount.lt(0)) {
    throw new Error("CREDIT_RESERVE_TURN must be a finite amount of 0 or more");
  }
  return amount;
}

export function reserveIdempotencyKey(runId: string): string {
  return `run:${runId}:reserve`;
}
