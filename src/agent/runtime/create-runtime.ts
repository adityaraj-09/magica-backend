import { createE2BAdapter } from "@/agent/tools/adapters/e2b";
import { createWebSearchAdapter } from "@/agent/tools/adapters/exa";
import { createMagicaAdapter } from "@/agent/tools/adapters/magica";
import {
  createSkillLoaderAdapter,
  resetSkillLoaderAdapter,
} from "@/agent/tools/adapters/skills";
import type { SkillLoaderAdapter } from "@/agent/tools/adapters/types";
import { createToolRegistry } from "@/agent/tools/catalog";
import type { ToolRegistry } from "@/agent/tools/registry";

export type AgentRuntime = {
  registry: ToolRegistry;
  skills: SkillLoaderAdapter;
};

let cachedRuntime: Promise<AgentRuntime> | undefined;

/**
 * Process-wide ToolRegistry + SkillRegistry. Orchestrator tasks on the same
 * worker reuse one catalog and one skill scan instead of rebuilding per run.
 */
export async function createAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentRuntime> {
  cachedRuntime ??= buildAgentRuntime(env).catch((error: unknown) => {
    cachedRuntime = undefined;
    throw error;
  });
  return cachedRuntime;
}

export function resetAgentRuntime(): void {
  cachedRuntime = undefined;
  resetSkillLoaderAdapter();
}

async function buildAgentRuntime(env: NodeJS.ProcessEnv): Promise<AgentRuntime> {
  const skills = await createSkillLoaderAdapter(env);
  const registry = createToolRegistry({
    magica: createMagicaAdapter(env),
    e2b: createE2BAdapter(env),
    skills,
    webSearch: createWebSearchAdapter(env),
  });
  return { registry, skills };
}
