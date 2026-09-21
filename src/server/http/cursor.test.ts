import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, nextCursor } from "./cursor.js";

describe("cursor", () => {
  it("round-trips createdAt and id", () => {
    const at = new Date("2026-09-21T12:00:00.000Z");
    const id = "11111111-1111-1111-1111-111111111111";
    const encoded = encodeCursor(at, id);
    expect(decodeCursor(encoded)).toEqual({ t: at, i: id });
  });

  it("emits nextCursor only when the page overflowed", () => {
    const rows = [
      { createdAt: new Date("2026-09-21T12:00:00.000Z"), id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      { createdAt: new Date("2026-09-20T12:00:00.000Z"), id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
    ];
    const page = nextCursor(rows, 1);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(encodeCursor(rows[0]!.createdAt, rows[0]!.id));
    expect(nextCursor(rows.slice(0, 1), 1).nextCursor).toBeNull();
  });
});
