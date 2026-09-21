import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ToolError } from "../tools/errors.js";

const frontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Skill names are lowercase kebab-case"),
  description: z.string().min(1).max(512),
});

export type SkillFrontmatter = z.infer<typeof frontmatterSchema>;

export type ParsedSkillFile = {
  frontmatter: SkillFrontmatter;
  body: string;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillMarkdown(raw: string): ParsedSkillFile {
  const match = FRONTMATTER.exec(raw);
  if (!match) {
    throw new ToolError("INVALID_INPUT", "Skill file is missing YAML frontmatter");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    throw new ToolError("INVALID_INPUT", "Skill frontmatter is not valid YAML");
  }

  const frontmatter = frontmatterSchema.safeParse(parsed);
  if (!frontmatter.success) {
    throw new ToolError("INVALID_INPUT", "Skill frontmatter must include name and description");
  }

  return {
    frontmatter: frontmatter.data,
    body: (match[2] ?? "").trim(),
  };
}
