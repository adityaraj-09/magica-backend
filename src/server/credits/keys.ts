export { reserveIdempotencyKey } from "./reserve";
export { initialGrantIdempotencyKey } from "./grant";

export function toolSettleIdempotencyKey(toolCallId: string): string {
  return `tool:${toolCallId}:settle`;
}

export function runFinalizeIdempotencyKey(runId: string): string {
  return `run:${runId}:finalize`;
}

export function runRefundIdempotencyKey(runId: string): string {
  return `run:${runId}:refund`;
}
