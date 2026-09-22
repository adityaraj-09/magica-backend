import { describe, expect, it } from "vitest";
import {
  runFinalizeIdempotencyKey,
  runRefundIdempotencyKey,
  toolSettleIdempotencyKey,
} from "./keys";
import { reserveIdempotencyKey } from "./reserve";

describe("credit ledger keys", () => {
  it("are stable charge-once keys", () => {
    expect(toolSettleIdempotencyKey("call_1")).toBe("tool:call_1:settle");
    expect(runFinalizeIdempotencyKey("run_1")).toBe("run:run_1:finalize");
    expect(runRefundIdempotencyKey("run_1")).toBe("run:run_1:refund");
    expect(reserveIdempotencyKey("run_1")).toBe("run:run_1:reserve");
  });
});
