import { Prisma, type PrismaClient } from "@prisma/client";
import type { GeneratedAsset } from "@/agent/tools/types";
import {
  parseContentBlocks,
  searchTextFromBlocks,
  type ContentBlock,
} from "./content-blocks";
import type { HistoryMessage } from "./history";
import { overlayFromWaitpoint, type WaitpointOverlay } from "./realtime";

export type RunSnapshot = {
  id: string;
  chatId: string;
  userId: string;
  userMessageId: string;
  status: string;
  triggerRunId: string | null;
  reservedCredits: string;
  settledCredits: string;
};

export type ToolInvocationSnapshot = {
  id: string;
  toolCallId: string;
  toolName: string;
  status: string;
  input: unknown;
  output: unknown;
  creditCost: string;
  errorMessage: string | null;
};

export type WaitpointSnapshot = {
  id: string;
  type: "OPTIONS" | "PLAN" | "CREDIT" | "MEDIA";
  status: "WAITING" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  triggerWaitpointId: string;
  publicAccessToken: string | null;
  timeoutAt: Date;
  payload: unknown;
  result: unknown;
};

export class AgentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getRun(runId: string): Promise<RunSnapshot | null> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        chatId: true,
        userId: true,
        userMessageId: true,
        status: true,
        triggerRunId: true,
        reservedCredits: true,
        settledCredits: true,
        chat: { select: { deletedAt: true } },
      },
    });
    if (!run || run.chat.deletedAt) return null;
    return {
      id: run.id,
      chatId: run.chatId,
      userId: run.userId,
      userMessageId: run.userMessageId,
      status: run.status,
      triggerRunId: run.triggerRunId,
      reservedCredits: run.reservedCredits.toString(),
      settledCredits: run.settledCredits.toString(),
    };
  }

  async spentCredits(runId: string): Promise<Prisma.Decimal> {
    const agg = await this.prisma.toolInvocation.aggregate({
      where: { agentRunId: runId, status: "SUCCESS" },
      _sum: { creditCost: true },
    });
    return agg._sum.creditCost ?? new Prisma.Decimal(0);
  }

  async listHistory(chatId: string): Promise<HistoryMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        chatId,
        role: { in: ["USER", "ASSISTANT", "SYSTEM"] },
        status: { not: "PENDING" },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      select: {
        role: true,
        status: true,
        contentBlocks: true,
        searchText: true,
        attachments: {
          orderBy: { sortOrder: "asc" },
          select: {
            attachment: { select: { url: true, mimeType: true, filename: true } },
          },
        },
      },
    });
    return rows.reverse().map((row) => ({
      role: row.role,
      status: row.status,
      contentBlocks: row.contentBlocks,
      searchText: row.searchText,
      attachments: row.attachments
        .map((link) =>
          link.attachment.url
            ? {
                url: link.attachment.url,
                mimeType: link.attachment.mimeType,
                filename: link.attachment.filename,
              }
            : null,
        )
        .filter((file): file is { url: string; mimeType: string; filename: string } => file !== null),
    }));
  }

  async ensureAssistantMessage(run: RunSnapshot): Promise<{ id: string; blocks: ContentBlock[] }> {
    const existing = await this.prisma.message.findFirst({
      where: { agentRunId: run.id, role: "ASSISTANT" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, contentBlocks: true },
    });
    if (existing) {
      return { id: existing.id, blocks: parseContentBlocks(existing.contentBlocks) };
    }
    const created = await this.prisma.message.create({
      data: {
        chatId: run.chatId,
        userId: run.userId,
        agentRunId: run.id,
        parentMessageId: run.userMessageId,
        role: "ASSISTANT",
        status: "STREAMING",
        contentBlocks: [],
      },
      select: { id: true },
    });
    return { id: created.id, blocks: [] };
  }

  async saveAssistant(input: {
    messageId: string;
    blocks: ContentBlock[];
    status: "STREAMING" | "SUCCESS" | "FAILED" | "CANCELLED";
    promptTokens: number;
    completionTokens: number;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    await this.prisma.message.update({
      where: { id: input.messageId },
      data: {
        contentBlocks: input.blocks as Prisma.InputJsonValue,
        searchText: searchTextFromBlocks(input.blocks),
        status: input.status,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      },
    });
  }

  async getToolInvocation(
    runId: string,
    toolCallId: string,
  ): Promise<ToolInvocationSnapshot | null> {
    const row = await this.prisma.toolInvocation.findUnique({
      where: { agentRunId_toolCallId: { agentRunId: runId, toolCallId } },
    });
    if (!row) return null;
    return {
      id: row.id,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      status: row.status,
      input: row.input,
      output: row.output,
      creditCost: row.creditCost.toString(),
      errorMessage: row.errorMessage,
    };
  }

  async findSuccessfulToolByInput(
    runId: string,
    toolName: string,
    input: unknown,
  ): Promise<ToolInvocationSnapshot | null> {
    const rows = await this.prisma.toolInvocation.findMany({
      where: { agentRunId: runId, toolName, status: "SUCCESS" },
    });
    const key = stableJson(input);
    const row = rows.find((item) => stableJson(item.input) === key);
    if (!row) return null;
    return {
      id: row.id,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      status: row.status,
      input: row.input,
      output: row.output,
      creditCost: row.creditCost.toString(),
      errorMessage: row.errorMessage,
    };
  }

  async nextToolSequence(runId: string): Promise<number> {
    const last = await this.prisma.toolInvocation.aggregate({
      where: { agentRunId: runId },
      _max: { sequence: true },
    });
    return (last._max.sequence ?? 0) + 1;
  }

  async upsertToolInvocation(input: {
    run: RunSnapshot;
    toolCallId: string;
    toolName: string;
    provider: "MAGICA" | "E2B" | "EXA" | "SKILL" | "INTERNAL";
    sequence: number;
    status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
    payload: unknown;
    output?: unknown;
    providerRunId?: string;
    durationMs?: number;
    creditCost?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<{ id: string }> {
    const row = await this.prisma.toolInvocation.upsert({
      where: {
        agentRunId_toolCallId: {
          agentRunId: input.run.id,
          toolCallId: input.toolCallId,
        },
      },
      create: {
        agentRunId: input.run.id,
        chatId: input.run.chatId,
        userId: input.run.userId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        provider: input.provider,
        sequence: input.sequence,
        status: input.status,
        input: (input.payload ?? {}) as Prisma.InputJsonValue,
        output: (input.output ?? undefined) as Prisma.InputJsonValue | undefined,
        providerRunId: input.providerRunId,
        durationMs: input.durationMs,
        creditCost: new Prisma.Decimal(input.creditCost ?? "0"),
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        startedAt: input.status === "PENDING" ? undefined : new Date(),
        completedAt:
          input.status === "SUCCESS" || input.status === "FAILED" || input.status === "CANCELLED"
            ? new Date()
            : undefined,
      },
      update: {
        status: input.status,
        output: (input.output ?? undefined) as Prisma.InputJsonValue | undefined,
        providerRunId: input.providerRunId,
        durationMs: input.durationMs,
        creditCost: input.creditCost ? new Prisma.Decimal(input.creditCost) : undefined,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        startedAt: input.status === "RUNNING" ? new Date() : undefined,
        completedAt:
          input.status === "SUCCESS" || input.status === "FAILED" || input.status === "CANCELLED"
            ? new Date()
            : undefined,
      },
      select: { id: true },
    });
    return row;
  }

  async saveRunSkill(input: {
    runId: string;
    skillName: string;
    contentHash: string;
    assetPath: string;
  }): Promise<void> {
    try {
      await this.prisma.runSkill.create({
        data: {
          agentRunId: input.runId,
          skillName: input.skillName,
          contentHash: input.contentHash,
          assetPath: input.assetPath,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return;
      }
      throw error;
    }
  }

  async saveGeneratedAssets(input: {
    run: RunSnapshot;
    toolInvocationId: string;
    assets: GeneratedAsset[];
  }): Promise<void> {
    const ephemeralExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    for (const asset of input.assets) {
      await this.prisma.attachment.create({
        data: {
          userId: input.run.userId,
          chatId: input.run.chatId,
          toolInvocationId: input.toolInvocationId,
          origin: "GENERATED",
          status: "COMPLETE",
          filename: asset.filename ?? asset.url.split("/").pop() ?? "generated",
          mimeType: asset.mimeType,
          byteSize: asset.byteSize ?? 0,
          storageKey: asset.storageKey,
          url: asset.url,
          width: asset.width,
          height: asset.height,
          expiresAt: asset.storageKey ? null : ephemeralExpiresAt,
        },
      });
    }
  }

  async saveWaitpoint(input: {
    run: { id: string; chatId: string; userId: string };
    type: "OPTIONS" | "PLAN" | "CREDIT" | "MEDIA";
    triggerWaitpointId: string;
    publicAccessToken?: string;
    idempotencyKey: string;
    payload: unknown;
    timeoutAt: Date;
  }): Promise<WaitpointOverlay> {
    const row = await this.prisma.waitpoint.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        agentRunId: input.run.id,
        chatId: input.run.chatId,
        userId: input.run.userId,
        type: input.type,
        status: "WAITING",
        triggerWaitpointId: input.triggerWaitpointId,
        publicAccessToken: input.publicAccessToken,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload as Prisma.InputJsonValue,
        timeoutAt: input.timeoutAt,
      },
      update: {
        triggerWaitpointId: input.triggerWaitpointId,
        publicAccessToken: input.publicAccessToken,
        payload: input.payload as Prisma.InputJsonValue,
        timeoutAt: input.timeoutAt,
        status: "WAITING",
        completedAt: null,
        result: Prisma.JsonNull,
      },
    });
    return overlayFromWaitpoint(row);
  }

  async finishWaitpoint(input: {
    idempotencyKey: string;
    status: "COMPLETED" | "EXPIRED" | "CANCELLED";
    result?: unknown;
  }): Promise<void> {
    await this.prisma.waitpoint.updateMany({
      where: { idempotencyKey: input.idempotencyKey, status: "WAITING" },
      data: {
        status: input.status,
        result: (input.result ?? undefined) as Prisma.InputJsonValue | undefined,
        completedAt: new Date(),
      },
    });
  }

  async getWaitpoint(idempotencyKey: string): Promise<WaitpointSnapshot | null> {
    const row = await this.prisma.waitpoint.findUnique({
      where: { idempotencyKey },
    });
    return row ? toWaitpointSnapshot(row) : null;
  }

  async expireTimedOutWaitpoint(
    runId: string,
    now = new Date(),
  ): Promise<WaitpointSnapshot | null> {
    const open = await this.prisma.waitpoint.findFirst({
      where: { agentRunId: runId, status: "WAITING" },
    });
    if (!open) return null;
    if (open.timeoutAt > now) return toWaitpointSnapshot(open);
    const expired = await this.prisma.waitpoint.update({
      where: { id: open.id },
      data: { status: "EXPIRED", completedAt: now },
    });
    return toWaitpointSnapshot(expired);
  }

  async getChatTitle(chatId: string): Promise<string | null> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { title: true },
    });
    return chat?.title ?? null;
  }

  async renameChat(chatId: string, title: string): Promise<void> {
    await this.prisma.chat.update({
      where: { id: chatId },
      data: { title },
    });
  }

  async updateRun(input: {
    runId: string;
    chatId: string;
    assistantMessageId?: string;
    status: "QUEUED" | "THINKING" | "WORKING" | "WAITING" | "STOPPING" | "COMPLETE" | "FAILED" | "CANCELLED";
    triggerRunId?: string;
    processId?: string;
    currentStep?: string | null;
    modelRouted?: string;
    promptTokens?: number;
    completionTokens?: number;
    thinkingStartedAt?: Date | null;
    thinkingDurationMs?: number;
    settledCredits?: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAt?: Date;
    completedAt?: Date | null;
  }): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.agentRun.update({
        where: { id: input.runId },
        data: {
          status: input.status,
          triggerRunId: input.triggerRunId,
          processId: input.processId,
          currentStep: input.currentStep,
          modelRouted: input.modelRouted,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          thinkingStartedAt: input.thinkingStartedAt,
          thinkingDurationMs: input.thinkingDurationMs,
          settledCredits: input.settledCredits
            ? new Prisma.Decimal(input.settledCredits)
            : undefined,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
        },
      }),
      ...(input.assistantMessageId &&
      (input.status === "COMPLETE" || input.status === "FAILED" || input.status === "CANCELLED")
        ? [
            this.prisma.chat.update({
              where: { id: input.chatId },
              data: {
                lastMessageAt: new Date(),
                lastMessageId: input.assistantMessageId,
              },
            }),
          ]
        : []),
    ]);
  }
}

export function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function toWaitpointSnapshot(row: {
  id: string;
  type: "OPTIONS" | "PLAN" | "CREDIT" | "MEDIA";
  status: "WAITING" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  triggerWaitpointId: string;
  publicAccessToken: string | null;
  timeoutAt: Date;
  payload: unknown;
  result: unknown;
}): WaitpointSnapshot {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    triggerWaitpointId: row.triggerWaitpointId,
    publicAccessToken: row.publicAccessToken,
    timeoutAt: row.timeoutAt,
    payload: row.payload,
    result: row.result,
  };
}
