import { describe, expect, it } from "vitest";
import {
  overlayFromWaitpoint,
  progressFor,
  runMetadataSchema,
  upsertToolLive,
} from "./realtime.js";

describe("run metadata", () => {
  it("maps live status to progress", () => {
    expect(progressFor("THINKING")).toBe(15);
    expect(progressFor("WAITING")).toBe(40);
    expect(progressFor("WORKING")).toBe(55);
    expect(progressFor("COMPLETE")).toBe(100);
  });

  it("upserts tools by toolCallId", () => {
    const running = upsertToolLive([], {
      toolCallId: "call_1",
      toolName: "crop_image",
      status: "RUNNING",
    });
    const done = upsertToolLive(running, {
      toolCallId: "call_1",
      toolName: "crop_image",
      status: "SUCCESS",
    });
    expect(done).toEqual([
      { toolCallId: "call_1", toolName: "crop_image", status: "SUCCESS" },
    ]);
  });

  it("builds a waitpoint overlay and accepts a full metadata snapshot", () => {
    const overlay = overlayFromWaitpoint({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      type: "PLAN",
      status: "WAITING",
      triggerWaitpointId: "waitpoint_1",
      publicAccessToken: "pat_wait",
      timeoutAt: new Date("2026-09-21T12:00:00.000Z"),
      payload: { text: "crop it" },
    });
    expect(overlay.timeoutAt).toBe("2026-09-21T12:00:00.000Z");
    expect(() =>
      runMetadataSchema.parse({
        chatId: "11111111-1111-1111-1111-111111111111",
        runId: "22222222-2222-2222-2222-222222222222",
        messageId: "33333333-3333-3333-3333-333333333333",
        assistantMessageId: null,
        status: "WAITING",
        currentStep: "wait:plan",
        thinkingDurationMs: 12,
        progressPercent: 40,
        tools: [],
        waitpoint: overlay,
        errorCode: null,
        errorMessage: null,
      }),
    ).not.toThrow();
  });
});
