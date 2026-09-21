import { logger, schemaTask } from "@trigger.dev/sdk";
import { createOpenRouterClient } from "@/agent/llm/openrouter.js";
import { createAgentRuntime } from "@/agent/runtime/create-runtime.js";
import { runAgentLoop } from "@/agent/runtime/loop.js";
import { AgentStore } from "@/agent/runtime/store.js";
import { prisma } from "@/server/db.js";
import { triggerChildTasks } from "./child-runner.js";
import { TASK_IDS } from "./ids.js";
import { agentTurnPayloadSchema } from "./payloads.js";
import { agentTurnsQueue } from "./queues.js";
import { createTriggerRealtime } from "./realtime.js";
import { createTriggerWaitpoints } from "./waitpoints.js";
import { createCreditGateway } from "@/server/credits/settle.js";
import { createAssetGateway } from "@/server/storage/copy.js";
import { createWebhookGateway } from "@/server/public/webhooks.js";

/**
 * One durable agent turn. Trigger with:
 *   concurrencyKey = chatId
 *   idempotencyKey = messageId
 */
export const orchestrateAgentTurn = schemaTask({
  id: TASK_IDS.orchestrateAgentTurn,
  queue: agentTurnsQueue,
  maxDuration: 3600,
  retry: { maxAttempts: 3 },
  schema: agentTurnPayloadSchema,
  run: async (payload, { ctx, signal }) => {
    logger.info("Agent turn started", {
      chatId: payload.chatId,
      userId: payload.userId,
      runId: payload.runId,
      messageId: payload.messageId,
      traceId: payload.traceId,
      processId: ctx.run.id,
    });

    const { registry, skills } = await createAgentRuntime();
    const store = new AgentStore(prisma);
    const webhooks = createWebhookGateway(prisma);
    await webhooks.emit({
      userId: payload.userId,
      event: "agent.started",
      agentRunId: payload.runId,
      idempotencySuffix: payload.runId,
      payload: {
        chatId: payload.chatId,
        runId: payload.runId,
        messageId: payload.messageId,
        traceId: payload.traceId,
        processId: ctx.run.id,
        status: "QUEUED",
      },
    });

    try {
      const result = await runAgentLoop(
        {
          ...payload,
          triggerRunId: ctx.run.id,
        },
        {
          store,
          llm: createOpenRouterClient(),
          registry,
          skills: skills.listMetadata(),
          children: triggerChildTasks,
          waitpoints: createTriggerWaitpoints(store),
          realtime: createTriggerRealtime(),
          credits: createCreditGateway(prisma),
          assets: createAssetGateway(),
          webhooks,
          maxTurns: parsePositiveInt(process.env.AGENT_MAX_TURNS, 8),
          waitTimeout: process.env.WAITPOINT_TIMEOUT ?? "24h",
          signal,
        },
      );

      await webhooks.emit({
        userId: payload.userId,
        event: result.status === "COMPLETE" ? "agent.completed" : "agent.failed",
        agentRunId: payload.runId,
        idempotencySuffix: `${payload.runId}:${result.status}`,
        payload: {
          chatId: payload.chatId,
          runId: payload.runId,
          messageId: payload.messageId,
          traceId: payload.traceId,
          processId: ctx.run.id,
          status: result.status,
          assistantMessageId: result.assistantMessageId,
        },
      });

      logger.info("Agent turn finished", {
        chatId: payload.chatId,
        userId: payload.userId,
        runId: payload.runId,
        messageId: payload.messageId,
        traceId: payload.traceId,
        processId: ctx.run.id,
        status: result.status,
        assistantMessageId: result.assistantMessageId,
      });

      return {
        ok: true as const,
        ...result,
        chatId: payload.chatId,
        userId: payload.userId,
        runId: payload.runId,
        messageId: payload.messageId,
        traceId: payload.traceId,
        triggerRunId: ctx.run.id,
      };
    } catch (error) {
      await webhooks.emit({
        userId: payload.userId,
        event: "agent.failed",
        agentRunId: payload.runId,
        idempotencySuffix: `${payload.runId}:THROWN`,
        payload: {
          chatId: payload.chatId,
          runId: payload.runId,
          messageId: payload.messageId,
          traceId: payload.traceId,
          processId: ctx.run.id,
          status: "FAILED",
          error: error instanceof Error ? error.message : "Agent turn failed",
        },
      });
      throw error;
    }
  },
});

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
