import { describe, expect, it } from "vitest";
import { messagesToLlm, LLM_TOOL_RESULT_MAX_CHARS } from "./history.js";

describe("messagesToLlm", () => {
  it("turns assistant tool blocks into assistant + tool messages", () => {
    const messages = messagesToLlm([
      {
        role: "USER",
        status: "SUCCESS",
        searchText: "crop this",
        contentBlocks: [{ type: "text", text: "crop this" }],
      },
      {
        role: "ASSISTANT",
        status: "SUCCESS",
        searchText: "done",
        contentBlocks: [
          { type: "text", text: "I'll crop it" },
          {
            type: "tool_use",
            toolCallId: "call_1",
            toolName: "crop_image",
            input: { image_url: "https://x/a.png", x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 50 },
          },
          {
            type: "tool_result",
            toolCallId: "call_1",
            toolName: "crop_image",
            output: { image_url: "https://x/b.png" },
          },
          { type: "text", text: "done" },
        ],
      },
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const assistant = messages[1];
    expect(assistant?.role).toBe("assistant");
    if (assistant?.role === "assistant") {
      expect(assistant.tool_calls?.[0]?.id).toBe("call_1");
    }
    expect(messages[3]).toMatchObject({ role: "assistant", content: "done" });
  });

  it("truncates large tool results for the LLM and keeps skill bodies intact", () => {
    const huge = "x".repeat(LLM_TOOL_RESULT_MAX_CHARS + 200);
    const messages = messagesToLlm([
      {
        role: "ASSISTANT",
        status: "STREAMING",
        searchText: "",
        contentBlocks: [
          {
            type: "tool_use",
            toolCallId: "call_crop",
            toolName: "crop_image",
            input: {},
          },
          {
            type: "tool_result",
            toolCallId: "call_crop",
            toolName: "crop_image",
            output: { blob: huge },
          },
          {
            type: "tool_use",
            toolCallId: "call_skill",
            toolName: "load_skill",
            input: { name: "image-editing" },
          },
          {
            type: "tool_result",
            toolCallId: "call_skill",
            toolName: "load_skill",
            output: { name: "image-editing", body: huge, contentHash: "abc" },
          },
        ],
      },
    ]);
    const crop = messages.find((message) => message.role === "tool" && message.tool_call_id === "call_crop");
    const skill = messages.find((message) => message.role === "tool" && message.tool_call_id === "call_skill");
    expect(crop?.role).toBe("tool");
    expect(skill?.role).toBe("tool");
    if (crop?.role === "tool") {
      expect(crop.content.length).toBeLessThan(huge.length);
      expect(crop.content).toContain("truncated");
    }
    if (skill?.role === "tool") {
      expect(skill.content).toContain(huge);
    }
  });
});
