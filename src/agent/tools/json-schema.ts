import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema } from "./types.js";

/** OpenRouter wants a plain JSON Schema object, not a $ref document. */
export function toOpenRouterParameters(schema: z.ZodType): JsonSchema {
  const json = zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
  });
  const { $schema: _schema, ...rest } = json as JsonSchema & {
    $schema?: unknown;
  };
  return rest;
}
