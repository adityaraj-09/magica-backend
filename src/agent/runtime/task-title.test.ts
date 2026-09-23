import { describe, expect, it } from "vitest";
import {
  cleanTaskTitle,
  fallbackTaskTitle,
  shouldSuggestTitle,
  suggestTaskTitle,
  userHasImage,
} from "./task-title";

describe("shouldSuggestTitle", () => {
  it("names placeholders and raw first-message titles", () => {
    expect(shouldSuggestTitle("New chat", "crop the right side")).toBe(true);
    expect(shouldSuggestTitle("New task", "crop the right side")).toBe(true);
    expect(shouldSuggestTitle("crop the right side", "crop the right side")).toBe(true);
    expect(shouldSuggestTitle("Crop the metrics panel", "crop the right side")).toBe(false);
    expect(shouldSuggestTitle("I'm sorry, I can’t see the image", "what is this")).toBe(true);
  });
});

describe("cleanTaskTitle", () => {
  it("keeps a short name and drops a placeholder", () => {
    expect(cleanTaskTitle('  "Crop the right side"  ')).toBe("Crop the right side");
    expect(cleanTaskTitle("Title: Crop the metrics")).toBe("Crop the metrics");
    expect(cleanTaskTitle("New chat")).toBeNull();
  });

  it("drops a vision-refusal used as a title", () => {
    expect(
      cleanTaskTitle("I'm sorry, I can’t see the image. Please upload or describe"),
    ).toBeNull();
  });
});

describe("fallbackTaskTitle", () => {
  it("names an image question Image review", () => {
    expect(fallbackTaskTitle("what is in this photo?", true)).toBe("Image review");
    expect(fallbackTaskTitle("crop the right side", true)).toBe("crop the right side");
  });
});

describe("userHasImage", () => {
  it("reads asset blocks and attachments", () => {
    expect(
      userHasImage([
        {
          role: "USER",
          status: "SUCCESS",
          searchText: "what is this",
          contentBlocks: [{ type: "asset", url: "https://cdn.example/a.png", mimeType: "image/png" }],
        },
      ]),
    ).toBe(true);
  });
});

describe("suggestTaskTitle", () => {
  it("does not keep a refusal from the title model", async () => {
    const title = await suggestTaskTitle(
      {
        complete: async () => ({
          text: "I'm sorry, I can’t see the image. Please upload or describe it.",
          reasoning: "",
          toolCalls: [],
          malformedToolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, cost: 0 },
        }),
      } as never,
      "what is in this photo?",
      new AbortController().signal,
      true,
    );
    expect(title).toBe("Image review");
  });
});
