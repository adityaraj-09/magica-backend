import { z } from "zod";
import { sendMessageBodySchema } from "@/server/chat/admit-turn";
import { collectSendImageUrls, sendAttachmentIdsSchema } from "@/server/chat/attachments";

const imageUrlPartSchema = z.union([z.string(), z.object({ url: z.string() })]);

const messagePartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  image_url: imageUrlPartSchema.optional(),
  imageUrl: imageUrlPartSchema.optional(),
});

const messageContentSchema = z.union([z.string(), z.array(messagePartSchema)]);

const completionMessageSchema = z.object({
  role: z.string(),
  content: messageContentSchema,
});

export const publicCompletionBodySchema = z
  .object({
    text: z.string().trim().min(1).max(8192).optional(),
    prompt: z.string().trim().min(1).max(8192).optional(),
    clientMessageId: z.string().uuid().optional(),
    planMode: z.boolean().optional(),
    attachmentIds: sendAttachmentIdsSchema,
    imageUrls: z.array(z.string()).optional(),
    image_urls: z.array(z.string()).optional(),
    imageUrl: z.string().optional(),
    image_url: z.string().optional(),
    messages: z.array(completionMessageSchema).optional(),
  })
  .transform((body) => {
    const lastUser = [...(body.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user" || message.role === "USER");
    const record = body as Record<string, unknown>;
    return {
      text: body.text || body.prompt || textFromContent(lastUser?.content) || "",
      clientMessageId: body.clientMessageId,
      planMode: body.planMode,
      attachmentIds: body.attachmentIds,
      imageUrls: [...collectSendImageUrls(record), ...imagesFromContent(lastUser?.content)],
    };
  })
  .pipe(sendMessageBodySchema);

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function imagesFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const urls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const raw = part.image_url ?? part.imageUrl;
    if (typeof raw === "string") urls.push(raw);
    else if (raw && typeof raw === "object" && typeof raw.url === "string") urls.push(raw.url);
  }
  return urls;
}
