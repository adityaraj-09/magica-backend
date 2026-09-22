import { z } from "zod";
import { ToolError } from "@/agent/tools/errors";
import { TOOL_NAMES } from "@/agent/tools/types";
import { createAgentRuntime } from "@/agent/runtime/create-runtime";
import { HttpError } from "@/server/http/errors";
import { createAssetGateway } from "@/server/storage/copy";
import { emitWebhooks } from "./webhooks";

export const magicaPublicToolSchema = z.enum([
  TOOL_NAMES.cropImage,
  TOOL_NAMES.gptImage2,
  TOOL_NAMES.mergeVideos,
]);

export type MagicaPublicTool = z.infer<typeof magicaPublicToolSchema>;

export async function executePublicMagicaTool(input: {
  userId: string;
  toolName: MagicaPublicTool;
  body: unknown;
}): Promise<{
  toolName: MagicaPublicTool;
  output: unknown;
  assets: Array<{ url: string; mimeType: string; filename?: string }>;
  creditCost: string;
  providerRunId?: string;
  durationMs: number;
}> {
  const record = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {};
  const chatId =
    typeof record.chatId === "string"
      ? record.chatId
      : "00000000-0000-0000-0000-000000000000";
  const toolCallId = crypto.randomUUID();
  const { registry } = await createAgentRuntime();
  const ctx = {
    chatId,
    userId: input.userId,
    runId: toolCallId,
    messageId: toolCallId,
    toolCallId,
    traceId: toolCallId,
    signal: new AbortController().signal,
  };

  let result;
  try {
    result = await registry.execute(input.toolName, input.body, ctx);
  } catch (error) {
    throw httpFromTool(error);
  }

  const assets = result.assets?.length
    ? await createAssetGateway().persist({
        chatId,
        runId: toolCallId,
        toolCallId,
        assets: result.assets,
      })
    : [];

  void emitWebhooks({
    userId: input.userId,
    event: "tool.completed",
    idempotencySuffix: toolCallId,
    payload: {
      toolName: input.toolName,
      chatId: typeof record.chatId === "string" ? record.chatId : null,
      output: result.output,
      assets,
      creditCost: result.creditCost,
      durationMs: result.durationMs,
    },
  }).catch(() => undefined);

  return {
    toolName: input.toolName,
    output: result.output,
    assets,
    creditCost: result.creditCost,
    providerRunId: result.providerRunId,
    durationMs: result.durationMs,
  };
}

function httpFromTool(error: unknown): HttpError {
  if (!(error instanceof ToolError)) {
    return new HttpError("Magica request failed", 502, "FAILED");
  }
  const status =
    error.code === "UNAUTHORIZED"
      ? 401
      : error.code === "RATE_LIMITED"
        ? 429
        : error.code === "INVALID_INPUT"
          ? 400
          : error.code === "TIMEOUT"
            ? 504
            : error.code === "CREDITS_INSUFFICIENT"
              ? 402
              : 502;
  return new HttpError(error.message, status, error.code);
}
