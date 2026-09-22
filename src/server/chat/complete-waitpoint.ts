import { z } from "zod";
import { wait } from "@trigger.dev/sdk";
import type { PrismaClient } from "@prisma/client";
import type { WaitpointOverlay } from "@/agent/runtime/realtime";
import { requireOwnedChat } from "@/server/chat/owned";
import { prisma } from "@/server/db";
import { HttpError } from "@/server/http/errors";

export const completeWaitpointBodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
});

export type WaitpointTokenOutput = {
  status: "approved" | "rejected";
  approved: boolean;
};

export type CompleteWaitpointResult = {
  waitpointId: string;
  runId: string;
  chatId: string;
  decision: "approved" | "rejected";
  replayed: boolean;
  overlay: WaitpointOverlay | null;
};

type CompleteToken = (
  tokenId: string,
  output: WaitpointTokenOutput,
) => Promise<{ ok?: boolean } | void>;

export async function completeWaitpoint(input: {
  userId: string;
  chatId: string;
  waitpointId: string;
  body: unknown;
  db?: PrismaClient;
  now?: Date;
  completeToken?: CompleteToken;
}): Promise<CompleteWaitpointResult> {
  const db = input.db ?? prisma;
  const chatId = z.string().uuid().parse(input.chatId);
  const waitpointId = z.string().uuid().parse(input.waitpointId);
  const body = completeWaitpointBodySchema.parse(input.body);
  const now = input.now ?? new Date();
  await requireOwnedChat(input.userId, chatId, db);

  const waitpoint = await db.waitpoint.findUnique({
    where: { id: waitpointId },
  });
  if (!waitpoint || waitpoint.chatId !== chatId || waitpoint.userId !== input.userId) {
    throw new HttpError("Waitpoint was not found", 404, "WAITPOINT_NOT_FOUND");
  }

  const approved = body.decision === "approved";
  const terminalForDecision = approved ? "COMPLETED" : "CANCELLED";

  if (waitpoint.status === "EXPIRED" || waitpoint.timeoutAt <= now) {
    if (waitpoint.status === "WAITING") {
      await db.waitpoint.update({
        where: { id: waitpoint.id },
        data: { status: "EXPIRED", completedAt: now },
      });
    }
    throw new HttpError("This approval expired. Send a new message to continue.", 409, "WAITPOINT_EXPIRED");
  }

  if (waitpoint.status === terminalForDecision) {
    return {
      waitpointId: waitpoint.id,
      runId: waitpoint.agentRunId,
      chatId: waitpoint.chatId,
      decision: body.decision,
      replayed: true,
      overlay: null,
    };
  }

  if (waitpoint.status !== "WAITING") {
    throw new HttpError("This approval is no longer open", 409, "WAITPOINT_CLOSED");
  }

  const output: WaitpointTokenOutput = {
    status: body.decision,
    approved,
  };
  const completeToken = input.completeToken ?? defaultCompleteToken;
  try {
    await completeToken(waitpoint.triggerWaitpointId, output);
  } catch {
    throw new HttpError(
      "The approval could not be submitted. Try again.",
      503,
      "WAITPOINT_COMPLETE_FAILED",
    );
  }

  const updated = await db.waitpoint.updateMany({
    where: { id: waitpoint.id, status: "WAITING" },
    data: {
      status: terminalForDecision,
      result: output,
      completedAt: now,
    },
  });
  if (updated.count === 0) {
    const current = await db.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
    if (current.status === "EXPIRED") {
      throw new HttpError("This approval expired. Send a new message to continue.", 409, "WAITPOINT_EXPIRED");
    }
  }

  return {
    waitpointId: waitpoint.id,
    runId: waitpoint.agentRunId,
    chatId: waitpoint.chatId,
    decision: body.decision,
    replayed: false,
    overlay: null,
  };
}

async function defaultCompleteToken(
  tokenId: string,
  output: WaitpointTokenOutput,
): Promise<void> {
  await wait.completeToken<WaitpointTokenOutput>(tokenId, output);
}
