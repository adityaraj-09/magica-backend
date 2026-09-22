import { describe, expect, it } from "vitest";
import { parseTurnReserve, reserveIdempotencyKey } from "./reserve";

describe("parseTurnReserve", () => {
  it("requires CREDIT_RESERVE_TURN", () => {
    expect(() => parseTurnReserve(undefined)).toThrow(/required/);
    expect(() => parseTurnReserve("")).toThrow(/required/);
  });

  it("rejects invalid and negative amounts", () => {
    expect(() => parseTurnReserve("nope")).toThrow(/number/);
    expect(() => parseTurnReserve("-1")).toThrow(/0 or more/);
  });

  it("accepts zero and decimals", () => {
    expect(parseTurnReserve("0").toString()).toBe("0");
    expect(parseTurnReserve("1.5").toString()).toBe("1.5");
  });
});

describe("reserveIdempotencyKey", () => {
  it("is stable per run", () => {
    expect(reserveIdempotencyKey("run_1")).toBe("run:run_1:reserve");
  });
});
