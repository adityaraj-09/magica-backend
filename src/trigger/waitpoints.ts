import { wait } from "@trigger.dev/sdk";
import type { AgentStore } from "@/agent/runtime/store.js";
import type { WaitpointApproval, WaitpointGateway } from "@/agent/runtime/waitpoint.js";

export function createTriggerWaitpoints(store: AgentStore): WaitpointGateway {
  return {
    async awaitApproval(input) {
      const existing = await store.getWaitpoint(input.idempotencyKey);
      if (existing?.status === "COMPLETED") return "approved";
      if (existing?.status === "CANCELLED") return "rejected";
      if (existing?.status === "EXPIRED") return "expired";

      const token = await wait.createToken({
        timeout: input.timeout,
        idempotencyKey: input.idempotencyKey,
        tags: [input.run.chatId, input.run.id],
      });

      await store.saveWaitpoint({
        run: input.run,
        type: input.type,
        triggerWaitpointId: token.id,
        publicAccessToken: token.publicAccessToken,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        timeoutAt: timeoutDate(input.timeout),
      });

      const result = await wait.forToken<{
        approved?: boolean;
        status?: "approved" | "rejected";
      }>(token.id);

      if (!result.ok) {
        await store.finishWaitpoint({
          idempotencyKey: input.idempotencyKey,
          status: "EXPIRED",
        });
        return "expired";
      }

      const approved =
        result.output.status === "approved" || result.output.approved === true;
      await store.finishWaitpoint({
        idempotencyKey: input.idempotencyKey,
        status: approved ? "COMPLETED" : "CANCELLED",
        result: result.output,
      });
      return (approved ? "approved" : "rejected") satisfies WaitpointApproval;
    },
  };
}

function timeoutDate(timeout: string): Date {
  const match = /^(\d+)(s|m|h|d)$/.exec(timeout.trim());
  const amount = match ? Number(match[1]) : 24;
  const unit = match?.[2] ?? "h";
  const ms =
    unit === "s"
      ? amount * 1000
      : unit === "m"
        ? amount * 60_000
        : unit === "d"
          ? amount * 86_400_000
          : amount * 3_600_000;
  return new Date(Date.now() + ms);
}
