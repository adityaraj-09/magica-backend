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
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const idempotencyKey = `wh:${args.endpoint.id}:${args.input.event}:${args.input.idempotencySuffix}`;
  const envelope = {
    id: idempotencyKey,
    event: args.input.event,
    createdAt: now.toISOString(),
    data: args.input.payload,
  };
  const body = JSON.stringify(envelope);
  const signature = signWebhookPayload({
    secret: args.endpoint.signingSecret,
    timestamp,
    body,
  });

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
        attempts: 1,
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
  try {
    const response = await fetchImpl(args.endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-galaxy-signature": signature,
        "x-galaxy-timestamp": timestamp,
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
      data: { status: "DELIVERED", deliveredAt: new Date() },
    });
  } catch (error) {
    await args.db.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "FAILED",
        lastError: error instanceof Error ? error.message.slice(0, 280) : "delivery failed",
      },
    });
  }
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
