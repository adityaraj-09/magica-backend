import type { User } from "@prisma/client";
import { admitTurn, type AdmittedTurn } from "@/server/chat/admit-turn";
import { createChat } from "@/server/chat/chats";
import { publicCompletionBodySchema } from "@/server/public/completions";
import { persistApiUploadFiles, readPublicRequest } from "@/server/uploads/api-upload";

export async function admitPublicSend(input: {
  user: User;
  request: Request;
  chatId?: string;
}): Promise<AdmittedTurn> {
  const { fields, files } = await readPublicRequest(input.request);
  const requestedChatId =
    input.chatId ?? (typeof fields.chatId === "string" ? fields.chatId : undefined);
  let chatId = requestedChatId;
  let uploadedIds: string[] = [];
  if (files.length) {
    const uploaded = await persistApiUploadFiles({
      userId: input.user.id,
      chatId,
      files,
    });
    chatId = uploaded.chatId ?? chatId;
    uploadedIds = uploaded.attachments.filter((row) => row.status === "COMPLETE").map((row) => row.id);
  }
  chatId ??= (await createChat({ userId: input.user.id, body: {} })).id;
  const existingIds = asStringArray(fields.attachmentIds);
  const body = publicCompletionBodySchema.parse({
    ...fields,
    attachmentIds: [...existingIds, ...uploadedIds],
  });
  return admitTurn({ user: input.user, chatId, body });
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value) return [value];
  return [];
}
