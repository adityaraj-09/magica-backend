import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cropImageInputSchema } from "./schemas";
import { toOpenRouterParameters } from "./json-schema";

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) walk(child, visit);
}

describe("toOpenRouterParameters", () => {
  it("never emits boolean exclusiveMinimum that OpenRouter rejects", () => {
    const schema = toOpenRouterParameters(
      z.object({
        width: z.number().positive(),
        height: z.number().positive().optional(),
      }),
    );
    walk(schema, (node) => {
      if ("exclusiveMinimum" in node) {
        expect(typeof node.exclusiveMinimum).toBe("number");
      }
      if ("exclusiveMaximum" in node) {
        expect(typeof node.exclusiveMaximum).toBe("number");
      }
    });
  });

  it("publishes crop_image with numeric exclusive bounds", () => {
    const schema = toOpenRouterParameters(cropImageInputSchema);
    expect(schema.type).toBe("object");
    walk(schema, (node) => {
      expect(node.exclusiveMinimum).not.toBe(true);
      expect(node.exclusiveMinimum).not.toBe(false);
    });
  });
});
