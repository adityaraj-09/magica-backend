import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import type {
  CropImageInput,
  CropImageOutput,
  GptImage2Input,
  GptImage2Output,
  LoadSkillInput,
  LoadSkillOutput,
  MergeVideosInput,
  MergeVideosOutput,
  ReadSkillAssetInput,
  ReadSkillAssetOutput,
  SandboxRunCodeInput,
  SandboxRunCodeOutput,
  WebSearchInput,
  WebSearchOutput,
} from "../schemas";

export type MagicaAdapter = {
  cropImage: (
    input: CropImageInput,
    ctx: ToolExecutionContext,
  ) => Promise<ToolExecutionResult<CropImageOutput>>;
  gptImage2: (
    input: GptImage2Input,
    ctx: ToolExecutionContext,
  ) => Promise<ToolExecutionResult<GptImage2Output>>;
  mergeVideos: (
    input: MergeVideosInput,
    ctx: ToolExecutionContext,
  ) => Promise<ToolExecutionResult<MergeVideosOutput>>;
};

export type E2BAdapter = {
  runCode: (
    input: SandboxRunCodeInput,
    ctx: ToolExecutionContext,
  ) => Promise<ToolExecutionResult<SandboxRunCodeOutput>>;
};

export type SkillLoaderAdapter = {
  listMetadata: () => { name: string; description: string }[];
  loadSkill: (
    input: LoadSkillInput,
    ctx: ToolExecutionContext,
  ) => Promise<ToolExecutionResult<LoadSkillOutput>>;
  readSkillAsset: (
    input: ReadSkillAssetInput,
    ctx: ToolExecutionContext,
  ) => Promise<ToolExecutionResult<ReadSkillAssetOutput>>;
};

export type WebSearchAdapter = {
  readonly provider: "exa" | "stub";
  search: (
    input: WebSearchInput,
    ctx: ToolExecutionContext,
  ) => Promise<ToolExecutionResult<WebSearchOutput>>;
};

export type ToolAdapters = {
  magica: MagicaAdapter;
  e2b: E2BAdapter;
  skills: SkillLoaderAdapter;
  /** Omit to keep web_search off the agent's tool list. */
  webSearch?: WebSearchAdapter;
};
