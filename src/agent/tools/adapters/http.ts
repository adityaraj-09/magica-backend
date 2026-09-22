import { ToolError } from "../errors";

const SENSITIVE = /api[_-]?key|authorization|bearer|gx_|e2b_|exa_/i;

export function providerHttpError(
  status: number,
  service: string,
  body?: unknown,
): ToolError {
  const detail = safeErrorDetail(body);

  if (status === 401) {
    return new ToolError("UNAUTHORIZED", `${service} rejected the request`);
  }
  if (status === 403) {
    return new ToolError(
      "FAILED",
      detail ?? `${service} denied the request. Check credits and permissions.`,
    );
  }
  if (status === 429) {
    return new ToolError("RATE_LIMITED", `${service} is rate limited. Try again shortly.`, {
      retryable: true,
    });
  }
  if (status === 400) {
    return new ToolError("INVALID_INPUT", detail ?? `Invalid ${service} input`);
  }
  if (status === 404) {
    return new ToolError("FAILED", `${service} resource was not found`);
  }
  if (status >= 500) {
    return new ToolError("FAILED", `${service} is temporarily unavailable`, {
      retryable: true,
    });
  }
  return new ToolError("FAILED", detail ?? `${service} request failed`);
}

export function safeErrorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const candidate =
    (typeof record.userMessage === "string" && record.userMessage) ||
    (typeof record.message === "string" && record.message) ||
    (typeof record.error === "string" && record.error) ||
    undefined;
  if (!candidate || SENSITIVE.test(candidate)) return undefined;
  return candidate.slice(0, 280);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof ToolError && error.code === "CANCELLED")
  );
}

export function throwIfAborted(signal: AbortSignal, message = "Cancelled"): void {
  if (signal.aborted) {
    throw new ToolError("CANCELLED", message);
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ToolError("CANCELLED", "Cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ToolError("CANCELLED", "Cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}
