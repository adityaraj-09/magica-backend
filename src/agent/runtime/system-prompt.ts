import type { SkillMetadata } from "@/agent/skills/registry";

export function buildSystemPrompt(
  skills: SkillMetadata[],
  project?: { instructions?: string; memory?: string },
): string {
  const catalog =
    skills.length === 0
      ? "No skills are installed."
      : skills
          .map((skill) => `- ${skill.name}: ${skill.description}`)
          .join("\n");

  const parts = [
    "You are Galaxy Agent, a helpful assistant.",
    "Answer with a normal reply when the user asks a question, wants an explanation, or wants a description of an attached image. Do not call tools for those turns.",
    "Call a tool only when the user asks to crop, generate, edit, merge, search the web, run code, or load a skill. An attached image is not a reason to call a tool.",
    "When a tool is needed and the user message lists attached file URLs, pass those URLs. Do not ask the user to paste a URL that is already attached.",
    "Cropping or editing an image uses crop_image or gpt_image_2 only. Do not call sandbox_run_code to inspect, download, or crop an image. The sandbox does not have the user's file.",
    "Do not mention API keys, provider secrets, or internal routing.",
    "Skills are listed below as name and description only. Call load_skill before following a skill's instructions, and read_skill_asset for files in that skill folder.",
    catalog,
  ];
  const instructions = project?.instructions?.trim();
  if (instructions) parts.push(`Project instructions:\n${instructions}`);
  const memory = project?.memory?.trim();
  if (memory) parts.push(`Project memory (facts from earlier chats in this project):\n${memory}`);
  return parts.join("\n\n");
}
