import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/server/http/errors";
import {
  COMMUNITY_MAX_FILE_BYTES,
  hmacSignature,
  persistAssembly,
  persistSignedWebhook,
  signAssemblyParams,
  signChatUpload,
  verifyTransloaditSignature,
} from "./transloadit";

const ids = {
  userId: "22222222-2222-2222-2222-222222222222",
  chatId: "11111111-1111-1111-1111-111111111111",
  otherId: "99999999-9999-9999-9999-999999999999",
};

describe("signAssemblyParams", () => {
  it("HMAC-SHA384 signs params and never embeds the secret", () => {
    const expiresAt = new Date("2026-09-21T12:00:00.000Z");
    const signed = signAssemblyParams({
      key: "auth_key",
      secret: "auth_secret",
      chatId: ids.chatId,
      userId: ids.userId,
      expiresAt,
      nonce: "nonce-1",
    });
    expect(signed.params).toContain("auth_key");
    expect(signed.params).not.toContain("auth_secret");
    expect(signed.signature).toBe(hmacSignature("auth_secret", signed.params));
    expect(JSON.parse(signed.params)).toMatchObject({
      fields: { chatId: ids.chatId, userId: ids.userId },
      steps: { ":original": { robot: "/upload/handle" } },
    });
    expect(signed.limits.maxFileBytes).toBe(COMMUNITY_MAX_FILE_BYTES);
  });

  it("omits chatId when the upload is not tied to a chat", () => {
    const signed = signAssemblyParams({
      key: "auth_key",
      secret: "auth_secret",
      userId: ids.userId,
      nonce: "nonce-2",
    });
    expect(JSON.parse(signed.params).fields).toEqual({ userId: ids.userId });
  });

  it("refuses to sign another user's chat", async () => {
    await expect(
      signChatUpload({
        userId: ids.userId,
        chatId: ids.chatId,
        db: {
          chat: {
            findUnique: vi.fn(async () => ({
              id: ids.chatId,
              userId: ids.otherId,
              deletedAt: null,
            })),
          },
        } as never,
        env: { TRANSLOADIT_KEY: "k", TRANSLOADIT_SECRET: "s" },
      }),
    ).rejects.toMatchObject({ status: 404, code: "CHAT_NOT_FOUND" });
  });
});

describe("persistAssembly", () => {
  it("upserts a complete upload and rejects oversize files", async () => {
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ id: "att_ok", status: "COMPLETE", filename: "shot.png" })
      .mockResolvedValueOnce({ id: "att_big", status: "FAILED", filename: "huge.mp4" });
    const db = {
      chat: {
        findUnique: vi.fn(async () => ({
          id: ids.chatId,
          userId: ids.userId,
          deletedAt: null,
        })),
      },
      attachment: { upsert },
    };
    const result = await persistAssembly({
      userId: ids.userId,
      chatId: ids.chatId,
      db: db as never,
      assembly: {
        assembly_id: "assembly_1",
        uploads: [
          {
            id: "file_ok",
            name: "shot.png",
            mime: "image/png",
            size: 1200,
            ssl_url: "https://tmp.example/shot.png",
            meta: { width: 800, height: 600, duration: null },
          },
          {
            id: "file_big",
            name: "huge.mp4",
            mime: "video/mp4",
            size: COMMUNITY_MAX_FILE_BYTES + 1,
            ssl_url: "https://tmp.example/huge.mp4",
          },
        ],
      },
    });
    expect(result.attachments.map((row) => row.status)).toEqual(["COMPLETE", "FAILED"]);
    expect(upsert.mock.calls[1]?.[0]?.create).toMatchObject({
      status: "FAILED",
      errorCode: "FILE_TOO_LARGE",
    });
  });

  it("stores a file without a chat", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "att_ok", status: "COMPLETE", filename: "shot.png" });
    const db = {
      chat: { findUnique: vi.fn() },
      attachment: { upsert },
    };
    await persistAssembly({
      userId: ids.userId,
      db: db as never,
      assembly: {
        assembly_id: "assembly_2",
        uploads: [
          {
            id: "file_ok",
            name: "shot.png",
            mime: "image/png",
            size: 1200,
            ssl_url: "https://tmp.example/shot.png",
          },
        ],
      },
    });
    expect(db.chat.findUnique).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ userId: ids.userId, chatId: undefined }),
      }),
    );
  });
});

describe("webhook signature", () => {
  it("accepts a matching sha384 signature and rejects a bad one", async () => {
    const payload = JSON.stringify({
      assembly_id: "assembly_1",
      fields: { chatId: ids.chatId, userId: ids.userId },
      uploads: [],
    });
    const secret = "auth_secret";
    const signature = hmacSignature(secret, payload);
    const persist = persistSignedWebhook({
      payload,
      signature,
      env: { TRANSLOADIT_KEY: "k", TRANSLOADIT_SECRET: secret },
      db: {
        chat: {
          findUnique: vi.fn(async () => ({
            id: ids.chatId,
            userId: ids.userId,
            deletedAt: null,
          })),
        },
        attachment: { upsert: vi.fn() },
      } as never,
    });
    await expect(persist).resolves.toEqual({ attachments: [] });
    await expect(
      persistSignedWebhook({
        payload,
        signature: "sha384:deadbeef",
        env: { TRANSLOADIT_KEY: "k", TRANSLOADIT_SECRET: secret },
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("does not treat a truncated hex as valid", () => {
    const payload = "{}";
    const full = createHmac("sha384", "secret").update(payload).digest("hex");
    expect(verifyTransloaditSignature(payload, `sha384:${full.slice(0, 8)}`, "secret")).toBe(false);
  });
});
