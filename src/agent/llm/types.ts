import type { LlmError } from "./errors";

export const OPENROUTER_FREE_ROUTE = "openrouter/free";

export type LlmRole = "system" | "user" | "assistant" | "tool";

export type LlmTextPart = { type: "text"; text: string };
export type LlmImagePart = { type: "image_url"; image_url: { url: string } };
export type LlmContent = string | Array<LlmTextPart | LlmImagePart>;

export type LlmTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type LlmWireToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type LlmSystemMessage = { role: "system"; content: string };
export type LlmUserMessage = { role: "user"; content: LlmContent };
export type LlmAssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: LlmWireToolCall[];
};
export type LlmToolMessage = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

export type LlmMessage =
  | LlmSystemMessage
  | LlmUserMessage
  | LlmAssistantMessage
  | LlmToolMessage;

export type LlmToolCallProposal = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
};

export type LlmMalformedToolCall = {
  id?: string;
  name?: string;
  rawArguments: string;
  error: string;
};

export type LlmFinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  /** OpenRouter reports USD. Must stay 0 on the free route. */
  cost: number;
};

export type ChatCompletionRequest = {
  messages: LlmMessage[];
  tools?: LlmTool[];
  toolChoice?: "auto" | "none";
  signal: AbortSignal;
  onToken?: (text: string) => void;
};

export type ChatCompletionResult = {
  text: string;
  reasoning: string;
  toolCalls: LlmToolCallProposal[];
  malformedToolCalls: LlmMalformedToolCall[];
  finishReason: LlmFinishReason;
  modelRequested: typeof OPENROUTER_FREE_ROUTE;
  modelRouted: string;
  usage: LlmUsage;
};

/**
 * Provider-neutral chat+tools brain. Implementations must not execute tools.
 */
export type ChatClient = {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
};

export type ChatClientError = LlmError;
