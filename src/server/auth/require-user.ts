import { Prisma, type User } from "@prisma/client";
import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/server/db";
import { AuthError } from "@/server/auth/errors";
import { initialGrantIdempotencyKey, parseInitialCreditGrant } from "@/server/credits/grant";

export async function requireUser(): Promise<User> {
  const { userId } = await auth();
  if (!userId) {
    throw new AuthError("Unauthorized");
  }

  const existing = await prisma.user.findUnique({
    where: { clerkUserId: userId },
  });
  if (existing) return existing;

  return createUserWithInitialGrant(userId);
}

async function createUserWithInitialGrant(clerkUserId: string): Promise<User> {
  const clerkUser = await currentUser();
  const email = clerkUser?.primaryEmailAddress?.emailAddress;
  if (!email) {
    throw new AuthError("Account is missing an email address", 400);
  }

  const grant = parseInitialCreditGrant(process.env.CREDIT_GRANT_INITIAL);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          clerkUserId,
          email,
          creditBalance: grant,
        },
      });
      await tx.creditLedger.create({
        data: {
          userId: user.id,
          type: "GRANT",
          amount: grant,
          balanceAfter: grant,
          idempotencyKey: initialGrantIdempotencyKey(clerkUserId),
          reason: "Initial credit grant",
        },
      });
      return user;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const user = await prisma.user.findUnique({ where: { clerkUserId } });
      if (user) return user;
    }
    throw error;
  }
}
