import { z } from "zod";

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("thinking"),
    text: z.string(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("tool_use"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    output: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("asset"),
    url: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().optional(),
  }),
]);

export type ContentBlock = z.infer<typeof contentBlockSchema>;

const SEARCH_TEXT_MAX = 8192;

export function parseContentBlocks(raw: unknown): ContentBlock[] {
  const result = z.array(contentBlockSchema).safeParse(raw);
  return result.success ? result.data : [];
}

export function searchTextFromBlocks(blocks: ContentBlock[]): string {
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.slice(0, SEARCH_TEXT_MAX);
}

export function appendBlocks(
  blocks: ContentBlock[],
  next: ContentBlock | ContentBlock[],
): ContentBlock[] {
  return [...blocks, ...(Array.isArray(next) ? next : [next])];
}
