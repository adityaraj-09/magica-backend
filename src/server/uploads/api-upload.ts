import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { requireOwnedChat } from "@/server/chat/owned";
import { s3ConfigFromEnv, createS3ObjectStore } from "@/server/storage/s3";
import {
  ALLOWED_UPLOAD_MIME,
  MAX_FILES_PER_ASSEMBLY,
  TRANSLOADIT_ASSEMBLY_URL,
  persistAssembly,
  signAssemblyParams,
  transloaditCredentials,
} from "@/server/uploads/transloadit";

export const API_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const ALLOWED = new Set<string>(ALLOWED_UPLOAD_MIME);
const FILE_FIELD = new Set(["file", "files", "image", "images", "upload", "uploads"]);

export type IncomingUpload = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type UploadedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  url: string | null;
  status: string;
};

export async function readPublicRequest(request: Request): Promise<{
  fields: Record<string, unknown>;
  files: IncomingUpload[];
}> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    return formDataToPublicInput(await request.formData());
  }
  const json: unknown = await request.json().catch(() => ({}));
  return {
    fields: json && typeof json === "object" && !Array.isArray(json) ? { ...(json as Record<string, unknown>) } : {},
    files: [],
  };
}

export async function formDataToPublicInput(form: FormData): Promise<{
  fields: Record<string, unknown>;
  files: IncomingUpload[];
}> {
  const fields: Record<string, unknown> = {};
  const files: IncomingUpload[] = [];
  for (const [key, value] of form.entries()) {
    if (typeof File !== "undefined" && value instanceof File) {
      if (!FILE_FIELD.has(key) && value.size === 0) {
        fields[key] = coerceFormValue(value.name);
        continue;
      }
      files.push(await fileToUpload(value));
      continue;
    }
    if (typeof value !== "string") continue;
    const parsed = coerceFormValue(value);
    const current = fields[key];
    if (current === undefined) {
      fields[key] = parsed;
    } else if (Array.isArray(current)) {
      current.push(parsed);
    } else {
      fields[key] = [current, parsed];
    }
  }
  return { fields, files };
}

export async function persistApiUploadFiles(input: {
  userId: string;
  chatId?: string;
  files: IncomingUpload[];
  db?: PrismaClient;
  env?: Record<string, string | undefined>;
}): Promise<{ chatId: string | null; attachments: UploadedAttachment[] }> {
  if (input.files.length === 0) {
    throw new HttpError("Attach at least one file", 400, "INVALID_REQUEST");
  }
  if (input.files.length > MAX_FILES_PER_ASSEMBLY) {
    throw new HttpError(
      `A request can include at most ${MAX_FILES_PER_ASSEMBLY} files`,
      400,
      "TOO_MANY_ATTACHMENTS",
    );
  }
  for (const file of input.files) {
    if (!ALLOWED.has(file.mimeType)) {
      throw new HttpError(`File type ${file.mimeType} is not allowed`, 400, "UNSUPPORTED_TYPE");
    }
    if (file.bytes.byteLength > API_UPLOAD_MAX_BYTES) {
      throw new HttpError(
        `Each file must be ${API_UPLOAD_MAX_BYTES / (1024 * 1024)} MB or smaller`,
        400,
        "FILE_TOO_LARGE",
      );
    }
  }

  const env = input.env ?? process.env;
  const s3 = s3ConfigFromEnv(env);
  if (!s3) {
    try {
      transloaditCredentials(env);
    } catch {
      throw new HttpError(
        "File uploads need S3 or Transloadit configured on the server",
        503,
        "UPLOADS_UNAVAILABLE",
      );
    }
  }

  const db = input.db ?? prisma;
  const chatId = input.chatId
    ? (await requireOwnedChat(input.userId, input.chatId, db), input.chatId)
    : null;

  if (s3) {
    return {
      chatId,
      attachments: await persistToS3({
        userId: input.userId,
        chatId,
        files: input.files,
        db,
        config: s3,
      }),
    };
  }

  return {
    chatId,
    attachments: await persistToTransloadit({
      userId: input.userId,
      chatId,
      files: input.files,
      db,
      env,
    }),
  };
}

async function persistToS3(input: {
  userId: string;
  chatId: string | null;
  files: IncomingUpload[];
  db: PrismaClient;
  config: NonNullable<ReturnType<typeof s3ConfigFromEnv>>;
}): Promise<UploadedAttachment[]> {
  const store = createS3ObjectStore(input.config);
  const saved: UploadedAttachment[] = [];
  for (const file of input.files) {
    const filename = safeFilename(file.filename);
    const stored = await store.put({
      key: `uploads/${input.userId}/${input.chatId ?? "library"}/${randomUUID()}/${filename}`,
      body: file.bytes,
      contentType: file.mimeType,
    });
    const row = await input.db.attachment.create({
      data: {
        userId: input.userId,
        chatId: input.chatId,
        origin: "UPLOAD",
        status: "COMPLETE",
        filename,
        mimeType: file.mimeType,
        byteSize: stored.byteSize,
        url: stored.url,
        storageKey: stored.key,
      },
      select: { id: true, filename: true, mimeType: true, url: true, status: true },
    });
    saved.push({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      url: row.url,
      status: row.status,
    });
  }
  return saved;
}

async function persistToTransloadit(input: {
  userId: string;
  chatId: string | null;
  files: IncomingUpload[];
  db: PrismaClient;
  env: Record<string, string | undefined>;
}): Promise<UploadedAttachment[]> {
  const creds = transloaditCredentials(input.env);
  const signed = signAssemblyParams({
    key: creds.key,
    secret: creds.secret,
    chatId: input.chatId ?? undefined,
    userId: input.userId,
    notifyUrl: creds.notifyUrl,
  });
  const form = new FormData();
  form.set("params", signed.params);
  form.set("signature", signed.signature);
  for (const file of input.files) {
    form.append(
      "files[]",
      new Blob([Buffer.from(file.bytes)], { type: file.mimeType }),
      file.filename,
    );
  }
  const response = await fetch(TRANSLOADIT_ASSEMBLY_URL, { method: "POST", body: form });
  const assembly: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HttpError("Upload to storage failed", 502, "UPLOAD_FAILED");
  }
  const persisted = await persistAssembly({
    userId: input.userId,
    chatId: input.chatId ?? undefined,
    assembly,
    db: input.db,
  });
  if (persisted.attachments.length === 0) {
    throw new HttpError("Upload finished without a file", 502, "UPLOAD_FAILED");
  }
  const rows = await input.db.attachment.findMany({
    where: { id: { in: persisted.attachments.map((row) => row.id) } },
    select: { id: true, filename: true, mimeType: true, url: true, status: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return persisted.attachments.map((row) => {
    const full = byId.get(row.id);
    return {
      id: row.id,
      filename: full?.filename ?? row.filename,
      mimeType: full?.mimeType ?? "application/octet-stream",
      url: full?.url ?? null,
      status: full?.status ?? row.status,
    };
  });
}

async function fileToUpload(file: File): Promise<IncomingUpload> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  return {
    filename: file.name || "upload",
    mimeType: file.type || "application/octet-stream",
    bytes: buffer,
  };
}

function coerceFormValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "upload";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "upload";
}
