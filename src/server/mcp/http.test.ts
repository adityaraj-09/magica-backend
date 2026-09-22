import type { User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/server/http/errors.js";
import { handleMcpHttp } from "./http.js";

vi.mock("@/server/chat/chats.js", () => ({
  listChats: vi.fn(async () => ({ items: [{ id: "chat_1", title: "Launch" }], nextCursor: null })),
  getChat: vi.fn(),
  createChat: vi.fn(),
  deleteChat: vi.fn(),
  listMessages: vi.fn(),
}));

const user = { id: "22222222-2222-2222-2222-222222222222" } as User;

function post(body: unknown, authorization = "Bearer gxk_live_test") {
  return handleMcpHttp(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { authorize: async () => user },
  );
}

describe("MCP HTTP", () => {
  it("rejects a missing API key", async () => {
    const response = await handleMcpHttp(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      {
        authorize: async () => {
          throw new HttpError("Missing or invalid API key", 401, "UNAUTHORIZED");
        },
      },
    );
    expect(response.status).toBe(401);
  });

  it("answers initialize and lists the public tools", async () => {
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const initBody = (await init.json()) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(initBody.result.serverInfo.name).toBe("galaxy-agent");
    expect(initBody.result.protocolVersion).toBe("2025-06-18");

    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listedBody = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    const names = listedBody.result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_chats",
        "send_message",
        "complete",
        "get_run",
        "crop_image",
        "gpt_image_2",
        "merge_videos",
      ]),
    );
  });

  it("accepts notifications with 202 and calls list_chats", async () => {
    const notice = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notice.status).toBe(202);

    const called = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_chats", arguments: { limit: 5 } },
    });
    const body = (await called.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0]?.text ?? "{}")).toMatchObject({
      items: [{ id: "chat_1" }],
    });
  });

  it("returns a tool error for an unknown tool", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    const body = (await response.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
  });
});
