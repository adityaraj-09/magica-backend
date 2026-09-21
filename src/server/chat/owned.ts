import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db.js";
import { HttpError } from "@/server/http/errors.js";

const uuid = z.string().uuid();

export async function requireOwnedChat(
  userId: string,
  chatId: string,
  db: PrismaClient = prisma,
): Promise<{ id: string; userId: string }> {
  const id = uuid.parse(chatId);
  const chat = await db.chat.findUnique({
    where: { id },
    select: { id: true, userId: true, deletedAt: true },
  });
  if (!chat || chat.userId !== userId || chat.deletedAt) {
    throw new HttpError("Chat was not found", 404, "CHAT_NOT_FOUND");
  }
  return chat;
}
