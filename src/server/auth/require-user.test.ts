import { Prisma, type User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "./errors";

const { auth, currentUser, findUnique, createUser, createLedger, transaction } = vi.hoisted(() => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  findUnique: vi.fn(),
  createUser: vi.fn(),
  createLedger: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => auth(),
  currentUser: () => currentUser(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    user: { findUnique },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => transaction(fn),
  },
}));

import { requireUser } from "./require-user";

const user: User = {
  id: "11111111-1111-1111-1111-111111111111",
  clerkUserId: "user_abc",
  email: "ada@example.com",
  creditBalance: new Prisma.Decimal("100"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("requireUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CREDIT_GRANT_INITIAL = "100";
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { create: createUser },
        creditLedger: { create: createLedger },
      }),
    );
  });

  it("rejects unauthenticated requests", async () => {
    auth.mockResolvedValue({ userId: null });
    await expect(requireUser()).rejects.toBeInstanceOf(AuthError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns an existing user without writing a grant", async () => {
    auth.mockResolvedValue({ userId: "user_abc" });
    findUnique.mockResolvedValue(user);

    await expect(requireUser()).resolves.toEqual(user);
    expect(currentUser).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("creates the user and opening GRANT on first request", async () => {
    auth.mockResolvedValue({ userId: "user_abc" });
    findUnique.mockResolvedValue(null);
    currentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "ada@example.com" },
    });
    createUser.mockResolvedValue(user);
    createLedger.mockResolvedValue({});

    await expect(requireUser()).resolves.toEqual(user);
    expect(createUser).toHaveBeenCalledWith({
      data: {
        clerkUserId: "user_abc",
        email: "ada@example.com",
        creditBalance: new Prisma.Decimal("100"),
      },
    });
    expect(createLedger).toHaveBeenCalledWith({
      data: {
        userId: user.id,
        type: "GRANT",
        amount: new Prisma.Decimal("100"),
        balanceAfter: new Prisma.Decimal("100"),
        idempotencyKey: "clerk:user_abc:grant:initial",
        reason: "Initial credit grant",
      },
    });
  });

  it("returns the winner when a concurrent first request hits P2002", async () => {
    auth.mockResolvedValue({ userId: "user_abc" });
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(user);
    currentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "ada@example.com" },
    });
    transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );

    await expect(requireUser()).resolves.toEqual(user);
  });
});
