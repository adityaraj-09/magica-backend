import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt";

describe("buildSystemPrompt", () => {
  it("tells the model to answer questions without tools", () => {
    const prompt = buildSystemPrompt([{ name: "image-editing", description: "Edit images" }]);
    expect(prompt).toMatch(/Answer with a normal reply/);
    expect(prompt).toMatch(/Do not call tools for those turns/);
    expect(prompt).toMatch(/An attached image is not a reason to call a tool/);
    expect(prompt).toContain("image-editing");
  });

  it("includes project instructions and memory when provided", () => {
    const prompt = buildSystemPrompt([], {
      instructions: "Write in a dry tone.",
      memory: "- prefers icy mountains",
    });
    expect(prompt).toContain("Project instructions:\nWrite in a dry tone.");
    expect(prompt).toContain("Project memory (facts from earlier chats in this project):\n- prefers icy mountains");
  });
});
