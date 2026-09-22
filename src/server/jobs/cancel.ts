import { z } from "zod";
import { runs } from "@trigger.dev/sdk";
import type { PrismaClient } from "@prisma/client";
import { requireOwnedChat } from "@/server/chat/owned";
import { prisma } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { logInfo, logWarn, traceFields } from "@/server/log";

const uuid = z.string().uuid();

const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELLED"]);
const TERMINAL_REMOTE = new Set([
  "CANCELED",
  "CANCELLED",
  "COMPLETED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
  "INTERRUPTED",
]);
const ACTIVE = new Set(["QUEUED", "THINKING", "WORKING", "WAITING", "STOPPING"]);

export type CancelRunResult = {
  chatId: string;
  runId: string;
  status: "STOPPING" | "CANCELLED" | "COMPLETE" | "FAILED";
  replayed: boolean;
};

export async function cancelRun(input: {
  userId: string;
  chatId: string;
  runId: string;
  db?: PrismaClient;
  cancelTrigger?: (triggerRunId: string) => Promise<void>;
  readTriggerStatus?: (triggerRunId: string) => Promise<string | null>;
}): Promise<CancelRunResult> {
  const db = input.db ?? prisma;
  const runId = uuid.parse(input.runId);
  const chatId = await requireOwnedChat(input.userId, input.chatId, db);

  const run = await db.agentRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      chatId: true,
      userMessageId: true,
      traceId: true,
      status: true,
      triggerRunId: true,
      processId: true,
    },
  });
  if (!run || run.chatId !== chatId.id) {
    throw new HttpError("Run was not found", 404, "RUN_NOT_FOUND");
  }

  if (TERMINAL.has(run.status)) {
    logInfo("run.cancel_replay", traceFields({
      chatId: run.chatId,
      runId: run.id,
      messageId: run.userMessageId,
      traceId: run.traceId,
      processId: run.processId ?? run.triggerRunId ?? undefined,
    }));
    return {
      chatId: run.chatId,
      runId: run.id,
      status: run.status as "CANCELLED" | "COMPLETE" | "FAILED",
      replayed: true,
    };
  }

  if (!ACTIVE.has(run.status)) {
    throw new HttpError("Run cannot be cancelled", 409, "RUN_NOT_ACTIVE");
  }

  const nextStatus = run.triggerRunId ? "STOPPING" : "CANCELLED";
  await db.agentRun.update({
    where: { id: run.id },
    data: {
      status: nextStatus,
      currentStep: nextStatus.toLowerCase(),
      ...(nextStatus === "CANCELLED"
        ? { completedAt: new Date(), errorCode: "CANCELLED", errorMessage: "The run was cancelled." }
        : {}),
    },
  });
  await db.waitpoint.updateMany({
    where: { agentRunId: run.id, status: "WAITING" },
    data: { status: "CANCELLED", completedAt: new Date() },
  });

  if (run.triggerRunId) {
    const cancelTrigger = input.cancelTrigger ?? defaultCancelTrigger;
    try {
      await cancelTrigger(run.triggerRunId);
      const remote = await (input.readTriggerStatus ?? defaultTriggerStatus)(run.triggerRunId);
      if (remote && TERMINAL_REMOTE.has(remote)) {
        await db.agentRun.update({
          where: { id: run.id },
          data: {
            status: "CANCELLED",
            currentStep: "cancelled",
            completedAt: new Date(),
            errorCode: "CANCELLED",
            errorMessage: "The run was cancelled.",
          },
        });
        return {
          chatId: run.chatId,
          runId: run.id,
          status: "CANCELLED",
          replayed: false,
        };
      }
    } catch (error) {
      logWarn("run.cancel_trigger_failed", {
        ...traceFields({
          chatId: run.chatId,
          runId: run.id,
          messageId: run.userMessageId,
          traceId: run.traceId,
          processId: run.triggerRunId,
        }),
        error: error instanceof Error ? error.message : "cancel failed",
      });
    }
  }

  logInfo("run.cancelled", traceFields({
    chatId: run.chatId,
    runId: run.id,
    messageId: run.userMessageId,
    traceId: run.traceId,
    processId: run.processId ?? run.triggerRunId ?? undefined,
  }));

  return {
    chatId: run.chatId,
    runId: run.id,
    status: nextStatus,
    replayed: run.status === "STOPPING",
  };
}

async function defaultCancelTrigger(triggerRunId: string): Promise<void> {
  await runs.cancel(triggerRunId);
}

async function defaultTriggerStatus(triggerRunId: string): Promise<string | null> {
  const remote = await runs.retrieve(triggerRunId);
  return typeof remote.status === "string" ? remote.status : null;
}
