export type TraceContext = {
  chatId?: string;
  userId?: string;
  runId?: string;
  messageId?: string;
  traceId?: string;
  processId?: string;
  waitpointTokenId?: string;
  toolCallId?: string;
  toolName?: string;
};

export function traceFields(input: TraceContext): Record<string, string> {
  const fields: Record<string, string> = {};
  if (input.chatId) fields.chatId = input.chatId;
  if (input.userId) fields.userId = input.userId;
  if (input.runId) fields.runId = input.runId;
  if (input.messageId) fields.messageId = input.messageId;
  if (input.traceId) fields.traceId = input.traceId;
  if (input.processId) fields.processId = input.processId;
  if (input.waitpointTokenId) fields.waitpointTokenId = input.waitpointTokenId;
  if (input.toolCallId) fields.toolCallId = input.toolCallId;
  if (input.toolName) fields.toolName = input.toolName;
  return fields;
}

export function logInfo(event: string, fields: TraceContext & Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      ts: new Date().toISOString(),
      ...sanitize(fields),
    }),
  );
}

export function logWarn(event: string, fields: TraceContext & Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event,
      ts: new Date().toISOString(),
      ...sanitize(fields),
    }),
  );
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (/secret|password|authorization|api[_-]?key/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}
