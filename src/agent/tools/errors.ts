const TOOL_ERROR_CODES = [
  "UNKNOWN_TOOL",
  "INVALID_INPUT",
  "INVALID_OUTPUT",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "TIMEOUT",
  "CANCELLED",
  "CREDITS_INSUFFICIENT",
  "FAILED",
  "DISABLED",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

const RETRYABLE_BY_DEFAULT: ReadonlySet<ToolErrorCode> = new Set([
  "RATE_LIMITED",
  "TIMEOUT",
]);

const WIRE_NAME = /^ToolError:([A-Z0-9_]+):(retryable|fatal)$/;

export class ToolError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: ToolErrorCode,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.retryable = options?.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.name = `ToolError:${this.code}:${this.retryable ? "retryable" : "fatal"}`;
  }
}

export function isToolErrorCode(value: string): value is ToolErrorCode {
  return (TOOL_ERROR_CODES as readonly string[]).includes(value);
}

/** Rebuild a ToolError after Trigger.dev serializes it across a child task. */
export function toolErrorFromUnknown(error: unknown): ToolError {
  if (error instanceof ToolError) return error;

  const record = asRecord(error);
  const name = typeof record?.name === "string" ? record.name : undefined;
  const message =
    (typeof record?.message === "string" && record.message) ||
    (typeof record?.raw === "string" && record.raw) ||
    (error instanceof Error ? error.message : undefined) ||
    "The tool task failed";

  const wired = name ? WIRE_NAME.exec(name) : null;
  const wiredCode = wired?.[1];
  if (wired && wiredCode && isToolErrorCode(wiredCode)) {
    return new ToolError(wiredCode, message, {
      retryable: wired[2] === "retryable",
      cause: error,
    });
  }

  const code = inferToolErrorCode(record, name, message);
  return new ToolError(code, userFacing(message), {
    retryable: RETRYABLE_BY_DEFAULT.has(code),
    cause: error,
  });
}

function inferToolErrorCode(
  record: Record<string, unknown> | undefined,
  name: string | undefined,
  message: string,
): ToolErrorCode {
  const internal = typeof record?.code === "string" ? record.code : undefined;
  if (internal === "TASK_RUN_CANCELLED" || internal === "TASK_EXECUTION_ABORTED") {
    return "CANCELLED";
  }
  if (name === "AbortError" || name === "TimeoutError") {
    return name === "TimeoutError" ? "TIMEOUT" : "CANCELLED";
  }
  const lower = message.toLowerCase();
  if (lower.includes("rate limit")) return "RATE_LIMITED";
  if (lower.includes("timed out") || lower.includes("timeout")) return "TIMEOUT";
  if (lower.includes("cancel")) return "CANCELLED";
  return "FAILED";
}

function userFacing(message: string): string {
  return message.slice(0, 280) || "The tool task failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
