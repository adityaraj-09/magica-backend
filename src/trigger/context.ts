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

export type ChildToolResult<T> = ToolExecutionResult<T>;
