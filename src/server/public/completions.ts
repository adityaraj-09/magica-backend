import { z } from "zod";
import { sendMessageBodySchema } from "@/server/chat/admit-turn";
import { sendAttachmentIdsSchema } from "@/server/chat/attachments";

export const publicCompletionBodySchema = z
  .object({
    text: z.string().trim().min(1).max(8192).optional(),
    prompt: z.string().trim().min(1).max(8192).optional(),
    clientMessageId: z.string().uuid().optional(),
    planMode: z.boolean().optional(),
    attachmentIds: sendAttachmentIdsSchema,
    messages: z
      .array(
        z.object({
          role: z.string(),
          content: z.string(),
        }),
      )
      .optional(),
  })
  .transform((body) => {
    const lastUser = [...(body.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user" || message.role === "USER");
    return {
      text: body.text || body.prompt || lastUser?.content || "",
      clientMessageId: body.clientMessageId,
      planMode: body.planMode,
      attachmentIds: body.attachmentIds,
    };
  })
  .pipe(sendMessageBodySchema);
