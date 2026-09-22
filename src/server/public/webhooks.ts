import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db.js";
import { HttpError } from "@/server/http/errors.js";
import { logWarn } from "@/server/log.js";

export const WEBHOOK_EVENTS = [
  "agent.started",
  "agent.completed",
  "agent.failed",
  "tool.completed",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const eventSchema = z.enum(WEBHOOK_EVENTS);

export const createWebhookBodySchema = z.object({
  url: z.string().url(),
  events: z.array(eventSchema).min(1).default([...WEBHOOK_EVENTS]),
});

export type WebhookEndpointJson = {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
};

export function generateWebhookSecret(): string {
  return `gwhsec_${randomBytes(24).toString("base64url")}`;
}

export function signWebhookPayload(input: {
  secret: string;
  timestamp: string;
  body: string;
}): string {
  const digest = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.body}`)
    .digest("hex");
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
}): boolean {
  const expected = signWebhookPayload(input);
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createWebhookEndpoint(input: {
  userId: string;
  body: unknown;
  db?: PrismaClient;
}): Promise<WebhookEndpointJson & { secret: string }> {
  const body = createWebhookBodySchema.parse(input.body ?? {});
  const secret = generateWebhookSecret();
  const db = input.db ?? prisma;
  const row = await db.webhookEndpoint.create({
    data: {
      userId: input.userId,
      url: body.url,
      signingSecret: secret,
      events: body.events,
    },
  });
  return { ...toEndpointJson(row), secret };
}

export async function listWebhookEndpoints(input: {
  userId: string;
  db?: PrismaClient;
}): Promise<{ items: WebhookEndpointJson[] }> {
  const db = input.db ?? prisma;
  const rows = await db.webhookEndpoint.findMany({
    where: { userId: input.userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return { items: rows.map(toEndpointJson) };
}

export async function deleteWebhookEndpoint(input: {
  userId: string;
  endpointId: string;
  db?: PrismaClient;
}): Promise<void> {
  const db = input.db ?? prisma;
  const row = await db.webhookEndpoint.findUnique({
    where: { id: input.endpointId },
    select: { id: true, userId: true },
  });
  if (!row || row.userId !== input.userId) {
    throw new HttpError("Webhook endpoint was not found", 404, "WEBHOOK_NOT_FOUND");
  }
  await db.webhookEndpoint.delete({ where: { id: row.id } });
}

export type WebhookGateway = {
  emit(input: EmitWebhooksInput): Promise<void>;
};

export const noopWebhooks: WebhookGateway = {
  async emit() {},
};

export function createWebhookGateway(db: PrismaClient = prisma): WebhookGateway {
  return {
    emit(input) {
      return emitWebhooks({ ...input, db });
    },
  };
}

/** Delays before attempts 2, 3, and 4. The first post is immediate. */
export const WEBHOOK_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

export type EmitWebhooksInput = {
  userId: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  agentRunId?: string;
  toolInvocationId?: string;
  idempotencySuffix: string;
  db?: PrismaClient;
  fetchImpl?: typeof fetch;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
};

export async function emitWebhooks(input: EmitWebhooksInput): Promise<void> {
  const db = input.db ?? prisma;
  const endpoints = await db.webhookEndpoint.findMany({
    where: {
      userId: input.userId,
      isActive: true,
      events: { has: input.event },
    },
  });
  await Promise.all(
    endpoints.map((endpoint) =>
      deliverOne({
        endpoint,
        input,
        db,
      }).catch((error: unknown) => {
        logWarn("webhook.emit_failed", {
          userId: input.userId,
          event: input.event,
          error: error instanceof Error ? error.message : "emit failed",
        });
      }),
    ),
  );
}

async function deliverOne(args: {
  endpoint: {
    id: string;
    url: string;
    signingSecret: string;
  };
  input: EmitWebhooksInput;
  db: PrismaClient;
}): Promise<void> {
  const now = args.input.now ?? new Date();
  const idempotencyKey = `wh:${args.endpoint.id}:${args.input.event}:${args.input.idempotencySuffix}`;
  const envelope = {
    id: idempotencyKey,
    event: args.input.event,
    createdAt: now.toISOString(),
    data: args.input.payload,
  };
  const body = JSON.stringify(envelope);

  let deliveryId: string;
  try {
    const created = await args.db.webhookDelivery.create({
      data: {
        endpointId: args.endpoint.id,
        agentRunId: args.input.agentRunId,
        toolInvocationId: args.input.toolInvocationId,
        eventType: args.input.event,
        payload: envelope as Prisma.InputJsonValue,
        status: "PENDING",
        attempts: 0,
        idempotencyKey,
      },
      select: { id: true },
    });
    deliveryId = created.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return;
    }
    throw error;
  }

  const fetchImpl = args.input.fetchImpl ?? fetch;
  const sleep = args.input.sleep ?? delay;
  const retryDelays = args.input.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS;
  const maxAttempts = retryDelays.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(retryDelays[attempt - 2] ?? 0);
    }
    const attemptTimestamp = String(Math.floor(Date.now() / 1000));
    const attemptSignature = signWebhookPayload({
      secret: args.endpoint.signingSecret,
      timestamp: attemptTimestamp,
      body,
    });
    try {
      const response = await fetchImpl(args.endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-galaxy-signature": attemptSignature,
          "x-galaxy-timestamp": attemptTimestamp,
          "x-galaxy-event": args.input.event,
          "x-galaxy-delivery-id": deliveryId,
          "user-agent": "Galaxy-Webhooks/1.0",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Webhook endpoint returned ${response.status}`);
      }
      await args.db.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "DELIVERED", attempts: attempt, deliveredAt: new Date(), lastError: null },
      });
      return;
    } catch (error) {
      const lastError = error instanceof Error ? error.message.slice(0, 280) : "delivery failed";
      const finalAttempt = attempt === maxAttempts;
      await args.db.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: finalAttempt ? "FAILED" : "PENDING",
          attempts: attempt,
          lastError,
        },
      });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toEndpointJson(row: {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: Date;
}): WebhookEndpointJson {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}
