import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { listCreditLedger } from "./ledger";
import { encodeCursor } from "@/server/http/cursor";

const ids = {
  userId: "22222222-2222-2222-2222-222222222222",
  newerId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  olderId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
};

describe("listCreditLedger", () => {
  it("returns the current balance and a createdAt/id cursor", async () => {
    const newer = {
      id: ids.newerId,
      type: "RESERVE",
      amount: new Prisma.Decimal("-10"),
      balanceAfter: new Prisma.Decimal("90"),
      reason: "Reserve credits for agent turn",
      chatId: "11111111-1111-1111-1111-111111111111",
      agentRunId: "33333333-3333-3333-3333-333333333333",
      toolInvocationId: null,
      createdAt: new Date("2026-09-21T12:00:00.000Z"),
    };
    const older = {
      ...newer,
      id: ids.olderId,
      type: "GRANT",
      amount: new Prisma.Decimal("100"),
      balanceAfter: new Prisma.Decimal("100"),
      chatId: null,
      agentRunId: null,
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
    };
    const findMany = vi.fn(async () => [newer, older]);
    const result = await listCreditLedger({
      userId: ids.userId,
      creditBalance: new Prisma.Decimal("90"),
      query: { limit: "1" },
      db: { creditLedger: { findMany } } as never,
    });
    expect(result.creditBalance).toBe("90");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: ids.newerId,
      type: "RESERVE",
      amount: "-10",
      balanceAfter: "90",
    });
    expect(result.nextCursor).toBe(encodeCursor(newer.createdAt, newer.id));
  });
});
