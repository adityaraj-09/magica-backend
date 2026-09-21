export { reserveIdempotencyKey } from "./reserve.js";
export { initialGrantIdempotencyKey } from "./grant.js";

export function toolSettleIdempotencyKey(toolCallId: string): string {
  return `tool:${toolCallId}:settle`;
}

export function runFinalizeIdempotencyKey(runId: string): string {
  return `run:${runId}:finalize`;
}

export function runRefundIdempotencyKey(runId: string): string {
  return `run:${runId}:refund`;
}
