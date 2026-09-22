import { Prisma, type PrismaClient, type User } from "@prisma/client";
import { z } from "zod";
import { OPENROUTER_FREE_ROUTE } from "@/agent/llm/types";
import { searchTextFromBlocks, type ContentBlock } from "@/agent/runtime/content-blocks";
import { prisma } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { parseSendRateLimit, type SendRateLimit } from "@/server/http/rate-limit";
import { parseTurnReserve, reserveIdempotencyKey } from "@/server/credits/reserve";
import { resolveSendAttachments, sendAttachmentIdsSchema } from "@/server/chat/attachments";
import { dispatchAgentTurn } from "@/server/jobs/dispatch";
import { logInfo, logWarn, traceFields } from "@/server/log";
import { createRunRealtimeToken } from "@/server/realtime/token";

export const sendMessageBodySchema = z.object({
  text: z.string().trim().min(1).max(8192),
  clientMessageId: z.string().uuid().optional(),
  planMode: z.boolean().optional(),
  attachmentIds: sendAttachmentIdsSchema,
});

const chatIdSchema = z.string().uuid();

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

export type AdmittedTurn = {
  chatId: string;
  messageId: string;
  runId: string;
  triggerRunId: string | null;
  realtimeToken: string;
  replayed: boolean;
};

const ACTIVE_RUN = ["QUEUED", "THINKING", "WORKING", "WAITING", "STOPPING"] as const;

export async function admitTurn(input: {
  user: User;
  chatId: string;
  body: unknown;
  db?: PrismaClient;
}): Promise<AdmittedTurn> {
  const chatId = chatIdSchema.parse(input.chatId);
  const body = sendMessageBodySchema.parse(input.body);
  const db = input.db ?? prisma;
  const reserve = parseTurnReserve(process.env.CREDIT_RESERVE_TURN);
  const rateLimit = parseSendRateLimit(process.env);

  const persisted = await db.$transaction((tx) =>
    persistAdmission(tx, {
      user: input.user,
      chatId,
      body,
      reserve,
      rateLimit,
    }),
  );

  let handle: { id: string };
  try {
    handle = await dispatchAgentTurn({
      chatId: persisted.chatId,
      userId: input.user.id,
      runId: persisted.runId,
      messageId: persisted.messageId,
      traceId: persisted.traceId,
      planMode: body.planMode,
    });
  } catch {
    logWarn("turn.dispatch_failed", traceFields({
      chatId: persisted.chatId,
      userId: input.user.id,
      runId: persisted.runId,
      messageId: persisted.messageId,
      traceId: persisted.traceId,
    }));
    const realtimeToken = await createRunRealtimeToken({
      chatId: persisted.chatId,
      runId: persisted.runId,
    });
    throw new HttpError(
      "The turn was saved but could not be started. Retry the same message.",
      503,
      "DISPATCH_FAILED",
      {
        chatId: persisted.chatId,
        messageId: persisted.messageId,
        runId: persisted.runId,
        realtimeToken,
      },
    );
  }

  if (!persisted.triggerRunId || persisted.triggerRunId !== handle.id) {
    await db.agentRun.update({
      where: { id: persisted.runId },
      data: { triggerRunId: handle.id },
    });
  }

  const realtimeToken = await createRunRealtimeToken({
    chatId: persisted.chatId,
    runId: persisted.runId,
    triggerRunId: handle.id,
  });

  logInfo("turn.admitted", {
    ...traceFields({
      chatId: persisted.chatId,
      userId: input.user.id,
      runId: persisted.runId,
      messageId: persisted.messageId,
      traceId: persisted.traceId,
      processId: handle.id,
    }),
    replayed: persisted.replayed,
  });

  return {
    chatId: persisted.chatId,
    messageId: persisted.messageId,
    runId: persisted.runId,
    triggerRunId: handle.id,
    realtimeToken,
    replayed: persisted.replayed,
  };
}

async function persistAdmission(
  tx: Prisma.TransactionClient,
  input: {
    user: User;
    chatId: string;
    body: SendMessageBody;
    reserve: Prisma.Decimal;
    rateLimit: SendRateLimit;
  },
): Promise<{
  chatId: string;
  messageId: string;
  runId: string;
  traceId: string;
  triggerRunId: string | null;
  replayed: boolean;
}> {
  const chat = await loadOrCreateChat(tx, input.user.id, input.chatId);

  if (input.body.clientMessageId) {
    const existing = await tx.message.findUnique({
      where: {
        chatId_clientMessageId: {
          chatId: chat.id,
          clientMessageId: input.body.clientMessageId,
        },
      },
      include: { triggeredRun: true },
    });
    if (existing?.triggeredRun) {
      return {
        chatId: chat.id,
        messageId: existing.id,
        runId: existing.triggeredRun.id,
        traceId: existing.triggeredRun.traceId,
        triggerRunId: existing.triggeredRun.triggerRunId,
        replayed: true,
      };
    }
  }

  const active = await tx.agentRun.findFirst({
    where: { chatId: chat.id, status: { in: [...ACTIVE_RUN] } },
    select: { id: true },
  });
  if (active) {
    throw new HttpError("A turn is already running in this chat", 409, "RUN_ACTIVE");
  }

  const recentSends = await tx.agentRun.count({
    where: {
      userId: input.user.id,
      createdAt: { gte: new Date(Date.now() - input.rateLimit.windowMs) },
    },
  });
  if (recentSends >= input.rateLimit.limit) {
    throw new HttpError(
      "Too many sends. Wait before starting another turn.",
      429,
      "RATE_LIMITED",
      { retryAfter: Math.ceil(input.rateLimit.windowMs / 1000) },
    );
  }

  const user = await tx.user.findUniqueOrThrow({
    where: { id: input.user.id },
    select: { creditBalance: true },
  });
  if (user.creditBalance.lt(input.reserve)) {
    throw new HttpError("Not enough credits to start a turn", 402, "CREDITS_INSUFFICIENT");
  }

  const attached = await resolveSendAttachments({
    userId: input.user.id,
    chatId: chat.id,
    attachmentIds: input.body.attachmentIds,
    db: tx,
  });
  const blocks: ContentBlock[] = [
    { type: "text", text: input.body.text },
    ...attached.map(
      (file): ContentBlock => ({
        type: "asset",
        url: file.url,
        mimeType: file.mimeType,
        filename: file.filename,
      }),
    ),
  ];
  const message = await tx.message.create({
    data: {
      chatId: chat.id,
      userId: input.user.id,
      clientMessageId: input.body.clientMessageId,
      role: "USER",
      status: "SUCCESS",
      contentBlocks: blocks as Prisma.InputJsonValue,
      searchText: searchTextFromBlocks(blocks),
      attachments: attached.length
        ? {
            create: attached.map((file, sortOrder) => ({
              attachmentId: file.id,
              chatId: chat.id,
              source: file.source,
              sortOrder,
            })),
          }
        : undefined,
    },
    select: { id: true },
  });

  const traceId = crypto.randomUUID();
  let run: { id: string };
  try {
    run = await tx.agentRun.create({
      data: {
        chatId: chat.id,
        userId: input.user.id,
        userMessageId: message.id,
        idempotencyKey: message.id,
        status: "QUEUED",
        modelRequested: OPENROUTER_FREE_ROUTE,
        traceId,
        reservedCredits: input.reserve,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueOn(error, "chatId")) {
      throw new HttpError("A turn is already running in this chat", 409, "RUN_ACTIVE");
    }
    throw error;
  }

  const balanceAfter = user.creditBalance.minus(input.reserve);
  await tx.user.update({
    where: { id: input.user.id },
    data: { creditBalance: balanceAfter },
  });
  await tx.creditLedger.create({
    data: {
      userId: input.user.id,
      chatId: chat.id,
      agentRunId: run.id,
      type: "RESERVE",
      amount: input.reserve.negated(),
      balanceAfter,
      idempotencyKey: reserveIdempotencyKey(run.id),
      reason: "Reserve credits for agent turn",
    },
  });
  await tx.chat.update({
    where: { id: chat.id },
    data: {
      lastMessageAt: new Date(),
      lastMessageId: message.id,
    },
  });

  return {
    chatId: chat.id,
    messageId: message.id,
    runId: run.id,
    traceId,
    triggerRunId: null,
    replayed: false,
  };
}

async function loadOrCreateChat(
  tx: Prisma.TransactionClient,
  userId: string,
  chatId: string,
): Promise<{ id: string; userId: string }> {
  const existing = await tx.chat.findUnique({
    where: { id: chatId },
    select: { id: true, userId: true, deletedAt: true },
  });
  if (existing) {
    if (existing.userId !== userId || existing.deletedAt) {
      throw new HttpError("Chat was not found", 404, "CHAT_NOT_FOUND");
    }
    return existing;
  }

  try {
    return await tx.chat.create({
      data: { id: chatId, userId },
      select: { id: true, userId: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await tx.chat.findUnique({
        where: { id: chatId },
        select: { id: true, userId: true, deletedAt: true },
      });
      if (raced && raced.userId === userId && !raced.deletedAt) return raced;
      throw new HttpError("Chat was not found", 404, "CHAT_NOT_FOUND");
    }
    throw error;
  }
}

function isUniqueOn(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const names = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return names.some((name) => name === field || name.toLowerCase().includes(field.toLowerCase()));
}
