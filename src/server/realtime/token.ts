import { auth } from "@trigger.dev/sdk";
import { TASK_IDS } from "@/trigger/ids";

export async function createRunRealtimeToken(input: {
  chatId: string;
  runId: string;
  triggerRunId?: string;
}): Promise<string> {
  return auth.createPublicToken({
    expirationTime: "24h",
    scopes: {
      read: {
        tasks: [TASK_IDS.orchestrateAgentTurn],
        tags: [input.chatId, input.runId],
        ...(input.triggerRunId ? { runs: [input.triggerRunId] } : {}),
      },
    },
  });
}
