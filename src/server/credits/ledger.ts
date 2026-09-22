import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";
import {
  createdAtIdWhere,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
} from "@/server/http/cursor";

export type LedgerEntryJson = {
  id: string;
  type: string;
  amount: string;
  balanceAfter: string;
  reason: string;
  chatId: string | null;
  agentRunId: string | null;
  toolInvocationId: string | null;
  createdAt: string;
};

export async function listCreditLedger(input: {
  userId: string;
  creditBalance: { toString(): string };
  query: unknown;
  db?: PrismaClient;
}): Promise<{
  creditBalance: string;
  items: LedgerEntryJson[];
  nextCursor: string | null;
}> {
  const query = paginationQuerySchema.parse(input.query);
  const db = input.db ?? prisma;
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

  const rows = await db.creditLedger.findMany({
    where: {
      userId: input.userId,
      ...createdAtIdWhere(cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: {
      id: true,
      type: true,
      amount: true,
      balanceAfter: true,
      reason: true,
      chatId: true,
      agentRunId: true,
      toolInvocationId: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);
  return {
    creditBalance: input.creditBalance.toString(),
    items: items.map((row) => ({
      id: row.id,
      type: row.type,
      amount: row.amount.toString(),
      balanceAfter: row.balanceAfter.toString(),
      reason: row.reason,
      chatId: row.chatId,
      agentRunId: row.agentRunId,
      toolInvocationId: row.toolInvocationId,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
