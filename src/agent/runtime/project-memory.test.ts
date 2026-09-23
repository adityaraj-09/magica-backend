import { describe, expect, it } from "vitest";
import {
  PROJECT_MEMORY_CAP,
  compactMemoryNote,
  memoryUsedPercent,
  mergeProjectMemory,
} from "./project-memory";

describe("project memory", () => {
  it("skips tiny notes and trims long ones", () => {
    expect(compactMemoryNote("hi")).toBeNull();
    expect(compactMemoryNote("  generate icy mountains  ")).toBe("generate icy mountains");
    expect(compactMemoryNote("x".repeat(200))?.endsWith("...")).toBe(true);
  });

  it("appends unique notes and drops the oldest when over the cap", () => {
    const first = mergeProjectMemory("", "prefer wide landscapes");
    expect(first).toBe("- prefer wide landscapes");
    expect(mergeProjectMemory(first, "prefer wide landscapes")).toBe(first);

    const bulky = "n".repeat(PROJECT_MEMORY_CAP - 10);
    const overflowed = mergeProjectMemory(`- ${bulky}`, "keep using 16:9");
    expect(overflowed).toContain("keep using 16:9");
    expect(overflowed).not.toContain(bulky.slice(0, 20));
    expect(overflowed.length).toBeLessThanOrEqual(PROJECT_MEMORY_CAP);
  });

  it("reports used percent against the cap", () => {
    expect(memoryUsedPercent("")).toBe(0);
    expect(memoryUsedPercent("x".repeat(PROJECT_MEMORY_CAP))).toBe(100);
  });
});
