import { Prisma } from "@prisma/client";
import { LlmError } from "@/agent/llm/errors";
import type { ChatClient, LlmMessage, LlmToolCallProposal } from "@/agent/llm/types";
import { ToolError } from "@/agent/tools/errors";
import type { ToolRegistry } from "@/agent/tools/registry";
import type { SkillMetadata } from "@/agent/skills/registry";
import { TOOL_NAMES } from "@/agent/tools/types";
import { appendBlocks, type ContentBlock } from "./content-blocks";
import { executeRegisteredTool, type ChildTaskRunner } from "./execute-tool";
import { messagesToLlm } from "./history";
import {
  noopRealtime,
  progressFor,
  upsertToolLive,
  type RealtimePublisher,
  type RunMetadata,
  type ToolLive,
} from "./realtime";
import { AgentStore, stableJson, type RunSnapshot } from "./store";
import { buildSystemPrompt } from "./system-prompt";
import { shouldSuggestTitle, suggestTaskTitle, userTextFromHistory } from "./task-title";
import type { WaitpointApproval, WaitpointGateway, WaitpointKind } from "./waitpoint";
import { noopCredits, type CreditGateway } from "@/server/credits/settle";
import { noopAssets, type AssetGateway } from "@/server/storage/copy";
import { noopWebhooks, type WebhookGateway } from "@/server/public/webhooks";

export type AgentTurnInput = {
  chatId: string;
  userId: string;
  runId: string;
  messageId: string;
  traceId: string;
  triggerRunId: string;
  planMode?: boolean;
};

export type AgentLoopDeps = {
  store: AgentStore;
  llm: ChatClient;
  registry: ToolRegistry;
  skills: SkillMetadata[];
  children: ChildTaskRunner;
  waitpoints: WaitpointGateway;
  realtime?: RealtimePublisher;
  credits?: CreditGateway;
  assets?: AssetGateway;
  webhooks?: WebhookGateway;
  maxTurns: number;
  waitTimeout: string;
  signal: AbortSignal;
};

const TERMINAL_RUN = new Set(["COMPLETE", "FAILED", "CANCELLED"]);

export async function runAgentLoop(
  input: AgentTurnInput,
  deps: AgentLoopDeps,
): Promise<{ status: "COMPLETE" | "FAILED" | "CANCELLED"; assistantMessageId: string }> {
  const run = await deps.store.getRun(input.runId);
  if (!run || run.chatId !== input.chatId || run.userId !== input.userId) {
    throw new Error("Agent run was not found");
  }
  if (run.userMessageId !== input.messageId) {
    throw new Error("Agent run does not match the user message");
  }
  if (TERMINAL_RUN.has(run.status)) {
    const assistant = await deps.store.ensureAssistantMessage(run);
    return {
      status: run.status as "COMPLETE" | "FAILED" | "CANCELLED",
      assistantMessageId: assistant.id,
    };
  }

  const assistant = await deps.store.ensureAssistantMessage(run);
  let blocks = assistant.blocks;
  const history = await deps.store.listHistory(run.chatId);
  const priorMessages = messagesToLlm(
    history.filter((message) => message.role !== "ASSISTANT" || message.status !== "STREAMING"),
  );
  const userText = userTextFromHistory(history);
  const project = await deps.store.getChatProject(run.chatId);
  await nameChatFromUserText(deps, run.chatId, userText);
  let promptTokens = 0;
  let completionTokens = 0;
  let modelRouted: string | undefined;
  const thinkingStartedAt = new Date();
  let planWaitPending = Boolean(input.planMode);
  const realtime = deps.realtime ?? noopRealtime;
  const credits = deps.credits ?? noopCredits;
  const live = createLiveMetadata(run, assistant.id);

  await deps.store.updateRun({
    runId: run.id,
    chatId: run.chatId,
    status: "THINKING",
    triggerRunId: input.triggerRunId,
    processId: input.triggerRunId,
    currentStep: "thinking",
    thinkingStartedAt,
    startedAt: new Date(),
    errorCode: null,
    errorMessage: null,
  });
  publishLive(realtime, live, thinkingStartedAt, { status: "THINKING", currentStep: "thinking" });

  try {
    for (let turn = 1; turn <= deps.maxTurns; turn += 1) {
      throwIfAborted(deps.signal);

      await deps.store.updateRun({
        runId: run.id,
        chatId: run.chatId,
        status: "THINKING",
        currentStep: `llm:${turn}`,
        thinkingStartedAt,
      });
      publishLive(realtime, live, thinkingStartedAt, {
        status: "THINKING",
        currentStep: `llm:${turn}`,
      });

      const llmMessages = buildMessages(deps, priorMessages, blocks, project);
      const sink = createTokenSink({
        assistantId: assistant.id,
        priorBlocks: blocks,
        live,
        realtime,
        thinkingStartedAt,
        persist: (next) =>
          deps.store.saveAssistant({
            messageId: assistant.id,
            blocks: next,
            promptTokens,
            completionTokens,
            status: "STREAMING",
          }),
      });
      const completion = await completeWithRetry(deps, llmMessages, sink);
      await sink.flush();
      promptTokens += completion.usage.promptTokens;
      completionTokens += completion.usage.completionTokens;
      modelRouted = completion.modelRouted;

      if (completion.reasoning.trim()) {
        blocks = appendBlocks(blocks, {
          type: "thinking",
          text: completion.reasoning,
        });
      }
      if (completion.text.trim()) {
        blocks = appendBlocks(blocks, { type: "text", text: completion.text });
      }

      const proposals = [
        ...completion.toolCalls,
        ...syntheticMalformed(completion.malformedToolCalls),
      ];

      await persistAssistant(
        deps,
        assistant.id,
        blocks,
        {
          promptTokens,
          completionTokens,
          status: proposals.length > 0 ? "STREAMING" : "SUCCESS",
        },
        { live, realtime, thinkingStartedAt },
      );

      if (proposals.length === 0) {
        return terminate(deps, run, assistant.id, blocks, live, realtime, {
          status: "COMPLETE",
          promptTokens,
          completionTokens,
          modelRouted,
          thinkingStartedAt,
          userText,
        });
      }

      if (planWaitPending) {
        const decision = await requestApproval({
          deps,
          run,
          live,
          realtime,
          thinkingStartedAt,
          type: "PLAN",
          currentStep: "wait:plan",
          idempotencyKey: `run:${run.id}:wait:plan`,
          payload: {
            text: completion.text,
            tools: proposals.map((call) => ({
              name: call.name,
              arguments: call.arguments,
            })),
          },
        });
        if (decision !== "approved") {
          return terminate(deps, run, assistant.id, blocks, live, realtime, {
            status: decision === "expired" ? "FAILED" : "CANCELLED",
            promptTokens,
            completionTokens,
            modelRouted,
            thinkingStartedAt,
            errorCode: decision === "expired" ? "WAITPOINT_EXPIRED" : "PLAN_REJECTED",
            errorMessage:
              decision === "expired"
                ? "Plan approval timed out."
                : "The plan was not approved.",
          });
        }
        planWaitPending = false;
      }

      const creditHold = await maybeCreditWait({
        deps,
        run,
        live,
        realtime,
        thinkingStartedAt,
        turn,
        proposals,
      });
      if (creditHold && creditHold !== "approved") {
        return terminate(deps, run, assistant.id, blocks, live, realtime, {
          status: creditHold === "expired" ? "FAILED" : "CANCELLED",
          promptTokens,
          completionTokens,
          modelRouted,
          thinkingStartedAt,
          errorCode: creditHold === "expired" ? "WAITPOINT_EXPIRED" : "CREDIT_REJECTED",
          errorMessage:
            creditHold === "expired"
              ? "Credit approval timed out."
              : "Additional credits were not approved.",
        });
      }

      await deps.store.updateRun({
        runId: run.id,
        chatId: run.chatId,
        status: "WORKING",
        currentStep: `tools:${turn}`,
        modelRouted,
        promptTokens,
        completionTokens,
        thinkingDurationMs: Date.now() - thinkingStartedAt.getTime(),
      });
      publishLive(realtime, live, thinkingStartedAt, {
        status: "WORKING",
        currentStep: `tools:${turn}`,
      });

      const executed = await executeProposals({
        run,
        assistantMessageId: assistant.id,
        proposals,
        liveBlocks: blocks,
        live,
        realtime,
        credits,
        assets: deps.assets ?? noopAssets,
        thinkingStartedAt,
        promptTokens,
        completionTokens,
        traceId: input.traceId,
        deps,
      });
      blocks = appendBlocks(blocks, executed.blocks);
      if (executed.aborted) {
        throw executed.aborted;
      }
      await persistAssistant(
        deps,
        assistant.id,
        blocks,
        {
          promptTokens,
          completionTokens,
          status: "STREAMING",
        },
        { live, realtime, thinkingStartedAt },
      );
    }

    return terminate(deps, run, assistant.id, blocks, live, realtime, {
      status: "FAILED",
      promptTokens,
      completionTokens,
      modelRouted,
      thinkingStartedAt,
      errorCode: "MAX_TURNS",
      errorMessage: "The agent reached the maximum number of tool turns.",
    });
  } catch (error) {
    const aborted = deps.signal.aborted || isCancelled(error);
    return terminate(deps, run, assistant.id, blocks, live, realtime, {
      status: aborted ? "CANCELLED" : "FAILED",
      promptTokens,
      completionTokens,
      modelRouted,
      thinkingStartedAt,
      errorCode: aborted ? "CANCELLED" : codeOf(error),
      errorMessage: aborted ? "The run was cancelled." : userSafeError(error),
    });
  }
}

async function nameChatFromUserText(
  deps: AgentLoopDeps,
  chatId: string,
  userText: string,
): Promise<void> {
  if (!userText) return;
  try {
    const current = await deps.store.getChatTitle(chatId);
    if (current == null || !shouldSuggestTitle(current, userText)) return;
    const title = await suggestTaskTitle(deps.llm, userText, deps.signal);
    if (!title) return;
    await deps.store.renameChat(chatId, title);
  } catch {
    // A missing name must not fail the turn.
  }
}

function buildMessages(
  deps: AgentLoopDeps,
  priorMessages: LlmMessage[],
  liveBlocks: ContentBlock[],
  project: { memoryEnabled: boolean; instructions: string; memory: string } | null,
): LlmMessage[] {
  const live = messagesToLlm([
    {
      role: "ASSISTANT",
      status: "STREAMING",
      contentBlocks: liveBlocks,
      searchText: "",
    },
  ]);
  return [
    {
      role: "system",
      content: buildSystemPrompt(deps.skills, {
        instructions: project?.instructions,
        memory: project?.memoryEnabled ? project.memory : undefined,
      }),
    },
    ...priorMessages,
    ...live,
  ];
}

async function completeWithRetry(
  deps: AgentLoopDeps,
  messages: LlmMessage[],
  sink?: TokenSink,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    sink?.reset();
    try {
      return await deps.llm.complete({
        messages,
        tools: deps.registry.listForAgent(),
        signal: deps.signal,
        onToken: sink ? (token) => sink.push(token) : undefined,
      });
    } catch (error) {
      lastError = error;
      if (error instanceof LlmError && error.retryable && attempt < 2) {
        await sleep(error.retryAfterMs ?? 2000 * (attempt + 1), deps.signal);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

const MAX_TOOL_ATTEMPTS = 3;

async function executeProposals(input: {
  run: RunSnapshot;
  assistantMessageId: string;
  proposals: LlmToolCallProposal[];
  liveBlocks: ContentBlock[];
  live: RunMetadata;
  realtime: RealtimePublisher;
  credits: CreditGateway;
  assets: AssetGateway;
  thinkingStartedAt: Date;
  promptTokens: number;
  completionTokens: number;
  traceId: string;
  deps: AgentLoopDeps;
}): Promise<{ blocks: ContentBlock[]; aborted?: unknown }> {
  let sequence = (await input.deps.store.nextToolSequence(input.run.id)) - 1;
  const jobs = input.proposals.map((proposal) => {
    sequence += 1;
    return { proposal, sequence };
  });
  const batchAbort = new AbortController();
  const signal =
    typeof AbortSignal.any === "function"
      ? AbortSignal.any([input.deps.signal, batchAbort.signal])
      : input.deps.signal;
  const sharedRuns = new Map<string, Promise<ContentBlock[] | null>>();
  let flushed = [...input.liveBlocks];
  let persistTail = Promise.resolve();
  const flush = (next: ContentBlock[]) => {
    if (!next.length) return persistTail;
    persistTail = persistTail.then(async () => {
      flushed = appendBlocks(flushed, next);
      await persistAssistant(
        input.deps,
        input.assistantMessageId,
        flushed,
        {
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          status: "STREAMING",
        },
        {
          live: input.live,
          realtime: input.realtime,
          thinkingStartedAt: input.thinkingStartedAt,
        },
      );
    });
    return persistTail;
  };

  const started = await Promise.all(
    jobs.map(async ({ proposal, sequence: toolSequence }, index) => {
      const existing = await input.deps.store.getToolInvocation(
        input.run.id,
        proposal.id,
      );
      if (existing?.status === "SUCCESS") {
        await input.credits.settleTool({
          run: input.run,
          toolCallId: proposal.id,
          toolInvocationId: existing.id,
          toolName: proposal.name,
          cost: existing.creditCost,
        });
        const already = input.liveBlocks.some(
          (block) => block.type === "tool_result" && block.toolCallId === proposal.id,
        );
        const block = already ? [] : resultBlock(proposal, existing.output, existing.errorMessage);
        await flush(block);
        return { index, block };
      }

      const reuseKey = `${proposal.name}:${stableJson(proposal.arguments)}`;
      const reused = await input.deps.store.findSuccessfulToolByInput(
        input.run.id,
        proposal.name,
        proposal.arguments,
      );
      if (reused) {
        await input.credits.settleTool({
          run: input.run,
          toolCallId: proposal.id,
          toolInvocationId: reused.id,
          toolName: proposal.name,
          cost: reused.creditCost,
        });
        publishTool(input, {
          toolCallId: proposal.id,
          toolName: proposal.name,
          status: "SUCCESS",
        });
        const block = resultBlock(proposal, reused.output, reused.errorMessage);
        await flush(block);
        return { index, block };
      }

      let resolveShared: ((blocks: ContentBlock[] | null) => void) | undefined;
      if (!sharedRuns.has(reuseKey)) {
        sharedRuns.set(
          reuseKey,
          new Promise<ContentBlock[] | null>((resolve) => {
            resolveShared = resolve;
          }),
        );
      } else {
        const shared = await sharedRuns.get(reuseKey);
        if (shared) {
          publishTool(input, {
            toolCallId: proposal.id,
            toolName: proposal.name,
            status: "SUCCESS",
          });
          const block = resultBlock(
            proposal,
            shared.find((item) => item.type === "tool_result")?.output,
            null,
          );
          await flush(block);
          return { index, block };
        }
      }

      let provider: "MAGICA" | "E2B" | "EXA" | "SKILL" | "INTERNAL" = "INTERNAL";
      try {
        const tool = input.deps.registry.get(proposal.name);
        provider = tool.provider;
        const estimate = await estimateOne(input.deps.registry, proposal);
        const spendable = await input.credits.spendable(input.run);
        if (estimate.gt(spendable)) {
          const error = new ToolError(
            "CREDITS_INSUFFICIENT",
            "Not enough credits to run this tool.",
            { retryable: false },
          );
          batchAbort.abort();
          await persistInvocationFailure({
            input,
            proposal,
            provider,
            toolSequence,
            error,
            status: "FAILED",
          });
          publishTool(input, {
            toolCallId: proposal.id,
            toolName: proposal.name,
            status: "FAILED",
            errorMessage: error.message,
          });
          const block = resultBlock(proposal, undefined, error.message);
          resolveShared?.(null);
          await flush(block);
          return {
            index,
            aborted: error,
            block,
          };
        }
        await input.deps.store.upsertToolInvocation({
          run: input.run,
          toolCallId: proposal.id,
          toolName: proposal.name,
          provider,
          sequence: toolSequence,
          status: "RUNNING",
          payload: proposal.arguments,
        });
        publishTool(input, {
          toolCallId: proposal.id,
          toolName: proposal.name,
          status: "RUNNING",
        });
        const result = await executeToolWithRetry({
          registry: input.deps.registry,
          children: input.deps.children,
          name: proposal.name,
          raw: proposal.arguments,
          ctx: {
            chatId: input.run.chatId,
            userId: input.run.userId,
            runId: input.run.id,
            messageId: input.assistantMessageId,
            toolCallId: proposal.id,
            traceId: input.traceId,
            signal,
          },
          signal,
        });
        const saved = await input.deps.store.upsertToolInvocation({
          run: input.run,
          toolCallId: proposal.id,
          toolName: proposal.name,
          provider,
          sequence: toolSequence,
          status: "SUCCESS",
          payload: proposal.arguments,
          output: result.output,
          providerRunId: result.providerRunId,
          durationMs: result.durationMs,
          creditCost: result.creditCost,
        });
        await persistSkillHash(input.deps, input.run.id, proposal.name, result.output);
        const assets = result.assets?.length
          ? await input.assets.persist({
              chatId: input.run.chatId,
              runId: input.run.id,
              toolCallId: proposal.id,
              assets: result.assets,
              signal,
            })
          : [];
        if (assets.length) {
          await input.deps.store.saveGeneratedAssets({
            run: input.run,
            toolInvocationId: saved.id,
            assets,
          });
        }
        const settled = await input.credits.settleTool({
          run: input.run,
          toolCallId: proposal.id,
          toolInvocationId: saved.id,
          toolName: proposal.name,
          cost: result.creditCost,
        });
        publishTool(input, {
          toolCallId: proposal.id,
          toolName: proposal.name,
          status: "SUCCESS",
        });
        void (input.deps.webhooks ?? noopWebhooks)
          .emit({
            userId: input.run.userId,
            event: "tool.completed",
            agentRunId: input.run.id,
            toolInvocationId: saved.id,
            idempotencySuffix: proposal.id,
            payload: {
              chatId: input.run.chatId,
              runId: input.run.id,
              messageId: input.assistantMessageId,
              traceId: input.traceId,
              toolCallId: proposal.id,
              toolName: proposal.name,
              output: result.output,
              assets,
              creditCost: result.creditCost,
              durationMs: result.durationMs,
            },
          })
          .catch(() => undefined);
        const blocks: ContentBlock[] = [
          {
            type: "tool_use",
            toolCallId: proposal.id,
            toolName: proposal.name,
            input: proposal.arguments,
          },
          {
            type: "tool_result",
            toolCallId: proposal.id,
            toolName: proposal.name,
            output: result.output,
            durationMs: result.durationMs,
          },
          ...assets.map(
            (asset): ContentBlock => ({
              type: "asset",
              url: asset.url,
              mimeType: asset.mimeType,
              filename: asset.filename,
            }),
          ),
        ];
        if (settled.exhausted) {
          batchAbort.abort();
          resolveShared?.(blocks);
          await flush(blocks);
          return {
            index,
            aborted: new ToolError(
              "CREDITS_INSUFFICIENT",
              "Credits ran out during this turn. Earlier results were kept.",
              { retryable: false },
            ),
            block: blocks,
          };
        }
        resolveShared?.(blocks);
        await flush(blocks);
        return { index, block: blocks };
      } catch (error) {
        const cancelled = input.deps.signal.aborted || batchAbort.signal.aborted || isCancelled(error);
        if (cancelled) {
          batchAbort.abort();
          await persistInvocationFailure({
            input,
            proposal,
            provider,
            toolSequence,
            error,
            status: "CANCELLED",
          });
          publishTool(input, {
            toolCallId: proposal.id,
            toolName: proposal.name,
            status: "CANCELLED",
            errorMessage: userSafeError(error),
          });
          const block = resultBlock(proposal, undefined, userSafeError(error));
          resolveShared?.(null);
          await flush(block);
          return {
            index,
            aborted: error instanceof ToolError || error instanceof LlmError
              ? error
              : new ToolError("CANCELLED", "The run was cancelled."),
            block,
          };
        }
        await persistInvocationFailure({
          input,
          proposal,
          provider,
          toolSequence,
          error,
          status: "FAILED",
        });
        publishTool(input, {
          toolCallId: proposal.id,
          toolName: proposal.name,
          status: "FAILED",
          errorMessage: userSafeError(error),
        });
        const block = resultBlock(proposal, undefined, userSafeError(error));
        resolveShared?.(null);
        await flush(block);
        return {
          index,
          block,
        };
      }
    }),
  );

  await persistTail;
  started.sort((a, b) => a.index - b.index);
  const aborted = started.find((item) => item.aborted)?.aborted;
  return { blocks: started.flatMap((item) => item.block), aborted };
}

async function executeToolWithRetry(input: {
  registry: ToolRegistry;
  children: ChildTaskRunner;
  name: string;
  raw: unknown;
  ctx: Parameters<typeof executeRegisteredTool>[0]["ctx"];
  signal: AbortSignal;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TOOL_ATTEMPTS; attempt += 1) {
    try {
      return await executeRegisteredTool({
        registry: input.registry,
        children: input.children,
        name: input.name,
        raw: input.raw,
        ctx: { ...input.ctx, signal: input.signal },
      });
    } catch (error) {
      lastError = error;
      if (isCancelled(error) || input.signal.aborted) {
        throw error instanceof ToolError || error instanceof LlmError
          ? error
          : new ToolError("CANCELLED", "The run was cancelled.");
      }
      if (error instanceof ToolError && error.retryable && attempt < MAX_TOOL_ATTEMPTS - 1) {
        await sleep(2_000 * (attempt + 1), input.signal);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function persistInvocationFailure(input: {
  input: {
    run: RunSnapshot;
    deps: AgentLoopDeps;
  };
  proposal: LlmToolCallProposal;
  provider: "MAGICA" | "E2B" | "EXA" | "SKILL" | "INTERNAL";
  toolSequence: number;
  error: unknown;
  status: "FAILED" | "CANCELLED";
}): Promise<void> {
  try {
    await input.input.deps.store.upsertToolInvocation({
      run: input.input.run,
      toolCallId: input.proposal.id,
      toolName: input.proposal.name,
      provider: input.provider,
      sequence: input.toolSequence,
      status: input.status,
      payload: input.proposal.arguments,
      errorCode: input.error instanceof ToolError ? input.error.code : input.status,
      errorMessage: userSafeError(input.error),
    });
  } catch {
    // Best-effort: the run is already aborting or failing.
  }
}

async function persistSkillHash(
  deps: AgentLoopDeps,
  runId: string,
  toolName: string,
  output: unknown,
): Promise<void> {
  if (!output || typeof output !== "object") return;
  const record = output as Record<string, unknown>;
  const hash = typeof record.contentHash === "string" ? record.contentHash : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  if (!hash || !name) return;
  if (toolName === TOOL_NAMES.loadSkill) {
    await deps.store.saveRunSkill({
      runId,
      skillName: name,
      contentHash: hash,
      assetPath: "",
    });
  }
  if (toolName === TOOL_NAMES.readSkillAsset) {
    const assetPath = typeof record.path === "string" ? record.path : "";
    await deps.store.saveRunSkill({
      runId,
      skillName: name,
      contentHash: hash,
      assetPath,
    });
  }
}

async function persistAssistant(
  deps: AgentLoopDeps,
  messageId: string,
  blocks: ContentBlock[],
  extras: {
    promptTokens: number;
    completionTokens: number;
    status: "STREAMING" | "SUCCESS" | "FAILED" | "CANCELLED";
    errorCode?: string;
    errorMessage?: string;
  },
  progress?: {
    live: RunMetadata;
    realtime: RealtimePublisher;
    thinkingStartedAt: Date;
  },
): Promise<void> {
  await deps.store.saveAssistant({
    messageId,
    blocks,
    ...extras,
  });
  if (!progress) return;
  progress.live.assistant = {
    id: messageId,
    status: extras.status,
    contentBlocks: blocks,
  };
  publishLive(progress.realtime, progress.live, progress.thinkingStartedAt, {});
}

async function terminate(
  deps: AgentLoopDeps,
  run: RunSnapshot,
  assistantMessageId: string,
  blocks: ContentBlock[],
  live: RunMetadata,
  realtime: RealtimePublisher,
  extras: {
    status: "COMPLETE" | "FAILED" | "CANCELLED";
    promptTokens: number;
    completionTokens: number;
    modelRouted?: string;
    thinkingStartedAt: Date;
    errorCode?: string;
    errorMessage?: string;
    userText?: string;
  },
): Promise<{ status: "COMPLETE" | "FAILED" | "CANCELLED"; assistantMessageId: string }> {
  const messageStatus =
    extras.status === "COMPLETE"
      ? "SUCCESS"
      : extras.status === "CANCELLED"
        ? "CANCELLED"
        : "FAILED";
  await persistAssistant(
    deps,
    assistantMessageId,
    blocks,
    {
      promptTokens: extras.promptTokens,
      completionTokens: extras.completionTokens,
      status: messageStatus,
      errorCode: extras.errorCode,
      errorMessage: extras.errorMessage,
    },
    { live, realtime, thinkingStartedAt: extras.thinkingStartedAt },
  );
  const credits = deps.credits ?? noopCredits;
  let settledCredits: string | undefined;
  try {
    const finalized = await credits.finalizeRun({
      run,
      promptTokens: extras.promptTokens,
      completionTokens: extras.completionTokens,
      modelRouted: extras.modelRouted,
    });
    settledCredits = finalized.settledCredits;
  } catch {
    settledCredits = undefined;
  }
  await deps.store.updateRun({
    runId: run.id,
    chatId: run.chatId,
    assistantMessageId,
    status: extras.status,
    currentStep: extras.status.toLowerCase(),
    modelRouted: extras.modelRouted,
    promptTokens: extras.promptTokens,
    completionTokens: extras.completionTokens,
    thinkingDurationMs: Date.now() - extras.thinkingStartedAt.getTime(),
    settledCredits,
    errorCode: extras.errorCode ?? null,
    errorMessage: extras.errorMessage ?? null,
    completedAt: new Date(),
  });
  live.waitpoint = null;
  publishLive(realtime, live, extras.thinkingStartedAt, {
    status: extras.status,
    currentStep: extras.status.toLowerCase(),
    errorCode: extras.errorCode ?? null,
    errorMessage: extras.errorMessage ?? null,
  });
  await realtime.flush();
  if (extras.status === "COMPLETE") {
    try {
      await deps.store.rememberProjectTurn(run.chatId, extras.userText ?? "");
    } catch {
      // Memory must not fail the turn.
    }
  }
  return { status: extras.status, assistantMessageId };
}

function syntheticMalformed(
  malformed: Array<{ id?: string; name?: string; rawArguments: string; error: string }>,
): LlmToolCallProposal[] {
  return malformed.map((item, index) => ({
    id: item.id ?? `malformed_${index}`,
    name: item.name ?? "unknown",
    arguments: { error: item.error, raw: item.rawArguments },
    rawArguments: item.rawArguments,
  }));
}

function resultBlock(
  proposal: LlmToolCallProposal,
  output: unknown,
  error: string | null,
): ContentBlock[] {
  return [
    {
      type: "tool_use",
      toolCallId: proposal.id,
      toolName: proposal.name,
      input: proposal.arguments,
    },
    {
      type: "tool_result",
      toolCallId: proposal.id,
      toolName: proposal.name,
      output: error ? undefined : output,
      error: error ?? undefined,
    },
  ];
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new LlmError("CANCELLED", "The run was cancelled.");
  }
}

function isCancelled(error: unknown): boolean {
  return (
    (error instanceof LlmError && error.code === "CANCELLED") ||
    (error instanceof ToolError && error.code === "CANCELLED") ||
    (error instanceof Error && (error.name === "AbortError" || error.name.startsWith("ToolError:CANCELLED:")))
  );
}

function codeOf(error: unknown): string {
  if (error instanceof LlmError) return error.code;
  if (error instanceof ToolError) return error.code;
  return "FAILED";
}

function userSafeError(error: unknown): string {
  if (error instanceof LlmError || error instanceof ToolError) return error.message;
  return "The agent turn failed.";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new LlmError("CANCELLED", "The run was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmError("CANCELLED", "The run was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createLiveMetadata(run: RunSnapshot, assistantMessageId: string): RunMetadata {
  return {
    chatId: run.chatId,
    runId: run.id,
    messageId: run.userMessageId,
    assistantMessageId,
    status: "THINKING",
    currentStep: "thinking",
    thinkingDurationMs: 0,
    progressPercent: progressFor("THINKING"),
    tools: [],
    waitpoint: null,
    assistant: {
      id: assistantMessageId,
      status: "STREAMING",
      contentBlocks: [],
    },
    errorCode: null,
    errorMessage: null,
  };
}

const STREAM_META_MS = 40;
const STREAM_PERSIST_MS = 250;

type TokenSink = {
  push(token: string): void;
  reset(): void;
  flush(): Promise<void>;
};

function createTokenSink(input: {
  assistantId: string;
  priorBlocks: ContentBlock[];
  live: RunMetadata;
  realtime: RealtimePublisher;
  thinkingStartedAt: Date;
  persist: (blocks: ContentBlock[]) => Promise<void>;
}): TokenSink {
  let streamed = "";
  let lastMeta = 0;
  let lastPersist = 0;
  let persistTail = Promise.resolve();

  const blocksFor = (text: string) =>
    text ? appendBlocks(input.priorBlocks, { type: "text", text }) : [...input.priorBlocks];

  const publish = (text: string) => {
    input.live.assistant = {
      id: input.assistantId,
      status: "STREAMING",
      contentBlocks: blocksFor(text),
    };
    publishLive(input.realtime, input.live, input.thinkingStartedAt, {});
  };

  return {
    push(token: string) {
      if (!token) return;
      streamed += token;
      void input.realtime.appendText(token);
      const now = Date.now();
      if (lastMeta === 0 || now - lastMeta >= STREAM_META_MS) {
        lastMeta = now;
        publish(streamed);
      }
      if (now - lastPersist >= STREAM_PERSIST_MS) {
        lastPersist = now;
        const snapshot = streamed;
        persistTail = persistTail.then(() => input.persist(blocksFor(snapshot)));
      }
    },
    reset() {
      streamed = "";
      lastMeta = 0;
      lastPersist = 0;
    },
    async flush() {
      if (streamed) publish(streamed);
      await persistTail;
    },
  };
}

function publishLive(
  realtime: RealtimePublisher,
  live: RunMetadata,
  thinkingStartedAt: Date,
  patch: Partial<Pick<RunMetadata, "status" | "currentStep" | "errorCode" | "errorMessage">>,
): void {
  if (patch.status) live.status = patch.status;
  if (patch.currentStep !== undefined) live.currentStep = patch.currentStep;
  if (patch.errorCode !== undefined) live.errorCode = patch.errorCode;
  if (patch.errorMessage !== undefined) live.errorMessage = patch.errorMessage;
  live.thinkingDurationMs = Date.now() - thinkingStartedAt.getTime();
  live.progressPercent = progressFor(live.status);
  realtime.publish({
    ...live,
    tools: live.tools.map((tool) => ({ ...tool })),
    waitpoint: live.waitpoint ? { ...live.waitpoint } : null,
  });
}

function publishTool(
  input: { live: RunMetadata; realtime: RealtimePublisher; thinkingStartedAt: Date },
  tool: ToolLive,
): void {
  input.live.tools = upsertToolLive(input.live.tools, tool);
  publishLive(input.realtime, input.live, input.thinkingStartedAt, {});
}

async function requestApproval(input: {
  deps: AgentLoopDeps;
  run: RunSnapshot;
  live: RunMetadata;
  realtime: RealtimePublisher;
  thinkingStartedAt: Date;
  type: WaitpointKind;
  currentStep: string;
  idempotencyKey: string;
  payload: unknown;
}): Promise<WaitpointApproval> {
  await input.deps.store.updateRun({
    runId: input.run.id,
    chatId: input.run.chatId,
    status: "WAITING",
    currentStep: input.currentStep,
    thinkingDurationMs: Date.now() - input.thinkingStartedAt.getTime(),
  });
  publishLive(input.realtime, input.live, input.thinkingStartedAt, {
    status: "WAITING",
    currentStep: input.currentStep,
  });
  const decision = await input.deps.waitpoints.awaitApproval({
    type: input.type,
    run: input.run,
    idempotencyKey: input.idempotencyKey,
    timeout: input.deps.waitTimeout,
    payload: input.payload,
    onOpen: (overlay) => {
      input.live.waitpoint = overlay;
      publishLive(input.realtime, input.live, input.thinkingStartedAt, {
        status: "WAITING",
        currentStep: input.currentStep,
      });
    },
  });
  input.live.waitpoint = null;
  publishLive(input.realtime, input.live, input.thinkingStartedAt, {});
  return decision;
}

async function maybeCreditWait(input: {
  deps: AgentLoopDeps;
  run: RunSnapshot;
  live: RunMetadata;
  realtime: RealtimePublisher;
  thinkingStartedAt: Date;
  turn: number;
  proposals: LlmToolCallProposal[];
}): Promise<WaitpointApproval | null> {
  const estimates = await estimateBatch(input.deps.registry, input.proposals);
  if (estimates.total.lte(0)) return null;
  const spent = await input.deps.store.spentCredits(input.run.id);
  const remaining = remainingReserved(input.run.reservedCredits, spent);
  if (estimates.total.lte(remaining)) return null;
  return requestApproval({
    ...input,
    type: "CREDIT",
    currentStep: "wait:credit",
    idempotencyKey: `run:${input.run.id}:wait:credit:${input.turn}`,
    payload: {
      estimatedCredits: estimates.total.toString(),
      remainingCredits: remaining.toString(),
      tools: estimates.tools,
    },
  });
}

async function estimateBatch(
  registry: ToolRegistry,
  proposals: LlmToolCallProposal[],
): Promise<{ tools: Array<{ name: string; credits: string }>; total: Prisma.Decimal }> {
  const tools: Array<{ name: string; credits: string }> = [];
  let total = new Prisma.Decimal(0);
  for (const proposal of proposals) {
    const credits = await estimateOne(registry, proposal);
    tools.push({ name: proposal.name, credits: credits.toString() });
    total = total.plus(credits);
  }
  return { tools, total };
}

async function estimateOne(
  registry: ToolRegistry,
  proposal: LlmToolCallProposal,
): Promise<Prisma.Decimal> {
  try {
    return new Prisma.Decimal(await registry.estimateCredits(proposal.name, proposal.arguments));
  } catch {
    return new Prisma.Decimal(0);
  }
}

function remainingReserved(reserved: string, spent: Prisma.Decimal): Prisma.Decimal {
  const left = new Prisma.Decimal(reserved).minus(spent);
  return left.isNegative() ? new Prisma.Decimal(0) : left;
}
