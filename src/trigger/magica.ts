import { logger, schemaTask } from "@trigger.dev/sdk";
import { createMagicaAdapter } from "@/agent/tools/adapters/magica.js";
import {
  cropImageInputSchema,
  gptImage2InputSchema,
  mergeVideosInputSchema,
} from "@/agent/tools/schemas.js";
import { TOOL_NAMES } from "@/agent/tools/types.js";
import type { MagicaAdapter } from "@/agent/tools/adapters/types.js";
import { childTrace, withSignal } from "./context.js";
import { catchNonRetryableToolError } from "./errors.js";
import { TASK_IDS } from "./ids.js";
import { parseToolInput } from "./parse.js";
import { magicaToolPayloadSchema } from "./payloads.js";
import { magicaQueue } from "./queues.js";

let magica: MagicaAdapter | undefined;

function getMagica(): MagicaAdapter {
  magica ??= createMagicaAdapter();
  return magica;
}

export const executeMagicaTool = schemaTask({
  id: TASK_IDS.magicaTool,
  queue: magicaQueue,
  maxDuration: 540,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 20_000,
    factor: 2,
    randomize: true,
  },
  schema: magicaToolPayloadSchema,
  catchError: catchNonRetryableToolError,
  run: async (payload, { signal }) => {
    logger.info("Magica child started", childTrace(payload.ctx, { toolName: payload.toolName }));
    const ctx = withSignal(payload.ctx, signal);
    const adapter = getMagica();

    switch (payload.toolName) {
      case TOOL_NAMES.cropImage:
        return adapter.cropImage(parseToolInput(cropImageInputSchema, payload.input), ctx);
      case TOOL_NAMES.gptImage2:
        return adapter.gptImage2(parseToolInput(gptImage2InputSchema, payload.input), ctx);
      case TOOL_NAMES.mergeVideos:
        return adapter.mergeVideos(parseToolInput(mergeVideosInputSchema, payload.input), ctx);
    }
  },
});
