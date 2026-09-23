import { describe, expect, it, vi } from "vitest";
import { listLibraryAttachments, resolveSendAttachments } from "./attachments";
import { encodeCursor } from "@/server/http/cursor";

const ids = {
  userId: "22222222-2222-2222-2222-222222222222",
  chatId: "11111111-1111-1111-1111-111111111111",
  otherChat: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  directId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  libraryId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
};

const now = new Date("2026-09-21T12:00:00.000Z");

function completeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.directId,
    chatId: ids.chatId,
    filename: "shot.png",
    mimeType: "image/png",
    url: "https://cdn.example/shot.png",
    status: "COMPLETE",
    expiresAt: null,
    ...overrides,
  };
}

describe("resolveSendAttachments", () => {
  it("preserves send order and tags media-library vs direct uploads", async () => {
    const findMany = vi.fn(async () => [
      completeRow({ id: ids.libraryId, chatId: ids.otherChat, filename: "lib.png" }),
      completeRow(),
    ]);
    const resolved = await resolveSendAttachments({
      userId: ids.userId,
      chatId: ids.chatId,
      attachmentIds: [ids.libraryId, ids.directId],
      db: { attachment: { findMany } } as never,
    });
    expect(resolved.map((file) => file.id)).toEqual([ids.libraryId, ids.directId]);
    expect(resolved.map((file) => file.source)).toEqual(["MEDIA_LIBRARY", "DIRECT_UPLOAD"]);
  });

  it("hides another user's attachment", async () => {
    const findMany = vi.fn(async () => []);
    await expect(
      resolveSendAttachments({
        userId: ids.userId,
        chatId: ids.chatId,
        attachmentIds: [ids.directId],
        db: { attachment: { findMany } } as never,
      }),
    ).rejects.toMatchObject({ status: 404, code: "ATTACHMENT_NOT_FOUND" });
  });

  it("rejects an incomplete or expired file", async () => {
    const findMany = vi.fn(async () => [completeRow({ status: "UPLOADING", url: null })]);
    await expect(
      resolveSendAttachments({
        userId: ids.userId,
        chatId: ids.chatId,
        attachmentIds: [ids.directId],
        db: { attachment: { findMany } } as never,
      }),
    ).rejects.toMatchObject({ status: 409, code: "ATTACHMENT_NOT_READY" });

    findMany.mockResolvedValueOnce([completeRow({ expiresAt: new Date("2026-09-21T11:00:00.000Z") })]);
    await expect(
      resolveSendAttachments({
        userId: ids.userId,
        chatId: ids.chatId,
        attachmentIds: [ids.directId],
        db: { attachment: { findMany } } as never,
        now,
      }),
    ).rejects.toMatchObject({ status: 409, code: "ATTACHMENT_EXPIRED" });
  });
});

describe("listLibraryAttachments", () => {
  it("lists complete unexpired files newest first", async () => {
    const newer = {
      ...completeRow(),
      origin: "UPLOAD",
      byteSize: 12,
      thumbnailUrl: null,
      width: 10,
      height: 10,
      durationMs: null,
      createdAt: now,
    };
    const older = {
      ...newer,
      id: ids.libraryId,
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
    };
    const findMany = vi.fn(async () => [newer, older]);
    const result = await listLibraryAttachments({
      userId: ids.userId,
      query: { limit: "1" },
      db: { attachment: { findMany } } as never,
      now,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 2,
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe(encodeCursor(newer.createdAt, newer.id));
  });

  it("scopes to one chat’s uploads, generated files, and attached inputs", async () => {
    const findMany = vi.fn(async () => []);
    await listLibraryAttachments({
      userId: ids.userId,
      query: { chatId: ids.chatId, limit: "20" },
      db: { attachment: { findMany } } as never,
      now,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: ids.userId,
          AND: expect.arrayContaining([
            {
              OR: [
                { chatId: ids.chatId },
                { messages: { some: { chatId: ids.chatId } } },
              ],
            },
          ]),
        }),
      }),
    );
  });
});
