import type { GeneratedAsset } from "@/agent/tools/types";
import { logWarn } from "@/server/log";
import { createS3ObjectStore, s3ConfigFromEnv } from "./s3";
import type { AssetGateway, ObjectStore } from "./types";

export type { AssetGateway, ObjectStore };

export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

export const noopAssets: AssetGateway = {
  async persist(input) {
    return input.assets;
  },
};

export function createAssetGateway(
  env: Record<string, string | undefined> = process.env,
  store?: ObjectStore,
): AssetGateway {
  const resolved = store ?? storeFromEnv(env);
  if (!resolved) return noopAssets;
  return {
    persist(input) {
      return persistAssets(resolved, input);
    },
  };
}

function storeFromEnv(env: Record<string, string | undefined>): ObjectStore | null {
  const config = s3ConfigFromEnv(env);
  return config ? createS3ObjectStore(config) : null;
}

export async function persistAssets(
  store: ObjectStore,
  input: {
    chatId: string;
    runId: string;
    toolCallId: string;
    assets: GeneratedAsset[];
    signal?: AbortSignal;
  },
): Promise<GeneratedAsset[]> {
  const copied: GeneratedAsset[] = [];
  const usedNames = new Set<string>();
  for (const asset of input.assets) {
    copied.push(
      await copyOne(store, asset, input, usedNames).catch((error: unknown) => {
        logWarn("asset.copy_failed", {
          chatId: input.chatId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          sourceUrl: asset.url,
          error: error instanceof Error ? error.message : "copy failed",
        });
        return asset;
      }),
    );
  }
  return copied;
}

export function objectKey(input: {
  chatId: string;
  runId: string;
  toolCallId: string;
  filename: string;
}): string {
  return `generated/${input.chatId}/${input.runId}/${input.toolCallId}/${safeFilename(input.filename)}`;
}

async function copyOne(
  store: ObjectStore,
  asset: GeneratedAsset,
  input: {
    chatId: string;
    runId: string;
    toolCallId: string;
    signal?: AbortSignal;
  },
  usedNames: Set<string>,
): Promise<GeneratedAsset> {
  if (asset.storageKey) return asset;
  const filename = uniqueFilename(asset.filename ?? filenameFromUrl(asset.url), usedNames);
  const downloaded = await downloadAsset(asset.url, input.signal);
  const mimeType = asset.mimeType || downloaded.contentType || "application/octet-stream";
  const stored = await store.put({
    key: objectKey({
      chatId: input.chatId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      filename,
    }),
    body: downloaded.body,
    contentType: mimeType,
  });
  return {
    ...asset,
    url: stored.url,
    mimeType,
    filename,
    storageKey: stored.key,
    byteSize: stored.byteSize,
  };
}

async function downloadAsset(
  url: string,
  signal?: AbortSignal,
): Promise<{ body: Uint8Array; contentType?: string }> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Asset download failed (${response.status})`);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_ASSET_BYTES) {
    throw new Error("Generated asset exceeds the 50 MB copy limit");
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ASSET_BYTES) {
    throw new Error("Generated asset exceeds the 50 MB copy limit");
  }
  return {
    body: buffer,
    contentType: response.headers.get("content-type") ?? undefined,
  };
}

function filenameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return name ? decodeURIComponent(name) : "generated";
  } catch {
    return "generated";
  }
}

function uniqueFilename(name: string, used: Set<string>): string {
  const cleaned = safeFilename(name);
  if (!used.has(cleaned)) {
    used.add(cleaned);
    return cleaned;
  }
  const dot = cleaned.lastIndexOf(".");
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  let n = 2;
  let candidate = `${stem}_${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${stem}_${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "generated";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return cleaned || "generated";
}
