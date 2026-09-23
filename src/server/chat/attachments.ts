import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import {
  createdAtIdWhere,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
} from "@/server/http/cursor";
import { MAX_FILES_PER_ASSEMBLY } from "@/server/uploads/transloadit";

export const sendAttachmentIdsSchema = z
  .array(z.string().uuid())
  .max(MAX_FILES_PER_ASSEMBLY)
  .optional()
  .default([]);

export type ResolvedSendAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
  source: "DIRECT_UPLOAD" | "MEDIA_LIBRARY";
};

export async function resolveSendAttachments(input: {
  userId: string;
  chatId: string;
  attachmentIds: string[];
  db: Prisma.TransactionClient | PrismaClient;
  now?: Date;
}): Promise<ResolvedSendAttachment[]> {
  const ids = [...new Set(input.attachmentIds)];
  if (ids.length === 0) return [];

  const rows = await input.db.attachment.findMany({
    where: { id: { in: ids }, userId: input.userId },
    select: {
      id: true,
      chatId: true,
      filename: true,
      mimeType: true,
      url: true,
      status: true,
      expiresAt: true,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const now = input.now ?? new Date();

  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new HttpError("Attachment was not found", 404, "ATTACHMENT_NOT_FOUND");
    }
    if (row.status !== "COMPLETE" || !row.url) {
      throw new HttpError("Attachment is not ready to send", 409, "ATTACHMENT_NOT_READY");
    }
    if (row.expiresAt && row.expiresAt <= now) {
      throw new HttpError("Attachment has expired", 409, "ATTACHMENT_EXPIRED");
    }
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      url: row.url,
      source: row.chatId === input.chatId ? "DIRECT_UPLOAD" : "MEDIA_LIBRARY",
    };
  });
}

export type LibraryAttachmentJson = {
  id: string;
  chatId: string | null;
  origin: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  url: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: string;
  expiresAt: string | null;
};

const libraryQuerySchema = paginationQuerySchema.extend({
  chatId: z.string().uuid().optional(),
});

export async function listLibraryAttachments(input: {
  userId: string;
  query: unknown;
  db?: PrismaClient;
  now?: Date;
}): Promise<{ items: LibraryAttachmentJson[]; nextCursor: string | null }> {
  const query = libraryQuerySchema.parse(input.query);
  const db = input.db ?? prisma;
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const now = input.now ?? new Date();

  const rows = await db.attachment.findMany({
    where: {
      userId: input.userId,
      status: "COMPLETE",
      url: { not: null },
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        createdAtIdWhere(cursor) ?? {},
        query.chatId
          ? {
              OR: [
                { chatId: query.chatId },
                { messages: { some: { chatId: query.chatId } } },
              ],
            }
          : {},
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: {
      id: true,
      chatId: true,
      origin: true,
      filename: true,
      mimeType: true,
      byteSize: true,
      url: true,
      thumbnailUrl: true,
      width: true,
      height: true,
      durationMs: true,
      createdAt: true,
      expiresAt: true,
    },
  });

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);
  return {
    items: items.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      origin: row.origin,
      filename: row.filename,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      url: row.url,
      thumbnailUrl: row.thumbnailUrl,
      width: row.width,
      height: row.height,
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function findAttachmentByUrl(input: {
  userId: string;
  url: string;
  db?: PrismaClient;
}): Promise<{ id: string; filename: string; mimeType: string; url: string }> {
  const db = input.db ?? prisma;
  const row = await db.attachment.findFirst({
    where: { userId: input.userId, url: input.url, status: "COMPLETE" },
    orderBy: { createdAt: "desc" },
    select: { id: true, filename: true, mimeType: true, url: true },
  });
  if (!row?.url) {
    throw new HttpError("Image was not found", 404, "ATTACHMENT_NOT_FOUND");
  }
  return { id: row.id, filename: row.filename, mimeType: row.mimeType, url: row.url };
}
