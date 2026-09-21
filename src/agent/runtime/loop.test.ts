import { describe, expect, it, vi } from "vitest";
import { OPENROUTER_FREE_ROUTE } from "@/agent/llm/types.js";
import type { ChatClient, ChatCompletionResult } from "@/agent/llm/types.js";
import { ToolRegistry } from "@/agent/tools/registry.js";
import {
  loadSkillInputSchema,
  loadSkillOutputSchema,
} from "@/agent/tools/schemas.js";
import { TOOL_NAMES } from "@/agent/tools/types.js";
import { runAgentLoop, type AgentLoopDeps } from "./loop.js";
import type { AgentStore, RunSnapshot } from "./store.js";
import type { ContentBlock } from "./content-blocks.js";

const ids = {
  chatId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
  messageId: "44444444-4444-4444-4444-444444444444",
  assistantId: "55555555-5555-5555-5555-555555555555",
};

const run: RunSnapshot = {
  id: ids.runId,
  chatId: ids.chatId,
  userId: ids.userId,
  userMessageId: ids.messageId,
  status: "QUEUED",
  triggerRunId: null,
};

function completion(partial: Partial<ChatCompletionResult>): ChatCompletionResult {
  return {
    text: "",
    reasoning: "",
    toolCalls: [],
    malformedToolCalls: [],
    finishReason: "stop",
    modelRequested: OPENROUTER_FREE_ROUTE,
    modelRouted: "deepseek/deepseek-r1:free",
    usage: { promptTokens: 3, completionTokens: 2, cost: 0 },
    ...partial,
  };
}

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: TOOL_NAMES.loadSkill,
    description: "Load a skill",
    provider: "SKILL",
    availability: "required",
    execution: "inline",
    rendererKey: "skill",
    input: loadSkillInputSchema,
    output: loadSkillOutputSchema,
    estimateCredits: () => "0",
    execute: async (input) => ({
      output: {
        name: input.name,
        description: "desc",
        body: "body",
        contentHash: "hash_skill",
      },
      creditCost: "0",
      durationMs: 4,
    }),
  });
  return registry;
}

function createDeps(llm: ChatClient, extras: Partial<AgentLoopDeps> = {}): AgentLoopDeps {
  let blocks: ContentBlock[] = [];
  const skills: Array<{ skillName: string; contentHash: string; assetPath: string }> = [];
  const store = {
    getRun: vi.fn(async () => run),
    listHistory: vi.fn(async () => [
      {
        role: "USER" as const,
        status: "SUCCESS",
        searchText: "hi",
        contentBlocks: [{ type: "text", text: "hi" }],
      },
    ]),
    ensureAssistantMessage: vi.fn(async () => ({ id: ids.assistantId, blocks })),
    saveAssistant: vi.fn(async (input: { blocks: ContentBlock[] }) => {
      blocks = input.blocks;
    }),
    getToolInvocation: vi.fn(async () => null),
    nextToolSequence: vi.fn(async () => 1),
    upsertToolInvocation: vi.fn(async () => ({ id: "inv_1" })),
    saveRunSkill: vi.fn(async (input: (typeof skills)[number]) => {
      skills.push(input);
    }),
    saveGeneratedAssets: vi.fn(async () => undefined),
    saveWaitpoint: vi.fn(async () => undefined),
    finishWaitpoint: vi.fn(async () => undefined),
    getWaitpoint: vi.fn(async () => null),
    updateRun: vi.fn(async () => undefined),
    skills,
  };

  return {
    store: store as unknown as AgentStore,
    llm,
    registry: createRegistry(),
    skills: [{ name: "image-editing", description: "Edit images" }],
    children: { run: vi.fn() },
    waitpoints: { awaitApproval: vi.fn(async () => "approved" as const) },
    maxTurns: 4,
    waitTimeout: "1m",
    signal: new AbortController().signal,
    ...extras,
  };
}

const turn = {
  ...ids,
  traceId: "trace_1",
  triggerRunId: "tr_run_1",
};

describe("runAgentLoop", () => {
  it("persists a terminal assistant message when the model stops", async () => {
    const llm: ChatClient = {
      complete: vi.fn(async () => completion({ text: "hello there", finishReason: "stop" })),
    };
    const deps = createDeps(llm);
    const result = await runAgentLoop(turn, deps);
    expect(result.status).toBe("COMPLETE");
    expect(deps.store.saveAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCESS",
        blocks: [expect.objectContaining({ type: "text", text: "hello there" })],
      }),
    );
    expect(deps.store.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "COMPLETE", modelRouted: "deepseek/deepseek-r1:free" }),
    );
    expect(deps.children.run).not.toHaveBeenCalled();
  });

  it("executes load_skill through the registry and persists the content hash", async () => {
    const llm: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          completion({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call_skill",
                name: "load_skill",
                arguments: { name: "image-editing" },
                rawArguments: '{"name":"image-editing"}',
              },
            ],
          }),
        )
        .mockResolvedValueOnce(completion({ text: "skill loaded", finishReason: "stop" })),
    };
    const deps = createDeps(llm);
    const result = await runAgentLoop(turn, deps);
    expect(result.status).toBe("COMPLETE");
    expect(deps.store.listHistory).toHaveBeenCalledTimes(1);
    expect(llm.complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "hi" }),
        ]),
      }),
    );
    expect(deps.store.saveRunSkill).toHaveBeenCalledWith({
      runId: ids.runId,
      skillName: "image-editing",
      contentHash: "hash_skill",
      assetPath: "",
    });
    expect(deps.children.run).not.toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  it("stops at a rejected plan waitpoint without executing tools", async () => {
    const llm: ChatClient = {
      complete: vi.fn(async () =>
        completion({
          text: "I will crop",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "call_skill",
              name: "load_skill",
              arguments: { name: "image-editing" },
              rawArguments: '{"name":"image-editing"}',
            },
          ],
        }),
      ),
    };
    const deps = createDeps(llm, {
      waitpoints: { awaitApproval: vi.fn(async () => "rejected" as const) },
    });
    const result = await runAgentLoop({ ...turn, planMode: true }, deps);
    expect(result.status).toBe("CANCELLED");
    expect(deps.store.upsertToolInvocation).not.toHaveBeenCalled();
    expect(deps.waitpoints.awaitApproval).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PLAN", idempotencyKey: `run:${ids.runId}:wait:plan` }),
    );
  });

  it("reloads chat history from Postgres on a new loop invocation", async () => {
    const llm: ChatClient = {
      complete: vi.fn(async () => completion({ text: "ok", finishReason: "stop" })),
    };
    const deps = createDeps(llm);
    await runAgentLoop(turn, deps);
    await runAgentLoop(turn, deps);
    expect(deps.store.listHistory).toHaveBeenCalledTimes(2);
  });
});
