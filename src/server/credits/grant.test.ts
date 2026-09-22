import { describe, expect, it } from "vitest";
import { initialGrantIdempotencyKey, parseInitialCreditGrant } from "./grant";

describe("parseInitialCreditGrant", () => {
  it("requires CREDIT_GRANT_INITIAL", () => {
    expect(() => parseInitialCreditGrant(undefined)).toThrow(/required/);
    expect(() => parseInitialCreditGrant("")).toThrow(/required/);
    expect(() => parseInitialCreditGrant("  ")).toThrow(/required/);
  });

  it("rejects invalid and negative amounts", () => {
    expect(() => parseInitialCreditGrant("nope")).toThrow(/number/);
    expect(() => parseInitialCreditGrant("-1")).toThrow(/0 or more/);
  });

  it("accepts zero and decimal grants", () => {
    expect(parseInitialCreditGrant("0").toString()).toBe("0");
    expect(parseInitialCreditGrant("100.5").toString()).toBe("100.5");
  });
});

describe("initialGrantIdempotencyKey", () => {
  it("is stable per Clerk user", () => {
    expect(initialGrantIdempotencyKey("user_abc")).toBe("clerk:user_abc:grant:initial");
  });
});
