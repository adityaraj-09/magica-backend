import { describe, expect, it, vi } from "vitest";
import { parseSendRateLimit } from "./rate-limit";

describe("parseSendRateLimit", () => {
  it("defaults to 20 sends per 60 seconds", () => {
    expect(parseSendRateLimit({})).toEqual({ limit: 20, windowMs: 60_000 });
  });

  it("reads positive integers from env", () => {
    expect(
      parseSendRateLimit({
        SEND_RATE_LIMIT_PER_MINUTE: "5",
        SEND_RATE_WINDOW_SECONDS: "30",
      }),
    ).toEqual({ limit: 5, windowMs: 30_000 });
  });

  it("rejects a non-positive limit", () => {
    expect(() => parseSendRateLimit({ SEND_RATE_LIMIT_PER_MINUTE: "0" })).toThrow(
      /positive integer/,
    );
  });
});
