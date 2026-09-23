import type { ChatClient } from "@/agent/llm/types";
import { parseContentBlocks } from "./content-blocks";
import type { HistoryMessage } from "./history";

const PLACEHOLDERS = new Set(["new chat", "new task"]);
const REFUSAL =
  /sorry|can.?t see|cannot see|unable to (see|view|access)|please (upload|describe|provide|send)|i don.?t (see|have) (the )?(image|photo|picture)|no image/i;
const IMAGE_QUESTION =
  /what('?s| is) (in |on )?(this|the) (photo|image|picture|img)|^(explain|describe|look at|review) (this|the) (photo|image|picture)/i;

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDERS.has(title.trim().toLowerCase());
}

/** Rename drafts and titles that are just the raw first message. Leave a custom name alone. */
export function shouldSuggestTitle(current: string, userText: string): boolean {
  const title = current.trim();
  if (!title || isPlaceholderTitle(title)) return true;
  if (looksLikeRefusal(title)) return true;
  const slice = userText.trim().slice(0, 80);
  return slice.length > 0 && title === slice;
}

export function looksLikeRefusal(raw: string): boolean {
  return REFUSAL.test(raw.trim());
}

export function cleanTaskTitle(raw: string): string | null {
  let line = raw.replace(/\s+/g, " ").trim();
  line = line.replace(/^(title|task name)\s*:\s*/i, "");
  line = line.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!line || isPlaceholderTitle(line) || looksLikeRefusal(line)) return null;
  if (line.length > 60) line = line.slice(0, 60).trim();
  return line.length >= 2 ? line : null;
}

export function userTextFromHistory(history: HistoryMessage[]): string {
  const message = lastUser(history);
  return message?.searchText?.trim() ?? "";
}

export function userHasImage(history: HistoryMessage[]): boolean {
  const message = lastUser(history);
  if (!message) return false;
  if (message.attachments?.some((file) => file.mimeType.startsWith("image/"))) return true;
  return parseContentBlocks(message.contentBlocks).some(
    (block) => block.type === "asset" && block.mimeType.startsWith("image/"),
  );
}

export function fallbackTaskTitle(userText: string, hasImage: boolean): string | null {
  const text = userText.replace(/\s+/g, " ").trim();
  if (hasImage && (!text || IMAGE_QUESTION.test(text))) return "Image review";
  if (!text) return null;
  return cleanTaskTitle(text.split(/\s+/).slice(0, 6).join(" "));
}

export async function suggestTaskTitle(
  llm: ChatClient,
  userText: string,
  signal: AbortSignal,
  hasImage = false,
): Promise<string | null> {
  const text = userText.trim().slice(0, 500);
  if (!text && !hasImage) return null;
  const result = await llm.complete({
    messages: [
      {
        role: "system",
        content:
          "Name this task in 2 to 6 words. Reply with the name only. No quotes. Do not answer the user. Do not say you cannot see an image.",
      },
      {
        role: "user",
        content: hasImage
          ? `The user attached an image.\n${text || "Review the attached image."}`
          : text,
      },
    ],
    toolChoice: "none",
    signal,
  });
  return cleanTaskTitle(result.text) ?? fallbackTaskTitle(userText, hasImage);
}

function lastUser(history: HistoryMessage[]): HistoryMessage | undefined {
  return [...history].reverse().find((item) => item.role === "USER");
}
