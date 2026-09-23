import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/** Interactive transactions need a held connection. Default 5s is too short
 *  on Supabase pooler (library attach does extra queries, then P2028 on the
 *  next write). */
const TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 20_000,
} as const;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    transactionOptions: TRANSACTION_OPTIONS,
  });

export { TRANSACTION_OPTIONS };

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
