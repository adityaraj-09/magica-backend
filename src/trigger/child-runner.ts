import { ToolError, toolErrorFromUnknown } from "@/agent/tools/errors.js";
import type { ToolExecutionResult } from "@/agent/tools/types.js";
import type { ChildTaskRunner, ChildToolRequest } from "@/agent/runtime/execute-tool.js";
import type { MagicaToolPayload, E2BSandboxPayload, ExaSearchPayload } from "./payloads.js";
import { executeE2BSandbox } from "./e2b.js";
import { executeExaSearch } from "./exa.js";
import { executeMagicaTool } from "./magica.js";

type SubscribableTask<TPayload, TOutput> = {
  triggerAndSubscribe: (
    payload: TPayload,
    options?: { idempotencyKey?: string; signal?: AbortSignal; cancelOnAbort?: boolean },
  ) => PromiseLike<{ ok: true; output: TOutput } | { ok: false; error: unknown }>;
};

export const triggerChildTasks: ChildTaskRunner = {
  async run(request: ChildToolRequest): Promise<ToolExecutionResult<unknown>> {
    const payload = {
      toolName: request.toolName,
      input: request.input,
      ctx: {
        chatId: request.ctx.chatId,
        userId: request.ctx.userId,
        runId: request.ctx.runId,
        messageId: request.ctx.messageId,
        toolCallId: request.ctx.toolCallId,
        traceId: request.ctx.traceId,
      },
    };
    const options = {
      idempotencyKey: request.ctx.toolCallId,
      signal: request.ctx.signal,
      cancelOnAbort: true,
    };

    if (request.provider === "MAGICA") {
      return awaitChild(executeMagicaTool, payload as MagicaToolPayload, options, request.ctx.signal);
    }
    if (request.provider === "E2B") {
      return awaitChild(executeE2BSandbox, payload as E2BSandboxPayload, options, request.ctx.signal);
    }
    if (request.provider === "EXA") {
      return awaitChild(executeExaSearch, payload as ExaSearchPayload, options, request.ctx.signal);
    }

    throw new ToolError("FAILED", `No child task is registered for ${request.toolName}`);
  },
};

async function awaitChild<TPayload, TOutput>(
  task: SubscribableTask<TPayload, TOutput>,
  payload: TPayload,
  options: { idempotencyKey: string; signal: AbortSignal; cancelOnAbort: boolean },
  signal: AbortSignal,
): Promise<TOutput> {
  if (signal.aborted) {
    throw new ToolError("CANCELLED", "The tool task was cancelled.");
  }

  let result: { ok: true; output: TOutput } | { ok: false; error: unknown };
  try {
    result = await task.triggerAndSubscribe(payload, options);
  } catch (error) {
    throw toolErrorFromUnknown(error);
  }

  if (!result.ok) {
    throw toolErrorFromUnknown(result.error);
  }
  return result.output;
}
