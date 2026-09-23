import { z } from "zod";
import { TOOL_NAMES } from "./types";

const urlSchema = z.string().url();

const cropRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const cropImageInputSchema = z
  .object({
    image_url: urlSchema,
    crop: cropRectSchema.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    x_percent: z.number().min(0).max(100).optional(),
    y_percent: z.number().min(0).max(100).optional(),
    width_percent: z.number().min(0).max(100).optional(),
    height_percent: z.number().min(0).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    const hasCrop = value.crop !== undefined;
    const hasPixels =
      value.x !== undefined &&
      value.y !== undefined &&
      value.width !== undefined &&
      value.height !== undefined;
    const hasPercent =
      value.x_percent !== undefined &&
      value.y_percent !== undefined &&
      value.width_percent !== undefined &&
      value.height_percent !== undefined;

    if ([hasCrop, hasPixels, hasPercent].filter(Boolean).length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide exactly one complete rectangle: crop.{x,y,width,height}, pixel x/y/width/height, or percent coordinates",
      });
    }
  });

export const cropImageOutputSchema = z.object({
  image_url: urlSchema,
});

export const gptImage2InputSchema = z
  .object({
    prompt: z.string().min(1).max(4000),
    image_url: urlSchema.optional(),
  })
  .transform((value) => ({
    ...value,
    mode: value.image_url ? "gpt-image-2-edit" : "gpt-image-2-text",
  }));

export const gptImage2OutputSchema = z.object({
  image_url: urlSchema,
  mode: z.enum(["gpt-image-2-text", "gpt-image-2-edit"]),
  prompt: z.string().min(1).max(4000).optional(),
});

export const mergeVideosInputSchema = z.object({
  video_urls: z.array(urlSchema).min(2).max(100),
  transition: z.enum(["none", "fade", "dissolve"]).default("none"),
});

export const mergeVideosOutputSchema = z.object({
  video_url: urlSchema,
});

export const sandboxRunCodeInputSchema = z.object({
  language: z.enum(["python", "bash"]),
  code: z.string().min(1).max(100_000),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        url: urlSchema,
      }),
    )
    .max(20)
    .optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

export const sandboxRunCodeOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  artifacts: z.array(
    z.object({
      path: z.string(),
      url: urlSchema,
      mimeType: z.string(),
    }),
  ),
});

export const loadSkillInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Skill names are lowercase kebab-case"),
});

export const loadSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  contentHash: z.string(),
});

export const readSkillAssetInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  path: z.string().min(1).max(256),
});

export const readSkillAssetOutputSchema = z.object({
  name: z.string(),
  path: z.string(),
  contentType: z.string(),
  content: z.string(),
  contentHash: z.string(),
});

export const webSearchInputSchema = z.object({
  query: z.string().min(1).max(512),
  count: z.number().int().min(1).max(10).default(5),
  category: z
    .enum([
      "company",
      "people",
      "publication",
      "news",
      "personal site",
      "financial report",
    ])
    .optional(),
});

export const webSearchResultSchema = z.object({
  title: z.string(),
  url: urlSchema,
  snippet: z.string(),
  publishedDate: z.string().nullable(),
  author: z.string().nullable(),
});

export const webSearchOutputSchema = z.object({
  query: z.string(),
  provider: z.enum(["exa", "stub"]),
  results: z.array(webSearchResultSchema),
});

export type CropImageInput = z.output<typeof cropImageInputSchema>;
export type CropImageOutput = z.output<typeof cropImageOutputSchema>;
export type GptImage2Input = z.output<typeof gptImage2InputSchema>;
export type GptImage2Output = z.output<typeof gptImage2OutputSchema>;
export type MergeVideosInput = z.output<typeof mergeVideosInputSchema>;
export type MergeVideosOutput = z.output<typeof mergeVideosOutputSchema>;
export type SandboxRunCodeInput = z.output<typeof sandboxRunCodeInputSchema>;
export type SandboxRunCodeOutput = z.output<typeof sandboxRunCodeOutputSchema>;
export type LoadSkillInput = z.output<typeof loadSkillInputSchema>;
export type LoadSkillOutput = z.output<typeof loadSkillOutputSchema>;
export type ReadSkillAssetInput = z.output<typeof readSkillAssetInputSchema>;
export type ReadSkillAssetOutput = z.output<typeof readSkillAssetOutputSchema>;
export type WebSearchInput = z.output<typeof webSearchInputSchema>;
export type WebSearchOutput = z.output<typeof webSearchOutputSchema>;

export const TOOL_DESCRIPTIONS: Record<
  (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES],
  string
> = {
  [TOOL_NAMES.cropImage]:
    "Crop an image by pixel rectangle, percent rectangle, or crop.{x,y,width,height}. Returns a generated image URL.",
  [TOOL_NAMES.gptImage2]:
    "Generate a new image from a prompt, or edit an existing image when image_url is provided.",
  [TOOL_NAMES.mergeVideos]:
    "Merge 2–100 videos in the given order. Transition may be none, fade, or dissolve.",
  [TOOL_NAMES.sandboxRunCode]:
    "Run Python or bash for computation that is not image or video editing. Do not use this to crop, inspect, or download user images; those files are not in the sandbox. Use crop_image with the attached image URL instead.",
  [TOOL_NAMES.loadSkill]:
    "Load the full SKILL.md body for a named application skill. Call only when that skill is needed this turn.",
  [TOOL_NAMES.readSkillAsset]:
    "Read a file from an approved skill directory. Path traversal is rejected.",
  [TOOL_NAMES.webSearch]:
    "Search the live web and return titled results with URLs and snippets. Use for current facts, citations, and research.",
};
