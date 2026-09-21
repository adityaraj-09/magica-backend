import { z } from "zod";

export const toolProviderSchema = z.enum([
  "MAGICA",
  "E2B",
  "EXA",
  "SKILL",
  "INTERNAL",
]);

export type ToolProvider = z.infer<typeof toolProviderSchema>;

export const TOOL_NAMES = {
  cropImage: "crop_image",
  gptImage2: "gpt_image_2",
  mergeVideos: "merge_videos",
  sandboxRunCode: "sandbox_run_code",
  loadSkill: "load_skill",
  readSkillAsset: "read_skill_asset",
  webSearch: "web_search",
} as const;

export const toolNameSchema = z.enum([
  TOOL_NAMES.cropImage,
  TOOL_NAMES.gptImage2,
  TOOL_NAMES.mergeVideos,
  TOOL_NAMES.sandboxRunCode,
  TOOL_NAMES.loadSkill,
  TOOL_NAMES.readSkillAsset,
  TOOL_NAMES.webSearch,
]);

export type ToolName = z.infer<typeof toolNameSchema>;

export type JsonSchema = Record<string, unknown>;

/** OpenRouter / OpenAI function-calling tool payload. */
export type OpenRouterTool = {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: JsonSchema;
  };
};

export type GeneratedAsset = {
  url: string;
  mimeType: string;
  filename?: string;
  width?: number;
  height?: number;
};

export type ToolExecutionContext = {
  chatId: string;
  userId: string;
  runId: string;
  messageId: string;
  toolCallId: string;
  traceId: string;
  signal: AbortSignal;
};

export type ToolExecutionResult<TOutput> = {
  output: TOutput;
  /** Application credits to settle exactly once for this toolCallId. */
  creditCost: string;
  providerRunId?: string;
  durationMs: number;
  assets?: GeneratedAsset[];
};

export type ToolAvailability = "required" | "optional";

export type ToolExecutionMode = "inline" | "child_task";

export type ToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> = {
  name: ToolName;
  description: string;
  provider: ToolProvider;
  availability: ToolAvailability;
  execution: ToolExecutionMode;
  /** Trigger.dev queue when execution is child_task. */
  queue?: string;
  /** Frontend result-card renderer. Adding a tool should only add a renderer keyed by this. */
  rendererKey: string;
  input: TInput;
  output: TOutput;
  estimateCredits: (input: z.infer<TInput>) => string | Promise<string>;
  execute: (
    input: z.infer<TInput>,
    ctx: ToolExecutionContext,
  ) => Promise<ToolExecutionResult<z.infer<TOutput>>>;
};

export type AnyToolDefinition = ToolDefinition<z.ZodType, z.ZodType>;
