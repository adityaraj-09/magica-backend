import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillRegistry } from "@/agent/skills/registry";
import {
  createSkillLoaderAdapter,
  resetSkillLoaderAdapter,
} from "@/agent/tools/adapters/skills";
import { createAgentRuntime, resetAgentRuntime } from "./create-runtime";

function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    MAGICA_API_KEY: "test-magica",
    E2B_API_KEY: "test-e2b",
    SKILLS_DIR: "agent-skills",
    ...overrides,
  };
}

afterEach(() => {
  resetAgentRuntime();
  vi.restoreAllMocks();
});

describe("createAgentRuntime singleton", () => {
  it("reuses the same ToolRegistry and SkillLoader across calls", async () => {
    const first = await createAgentRuntime(testEnv());
    const second = await createAgentRuntime(testEnv());
    expect(second.registry).toBe(first.registry);
    expect(second.skills).toBe(first.skills);
  });

  it("scans skills once when concurrent callers race", async () => {
    const load = vi.spyOn(SkillRegistry, "load");
    const env = testEnv();
    const [a, b] = await Promise.all([
      createAgentRuntime(env),
      createAgentRuntime(env),
    ]);
    expect(a.registry).toBe(b.registry);
    expect(a.skills).toBe(b.skills);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed build", async () => {
    await expect(createAgentRuntime(testEnv({ MAGICA_API_KEY: "" }))).rejects.toThrow(
      /MAGICA_API_KEY/,
    );
    const recovered = await createAgentRuntime(testEnv());
    expect(recovered.registry.listForAgent().length).toBeGreaterThan(0);
  });

  it("loads a new catalog after reset", async () => {
    const first = await createAgentRuntime(testEnv());
    resetAgentRuntime();
    const second = await createAgentRuntime(testEnv());
    expect(second.registry).not.toBe(first.registry);
    expect(second.skills).not.toBe(first.skills);
  });
});

describe("createSkillLoaderAdapter singleton", () => {
  afterEach(() => {
    resetSkillLoaderAdapter();
  });

  it("reuses one SkillRegistry scan for the same roots", async () => {
    const load = vi.spyOn(SkillRegistry, "load");
    const env = testEnv();
    const [first, second] = await Promise.all([
      createSkillLoaderAdapter(env),
      createSkillLoaderAdapter(env),
    ]);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first.listMetadata().map((skill) => skill.name).sort()).toEqual([
      "image-editing",
      "sandbox-python",
      "video-merge",
    ]);
  });
});
