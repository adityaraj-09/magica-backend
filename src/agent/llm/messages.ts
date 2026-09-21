import type {
  LlmAssistantMessage,
  LlmToolCallProposal,
  LlmToolMessage,
  LlmWireToolCall,
} from "./types.js";

export function toAssistantToolCallMessage(
  calls: LlmToolCallProposal[],
  text: string | null = null,
): LlmAssistantMessage {
  return {
    role: "assistant",
    content: text,
    tool_calls: calls.map(toWireToolCall),
  };
}

export function toToolResultMessage(
  toolCallId: string,
  payload: unknown,
): LlmToolMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

export function toWireToolCall(call: LlmToolCallProposal): LlmWireToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.rawArguments,
    },
  };
}
