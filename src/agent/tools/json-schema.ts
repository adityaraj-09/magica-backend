import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema } from "./types";

/** OpenRouter validates tool parameters as JSON Schema draft-07 (numeric exclusiveMinimum). */
export function toOpenRouterParameters(schema: z.ZodType): JsonSchema {
  const json = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  const { $schema: _schema, ...rest } = json as JsonSchema & {
    $schema?: unknown;
  };
  return sanitizeExclusiveBounds(rest) as JsonSchema;
}

function sanitizeExclusiveBounds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeExclusiveBounds(item));
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    next[key] = sanitizeExclusiveBounds(child);
  }
  rewriteBound(next, "exclusiveMinimum", "minimum");
  rewriteBound(next, "exclusiveMaximum", "maximum");
  return next;
}

function rewriteBound(
  schema: Record<string, unknown>,
  exclusiveKey: "exclusiveMinimum" | "exclusiveMaximum",
  inclusiveKey: "minimum" | "maximum",
): void {
  const exclusive = schema[exclusiveKey];
  if (typeof exclusive === "boolean") {
    const inclusive = schema[inclusiveKey];
    if (exclusive && typeof inclusive === "number") {
      schema[exclusiveKey] = inclusive;
      delete schema[inclusiveKey];
    } else {
      delete schema[exclusiveKey];
    }
  }
}
