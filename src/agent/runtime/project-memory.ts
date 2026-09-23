export const PROJECT_MEMORY_CAP = 4000;

export function compactMemoryNote(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length < 8) return null;
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
}

export function mergeProjectMemory(existing: string, note: string): string {
  const lines = existing
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  if (lines.some((line) => line === note || line.startsWith(note) || note.startsWith(line))) {
    return existing;
  }
  lines.push(note);
  let out = lines.map((line) => `- ${line}`).join("\n");
  while (out.length > PROJECT_MEMORY_CAP && lines.length > 1) {
    lines.shift();
    out = lines.map((line) => `- ${line}`).join("\n");
  }
  return out.slice(0, PROJECT_MEMORY_CAP);
}

export function memoryUsedPercent(memory: string): number {
  if (!memory) return 0;
  return Math.min(100, Math.round((memory.length / PROJECT_MEMORY_CAP) * 100));
}
