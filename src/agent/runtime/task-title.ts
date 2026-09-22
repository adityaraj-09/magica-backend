import type { ChatClient } from "@/agent/llm/types";
import type { HistoryMessage } from "./history";

const PLACEHOLDERS = new Set(["new chat", "new task"]);

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDERS.has(title.trim().toLowerCase());
}

/** Rename drafts and titles that are just the raw first message. Leave a custom name alone. */
export function shouldSuggestTitle(current: string, userText: string): boolean {
  const title = current.trim();
  if (!title || isPlaceholderTitle(title)) return true;
  const slice = userText.trim().slice(0, 80);
  return slice.length > 0 && title === slice;
}

export function cleanTaskTitle(raw: string): string | null {
  let line = raw.replace(/\s+/g, " ").trim();
  line = line.replace(/^(title|task name)\s*:\s*/i, "");
  line = line.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!line || isPlaceholderTitle(line)) return null;
  if (line.length > 60) line = line.slice(0, 60).trim();
  return line.length >= 2 ? line : null;
}

export function userTextFromHistory(history: HistoryMessage[]): string {
  const message = [...history].reverse().find((item) => item.role === "USER");
  return message?.searchText?.trim() ?? "";
}

export async function suggestTaskTitle(
  llm: ChatClient,
  userText: string,
  signal: AbortSignal,
): Promise<string | null> {
  const text = userText.trim().slice(0, 500);
  if (!text) return null;
  const result = await llm.complete({
    messages: [
      {
        role: "system",
        content: "Name this task in 2 to 6 words. Reply with the name only. No quotes.",
      },
      { role: "user", content: text },
    ],
    toolChoice: "none",
    signal,
  });
  return cleanTaskTitle(result.text);
}
