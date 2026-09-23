import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseContentBlocks } from "@/agent/runtime/content-blocks";
import { prisma } from "@/server/db";
import { requireOwnedChat } from "@/server/chat/owned";
import { requireOwnedProject } from "@/server/chat/projects";
import {
  createdAtIdWhere,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
} from "@/server/http/cursor";

export const createChatBodySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  projectId: z.string().uuid().optional(),
});

export const updateChatBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    isFavorite: z.boolean().optional(),
    projectId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined || body.isFavorite !== undefined || body.projectId !== undefined,
    {
      message: "Provide title, isFavorite, or projectId",
    },
  );

export const listChatsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  favorite: z.enum(["true", "false"]).optional(),
  projectId: z.string().uuid().optional(),
});

const chatSelect = {
  id: true,
  userId: true,
  projectId: true,
  title: true,
  isFavorite: true,
  lastMessageAt: true,
  lastMessageId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ChatJson = {
  id: string;
  projectId: string | null;
  title: string;
  isFavorite: boolean;
  lastMessageAt: string;
  lastMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toChatJson(chat: {
  id: string;
  projectId?: string | null;
  title: string;
  isFavorite: boolean;
  lastMessageAt: Date;
  lastMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ChatJson {
  return {
    id: chat.id,
    projectId: chat.projectId ?? null,
    title: chat.title,
    isFavorite: chat.isFavorite,
    lastMessageAt: chat.lastMessageAt.toISOString(),
    lastMessageId: chat.lastMessageId,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

export async function createChat(input: {
  userId: string;
  body: unknown;
  db?: PrismaClient;
}): Promise<ChatJson> {
  const body = createChatBodySchema.parse(input.body ?? {});
  const db = input.db ?? prisma;
  if (body.projectId) await requireOwnedProject(input.userId, body.projectId, db);
  const chat = await db.chat.create({
    data: {
      userId: input.userId,
      title: body.title ?? "New chat",
      ...(body.projectId ? { projectId: body.projectId } : {}),
    },
    select: chatSelect,
  });
  return toChatJson(chat);
}

export async function listChats(input: {
  userId: string;
  query: unknown;
  db?: PrismaClient;
}): Promise<{ items: ChatJson[]; nextCursor: string | null }> {
  const query = listChatsQuerySchema.parse(input.query);
  const db = input.db ?? prisma;
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const search = query.q;
  const favoriteOnly = query.favorite === "true";

  const rows = await db.chat.findMany({
    where: {
      userId: input.userId,
      deletedAt: null,
      ...(favoriteOnly ? { isFavorite: true } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...createdAtIdWhere(cursor),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" } },
              {
                messages: {
                  some: { searchText: { contains: search, mode: "insensitive" } },
                },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: chatSelect,
  });

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);
  return {
    items: items.map(toChatJson),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function getChat(input: {
  userId: string;
  chatId: string;
  db?: PrismaClient;
}): Promise<ChatJson> {
  const db = input.db ?? prisma;
  await requireOwnedChat(input.userId, input.chatId, db);
  const chat = await db.chat.findUniqueOrThrow({
    where: { id: input.chatId },
    select: chatSelect,
  });
  return toChatJson(chat);
}

export async function updateChat(input: {
  userId: string;
  chatId: string;
  body: unknown;
  db?: PrismaClient;
}): Promise<ChatJson> {
  const body = updateChatBodySchema.parse(input.body);
  const db = input.db ?? prisma;
  await requireOwnedChat(input.userId, input.chatId, db);
  if (body.projectId) await requireOwnedProject(input.userId, body.projectId, db);
  const chat = await db.chat.update({
    where: { id: input.chatId },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.isFavorite !== undefined ? { isFavorite: body.isFavorite } : {}),
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
    },
    select: chatSelect,
  });
  return toChatJson(chat);
}

export async function deleteChat(input: {
  userId: string;
  chatId: string;
  db?: PrismaClient;
}): Promise<void> {
  const db = input.db ?? prisma;
  await requireOwnedChat(input.userId, input.chatId, db);
  await db.chat.update({
    where: { id: input.chatId },
    data: { deletedAt: new Date() },
  });
}

export async function listMessages(input: {
  userId: string;
  chatId: string;
  query: unknown;
  db?: PrismaClient;
}): Promise<{ items: MessageJson[]; nextCursor: string | null }> {
  const query = paginationQuerySchema.parse(input.query);
  const db = input.db ?? prisma;
  await requireOwnedChat(input.userId, input.chatId, db);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

  const rows = await db.message.findMany({
    where: {
      chatId: input.chatId,
      status: { not: "PENDING" },
      ...createdAtIdWhere(cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: {
      agentRun: {
        select: {
          promptTokens: true,
          completionTokens: true,
          settledCredits: true,
          modelRouted: true,
          thinkingDurationMs: true,
        },
      },
      attachments: {
        orderBy: { sortOrder: "asc" },
        select: {
          source: true,
          attachment: {
            select: {
              id: true,
              filename: true,
              mimeType: true,
              byteSize: true,
              url: true,
              thumbnailUrl: true,
              status: true,
              origin: true,
              width: true,
              height: true,
              durationMs: true,
              expiresAt: true,
            },
          },
        },
      },
    },
  });

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);
  return {
    items: items.map(toMessageJson),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export type MessageUsage = {
  promptTokens: number;
  completionTokens: number;
  credits: string;
  model: string | null;
  durationMs: number | null;
};

export type MessageJson = {
  id: string;
  chatId: string;
  role: string;
  status: string;
  contentBlocks: unknown[];
  createdAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  usage?: MessageUsage;
  attachments: Array<{
    id: string;
    source: string;
    filename: string;
    mimeType: string;
    byteSize: number;
    url: string | null;
    thumbnailUrl: string | null;
    status: string;
    origin: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    expiresAt: string | null;
  }>;
};

function toMessageJson(row: {
  id: string;
  chatId: string;
  role: string;
  status: string;
  contentBlocks: Prisma.JsonValue;
  createdAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  promptTokens?: number;
  completionTokens?: number;
  agentRun?: {
    promptTokens: number;
    completionTokens: number;
    settledCredits: { toString(): string };
    modelRouted: string | null;
    thinkingDurationMs: number | null;
  } | null;
  attachments: Array<{
    source: string;
    attachment: {
      id: string;
      filename: string;
      mimeType: string;
      byteSize: number;
      url: string | null;
      thumbnailUrl: string | null;
      status: string;
      origin: string;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      expiresAt: Date | null;
    };
  }>;
}): MessageJson {
  return {
    id: row.id,
    chatId: row.chatId,
    role: row.role,
    status: row.status,
    contentBlocks: parseContentBlocks(row.contentBlocks),
    createdAt: row.createdAt.toISOString(),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    usage: messageUsage(row),
    attachments: row.attachments.map((link) => ({
      id: link.attachment.id,
      source: link.source,
      filename: link.attachment.filename,
      mimeType: link.attachment.mimeType,
      byteSize: link.attachment.byteSize,
      url: link.attachment.url,
      thumbnailUrl: link.attachment.thumbnailUrl,
      status: link.attachment.status,
      origin: link.attachment.origin,
      width: link.attachment.width,
      height: link.attachment.height,
      durationMs: link.attachment.durationMs,
      expiresAt: link.attachment.expiresAt?.toISOString() ?? null,
    })),
  };
}

function messageUsage(row: {
  role: string;
  promptTokens?: number;
  completionTokens?: number;
  agentRun?: {
    promptTokens: number;
    completionTokens: number;
    settledCredits: { toString(): string };
    modelRouted: string | null;
    thinkingDurationMs: number | null;
  } | null;
}): MessageUsage | undefined {
  if (row.role !== "ASSISTANT") return undefined;
  const promptTokens = row.promptTokens || row.agentRun?.promptTokens || 0;
  const completionTokens = row.completionTokens || row.agentRun?.completionTokens || 0;
  return {
    promptTokens,
    completionTokens,
    credits: row.agentRun?.settledCredits.toString() ?? "0",
    model: row.agentRun?.modelRouted ?? null,
    durationMs: row.agentRun?.thinkingDurationMs ?? null,
  };
}

export function queryFromUrl(url: string): Record<string, string> {
  const params = new URL(url).searchParams;
  return Object.fromEntries(params.entries());
}
