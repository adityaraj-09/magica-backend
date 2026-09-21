import {
  toAssistantToolCallMessage,
  toToolResultMessage,
} from "@/agent/llm/messages.js";
import type { LlmMessage } from "@/agent/llm/types.js";
import {
  parseContentBlocks,
  type ContentBlock,
} from "./content-blocks.js";

export type HistoryMessage = {
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  status: string;
  contentBlocks: unknown;
  searchText: string;
  attachments?: Array<{ url: string; mimeType: string }>;
};

const IMAGE_MIME = /^image\//;

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
  const text = textOf(message);
  const images = (message.attachments ?? []).filter((file) => IMAGE_MIME.test(file.mimeType));
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
        content: block.error ? { error: block.error } : (block.output ?? {}),
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
