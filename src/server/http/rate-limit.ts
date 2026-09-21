export type SendRateLimit = {
  limit: number;
  windowMs: number;
};

export function parseSendRateLimit(
  env: Record<string, string | undefined> = process.env,
): SendRateLimit {
  return {
    limit: parsePositiveInt(env.SEND_RATE_LIMIT_PER_MINUTE, 20),
    windowMs: parsePositiveInt(env.SEND_RATE_WINDOW_SECONDS, 60) * 1000,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Send rate limit must be a positive integer");
  }
  return parsed;
}
