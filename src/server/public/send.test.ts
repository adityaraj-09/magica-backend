import { afterEach, describe, expect, it, vi } from "vitest";

const { persist, admit } = vi.hoisted(() => ({
  persist: vi.fn(),
  admit: vi.fn(),
}));

vi.mock("@/server/uploads/api-upload.js", async () => {
  const actual = await vi.importActual<typeof import("@/server/uploads/api-upload")>(
    "@/server/uploads/api-upload",
  );
  return { ...actual, persistApiUploadFiles: persist };
});
vi.mock("@/server/chat/admit-turn.js", async () => {
  const actual = await vi.importActual<typeof import("@/server/chat/admit-turn")>(
    "@/server/chat/admit-turn",
  );
  return { ...actual, admitTurn: admit };
});

import type { User } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { admitPublicSend } from "./send";

const userId = "22222222-2222-2222-2222-222222222222";
const user = {
  id: userId,
  clerkUserId: "user_test",
  email: "ada@example.com",
  creditBalance: new Prisma.Decimal("100"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies User;

describe("admitPublicSend", () => {
  afterEach(() => {
    persist.mockReset();
    admit.mockReset();
  });

  it("uploads multipart files then admits with those attachment ids", async () => {
    persist.mockResolvedValue({
      chatId: "11111111-1111-1111-1111-111111111111",
      attachments: [
        { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", status: "COMPLETE" },
      ],
    });
    admit.mockResolvedValue({
      chatId: "11111111-1111-1111-1111-111111111111",
      messageId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      runId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      triggerRunId: "run_1",
      realtimeToken: "pat",
      replayed: false,
    });
    const form = new FormData();
    form.set("text", "what is this");
    form.append("file", new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
    const request = new Request("http://localhost/api/v1/completions", {
      method: "POST",
      body: form,
    });
    const result = await admitPublicSend({ user, request });
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        files: [expect.objectContaining({ filename: "shot.png", mimeType: "image/png" })],
      }),
    );
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "11111111-1111-1111-1111-111111111111",
        body: expect.objectContaining({
          text: "what is this",
          attachmentIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
        }),
      }),
    );
    expect(result.runId).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
  });

  it("uploads a file onto an existing chat in the same send", async () => {
    const chatId = "11111111-1111-1111-1111-111111111111";
    persist.mockResolvedValue({
      chatId,
      attachments: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", status: "COMPLETE" }],
    });
    admit.mockResolvedValue({
      chatId,
      messageId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      runId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      triggerRunId: "run_1",
      realtimeToken: "pat",
      replayed: false,
    });
    const form = new FormData();
    form.set("text", "crop this");
    form.append("file", new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
    const request = new Request("http://localhost/api/v1/chats/" + chatId + "/messages", {
      method: "POST",
      body: form,
    });
    await admitPublicSend({ user, request, chatId });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ userId, chatId }));
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId,
        body: expect.objectContaining({
          text: "crop this",
          attachmentIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
        }),
      }),
    );
  });
});
