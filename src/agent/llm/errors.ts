export class LlmError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly partialText?: string;
  readonly modelRouted?: string;

  constructor(
    readonly code:
      | "UNAUTHORIZED"
      | "RATE_LIMITED"
      | "EMPTY_STREAM"
      | "MALFORMED_TOOL_CALL"
      | "UNSUPPORTED_MODEL"
      | "TIMEOUT"
      | "CANCELLED"
      | "UNAVAILABLE"
      | "FAILED",
    message: string,
    options?: {
      retryable?: boolean;
      cause?: unknown;
      retryAfterMs?: number;
      partialText?: string;
      modelRouted?: string;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "LlmError";
    this.retryable = options?.retryable ?? false;
    this.retryAfterMs = options?.retryAfterMs;
    this.partialText = options?.partialText;
    this.modelRouted = options?.modelRouted;
  }
}

export function isLlmAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof LlmError && (error.code === "CANCELLED" || error.code === "TIMEOUT"))
  );
}
