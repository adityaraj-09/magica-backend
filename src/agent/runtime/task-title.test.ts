import { describe, expect, it } from "vitest";
import { cleanTaskTitle, shouldSuggestTitle } from "./task-title";

describe("shouldSuggestTitle", () => {
  it("names placeholders and raw first-message titles", () => {
    expect(shouldSuggestTitle("New chat", "crop the right side")).toBe(true);
    expect(shouldSuggestTitle("New task", "crop the right side")).toBe(true);
    expect(shouldSuggestTitle("crop the right side", "crop the right side")).toBe(true);
    expect(shouldSuggestTitle("Crop the metrics panel", "crop the right side")).toBe(false);
  });
});

describe("cleanTaskTitle", () => {
  it("keeps a short name and drops a placeholder", () => {
    expect(cleanTaskTitle('  "Crop the right side"  ')).toBe("Crop the right side");
    expect(cleanTaskTitle("Title: Crop the metrics")).toBe("Crop the metrics");
    expect(cleanTaskTitle("New chat")).toBeNull();
  });
});
