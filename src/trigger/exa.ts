import { logger, schemaTask } from "@trigger.dev/sdk";
import { createWebSearchAdapter } from "@/agent/tools/adapters/exa";
import { webSearchInputSchema } from "@/agent/tools/schemas";
import { ToolError } from "@/agent/tools/errors";
import type { WebSearchAdapter } from "@/agent/tools/adapters/types";
import { childTrace, withSignal } from "./context";
import { catchNonRetryableToolError } from "./errors";
import { TASK_IDS } from "./ids";
import { parseToolInput } from "./parse";
import { exaSearchPayloadSchema } from "./payloads";
import { exaQueue } from "./queues";

let webSearch: WebSearchAdapter | undefined;

function getWebSearch(): WebSearchAdapter {
  if (webSearch) return webSearch;
  const adapter = createWebSearchAdapter();
  if (!adapter) {
    throw new ToolError("DISABLED", "Web search is turned off");
  }
  webSearch = adapter;
  return adapter;
}

export const executeExaSearch = schemaTask({
  id: TASK_IDS.exaSearch,
  queue: exaQueue,
  maxDuration: 60,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10_000,
    factor: 2,
    randomize: true,
  },
  schema: exaSearchPayloadSchema,
  catchError: catchNonRetryableToolError,
  run: async (payload, { signal }) => {
    logger.info("Exa child started", childTrace(payload.ctx, { toolName: payload.toolName }));
    return getWebSearch().search(
      parseToolInput(webSearchInputSchema, payload.input),
      withSignal(payload.ctx, signal),
    );
  },
});
