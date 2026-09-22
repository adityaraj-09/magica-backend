import {
  toAssistantToolCallMessage,
  toToolResultMessage,
} from "@/agent/llm/messages";
import type { LlmMessage } from "@/agent/llm/types";
import {
  parseContentBlocks,
  type ContentBlock,
} from "./content-blocks";

export type HistoryMessage = {
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  status: string;
  contentBlocks: unknown;
  searchText: string;
  attachments?: Array<{ url: string; mimeType: string; filename?: string }>;
};

const IMAGE_MIME = /^image\//;

/** Max JSON size sent back to OpenRouter per tool_result. Persisted blocks stay full. */
export const LLM_TOOL_RESULT_MAX_CHARS = 4_096;

const KEEP_FULL_TOOL_RESULTS = new Set(["load_skill", "read_skill_asset"]);

export function truncateToolResultForLlm(toolName: string, output: unknown): unknown {
  if (KEEP_FULL_TOOL_RESULTS.has(toolName)) return output;
  if (typeof output === "string") {
    return output.length <= LLM_TOOL_RESULT_MAX_CHARS
      ? output
      : `${output.slice(0, LLM_TOOL_RESULT_MAX_CHARS)}\n… truncated`;
  }
  let json: string;
  try {
    json = JSON.stringify(output);
  } catch {
    return { truncated: true, preview: "[unserializable tool output]" };
  }
  if (json.length <= LLM_TOOL_RESULT_MAX_CHARS) return output;
  return {
    truncated: true,
    preview: json.slice(0, LLM_TOOL_RESULT_MAX_CHARS),
  };
}

export function messagesToLlm(history: HistoryMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const message of history) {
    if (message.role === "TOOL") continue;
    if (message.role === "SYSTEM") {
      const text = textOf(message);
      if (text) out.push({ role: "system", content: text });
      continue;
    }
    if (message.role === "USER") {
      out.push(userMessage(message));
      continue;
    }
    if (message.role === "ASSISTANT") {
      out.push(...assistantBlocksToLlm(parseContentBlocks(message.contentBlocks), textOf(message)));
    }
  }
  return out;
}

function userMessage(message: HistoryMessage): LlmMessage {
  const files = attachedFiles(message);
  const text = [textOf(message), attachmentListing(files)].filter(Boolean).join("\n\n");
  const images = files.filter((file) => IMAGE_MIME.test(file.mimeType));
  if (images.length === 0) {
    return { role: "user", content: text };
  }
  return {
    role: "user",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images.map((file) => ({
        type: "image_url" as const,
        image_url: { url: file.url },
      })),
    ],
  };
}

function attachedFiles(message: HistoryMessage): Array<{ url: string; mimeType: string; filename?: string }> {
  const seen = new Set<string>();
  const files: Array<{ url: string; mimeType: string; filename?: string }> = [];
  const push = (file: { url: string; mimeType: string; filename?: string }) => {
    if (!file.url || seen.has(file.url)) return;
    seen.add(file.url);
    files.push(file);
  };
  for (const file of message.attachments ?? []) push(file);
  for (const block of parseContentBlocks(message.contentBlocks)) {
    if (block.type === "asset") {
      push({ url: block.url, mimeType: block.mimeType, filename: block.filename });
    }
  }
  return files;
}

function attachmentListing(files: Array<{ url: string; mimeType: string; filename?: string }>): string {
  if (files.length === 0) return "";
  return [
    "Attached files (already visible). Use these URLs only if a tool is actually required. Do not ask the user for a URL.",
    ...files.map((file) => `- ${file.filename || file.mimeType}: ${file.url}`),
  ].join("\n");
}

export function assistantBlocksToLlm(
  blocks: ContentBlock[],
  fallbackText = "",
): LlmMessage[] {
  const out: LlmMessage[] = [];
  let text = "";
  let toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    rawArguments: string;
  }> = [];
  let results: Array<{ id: string; content: unknown }> = [];

  const flush = () => {
    if (toolCalls.length > 0) {
      out.push(
        toAssistantToolCallMessage(
          toolCalls,
          text.trim() === "" ? null : text,
        ),
      );
      for (const result of results) {
        out.push(toToolResultMessage(result.id, result.content));
      }
    } else if (text.trim() !== "") {
      out.push({ role: "assistant", content: text });
    }
    text = "";
    toolCalls = [];
    results = [];
  };

  for (const block of blocks) {
    if (block.type === "text") {
      if (toolCalls.length > 0 && results.length >= toolCalls.length) flush();
      text += block.text;
      continue;
    }
    if (block.type === "tool_use") {
      const args =
        block.input && typeof block.input === "object" && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {};
      toolCalls.push({
        id: block.toolCallId,
        name: block.toolName,
        arguments: args,
        rawArguments: JSON.stringify(block.input ?? {}),
      });
      continue;
    }
    if (block.type === "tool_result") {
      results.push({
        id: block.toolCallId,
        content: block.error
          ? { error: block.error }
          : truncateToolResultForLlm(block.toolName, block.output ?? {}),
      });
    }
  }
  flush();

  if (out.length === 0 && fallbackText.trim() !== "") {
    out.push({ role: "assistant", content: fallbackText });
  }
  return out;
}

function textOf(message: HistoryMessage): string {
  const fromBlocks = parseContentBlocks(message.contentBlocks)
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  return fromBlocks || message.searchText;
}
