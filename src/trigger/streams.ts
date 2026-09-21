import { streams, type InferStreamType } from "@trigger.dev/sdk";
import { STREAM_IDS, type AssistantTextChunk } from "@/agent/runtime/realtime.js";

/** Token-by-token assistant text. Run metadata (status, tools, overlay) is separate. */
export const assistantTextStream = streams.define<AssistantTextChunk>({
  id: STREAM_IDS.assistantText,
});

export type AssistantTextStreamPart = InferStreamType<typeof assistantTextStream>;
