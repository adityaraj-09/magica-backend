import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/server/http/errors.js";
import {
  createChat,
  deleteChat,
  getChat,
  listChats,
  listMessages,
  updateChat,
} from "./chats.js";
import { encodeCursor } from "@/server/http/cursor.js";

const ids = {
  userId: "22222222-2222-2222-2222-222222222222",
  otherId: "99999999-9999-9999-9999-999999999999",
  chatId: "11111111-1111-1111-1111-111111111111",
  olderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
};

const createdAt = new Date("2026-09-21T12:00:00.000Z");

function chatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.chatId,
    userId: ids.userId,
    title: "New chat",
    isFavorite: false,
    lastMessageAt: createdAt,
    lastMessageId: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

describe("chats", () => {
  it("creates a chat for the authenticated user", async () => {
    const create = vi.fn(async () => chatRow({ title: "Launch plan" }));
    const chat = await createChat({
      userId: ids.userId,
      body: { title: "Launch plan" },
      db: { chat: { create } } as never,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { userId: ids.userId, title: "Launch plan" },
      }),
    );
    expect(chat.title).toBe("Launch plan");
  });

  it("lists newest chats first and returns a createdAt/id cursor", async () => {
    const newer = chatRow();
    const older = chatRow({
      id: ids.olderId,
      title: "Older",
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
    });
    const findMany = vi.fn(async () => [newer, older]);
    const result = await listChats({
      userId: ids.userId,
      query: { limit: "1" },
      db: { chat: { findMany } } as never,
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

  it("searches title and message text without changing cursor fields", async () => {
    const findMany = vi.fn(async () => [chatRow()]);
    await listChats({
      userId: ids.userId,
      query: { q: "crop", favorite: "true" },
      db: { chat: { findMany } } as never,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: ids.userId,
          deletedAt: null,
          isFavorite: true,
          OR: [
            { title: { contains: "crop", mode: "insensitive" } },
            {
              messages: {
                some: { searchText: { contains: "crop", mode: "insensitive" } },
              },
            },
          ],
        }),
      }),
    );
  });

  it("hides another user's chat on get, favorite, and delete", async () => {
    const findUnique = vi.fn(async () =>
      chatRow({ userId: ids.otherId }),
    );
    const db = { chat: { findUnique, update: vi.fn() } } as never;
    await expect(getChat({ userId: ids.userId, chatId: ids.chatId, db })).rejects.toMatchObject({
      status: 404,
      code: "CHAT_NOT_FOUND",
    });
    await expect(
      updateChat({ userId: ids.userId, chatId: ids.chatId, body: { isFavorite: true }, db }),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(deleteChat({ userId: ids.userId, chatId: ids.chatId, db })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect((db as { chat: { update: ReturnType<typeof vi.fn> } }).chat.update).not.toHaveBeenCalled();
  });

  it("soft-deletes an owned chat", async () => {
    const update = vi.fn(async () => chatRow({ deletedAt: new Date() }));
    await deleteChat({
      userId: ids.userId,
      chatId: ids.chatId,
      db: {
        chat: {
          findUnique: vi.fn(async () => chatRow()),
          update,
        },
      } as never,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it("lists newest messages first for an owned chat", async () => {
    const findUnique = vi.fn(async () => chatRow());
    const findMany = vi.fn(async () => [
      {
        id: "55555555-5555-5555-5555-555555555555",
        chatId: ids.chatId,
        role: "USER",
        status: "SUCCESS",
        contentBlocks: [{ type: "text", text: "hi" }],
        createdAt,
        errorCode: null,
        errorMessage: null,
        attachments: [],
      },
    ]);
    const result = await listMessages({
      userId: ids.userId,
      chatId: ids.chatId,
      query: {},
      db: {
        chat: { findUnique },
        message: { findMany },
      } as never,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(result.items[0]?.contentBlocks).toEqual([{ type: "text", text: "hi" }]);
  });
});
