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

  it("accepts image_urls and OpenAI image parts", () => {
    expect(
      publicCompletionBodySchema.parse({
        text: "what is this",
        image_urls: ["https://cdn.example/a.png"],
        image_url: "https://cdn.example/b.jpg",
      }).imageUrls,
    ).toEqual(["https://cdn.example/a.png", "https://cdn.example/b.jpg"]);

    expect(
      publicCompletionBodySchema.parse({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image_url", image_url: { url: "https://cdn.example/c.webp" } },
            ],
          },
        ],
      }),
    ).toMatchObject({
      text: "describe this",
      imageUrls: ["https://cdn.example/c.webp"],
    });
  });
});
