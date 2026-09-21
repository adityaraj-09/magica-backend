import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../errors.js";
import { resolveInside } from "../../skills/paths.js";
import { MAX_ASSET_BYTES, SkillRegistry, sha256 } from "../../skills/registry.js";
import {
  loadSkillInputSchema,
  loadSkillOutputSchema,
  readSkillAssetInputSchema,
  readSkillAssetOutputSchema,
} from "../schemas.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";
import type { SkillLoaderAdapter } from "./types.js";
import { throwIfAborted } from "./http.js";

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".yml", ".yaml"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const ALLOWED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...BINARY_EXTENSIONS]);

const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export class FilesystemSkillLoaderAdapter implements SkillLoaderAdapter {
  constructor(private readonly registry: SkillRegistry) {}

  listMetadata() {
    return this.registry.listMetadata();
  }

  async loadSkill(
    raw: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult<ReturnType<typeof loadSkillOutputSchema.parse>>> {
    throwIfAborted(ctx.signal, "Skill load cancelled");
    const input = loadSkillInputSchema.parse(raw);
    const started = Date.now();
    const skill = this.registry.get(input.name);
    const output = loadSkillOutputSchema.parse({
      name: skill.name,
      description: skill.description,
      body: skill.body,
      contentHash: skill.contentHash,
    });
    return {
      output,
      creditCost: "0",
      providerRunId: skill.contentHash,
      durationMs: Date.now() - started,
    };
  }

  async readSkillAsset(
    raw: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult<ReturnType<typeof readSkillAssetOutputSchema.parse>>> {
    throwIfAborted(ctx.signal, "Skill asset read cancelled");
    const input = readSkillAssetInputSchema.parse(raw);
    const started = Date.now();
    const skill = this.registry.get(input.name);
    const absolute = resolveInside(skill.root, input.path);

    if (path.basename(absolute) === "SKILL.md") {
      throw new ToolError("INVALID_INPUT", "Use load_skill to read SKILL.md");
    }

    const extension = path.extname(absolute).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new ToolError("INVALID_INPUT", "Skill asset type is not allowed");
    }

    const stat = await lstat(absolute).catch(() => undefined);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new ToolError("INVALID_INPUT", "Skill asset was not found");
    }
    if (stat.size > MAX_ASSET_BYTES) {
      throw new ToolError("INVALID_INPUT", "Skill asset exceeds the size limit");
    }

    const bytes = await readFile(absolute);
    const isText = TEXT_EXTENSIONS.has(extension);
    const output = readSkillAssetOutputSchema.parse({
      name: skill.name,
      path: input.path,
      contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
      content: isText ? bytes.toString("utf8") : bytes.toString("base64"),
      contentHash: sha256(bytes),
    });

    return {
      output,
      creditCost: "0",
      providerRunId: output.contentHash,
      durationMs: Date.now() - started,
    };
  }
}

let cachedLoader: Promise<SkillLoaderAdapter> | undefined;
let cachedRootsKey: string | undefined;

function skillRoots(env: NodeJS.ProcessEnv): string[] {
  return (env.SKILLS_DIR ?? "agent-skills")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function rootsKey(env: NodeJS.ProcessEnv): string {
  return skillRoots(env).join("\0");
}

/**
 * Process-wide SkillRegistry. Concurrent callers share one disk scan;
 * a failed load is not cached so the next call can retry.
 */
export async function createSkillLoaderAdapter(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillLoaderAdapter> {
  const key = rootsKey(env);
  if (!cachedLoader || cachedRootsKey !== key) {
    cachedRootsKey = key;
    const pending = SkillRegistry.load(skillRoots(env))
      .then((registry) => new FilesystemSkillLoaderAdapter(registry))
      .catch((error: unknown) => {
        if (cachedLoader === pending) {
          cachedLoader = undefined;
          cachedRootsKey = undefined;
        }
        throw error;
      });
    cachedLoader = pending;
  }
  return cachedLoader;
}

export function resetSkillLoaderAdapter(): void {
  cachedLoader = undefined;
  cachedRootsKey = undefined;
}
