import { Prisma } from "@prisma/client";

export function parseInitialCreditGrant(raw: string | undefined): Prisma.Decimal {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("CREDIT_GRANT_INITIAL is required");
  }
  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(raw.trim());
  } catch {
    throw new Error("CREDIT_GRANT_INITIAL must be a number");
  }
  if (amount.isNaN()) {
    throw new Error("CREDIT_GRANT_INITIAL must be a number");
  }
  if (!amount.isFinite() || amount.lt(0)) {
    throw new Error("CREDIT_GRANT_INITIAL must be a finite amount of 0 or more");
  }
  return amount;
}

export function initialGrantIdempotencyKey(clerkUserId: string): string {
  return `clerk:${clerkUserId}:grant:initial`;
}
