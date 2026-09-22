import { describe, expect, it } from "vitest";
import { createMagicaAdapter } from "./magica";
import { gptImage2InputSchema } from "../schemas";
import type { ToolExecutionContext } from "../types";

const live = process.env.MAGICA_LIVE === "1" && Boolean(process.env.MAGICA_API_KEY?.trim());

const SAMPLE_IMAGE =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/240px-PNG_transparency_demonstration_1.png";

const SAMPLE_VIDEOS = [
  process.env.MAGICA_SAMPLE_VIDEO_A?.trim() ||
    "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
  process.env.MAGICA_SAMPLE_VIDEO_B?.trim() ||
    "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
];

function ctx(toolCallId: string): ToolExecutionContext {
  return {
    chatId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
    messageId: "44444444-4444-4444-4444-444444444444",
    toolCallId,
    traceId: "live-magica",
    signal: new AbortController().signal,
  };
}

describe.skipIf(!live)("Magica live success paths", () => {
  const timeout = 10 * 60_000;

  function adapter() {
    return createMagicaAdapter();
  }

  it(
    "crops a public image",
    async () => {
      const result = await adapter().cropImage(
        {
          image_url: SAMPLE_IMAGE,
          x_percent: 10,
          y_percent: 10,
          width_percent: 80,
          height_percent: 80,
        },
        ctx("live_crop"),
      );
      expect(result.output.image_url).toMatch(/^https?:\/\//);
      expect(result.assets?.[0]?.url).toBe(result.output.image_url);
    },
    timeout,
  );

  it(
    "generates an image with GPT Image 2",
    async () => {
      const result = await adapter().gptImage2(
        gptImage2InputSchema.parse({
          prompt: "a simple red square on a white background, flat vector",
        }),
        ctx("live_gpt"),
      );
      expect(result.output.image_url).toMatch(/^https?:\/\//);
      expect(result.output.mode).toBe("gpt-image-2-text");
    },
    timeout,
  );

  it(
    "merges two sample videos",
    async () => {
      const result = await adapter().mergeVideos(
        { video_urls: SAMPLE_VIDEOS, transition: "none" },
        ctx("live_merge"),
      );
      expect(result.output.video_url).toMatch(/^https?:\/\//);
    },
    timeout,
  );

  it(
    "chains generate then crop",
    async () => {
      const generated = await adapter().gptImage2(
        gptImage2InputSchema.parse({ prompt: "a solid blue circle centered on white, no text" }),
        ctx("live_chain_gen"),
      );
      const cropped = await adapter().cropImage(
        {
          image_url: generated.output.image_url,
          x_percent: 15,
          y_percent: 15,
          width_percent: 70,
          height_percent: 70,
        },
        ctx("live_chain_crop"),
      );
      expect(cropped.output.image_url).toMatch(/^https?:\/\//);
      expect(cropped.output.image_url).not.toBe(generated.output.image_url);
    },
    timeout,
  );
});
