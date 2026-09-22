import { describe, expect, it, vi } from "vitest";
import {
  emitWebhooks,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./webhooks.js";

const endpoint = {
  id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
  url: "https://hooks.example/galaxy",
  signingSecret: "gwhsec_test",
  events: ["agent.started"],
  isActive: true,
  userId: "22222222-2222-2222-2222-222222222222",
};

describe("webhook signatures", () => {
  it("HMAC-SHA256 signs timestamp + body", () => {
    const signature = signWebhookPayload({
      secret: "gwhsec_test",
      timestamp: "1710000000",
      body: "{\"ok\":true}",
    });
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(
      verifyWebhookSignature({
        secret: "gwhsec_test",
        timestamp: "1710000000",
        body: "{\"ok\":true}",
        signature,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        secret: "gwhsec_test",
        timestamp: "1710000000",
        body: "{\"ok\":false}",
        signature,
      }),
    ).toBe(false);
  });
});

describe("emitWebhooks", () => {
  it("posts a signed envelope and marks the delivery delivered", async () => {
    const create = vi.fn(async () => ({ id: "del_1" }));
    const update = vi.fn(async () => ({}));
    const findMany = vi.fn(async () => [endpoint]);
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    await emitWebhooks({
      userId: endpoint.userId,
      event: "agent.started",
      idempotencySuffix: "run_1",
      agentRunId: "33333333-3333-3333-3333-333333333333",
      payload: { runId: "33333333-3333-3333-3333-333333333333" },
      db: {
        webhookEndpoint: { findMany },
        webhookDelivery: { create, update },
      } as never,
      fetchImpl: fetchImpl as never,
      now: new Date("2026-09-21T12:00:00.000Z"),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      endpoint.url,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-galaxy-event": "agent.started",
          "x-galaxy-signature": expect.stringMatching(/^sha256=/),
        }),
      }),
    );
    const call = fetchImpl.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(
      verifyWebhookSignature({
        secret: endpoint.signingSecret,
        timestamp: call[1].headers["x-galaxy-timestamp"] ?? "",
        body: call[1].body,
        signature: call[1].headers["x-galaxy-signature"] ?? "",
      }),
    ).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DELIVERED" }),
      }),
    );
  });

  it("skips a duplicate idempotency key", async () => {
    const { Prisma } = await import("@prisma/client");
    const create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "6.19.3",
      });
    });
    const fetchImpl = vi.fn();
    await emitWebhooks({
      userId: endpoint.userId,
      event: "agent.completed",
      idempotencySuffix: "run_1:COMPLETE",
      payload: {},
      db: {
        webhookEndpoint: { findMany: vi.fn(async () => [endpoint]) },
        webhookDelivery: { create, update: vi.fn() },
      } as never,
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries a non-2xx response and delivers on the next attempt", async () => {
    const update = vi.fn(async () => ({}));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("no", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    await emitWebhooks({
      userId: endpoint.userId,
      event: "agent.started",
      idempotencySuffix: "run_retry",
      payload: { runId: "33333333-3333-3333-3333-333333333333" },
      db: {
        webhookEndpoint: { findMany: vi.fn(async () => [endpoint]) },
        webhookDelivery: { create: vi.fn(async () => ({ id: "del_2" })), update },
      } as never,
      fetchImpl: fetchImpl as never,
      sleep,
      retryDelaysMs: [1_000, 5_000, 15_000],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DELIVERED", attempts: 2 }),
      }),
    );
  });

  it("marks the delivery FAILED after the last attempt", async () => {
    const update = vi.fn(async () => ({}));
    const fetchImpl = vi.fn(async () => {
      throw new Error("The operation was aborted");
    });
    await emitWebhooks({
      userId: endpoint.userId,
      event: "agent.started",
      idempotencySuffix: "run_fail",
      payload: {},
      db: {
        webhookEndpoint: { findMany: vi.fn(async () => [endpoint]) },
        webhookDelivery: { create: vi.fn(async () => ({ id: "del_3" })), update },
      } as never,
      fetchImpl: fetchImpl as never,
      sleep: async () => undefined,
      retryDelaysMs: [10, 20],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          attempts: 3,
          lastError: "The operation was aborted",
        }),
      }),
    );
  });
});
