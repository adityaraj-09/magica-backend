import { describe, expect, it } from "vitest";
import { ToolError, toolErrorFromUnknown } from "./errors";

describe("toolErrorFromUnknown", () => {
  it("preserves code and retryable from the wire name", () => {
    const error = toolErrorFromUnknown({
      type: "BUILT_IN_ERROR",
      name: "ToolError:RATE_LIMITED:retryable",
      message: "Magica is rate limited. Try again shortly.",
    });
    expect(error).toBeInstanceOf(ToolError);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
  });

  it("maps Trigger cancellation codes", () => {
    const error = toolErrorFromUnknown({
      type: "INTERNAL_ERROR",
      code: "TASK_RUN_CANCELLED",
      message: "Run cancelled",
    });
    expect(error.code).toBe("CANCELLED");
  });
});
