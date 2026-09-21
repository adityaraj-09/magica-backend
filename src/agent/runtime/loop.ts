import { LlmError } from "@/agent/llm/errors.js";
import type { ChatClient, LlmMessage, LlmToolCallProposal } from "@/agent/llm/types.js";
import { ToolError } from "@/agent/tools/errors.js";
import type { ToolRegistry } from "@/agent/tools/registry.js";
import type { SkillMetadata } from "@/agent/skills/registry.js";
import { TOOL_NAMES } from "@/agent/tools/types.js";
import { appendBlocks, type ContentBlock } from "./content-blocks.js";
import { executeRegisteredTool, type ChildTaskRunner } from "./execute-tool.js";
import { messagesToLlm } from "./history.js";
import { AgentStore, type RunSnapshot } from "./store.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { WaitpointGateway } from "./waitpoint.js";

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
  const priorMessages = messagesToLlm(
    (await deps.store.listHistory(run.chatId)).filter(
      (message) => message.role !== "ASSISTANT" || message.status !== "STREAMING",
    ),
  );
  let promptTokens = 0;
  let completionTokens = 0;
  let modelRouted: string | undefined;
  const thinkingStartedAt = new Date();
  let planWaitPending = Boolean(input.planMode);

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

      const llmMessages = buildMessages(deps, priorMessages, blocks);
      const completion = await completeWithRetry(deps, llmMessages);
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

      await persistAssistant(deps, assistant.id, blocks, {
        promptTokens,
        completionTokens,
        status: proposals.length > 0 ? "STREAMING" : "SUCCESS",
      });

      if (proposals.length === 0) {
        return terminate(deps, run, assistant.id, blocks, {
          status: "COMPLETE",
          promptTokens,
          completionTokens,
          modelRouted,
          thinkingStartedAt,
        });
      }

      if (planWaitPending) {
        await deps.store.updateRun({
          runId: run.id,
          chatId: run.chatId,
          status: "WAITING",
          currentStep: "wait:plan",
          modelRouted,
        });
        const decision = await deps.waitpoints.awaitApproval({
          type: "PLAN",
          run,
          idempotencyKey: `run:${run.id}:wait:plan`,
          timeout: deps.waitTimeout,
          payload: {
            text: completion.text,
            tools: proposals.map((call) => ({
              name: call.name,
              arguments: call.arguments,
            })),
          },
        });
        if (decision !== "approved") {
          return terminate(deps, run, assistant.id, blocks, {
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

      const executed = await executeProposals({
        run,
        assistantMessageId: assistant.id,
        proposals,
        liveBlocks: blocks,
        deps,
      });
      blocks = appendBlocks(blocks, executed.blocks);
      if (executed.aborted) {
        throw executed.aborted;
      }
      await persistAssistant(deps, assistant.id, blocks, {
        promptTokens,
        completionTokens,
        status: "STREAMING",
      });
    }

    return terminate(deps, run, assistant.id, blocks, {
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
    return terminate(deps, run, assistant.id, blocks, {
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

function buildMessages(
  deps: AgentLoopDeps,
  priorMessages: LlmMessage[],
  liveBlocks: ContentBlock[],
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
    { role: "system", content: buildSystemPrompt(deps.skills) },
    ...priorMessages,
    ...live,
  ];
}

async function completeWithRetry(deps: AgentLoopDeps, messages: LlmMessage[]) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await deps.llm.complete({
        messages,
        tools: deps.registry.listForAgent(),
        signal: deps.signal,
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

  const started = await Promise.all(
    jobs.map(async ({ proposal, sequence: toolSequence }, index) => {
      const existing = await input.deps.store.getToolInvocation(
        input.run.id,
        proposal.id,
      );
      if (existing?.status === "SUCCESS") {
        const already = input.liveBlocks.some(
          (block) => block.type === "tool_result" && block.toolCallId === proposal.id,
        );
        return {
          index,
          block: already ? [] : resultBlock(proposal, existing.output, existing.errorMessage),
        };
      }

      let provider: "MAGICA" | "E2B" | "EXA" | "SKILL" | "INTERNAL" = "INTERNAL";
      try {
        const tool = input.deps.registry.get(proposal.name);
        provider = tool.provider;
        await input.deps.store.upsertToolInvocation({
          run: input.run,
          toolCallId: proposal.id,
          toolName: proposal.name,
          provider,
          sequence: toolSequence,
          status: "RUNNING",
          payload: proposal.arguments,
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
            traceId: input.run.id,
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
        if (result.assets?.length) {
          await input.deps.store.saveGeneratedAssets({
            run: input.run,
            toolInvocationId: saved.id,
            assets: result.assets,
          });
        }
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
          },
          ...(result.assets ?? []).map(
            (asset): ContentBlock => ({
              type: "asset",
              url: asset.url,
              mimeType: asset.mimeType,
              filename: asset.filename,
            }),
          ),
        ];
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
          return {
            index,
            aborted: error instanceof ToolError || error instanceof LlmError
              ? error
              : new ToolError("CANCELLED", "The run was cancelled."),
            block: resultBlock(proposal, undefined, userSafeError(error)),
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
        return {
          index,
          block: resultBlock(proposal, undefined, userSafeError(error)),
        };
      }
    }),
  );

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
): Promise<void> {
  await deps.store.saveAssistant({
    messageId,
    blocks,
    ...extras,
  });
}

async function terminate(
  deps: AgentLoopDeps,
  run: RunSnapshot,
  assistantMessageId: string,
  blocks: ContentBlock[],
  extras: {
    status: "COMPLETE" | "FAILED" | "CANCELLED";
    promptTokens: number;
    completionTokens: number;
    modelRouted?: string;
    thinkingStartedAt: Date;
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<{ status: "COMPLETE" | "FAILED" | "CANCELLED"; assistantMessageId: string }> {
  const messageStatus =
    extras.status === "COMPLETE"
      ? "SUCCESS"
      : extras.status === "CANCELLED"
        ? "CANCELLED"
        : "FAILED";
  await persistAssistant(deps, assistantMessageId, blocks, {
    promptTokens: extras.promptTokens,
    completionTokens: extras.completionTokens,
    status: messageStatus,
    errorCode: extras.errorCode,
    errorMessage: extras.errorMessage,
  });
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
    errorCode: extras.errorCode ?? null,
    errorMessage: extras.errorMessage ?? null,
    completedAt: new Date(),
  });
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
