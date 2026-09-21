import { TOOL_NAMES } from "./types.js";
import { TOOL_DESCRIPTIONS } from "./schemas.js";
import {
  cropImageInputSchema,
  cropImageOutputSchema,
  gptImage2InputSchema,
  gptImage2OutputSchema,
  loadSkillInputSchema,
  loadSkillOutputSchema,
  mergeVideosInputSchema,
  mergeVideosOutputSchema,
  readSkillAssetInputSchema,
  readSkillAssetOutputSchema,
  sandboxRunCodeInputSchema,
  sandboxRunCodeOutputSchema,
  webSearchInputSchema,
  webSearchOutputSchema,
} from "./schemas.js";
import type { ToolAdapters } from "./adapters/types.js";
import { ToolRegistry } from "./registry.js";

const ZERO_CREDITS = "0";

/**
 * Builds the single tool catalog. Adding a tool means: Zod schemas + adapter
 * method + one register() call. The agent loop does not change.
 */
export function createToolRegistry(adapters: ToolAdapters): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: TOOL_NAMES.cropImage,
    description: TOOL_DESCRIPTIONS.crop_image,
    provider: "MAGICA",
    availability: "required",
    execution: "child_task",
    queue: "magica",
    rendererKey: "generated-image",
    input: cropImageInputSchema,
    output: cropImageOutputSchema,
    estimateCredits: () => ZERO_CREDITS,
    execute: (input, ctx) => adapters.magica.cropImage(input, ctx),
  });

  registry.register({
    name: TOOL_NAMES.gptImage2,
    description: TOOL_DESCRIPTIONS.gpt_image_2,
    provider: "MAGICA",
    availability: "required",
    execution: "child_task",
    queue: "magica",
    rendererKey: "generated-image",
    input: gptImage2InputSchema,
    output: gptImage2OutputSchema,
    estimateCredits: () => ZERO_CREDITS,
    execute: (input, ctx) => adapters.magica.gptImage2(input, ctx),
  });

  registry.register({
    name: TOOL_NAMES.mergeVideos,
    description: TOOL_DESCRIPTIONS.merge_videos,
    provider: "MAGICA",
    availability: "required",
    execution: "child_task",
    queue: "magica",
    rendererKey: "generated-video",
    input: mergeVideosInputSchema,
    output: mergeVideosOutputSchema,
    estimateCredits: () => ZERO_CREDITS,
    execute: (input, ctx) => adapters.magica.mergeVideos(input, ctx),
  });

  registry.register({
    name: TOOL_NAMES.sandboxRunCode,
    description: TOOL_DESCRIPTIONS.sandbox_run_code,
    provider: "E2B",
    availability: "required",
    execution: "child_task",
    queue: "e2b-sandbox",
    rendererKey: "sandbox-code",
    input: sandboxRunCodeInputSchema,
    output: sandboxRunCodeOutputSchema,
    estimateCredits: () => ZERO_CREDITS,
    execute: (input, ctx) => adapters.e2b.runCode(input, ctx),
  });

  registry.register({
    name: TOOL_NAMES.loadSkill,
    description: TOOL_DESCRIPTIONS.load_skill,
    provider: "SKILL",
    availability: "required",
    execution: "inline",
    rendererKey: "skill",
    input: loadSkillInputSchema,
    output: loadSkillOutputSchema,
    estimateCredits: () => ZERO_CREDITS,
    execute: (input, ctx) => adapters.skills.loadSkill(input, ctx),
  });

  registry.register({
    name: TOOL_NAMES.readSkillAsset,
    description: TOOL_DESCRIPTIONS.read_skill_asset,
    provider: "SKILL",
    availability: "required",
    execution: "inline",
    rendererKey: "skill-asset",
    input: readSkillAssetInputSchema,
    output: readSkillAssetOutputSchema,
    estimateCredits: () => ZERO_CREDITS,
    execute: (input, ctx) => adapters.skills.readSkillAsset(input, ctx),
  });

  if (adapters.webSearch) {
    const webSearch = adapters.webSearch;
    registry.register({
      name: TOOL_NAMES.webSearch,
      description: TOOL_DESCRIPTIONS.web_search,
      provider: "EXA",
      availability: "optional",
      execution: "child_task",
      queue: "exa",
      rendererKey: "web-search",
      input: webSearchInputSchema,
      output: webSearchOutputSchema,
      estimateCredits: () => ZERO_CREDITS,
      execute: (input, ctx) => webSearch.search(input, ctx),
    });
  }

  return registry;
}
