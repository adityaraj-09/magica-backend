import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";
import { requireOwnedChat } from "@/server/chat/owned";
import { HttpError } from "@/server/http/errors";

/** Community plan: 0.5 GB per file. */
export const COMMUNITY_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_FILES_PER_ASSEMBLY = 8;

export const ALLOWED_UPLOAD_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
] as const;

const ALLOWED = new Set<string>(ALLOWED_UPLOAD_MIME);

export const TRANSLOADIT_ASSEMBLY_URL = "https://api2.transloadit.com/assemblies";

export type SignedAssembly = {
  params: string;
  signature: string;
  expires: string;
  assemblyUrl: string;
  limits: {
    maxFileBytes: number;
    maxFiles: number;
    mimeTypes: readonly string[];
  };
};

export function transloaditCredentials(
  env: Record<string, string | undefined> = process.env,
): {
  key: string;
  secret: string;
  notifyUrl?: string;
} {
  const key = env.TRANSLOADIT_KEY?.trim();
  const secret = env.TRANSLOADIT_SECRET?.trim();
  if (!key || !secret) {
    throw new HttpError(
      "Uploads are unavailable until TRANSLOADIT_KEY and TRANSLOADIT_SECRET are set",
      503,
      "UPLOADS_UNAVAILABLE",
    );
  }
  const notifyUrl = env.TRANSLOADIT_NOTIFY_URL?.trim();
  return { key, secret, ...(notifyUrl ? { notifyUrl } : {}) };
}

export function signAssemblyParams(input: {
  key: string;
  secret: string;
  chatId?: string;
  userId: string;
  expiresAt?: Date;
  notifyUrl?: string;
  nonce?: string;
}): SignedAssembly {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);
  const expires = expiresAt.toISOString();
  const payload: Record<string, unknown> = {
    auth: {
      key: input.key,
      expires,
      nonce: input.nonce ?? randomUUID(),
    },
    fields: {
      userId: input.userId,
      ...(input.chatId ? { chatId: input.chatId } : {}),
    },
    steps: {
      ":original": {
        robot: "/upload/handle",
      },
    },
  };
  if (input.notifyUrl) {
    payload.notify_url = input.notifyUrl;
  }
  const params = JSON.stringify(payload);
  return {
    params,
    signature: hmacSignature(input.secret, params),
    expires,
    assemblyUrl: TRANSLOADIT_ASSEMBLY_URL,
    limits: {
      maxFileBytes: COMMUNITY_MAX_FILE_BYTES,
      maxFiles: MAX_FILES_PER_ASSEMBLY,
      mimeTypes: ALLOWED_UPLOAD_MIME,
    },
  };
}

export function hmacSignature(secret: string, payload: string, algo = "sha384"): string {
  const digest = createHmac(algo, secret).update(Buffer.from(payload, "utf8")).digest("hex");
  return `${algo}:${digest}`;
}

export function verifyTransloaditSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const separator = signature.indexOf(":");
  const algo = separator === -1 ? "sha1" : signature.slice(0, separator);
  const received = separator === -1 ? signature : signature.slice(separator + 1);
  let expected: string;
  try {
    expected = createHmac(algo, secret).update(Buffer.from(payload, "utf8")).digest("hex");
  } catch {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function signChatUpload(input: {
  userId: string;
  chatId: string;
  db?: PrismaClient;
  env?: Record<string, string | undefined>;
}): Promise<SignedAssembly> {
  const db = input.db ?? prisma;
  await requireOwnedChat(input.userId, input.chatId, db);
  const creds = transloaditCredentials(input.env ?? process.env);
  return signAssemblyParams({
    key: creds.key,
    secret: creds.secret,
    chatId: input.chatId,
    userId: input.userId,
    notifyUrl: creds.notifyUrl,
  });
}

const assemblyFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  basename: z.string().optional(),
  ext: z.string().optional(),
  mime: z.string().optional(),
  type: z.string().optional(),
  size: z.number().nonnegative().nullish(),
  ssl_url: z.string().url().nullish(),
  url: z.string().url().nullish(),
  original_id: z.string().nullish(),
  meta: z
    .object({
      width: z.number().nullish(),
      height: z.number().nullish(),
      duration: z.number().nullish(),
    })
    .passthrough()
    .nullish(),
});

export async function persistAssembly(input: {
  userId: string;
  chatId?: string;
  assembly: unknown;
  db?: PrismaClient;
}): Promise<{ attachments: Array<{ id: string; status: string; filename: string }> }> {
  const db = input.db ?? prisma;
  if (input.chatId) await requireOwnedChat(input.userId, input.chatId, db);
  const files = filesFromAssembly(input.assembly);
  const assemblyId = assemblyIdOf(input.assembly);
  if (!assemblyId) {
    throw new HttpError("Assembly id is required", 400, "INVALID_REQUEST");
  }

  const saved: Array<{ id: string; status: string; filename: string }> = [];
  for (const file of files.slice(0, MAX_FILES_PER_ASSEMBLY)) {
    const row = await upsertUpload(db, {
      userId: input.userId,
      chatId: input.chatId,
      assemblyId,
      file,
    });
    saved.push(row);
  }
  return { attachments: saved };
}

export async function persistSignedWebhook(input: {
  payload: string;
  signature: string;
  db?: PrismaClient;
  env?: Record<string, string | undefined>;
}): Promise<{ attachments: Array<{ id: string; status: string; filename: string }> }> {
  const creds = transloaditCredentials(input.env ?? process.env);
  if (!verifyTransloaditSignature(input.payload, input.signature, creds.secret)) {
    throw new HttpError("Invalid Transloadit signature", 401, "INVALID_SIGNATURE");
  }
  let assembly: unknown;
  try {
    assembly = JSON.parse(input.payload) as unknown;
  } catch {
    throw new HttpError("Invalid Transloadit payload", 400, "INVALID_REQUEST");
  }
  const fields = fieldsOf(assembly);
  if (!fields.userId) {
    throw new HttpError("Assembly is missing ownership fields", 400, "INVALID_REQUEST");
  }
  return persistAssembly({
    userId: fields.userId,
    chatId: fields.chatId,
    assembly,
    db: input.db,
  });
}

function fieldsOf(assembly: unknown): { userId?: string; chatId?: string } {
  if (!assembly || typeof assembly !== "object") return {};
  const record = assembly as Record<string, unknown>;
  const fields = record.fields;
  if (!fields || typeof fields !== "object") return {};
  const typed = fields as Record<string, unknown>;
  return {
    userId: typeof typed.userId === "string" ? typed.userId : undefined,
    chatId: typeof typed.chatId === "string" ? typed.chatId : undefined,
  };
}

function assemblyIdOf(assembly: unknown): string | undefined {
  if (!assembly || typeof assembly !== "object") return undefined;
  const id = (assembly as Record<string, unknown>).assembly_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function filesFromAssembly(assembly: unknown): z.infer<typeof assemblyFileSchema>[] {
  if (!assembly || typeof assembly !== "object") return [];
  const record = assembly as Record<string, unknown>;
  const collected: unknown[] = [];
  if (Array.isArray(record.uploads)) collected.push(...record.uploads);
  const results = record.results;
  if (results && typeof results === "object") {
    for (const value of Object.values(results as Record<string, unknown>)) {
      if (Array.isArray(value)) collected.push(...value);
    }
  }
  const parsed = collected
    .map((file) => assemblyFileSchema.safeParse(file))
    .filter((result) => result.success)
    .map((result) => result.data);
  const seen = new Set<string>();
  return parsed.filter((file) => {
    if (seen.has(file.id)) return false;
    seen.add(file.id);
    return true;
  });
}

async function upsertUpload(
  db: PrismaClient,
  input: {
    userId: string;
    chatId?: string;
    assemblyId: string;
    file: z.infer<typeof assemblyFileSchema>;
  },
): Promise<{ id: string; status: string; filename: string }> {
  const filename =
    input.file.name ||
    [input.file.basename, input.file.ext].filter(Boolean).join(".") ||
    "upload";
  const mimeType = input.file.mime ?? input.file.type ?? "application/octet-stream";
  const byteSize = Math.round(input.file.size ?? 0);
  const url = input.file.ssl_url ?? input.file.url ?? null;
  const tooLarge = byteSize > COMMUNITY_MAX_FILE_BYTES;
  const mimeDenied = !ALLOWED.has(mimeType);
  const status = tooLarge || mimeDenied || !url ? "FAILED" : "COMPLETE";
  const errorMessage = tooLarge
    ? "File exceeds the 0.5 GB Community-plan limit"
    : mimeDenied
      ? "This file type is not allowed"
      : !url
        ? "Upload finished without a result URL"
        : undefined;
  const errorCode = tooLarge
    ? "FILE_TOO_LARGE"
    : mimeDenied
      ? "UNSUPPORTED_TYPE"
      : !url
        ? "UPLOAD_FAILED"
        : undefined;
  const durationMs =
    typeof input.file.meta?.duration === "number"
      ? Math.round(input.file.meta.duration * 1000)
      : undefined;
  const expiresAt = status === "COMPLETE" ? new Date(Date.now() + 24 * 60 * 60 * 1000) : undefined;

  const data = {
    userId: input.userId,
    chatId: input.chatId,
    origin: "UPLOAD" as const,
    status: status as "COMPLETE" | "FAILED",
    filename,
    mimeType,
    byteSize,
    url,
    width: input.file.meta?.width ?? undefined,
    height: input.file.meta?.height ?? undefined,
    durationMs,
    transloaditAssemblyId: input.assemblyId,
    transloaditFileId: input.file.id,
    expiresAt,
    errorCode,
    errorMessage,
  };

  try {
    const row = await db.attachment.upsert({
      where: {
        transloaditAssemblyId_transloaditFileId: {
          transloaditAssemblyId: input.assemblyId,
          transloaditFileId: input.file.id,
        },
      },
      create: data,
      update: data,
      select: { id: true, status: true, filename: true },
    });
    return row;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await db.attachment.findFirst({
        where: {
          transloaditAssemblyId: input.assemblyId,
          transloaditFileId: input.file.id,
        },
        select: { id: true, status: true, filename: true },
      });
      if (existing) return existing;
    }
    throw error;
  }
}
