import { z } from "zod";

export const STREAM_IDS = {
  assistantText: "assistant-text",
} as const;

export const assistantTextChunkSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export type AssistantTextChunk = z.infer<typeof assistantTextChunkSchema>;

export const runLiveStatusSchema = z.enum([
  "QUEUED",
  "THINKING",
  "WORKING",
  "WAITING",
  "STOPPING",
  "COMPLETE",
  "FAILED",
  "CANCELLED",
]);

export const toolLiveStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
]);

export const toolLiveSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: toolLiveStatusSchema,
  errorMessage: z.string().nullable().optional(),
});

export const waitpointOverlaySchema = z.object({
  waitpointId: z.string().uuid(),
  type: z.enum(["OPTIONS", "PLAN", "CREDIT", "MEDIA"]),
  status: z.enum(["WAITING", "COMPLETED", "EXPIRED", "CANCELLED"]),
  triggerWaitpointId: z.string().min(1),
  publicAccessToken: z.string().nullable(),
  timeoutAt: z.string().datetime(),
  payload: z.unknown(),
});

export const liveAssistantSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  contentBlocks: z.array(z.unknown()),
});

export const runMetadataSchema = z.object({
  chatId: z.string().uuid(),
  runId: z.string().uuid(),
  messageId: z.string().uuid(),
  assistantMessageId: z.string().uuid().nullable(),
  status: runLiveStatusSchema,
  currentStep: z.string().nullable(),
  thinkingDurationMs: z.number().int().nonnegative().nullable(),
  progressPercent: z.number().int().min(0).max(100).nullable(),
  tools: z.array(toolLiveSchema),
  waitpoint: waitpointOverlaySchema.nullable(),
  assistant: liveAssistantSchema.nullable().optional(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
      credits: z.string(),
      model: z.string().nullable().optional(),
      durationMs: z.number().int().nonnegative().nullable().optional(),
    })
    .optional(),
});

export type ToolLive = z.infer<typeof toolLiveSchema>;
export type WaitpointOverlay = z.infer<typeof waitpointOverlaySchema>;
export type RunMetadata = z.infer<typeof runMetadataSchema>;

export type RealtimePublisher = {
  publish(snapshot: RunMetadata): void;
  appendText(chunk: string): Promise<void>;
  flush(): Promise<void>;
};

export const noopRealtime: RealtimePublisher = {
  publish() {},
  async appendText() {},
  async flush() {},
};

export function progressFor(
  status: RunMetadata["status"],
): number {
  switch (status) {
    case "QUEUED":
      return 0;
    case "THINKING":
      return 15;
    case "WAITING":
      return 40;
    case "WORKING":
      return 55;
    case "STOPPING":
      return 80;
    case "COMPLETE":
    case "FAILED":
    case "CANCELLED":
      return 100;
  }
}

export function upsertToolLive(tools: ToolLive[], next: ToolLive): ToolLive[] {
  const index = tools.findIndex((tool) => tool.toolCallId === next.toolCallId);
  if (index < 0) return [...tools, next];
  const copy = [...tools];
  copy[index] = { ...copy[index], ...next };
  return copy;
}

export function overlayFromWaitpoint(row: {
  id: string;
  type: "OPTIONS" | "PLAN" | "CREDIT" | "MEDIA";
  status: "WAITING" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  triggerWaitpointId: string;
  publicAccessToken: string | null;
  timeoutAt: Date;
  payload: unknown;
}): WaitpointOverlay {
  return waitpointOverlaySchema.parse({
    waitpointId: row.id,
    type: row.type,
    status: row.status,
    triggerWaitpointId: row.triggerWaitpointId,
    publicAccessToken: row.publicAccessToken,
    timeoutAt: row.timeoutAt.toISOString(),
    payload: row.payload,
  });
}
