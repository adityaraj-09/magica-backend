import { tasks } from "@trigger.dev/sdk";
import type { orchestrateAgentTurn } from "@/trigger/orchestrator";
import { TASK_IDS } from "@/trigger/ids";
import {
  agentTurnPayloadSchema,
  type AgentTurnPayload,
} from "@/trigger/payloads";

export type { AgentTurnPayload };
export { TASK_IDS };

/**
 * Dispatch one agent turn. Safe to call twice with the same messageId.
 * One-active-run-per-chat is enforced by concurrencyKey = chatId.
 */
export async function dispatchAgentTurn(payload: AgentTurnPayload) {
  const parsed = agentTurnPayloadSchema.parse(payload);
  return tasks.trigger<typeof orchestrateAgentTurn>(
    TASK_IDS.orchestrateAgentTurn,
    parsed,
    {
      idempotencyKey: parsed.messageId,
      concurrencyKey: parsed.chatId,
      tags: [parsed.chatId, parsed.runId],
    },
  );
}
