import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { chatSelect, toChatJson, type ChatJson } from "./chats";

export const forkChatBodySchema = z.object({
  messageId: z.string().uuid(),
});

export async function forkChat(input: {
  userId: string;
  chatId: string;
  body: unknown;
  db?: PrismaClient;
}): Promise<ChatJson> {
  const body = forkChatBodySchema.parse(input.body);
  const db = input.db ?? prisma;
  const source = await db.chat.findUnique({
    where: { id: input.chatId },
    select: { id: true, userId: true, deletedAt: true, title: true, projectId: true },
  });
  if (!source || source.userId !== input.userId || source.deletedAt) {
    throw new HttpError("Chat was not found", 404, "CHAT_NOT_FOUND");
  }

  const history = await db.message.findMany({
    where: { chatId: source.id, status: { not: "PENDING" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      attachments: { select: { attachmentId: true, source: true, sortOrder: true } },
    },
  });
  const end = history.findIndex((row) => row.id === body.messageId);
  if (end < 0) {
    throw new HttpError("Message was not found", 404, "MESSAGE_NOT_FOUND");
  }
  const copied = history.slice(0, end + 1);

  return db.$transaction(async (tx) => {
    const chat = await tx.chat.create({
      data: {
        userId: input.userId,
        title: source.title,
        ...(source.projectId ? { projectId: source.projectId } : {}),
      },
      select: chatSelect,
    });

    const idMap = new Map<string, string>();
    for (const row of copied) {
      const created = await tx.message.create({
        data: {
          chatId: chat.id,
          userId: input.userId,
          parentMessageId: row.parentMessageId ? (idMap.get(row.parentMessageId) ?? null) : null,
          role: row.role,
          status: row.status === "STREAMING" ? "SUCCESS" : row.status,
          contentBlocks: row.contentBlocks as Prisma.InputJsonValue,
          searchText: row.searchText,
          errorCode: row.errorCode,
          errorMessage: row.errorMessage,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          createdAt: row.createdAt,
        },
        select: { id: true },
      });
      idMap.set(row.id, created.id);
      if (row.attachments.length) {
        await tx.messageAttachment.createMany({
          data: row.attachments.map((link) => ({
            messageId: created.id,
            attachmentId: link.attachmentId,
            chatId: chat.id,
            source: link.source,
            sortOrder: link.sortOrder,
          })),
        });
      }
    }

    const last = copied.at(-1);
    const lastId = last ? (idMap.get(last.id) ?? null) : null;
    return toChatJson(
      await tx.chat.update({
        where: { id: chat.id },
        data: {
          lastMessageId: lastId,
          lastMessageAt: last?.createdAt ?? new Date(),
        },
        select: chatSelect,
      }),
    );
  });
}
