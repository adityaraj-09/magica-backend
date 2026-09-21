import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, User } from "@prisma/client";
import { prisma } from "@/server/db.js";
import { HttpError } from "@/server/http/errors.js";

export const API_KEY_PREFIX = "gxk_live_";

export const createApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export type ApiKeyJson = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; prefix: string; hashedKey: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { key, prefix: key.slice(0, 16), hashedKey: hashApiKey(key) };
}

export function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export async function requireApiUser(input: {
  authorization: string | null;
  db?: PrismaClient;
}): Promise<User> {
  const token = bearerToken(input.authorization);
  if (!token || !token.startsWith(API_KEY_PREFIX)) {
    throw new HttpError("Missing or invalid API key", 401, "UNAUTHORIZED");
  }
  const db = input.db ?? prisma;
  const row = await db.apiKey.findUnique({
    where: { hashedKey: hashApiKey(token) },
    include: { user: true },
  });
  if (!row || row.revokedAt) {
    throw new HttpError("Missing or invalid API key", 401, "UNAUTHORIZED");
  }
  void db.apiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return row.user;
}

export async function createApiKey(input: {
  userId: string;
  body: unknown;
  db?: PrismaClient;
}): Promise<ApiKeyJson & { key: string }> {
  const body = createApiKeyBodySchema.parse(input.body ?? {});
  const generated = generateApiKey();
  const db = input.db ?? prisma;
  const row = await db.apiKey.create({
    data: {
      userId: input.userId,
      name: body.name,
      prefix: generated.prefix,
      hashedKey: generated.hashedKey,
    },
  });
  return { ...toApiKeyJson(row), key: generated.key };
}

export async function listApiKeys(input: {
  userId: string;
  db?: PrismaClient;
}): Promise<{ items: ApiKeyJson[] }> {
  const db = input.db ?? prisma;
  const rows = await db.apiKey.findMany({
    where: { userId: input.userId, revokedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return { items: rows.map(toApiKeyJson) };
}

export async function revokeApiKey(input: {
  userId: string;
  keyId: string;
  db?: PrismaClient;
}): Promise<void> {
  const db = input.db ?? prisma;
  const row = await db.apiKey.findUnique({
    where: { id: input.keyId },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!row || row.userId !== input.userId) {
    throw new HttpError("API key was not found", 404, "API_KEY_NOT_FOUND");
  }
  if (row.revokedAt) return;
  await db.apiKey.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
  });
}

function toApiKeyJson(row: {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}): ApiKeyJson {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
