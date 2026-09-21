import type { LlmMalformedToolCall, LlmToolCallProposal } from "./types.js";

export type ToolCallDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type Slot = {
  id?: string;
  name?: string;
  arguments: string;
};

export function applyToolCallDeltas(
  slots: Map<number, Slot>,
  deltas: ToolCallDelta[] | undefined,
): void {
  if (!deltas) return;
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    const slot = slots.get(index) ?? { arguments: "" };
    if (delta.id) slot.id = delta.id;
    if (delta.function?.name) {
      slot.name = `${slot.name ?? ""}${delta.function.name}`;
    }
    if (typeof delta.function?.arguments === "string") {
      slot.arguments += delta.function.arguments;
    }
    slots.set(index, slot);
  }
}

export function applyFullToolCalls(
  slots: Map<number, Slot>,
  calls: ToolCallDelta[] | undefined,
): void {
  if (!calls) return;
  slots.clear();
  applyToolCallDeltas(
    slots,
    calls.map((call, index) => ({ ...call, index: call.index ?? index })),
  );
}

export function finalizeToolCalls(slots: Map<number, Slot>): {
  toolCalls: LlmToolCallProposal[];
  malformedToolCalls: LlmMalformedToolCall[];
} {
  const toolCalls: LlmToolCallProposal[] = [];
  const malformedToolCalls: LlmMalformedToolCall[] = [];

  const ordered = [...slots.entries()].sort(([a], [b]) => a - b);
  for (const [, slot] of ordered) {
    const parsed = parseToolCall(slot);
    if ("error" in parsed) {
      malformedToolCalls.push(parsed);
    } else {
      toolCalls.push(parsed);
    }
  }

  return { toolCalls, malformedToolCalls };
}

function parseToolCall(
  slot: Slot,
): LlmToolCallProposal | (LlmMalformedToolCall & { error: string }) {
  const rawArguments = slot.arguments;
  if (!slot.id || !slot.name) {
    return {
      id: slot.id,
      name: slot.name,
      rawArguments,
      error: "Tool call is missing an id or name",
    };
  }

  const args = parseArgumentObject(rawArguments);
  if (!args.ok) {
    return {
      id: slot.id,
      name: slot.name,
      rawArguments,
      error: args.error,
    };
  }

  return {
    id: slot.id,
    name: slot.name,
    arguments: args.value,
    rawArguments,
  };
}

function parseArgumentObject(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Tool arguments must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Tool arguments were not valid JSON" };
  }
}
