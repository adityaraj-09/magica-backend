import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../tools/errors.js";
import { parseSkillMarkdown } from "./parse.js";

export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_ASSET_BYTES = 512 * 1024;

export type SkillMetadata = {
  name: string;
  description: string;
};

export type SkillRecord = SkillMetadata & {
  root: string;
  skillFile: string;
  body: string;
  contentHash: string;
};

export class SkillRegistry {
  private constructor(private readonly skills: ReadonlyMap<string, SkillRecord>) {}

  static async load(roots: string[]): Promise<SkillRegistry> {
    if (roots.length === 0) {
      throw new ToolError("FAILED", "No approved skill directories configured");
    }

    const skills = new Map<string, SkillRecord>();
    for (const root of roots) {
      await scanRoot(path.resolve(root), skills);
    }
    if (skills.size === 0) {
      throw new ToolError("FAILED", "No valid skills were discovered");
    }
    return new SkillRegistry(skills);
  }

  get(name: string): SkillRecord {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new ToolError("INVALID_INPUT", `Unknown skill: ${name}`);
    }
    return skill;
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  listMetadata(): SkillMetadata[] {
    return [...this.skills.values()]
      .map(({ name, description }) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

async function scanRoot(root: string, skills: Map<string, SkillRecord>): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new ToolError("FAILED", `Skill directory is not readable: ${root}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillRoot = path.join(root, entry.name);
    const skillFile = path.join(skillRoot, "SKILL.md");
    const stat = await lstat(skillFile).catch(() => undefined);
    if (!stat) continue;
    const record = await loadSkillDir(skillRoot, entry.name);
    const existing = skills.get(record.name);
    if (existing) {
      throw new ToolError(
        "FAILED",
        `Duplicate skill name "${record.name}" in ${existing.root} and ${record.root}`,
      );
    }
    skills.set(record.name, record);
  }
}

async function loadSkillDir(skillRoot: string, folderName: string): Promise<SkillRecord> {
  const skillFile = path.join(skillRoot, "SKILL.md");
  const stat = await lstat(skillFile).catch(() => undefined);
  if (!stat) {
    throw new ToolError("FAILED", `Skill is missing SKILL.md: ${skillRoot}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) {
    throw new ToolError("FAILED", `Skill file is invalid or too large: ${skillFile}`);
  }

  const raw = await readFile(skillFile, "utf8");
  const parsed = parseSkillMarkdown(raw);
  if (parsed.frontmatter.name !== folderName) {
    throw new ToolError(
      "FAILED",
      `Skill folder "${folderName}" must match frontmatter name "${parsed.frontmatter.name}"`,
    );
  }

  return {
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    root: skillRoot,
    skillFile,
    body: parsed.body,
    contentHash: sha256(raw),
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
