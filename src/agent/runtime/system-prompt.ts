import type { SkillMetadata } from "@/agent/skills/registry.js";

export function buildSystemPrompt(skills: SkillMetadata[]): string {
  const catalog =
    skills.length === 0
      ? "No skills are installed."
      : skills
          .map((skill) => `- ${skill.name}: ${skill.description}`)
          .join("\n");

  return [
    "You are Galaxy Agent, a helpful assistant that uses tools to edit images, merge videos, run sandboxed code, and load skills.",
    "Call tools when they are needed. Do not mention API keys, provider secrets, or internal routing.",
    "Skills are listed below as name and description only. Call load_skill before following a skill's instructions, and read_skill_asset for files in that skill folder.",
    catalog,
  ].join("\n\n");
}
