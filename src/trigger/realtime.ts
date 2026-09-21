import { metadata } from "@trigger.dev/sdk";
import {
  runMetadataSchema,
  type RealtimePublisher,
  type RunMetadata,
} from "@/agent/runtime/realtime.js";
import { assistantTextStream } from "./streams.js";

export function createTriggerRealtime(): RealtimePublisher {
  let textChain = Promise.resolve();

  return {
    publish(snapshot: RunMetadata) {
      metadata.replace(runMetadataSchema.parse(snapshot) as never);
    },
    appendText(chunk: string) {
      if (!chunk) return Promise.resolve();
      textChain = textChain.then(() =>
        assistantTextStream.append({ type: "text", text: chunk }).then(() => undefined),
      );
      return textChain;
    },
    async flush() {
      await textChain;
    },
  };
}
