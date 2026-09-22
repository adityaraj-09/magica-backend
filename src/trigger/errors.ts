import { ToolError } from "@/agent/tools/errors";

/** Non-retryable tool failures must not burn Magica/E2B attempts. */
export function catchNonRetryableToolError({ error }: { error: unknown }):
  | { skipRetrying: true }
  | undefined {
  if (error instanceof ToolError && !error.retryable) {
    return { skipRetrying: true };
  }
  return undefined;
}
