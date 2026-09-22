import { z } from "zod";
import { ToolError } from "@/agent/tools/errors";

export function parseToolInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ToolError(
      "INVALID_INPUT",
      result.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return result.data;
}
