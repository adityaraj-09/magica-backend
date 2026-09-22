import { logger, schemaTask } from "@trigger.dev/sdk";
import { createE2BAdapter } from "@/agent/tools/adapters/e2b";
import { sandboxRunCodeInputSchema } from "@/agent/tools/schemas";
import type { E2BAdapter } from "@/agent/tools/adapters/types";
import { childTrace, withSignal } from "./context";
import { catchNonRetryableToolError } from "./errors";
import { TASK_IDS } from "./ids";
import { parseToolInput } from "./parse";
import { e2bSandboxPayloadSchema } from "./payloads";
import { e2bQueue } from "./queues";

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
    logger.info("E2B child started", childTrace(payload.ctx, { toolName: payload.toolName }));
    return getE2B().runCode(
      parseToolInput(sandboxRunCodeInputSchema, payload.input),
      withSignal(payload.ctx, signal),
    );
  },
});
