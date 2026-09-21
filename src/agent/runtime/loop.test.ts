import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { OPENROUTER_FREE_ROUTE } from "@/agent/llm/types.js";
import type { ChatClient, ChatCompletionResult } from "@/agent/llm/types.js";
import { ToolError } from "@/agent/tools/errors.js";
import { ToolRegistry } from "@/agent/tools/registry.js";
import {
  cropImageInputSchema,
  cropImageOutputSchema,
  loadSkillInputSchema,
  loadSkillOutputSchema,
} from "@/agent/tools/schemas.js";
import { TOOL_NAMES } from "@/agent/tools/types.js";
import { runAgentLoop, type AgentLoopDeps } from "./loop.js";
import type { AgentStore, RunSnapshot } from "./store.js";
import type { ContentBlock } from "./content-blocks.js";
import { LLM_TOOL_RESULT_MAX_CHARS } from "./history.js";

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
  reservedCredits: "10",
  settledCredits: "0",
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

function createRegistry(
  execute?: (input: { name: string }) => Promise<{
    output: { name: string; description: string; body: string; contentHash: string };
    creditCost: string;
    durationMs: number;
  }>,
): ToolRegistry {
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
    execute: execute
      ? (input) => execute(input)
      : async (input) => ({
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

function skillCall(id = "call_skill") {
  return {
    id,
    name: "load_skill" as const,
    arguments: { name: "image-editing" },
    rawArguments: '{"name":"image-editing"}',
  };
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
    spentCredits: vi.fn(async () => new Prisma.Decimal(0)),
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
    realtime: {
      publish: vi.fn(),
      appendText: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    },
    credits: {
      spendable: vi.fn(async () => new Prisma.Decimal("1000000")),
      settleTool: vi.fn(async () => ({
        replayed: false,
        exhausted: false,
        charged: "0",
        settledCredits: "0",
      })),
      finalizeRun: vi.fn(async () => ({
        replayed: false,
        refunded: "10",
        settledCredits: "0",
      })),
    },
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

  it("waits for plan approval only on the first tool batch", async () => {
    const llm: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          completion({
            finishReason: "tool_calls",
            toolCalls: [skillCall("call_1")],
          }),
        )
        .mockResolvedValueOnce(
          completion({
            finishReason: "tool_calls",
            toolCalls: [skillCall("call_2")],
          }),
        )
        .mockResolvedValueOnce(completion({ text: "done", finishReason: "stop" })),
    };
    const deps = createDeps(llm, {
      waitpoints: { awaitApproval: vi.fn(async () => "approved" as const) },
    });
    const result = await runAgentLoop({ ...turn, planMode: true }, deps);
    expect(result.status).toBe("COMPLETE");
    expect(deps.waitpoints.awaitApproval).toHaveBeenCalledTimes(1);
  });

  it("marks the run CANCELLED when a tool is aborted", async () => {
    const llm: ChatClient = {
      complete: vi.fn(async () =>
        completion({
          finishReason: "tool_calls",
          toolCalls: [skillCall()],
        }),
      ),
    };
    const deps = createDeps(llm, {
      registry: createRegistry(async () => {
        throw new ToolError("CANCELLED", "Skill load cancelled");
      }),
    });
    const result = await runAgentLoop(turn, deps);
    expect(result.status).toBe("CANCELLED");
    expect(deps.store.upsertToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED", errorCode: "CANCELLED" }),
    );
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limited tool and keeps the original error code if it still fails", async () => {
    vi.useFakeTimers();
    const llm: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          completion({
            finishReason: "tool_calls",
            toolCalls: [skillCall()],
          }),
        )
        .mockResolvedValueOnce(completion({ text: "recovered", finishReason: "stop" })),
    };
    const execute = vi.fn(async () => {
      throw new ToolError("RATE_LIMITED", "Free models are rate limited. Try again shortly.");
    });
    const deps = createDeps(llm, { registry: createRegistry(execute) });
    const pending = runAgentLoop(turn, deps);
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();
    expect(result.status).toBe("COMPLETE");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(deps.store.upsertToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        errorCode: "RATE_LIMITED",
        errorMessage: "Free models are rate limited. Try again shortly.",
      }),
    );
  });

  it("sends truncated tool results to the LLM while persisting the full output", async () => {
    const huge = `https://cdn.example/${"a".repeat(LLM_TOOL_RESULT_MAX_CHARS)}`;
    const registry = new ToolRegistry();
    registry.register({
      name: TOOL_NAMES.cropImage,
      description: "Crop",
      provider: "MAGICA",
      availability: "required",
      execution: "inline",
      rendererKey: "generated-image",
      input: cropImageInputSchema,
      output: cropImageOutputSchema,
      estimateCredits: () => "0",
      execute: async () => ({
        output: { image_url: huge },
        creditCost: "0",
        durationMs: 2,
      }),
    });
    const llm: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          completion({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call_crop",
                name: "crop_image",
                arguments: {
                  image_url: "https://cdn.example/in.png",
                  x_percent: 0,
                  y_percent: 0,
                  width_percent: 50,
                  height_percent: 50,
                },
                rawArguments: "{}",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(completion({ text: "cropped", finishReason: "stop" })),
    };
    const deps = createDeps(llm, { registry });
    await runAgentLoop(turn, deps);
    const second = vi.mocked(llm.complete).mock.calls[1]?.[0];
    const toolMessage = second?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role === "tool") {
      expect(toolMessage.content).toContain("truncated");
      expect(toolMessage.content).not.toContain(huge);
    }
    expect(deps.store.saveAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: "tool_result", output: { image_url: huge } }),
        ]),
      }),
    );
  });

  it("streams tokens and publishes run metadata", async () => {
    const llm: ChatClient = {
      complete: vi.fn(async (request) => {
        request.onToken?.("Hel");
        request.onToken?.("lo");
        return completion({ text: "Hello", finishReason: "stop" });
      }),
    };
    const deps = createDeps(llm);
    await runAgentLoop(turn, deps);
    expect(deps.realtime?.appendText).toHaveBeenCalledWith("Hel");
    expect(deps.realtime?.appendText).toHaveBeenCalledWith("lo");
    expect(deps.realtime?.publish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "THINKING", runId: ids.runId }),
    );
    expect(deps.realtime?.publish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "COMPLETE", waitpoint: null }),
    );
    expect(deps.realtime?.flush).toHaveBeenCalled();
  });

  it("opens a credit waitpoint when the batch estimate exceeds remaining reserve", async () => {
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
      estimateCredits: () => "50",
      execute: async (input) => ({
        output: {
          name: input.name,
          description: "desc",
          body: "body",
          contentHash: "hash_skill",
        },
        creditCost: "50",
        durationMs: 4,
      }),
    });
    const llm: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          completion({ finishReason: "tool_calls", toolCalls: [skillCall()] }),
        )
        .mockResolvedValueOnce(completion({ text: "ok", finishReason: "stop" })),
    };
    const awaitApproval = vi.fn(async () => "approved" as const);
    const deps = createDeps(llm, { registry, waitpoints: { awaitApproval } });
    await runAgentLoop(turn, deps);
    expect(awaitApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CREDIT",
        idempotencyKey: `run:${ids.runId}:wait:credit:1`,
      }),
    );
  });

  it("opens a media waitpoint after generated assets", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: TOOL_NAMES.cropImage,
      description: "Crop",
      provider: "MAGICA",
      availability: "required",
      execution: "inline",
      rendererKey: "generated-image",
      input: cropImageInputSchema,
      output: cropImageOutputSchema,
      estimateCredits: () => "0",
      execute: async () => ({
        output: { image_url: "https://cdn.example/out.png" },
        creditCost: "0",
        durationMs: 2,
        assets: [{ url: "https://cdn.example/out.png", mimeType: "image/png" }],
      }),
    });
    const llm: ChatClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          completion({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call_crop",
                name: "crop_image",
                arguments: {
                  image_url: "https://cdn.example/in.png",
                  x_percent: 0,
                  y_percent: 0,
                  width_percent: 50,
                  height_percent: 50,
                },
                rawArguments: "{}",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(completion({ text: "cropped", finishReason: "stop" })),
    };
    const awaitApproval = vi.fn(async () => "approved" as const);
    const deps = createDeps(llm, { registry, waitpoints: { awaitApproval } });
    await runAgentLoop(turn, deps);
    expect(awaitApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MEDIA",
        idempotencyKey: `run:${ids.runId}:wait:media:1`,
        payload: expect.objectContaining({
          assets: [expect.objectContaining({ url: "https://cdn.example/out.png" })],
        }),
      }),
    );
  });

  it("finalizes credits on a completed turn", async () => {
    const llm: ChatClient = {
      complete: vi.fn(async () => completion({ text: "hello there", finishReason: "stop" })),
    };
    const deps = createDeps(llm);
    await runAgentLoop(turn, deps);
    expect(deps.credits?.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ id: ids.runId }),
        promptTokens: 3,
        completionTokens: 2,
      }),
    );
  });

  it("keeps a successful tool result when credits run out mid-turn", async () => {
    const llm: ChatClient = {
      complete: vi.fn(async () =>
        completion({
          finishReason: "tool_calls",
          toolCalls: [skillCall()],
        }),
      ),
    };
    const deps = createDeps(llm, {
      credits: {
        spendable: vi.fn(async () => new Prisma.Decimal("1000000")),
        settleTool: vi.fn(async () => ({
          replayed: false,
          exhausted: true,
          charged: "10",
          settledCredits: "50",
        })),
        finalizeRun: vi.fn(async () => ({
          replayed: false,
          refunded: "0",
          settledCredits: "50",
        })),
      },
    });
    const result = await runAgentLoop(turn, deps);
    expect(result.status).toBe("FAILED");
    expect(deps.store.saveAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "CREDITS_INSUFFICIENT",
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: "tool_result", output: expect.anything() }),
        ]),
      }),
    );
    expect(deps.credits?.finalizeRun).toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("does not execute a tool when the estimate exceeds spendable credits", async () => {
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
      estimateCredits: () => "5",
      execute: async () => {
        throw new Error("should not run");
      },
    });
    const llm: ChatClient = {
      complete: vi.fn(async () =>
        completion({ finishReason: "tool_calls", toolCalls: [skillCall()] }),
      ),
    };
    const deps = createDeps(llm, {
      registry,
      credits: {
        spendable: vi.fn(async () => new Prisma.Decimal("1")),
        settleTool: vi.fn(),
        finalizeRun: vi.fn(async () => ({
          replayed: false,
          refunded: "10",
          settledCredits: "0",
        })),
      },
    });
    const result = await runAgentLoop(turn, deps);
    expect(result.status).toBe("FAILED");
    expect(deps.credits?.settleTool).not.toHaveBeenCalled();
    expect(deps.store.upsertToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        errorCode: "CREDITS_INSUFFICIENT",
      }),
    );
  });
});
