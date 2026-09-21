import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { parseContentBlocks } from "@/agent/runtime/content-blocks.js";
import {
  overlayFromWaitpoint,
  progressFor,
  runMetadataSchema,
  type RunMetadata,
  type WaitpointOverlay,
} from "@/agent/runtime/realtime.js";
import { prisma } from "@/server/db.js";
import { requireOwnedChat } from "@/server/chat/owned.js";
import { HttpError } from "@/server/http/errors.js";
import { createRunRealtimeToken } from "@/server/realtime/token.js";

const uuid = z.string().uuid();

const ACTIVE = new Set(["QUEUED", "THINKING", "WORKING", "WAITING", "STOPPING"]);

export const runSnapshotResponseSchema = runMetadataSchema.extend({
  triggerRunId: z.string().nullable(),
  assistant: z
    .object({
      id: z.string().uuid(),
      status: z.string(),
      contentBlocks: z.array(z.unknown()),
    })
    .nullable(),
  realtimeToken: z.string().optional(),
});

export type RunSnapshotResponse = z.infer<typeof runSnapshotResponseSchema>;

export async function loadRunSnapshot(input: {
  userId: string;
  chatId: string;
  runId: string;
  db?: PrismaClient;
  now?: Date;
  mintToken?: boolean;
}): Promise<RunSnapshotResponse> {
  const db = input.db ?? prisma;
  const chatId = uuid.parse(input.chatId);
  const runId = uuid.parse(input.runId);
  await requireOwnedChat(input.userId, chatId, db);

  const run = await db.agentRun.findUnique({
    where: { id: runId },
    include: {
      toolInvocations: {
        orderBy: { sequence: "asc" },
        select: {
          toolCallId: true,
          toolName: true,
          status: true,
          errorMessage: true,
        },
      },
      messages: {
        where: { role: "ASSISTANT" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1,
        select: { id: true, status: true, contentBlocks: true },
      },
      waitpoints: {
        where: { status: "WAITING" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!run || run.chatId !== chatId) {
    throw new HttpError("Run was not found", 404, "RUN_NOT_FOUND");
  }

  const now = input.now ?? new Date();
  const waitpoint = await expireOpenWaitpoint(db, run.waitpoints[0], now);
  const assistant = run.messages[0] ?? null;

  const metadata: RunMetadata = {
    chatId: run.chatId,
    runId: run.id,
    messageId: run.userMessageId,
    assistantMessageId: assistant?.id ?? null,
    status: run.status,
    currentStep: run.currentStep,
    thinkingDurationMs: run.thinkingDurationMs,
    progressPercent: progressFor(run.status as RunMetadata["status"]),
    tools: run.toolInvocations.map((tool) => ({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      status: tool.status,
      errorMessage: tool.errorMessage,
    })),
    waitpoint,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
  };

  const realtimeToken =
    input.mintToken !== false && ACTIVE.has(run.status)
      ? await createRunRealtimeToken({
          chatId: run.chatId,
          runId: run.id,
          triggerRunId: run.triggerRunId ?? undefined,
        })
      : undefined;

  return runSnapshotResponseSchema.parse({
    ...metadata,
    triggerRunId: run.triggerRunId,
    assistant: assistant
      ? {
          id: assistant.id,
          status: assistant.status,
          contentBlocks: parseContentBlocks(assistant.contentBlocks),
        }
      : null,
    ...(realtimeToken ? { realtimeToken } : {}),
  });
}

async function expireOpenWaitpoint(
  db: PrismaClient,
  open:
    | {
        id: string;
        type: "OPTIONS" | "PLAN" | "CREDIT" | "MEDIA";
        status: "WAITING" | "COMPLETED" | "EXPIRED" | "CANCELLED";
        triggerWaitpointId: string;
        publicAccessToken: string | null;
        timeoutAt: Date;
        payload: unknown;
      }
    | undefined,
  now: Date,
): Promise<WaitpointOverlay | null> {
  if (!open) return null;
  if (open.timeoutAt > now) return overlayFromWaitpoint(open);
  await db.waitpoint.update({
    where: { id: open.id },
    data: { status: "EXPIRED", completedAt: now },
  });
  return null;
}
