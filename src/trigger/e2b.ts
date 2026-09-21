import { logger, schemaTask } from "@trigger.dev/sdk";
import { createE2BAdapter } from "@/agent/tools/adapters/e2b.js";
import { sandboxRunCodeInputSchema } from "@/agent/tools/schemas.js";
import type { E2BAdapter } from "@/agent/tools/adapters/types.js";
import { withSignal } from "./context.js";
import { catchNonRetryableToolError } from "./errors.js";
import { TASK_IDS } from "./ids.js";
import { parseToolInput } from "./parse.js";
import { e2bSandboxPayloadSchema } from "./payloads.js";
import { e2bQueue } from "./queues.js";

let e2b: E2BAdapter | undefined;

function getE2B(): E2BAdapter {
  e2b ??= createE2BAdapter();
  return e2b;
}

export const executeE2BSandbox = schemaTask({
  id: TASK_IDS.e2bSandbox,
  queue: e2bQueue,
  maxDuration: 180,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10_000,
    factor: 2,
    randomize: true,
  },
  schema: e2bSandboxPayloadSchema,
  catchError: catchNonRetryableToolError,
  run: async (payload, { signal }) => {
    logger.info("E2B child started", {
      toolCallId: payload.ctx.toolCallId,
      runId: payload.ctx.runId,
    });
    return getE2B().runCode(
      parseToolInput(sandboxRunCodeInputSchema, payload.input),
      withSignal(payload.ctx, signal),
    );
  },
});
