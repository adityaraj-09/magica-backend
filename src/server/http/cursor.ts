import { z } from "zod";
import { HttpError } from "@/server/http/errors";

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

const cursorPayloadSchema = z.object({
  t: z.string().datetime(),
  i: z.string().uuid(),
});

export type Cursor = { t: Date; i: string };

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: at.toISOString(), i: id }), "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(raw: string): Cursor {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = cursorPayloadSchema.parse(JSON.parse(json) as unknown);
    return { t: new Date(parsed.t), i: parsed.i };
  } catch {
    throw new HttpError("Invalid cursor", 400, "INVALID_CURSOR");
  }
}

export function nextCursor<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export function createdAtIdWhere(cursor: Cursor | undefined):
  | {
      OR: Array<
        | { createdAt: { lt: Date } }
        | { createdAt: Date; id: { lt: string } }
      >;
    }
  | undefined {
  if (!cursor) return undefined;
  return {
    OR: [{ createdAt: { lt: cursor.t } }, { createdAt: cursor.t, id: { lt: cursor.i } }],
  };
}
