import { z } from "zod";
import { TOOL_NAMES } from "@/agent/tools/types.js";

export const toolExecutionContextSchema = z.object({
  chatId: z.string().uuid(),
  userId: z.string().uuid(),
  runId: z.string().uuid(),
  messageId: z.string().uuid(),
  toolCallId: z.string().min(1),
  traceId: z.string().min(1),
});

export const agentTurnPayloadSchema = z.object({
  chatId: z.string().uuid(),
  userId: z.string().uuid(),
  runId: z.string().uuid(),
  messageId: z.string().uuid(),
  traceId: z.string().min(1),
  planMode: z.boolean().optional(),
});

export type AgentTurnPayload = z.infer<typeof agentTurnPayloadSchema>;

export const magicaToolPayloadSchema = z.object({
  toolName: z.enum([
    TOOL_NAMES.cropImage,
    TOOL_NAMES.gptImage2,
    TOOL_NAMES.mergeVideos,
  ]),
  input: z.unknown(),
  ctx: toolExecutionContextSchema,
});

export const e2bSandboxPayloadSchema = z.object({
  toolName: z.literal(TOOL_NAMES.sandboxRunCode),
  input: z.unknown(),
  ctx: toolExecutionContextSchema,
});

export const exaSearchPayloadSchema = z.object({
  toolName: z.literal(TOOL_NAMES.webSearch),
  input: z.unknown(),
  ctx: toolExecutionContextSchema,
});

export type MagicaToolPayload = z.infer<typeof magicaToolPayloadSchema>;
export type E2BSandboxPayload = z.infer<typeof e2bSandboxPayloadSchema>;
export type ExaSearchPayload = z.infer<typeof exaSearchPayloadSchema>;
