export class ToolError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code:
      | "UNKNOWN_TOOL"
      | "INVALID_INPUT"
      | "INVALID_OUTPUT"
      | "UNAUTHORIZED"
      | "RATE_LIMITED"
      | "TIMEOUT"
      | "CANCELLED"
      | "FAILED"
      | "DISABLED",
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ToolError";
    this.retryable = options?.retryable ?? false;
  }
}
