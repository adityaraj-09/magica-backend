import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTriggerWaitpoints, timeoutDate } from "./waitpoints.js";
import type { AgentStore } from "@/agent/runtime/store.js";

const { createToken, forToken } = vi.hoisted(() => ({
  createToken: vi.fn(),
  forToken: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  wait: { createToken, forToken },
  logger: { info: vi.fn() },
}));

describe("timeoutDate", () => {
  it("parses duration units from now", () => {
    const from = Date.parse("2026-09-21T00:00:00.000Z");
    expect(timeoutDate("30s", from).toISOString()).toBe("2026-09-21T00:00:30.000Z");
    expect(timeoutDate("2h", from).toISOString()).toBe("2026-09-21T02:00:00.000Z");
  });
});

describe("createTriggerWaitpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the waitpoint, publishes the overlay, then maps a timeout", async () => {
    const overlay = {
      waitpointId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      type: "PLAN" as const,
      status: "WAITING" as const,
      triggerWaitpointId: "waitpoint_tok",
      publicAccessToken: "pat_wait",
      timeoutAt: "2026-09-22T00:00:00.000Z",
      payload: { text: "plan" },
    };
    const store = {
      getWaitpoint: vi.fn(async () => null),
      saveWaitpoint: vi.fn(async () => overlay),
      finishWaitpoint: vi.fn(async () => undefined),
    };
    createToken.mockResolvedValue({
      id: "waitpoint_tok",
      publicAccessToken: "pat_wait",
    });
    forToken.mockResolvedValue({ ok: false, error: "timed out" });
    const onOpen = vi.fn();
    const gateway = createTriggerWaitpoints(store as unknown as AgentStore);
    const decision = await gateway.awaitApproval({
      type: "PLAN",
      run: {
        id: "33333333-3333-3333-3333-333333333333",
        chatId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
      },
      idempotencyKey: "run:1:wait:plan",
      payload: { text: "plan" },
      timeout: "1h",
      onOpen,
    });
    expect(onOpen).toHaveBeenCalledWith(overlay);
    expect(store.finishWaitpoint).toHaveBeenCalledWith({
      idempotencyKey: "run:1:wait:plan",
      status: "EXPIRED",
    });
    expect(decision).toBe("expired");
  });

  it("skips a new token when the waitpoint already completed", async () => {
    const store = {
      getWaitpoint: vi.fn(async () => ({ status: "COMPLETED" })),
      saveWaitpoint: vi.fn(),
      finishWaitpoint: vi.fn(),
    };
    const gateway = createTriggerWaitpoints(store as unknown as AgentStore);
    await expect(
      gateway.awaitApproval({
        type: "CREDIT",
        run: {
          id: "33333333-3333-3333-3333-333333333333",
          chatId: "11111111-1111-1111-1111-111111111111",
          userId: "22222222-2222-2222-2222-222222222222",
        },
        idempotencyKey: "run:1:wait:credit:1",
        payload: {},
        timeout: "1h",
      }),
    ).resolves.toBe("approved");
    expect(createToken).not.toHaveBeenCalled();
  });
});
