import { afterEach, describe, expect, it, vi } from "vitest";
import { logInfo, logWarn, traceFields } from "./log.js";

describe("traceFields", () => {
  it("keeps chatId, runId, messageId, and traceId", () => {
    expect(
      traceFields({
        chatId: "chat_1",
        runId: "run_1",
        messageId: "msg_1",
        traceId: "trace_1",
        processId: "tr_1",
        waitpointTokenId: "wait_1",
      }),
    ).toEqual({
      chatId: "chat_1",
      runId: "run_1",
      messageId: "msg_1",
      traceId: "trace_1",
      processId: "tr_1",
      waitpointTokenId: "wait_1",
    });
  });
});

describe("logInfo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one JSON line and strips secrets", () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logInfo("turn.admitted", {
      chatId: "chat_1",
      runId: "run_1",
      messageId: "msg_1",
      traceId: "trace_1",
      apiKey: "secret",
      replayed: false,
    });
    expect(info).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(info.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      level: "info",
      event: "turn.admitted",
      chatId: "chat_1",
      runId: "run_1",
      messageId: "msg_1",
      traceId: "trace_1",
      replayed: false,
    });
    expect(payload.apiKey).toBeUndefined();
  });

  it("writes warnings as JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logWarn("asset.copy_failed", { chatId: "chat_1", error: "410" });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      level: "warn",
      event: "asset.copy_failed",
      chatId: "chat_1",
    });
  });
});
