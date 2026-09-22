import { LlmError } from "./errors";

/** Yields `data:` payloads from an SSE body. Comments (`: ...`) are skipped. */
export async function* iterateSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal.aborted) {
        throw abortError(signal);
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = sseDataPayload(line);
        if (payload === undefined) continue;
        if (payload === "[DONE]") return;
        yield payload;
      }
    }

    const trailing = sseDataPayload(buffer);
    if (trailing && trailing !== "[DONE]") yield trailing;
  } catch (error) {
    if (signal.aborted) throw abortError(signal, error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function sseDataPayload(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return undefined;
  if (!trimmed.startsWith("data:")) return undefined;
  return trimmed.slice(5).trim();
}

function abortError(signal: AbortSignal, cause?: unknown): LlmError {
  if (isTimeout(signal, cause)) {
    return new LlmError("TIMEOUT", "OpenRouter Free timed out", {
      retryable: true,
      cause,
    });
  }
  return new LlmError("CANCELLED", "OpenRouter Free request cancelled", {
    retryable: false,
    cause,
  });
}

function isTimeout(signal: AbortSignal, cause?: unknown): boolean {
  const reason = signal.reason;
  return (
    (reason instanceof Error && reason.name === "TimeoutError") ||
    (cause instanceof Error && cause.name === "TimeoutError")
  );
}
