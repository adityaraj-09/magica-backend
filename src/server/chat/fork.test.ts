import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/server/http/errors";
import { forkChat } from "./fork";

const ids = {
  userId: "22222222-2222-2222-2222-222222222222",
  otherId: "99999999-9999-9999-9999-999999999999",
  chatId: "11111111-1111-1111-1111-111111111111",
  nextChatId: "44444444-4444-4444-4444-444444444444",
  userMessageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  assistantId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  laterId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
};

const createdAt = new Date("2026-09-21T12:00:00.000Z");

function sourceChat() {
  return {
    id: ids.chatId,
    userId: ids.userId,
    deletedAt: null,
    title: "Crop work",
    projectId: null,
  };
}

function messageRow(id: string, role: "USER" | "ASSISTANT", extras: Record<string, unknown> = {}) {
  return {
    id,
    chatId: ids.chatId,
    userId: ids.userId,
    parentMessageId: null,
    role,
    status: "SUCCESS",
    contentBlocks: [{ type: "text", text: role === "USER" ? "crop it" : "done" }],
    searchText: role === "USER" ? "crop it" : "done",
    errorCode: null,
    errorMessage: null,
    promptTokens: 0,
    completionTokens: 0,
    createdAt,
    attachments: [],
    ...extras,
  };
}

describe("forkChat", () => {
  it("copies messages up to the cutoff into a new chat and leaves later turns behind", async () => {
    const chatCreate = vi.fn(async () => ({
      id: ids.nextChatId,
      userId: ids.userId,
      projectId: null,
      title: "Crop work",
      isFavorite: false,
      lastMessageAt: createdAt,
      lastMessageId: null,
      createdAt,
      updatedAt: createdAt,
    }));
    const messageCreate = vi
      .fn()
      .mockResolvedValueOnce({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd" })
      .mockResolvedValueOnce({ id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" });
    const chatUpdate = vi.fn(async () => ({
      id: ids.nextChatId,
      userId: ids.userId,
      projectId: null,
      title: "Crop work",
      isFavorite: false,
      lastMessageAt: createdAt,
      lastMessageId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      createdAt,
      updatedAt: createdAt,
    }));
    const tx = {
      chat: { create: chatCreate, update: chatUpdate },
      message: { create: messageCreate },
      messageAttachment: { createMany: vi.fn() },
    };
    const result = await forkChat({
      userId: ids.userId,
      chatId: ids.chatId,
      body: { messageId: ids.assistantId },
      db: {
        chat: { findUnique: vi.fn(async () => sourceChat()) },
        message: {
          findMany: vi.fn(async () => [
            messageRow(ids.userMessageId, "USER"),
            messageRow(ids.assistantId, "ASSISTANT"),
            messageRow(ids.laterId, "USER", { searchText: "again" }),
          ]),
        },
        $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
      } as never,
    });

    expect(messageCreate).toHaveBeenCalledTimes(2);
    expect(messageCreate.mock.calls[0]?.[0].data.searchText).toBe("crop it");
    expect(messageCreate.mock.calls[1]?.[0].data.searchText).toBe("done");
    expect(result.id).toBe(ids.nextChatId);
    expect(result.lastMessageId).toBe("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
  });

  it("rejects a message that is not in the chat", async () => {
    await expect(
      forkChat({
        userId: ids.userId,
        chatId: ids.chatId,
        body: { messageId: ids.assistantId },
        db: {
          chat: { findUnique: vi.fn(async () => sourceChat()) },
          message: { findMany: vi.fn(async () => [messageRow(ids.userMessageId, "USER")]) },
        } as never,
      }),
    ).rejects.toMatchObject({ status: 404, code: "MESSAGE_NOT_FOUND" });
  });

  it("hides another user's chat", async () => {
    await expect(
      forkChat({
        userId: ids.userId,
        chatId: ids.chatId,
        body: { messageId: ids.assistantId },
        db: {
          chat: { findUnique: vi.fn(async () => ({ ...sourceChat(), userId: ids.otherId })) },
        } as never,
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
