import { describe, expect, it } from "vitest";
import { publicCompletionBodySchema } from "./completions";

describe("publicCompletionBodySchema", () => {
  it("accepts text, prompt, or the last user message", () => {
    expect(publicCompletionBodySchema.parse({ text: "hello" }).text).toBe("hello");
    expect(publicCompletionBodySchema.parse({ prompt: "draw a cat" }).text).toBe("draw a cat");
    expect(
      publicCompletionBodySchema.parse({
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "crop the image" },
        ],
      }).text,
    ).toBe("crop the image");
  });
});
