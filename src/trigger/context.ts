import type { ToolExecutionContext, ToolExecutionResult } from "@/agent/tools/types.js";
import type { toolExecutionContextSchema } from "./payloads.js";
import type { z } from "zod";

type PayloadContext = z.infer<typeof toolExecutionContextSchema>;

export function withSignal(
  ctx: PayloadContext,
  signal: AbortSignal,
): ToolExecutionContext {
  return { ...ctx, signal };
}

export function childTrace(
  ctx: PayloadContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chatId: ctx.chatId,
    userId: ctx.userId,
    runId: ctx.runId,
    messageId: ctx.messageId,
    traceId: ctx.traceId,
    toolCallId: ctx.toolCallId,
    ...extra,
  };
}

export type ChildToolResult<T> = ToolExecutionResult<T>;
