import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetGateway, objectKey, persistAssets } from "./copy";
import { s3ConfigFromEnv } from "./s3";
import type { ObjectStore } from "./types";

const ids = {
  chatId: "11111111-1111-1111-1111-111111111111",
  runId: "33333333-3333-3333-3333-333333333333",
  toolCallId: "call_crop",
};

function fakeStore(): ObjectStore & { puts: Array<{ key: string; body: Uint8Array; contentType: string }> } {
  const puts: Array<{ key: string; body: Uint8Array; contentType: string }> = [];
  return {
    puts,
    async put(input) {
      puts.push(input);
      return {
        key: input.key,
        url: `https://cdn.galaxy.test/${input.key}`,
        byteSize: input.body.byteLength,
      };
    },
  };
}

describe("s3ConfigFromEnv", () => {
  it("returns null until bucket, keys, and public base URL are set", () => {
    expect(s3ConfigFromEnv({})).toBeNull();
    expect(
      s3ConfigFromEnv({
        S3_BUCKET: "galaxy",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
      }),
    ).toBeNull();
    expect(
      s3ConfigFromEnv({
        S3_BUCKET: "galaxy",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
        S3_PUBLIC_BASE_URL: "https://cdn.example",
        S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      }),
    ).toMatchObject({
      bucket: "galaxy",
      endpoint: "https://account.r2.cloudflarestorage.com",
      publicBaseUrl: "https://cdn.example",
      region: "auto",
    });
  });
});

describe("createAssetGateway", () => {
  it("keeps ephemeral URLs when object storage is not configured", async () => {
    const gateway = createAssetGateway({});
    const assets = [{ url: "https://magica.example/out.png", mimeType: "image/png" }];
    await expect(
      gateway.persist({ ...ids, assets }),
    ).resolves.toEqual(assets);
  });
});

describe("persistAssets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies Magica result bytes into durable object storage", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "4" },
        }),
      ),
    );
    const store = fakeStore();
    const copied = await persistAssets(store, {
      ...ids,
      assets: [
        {
          url: "https://inference.magica.com/results/out.png?exp=1",
          mimeType: "image/png",
        },
      ],
    });
    expect(copied[0]).toMatchObject({
      url: `https://cdn.galaxy.test/generated/${ids.chatId}/${ids.runId}/${ids.toolCallId}/out.png`,
      storageKey: `generated/${ids.chatId}/${ids.runId}/${ids.toolCallId}/out.png`,
      byteSize: 4,
      mimeType: "image/png",
      filename: "out.png",
    });
    expect(store.puts).toHaveLength(1);
  });

  it("keeps the ephemeral URL when the copy fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 410 })));
    const store = fakeStore();
    const ephemeral = { url: "https://e2b.dev/expired.png", mimeType: "image/png" };
    await expect(persistAssets(store, { ...ids, assets: [ephemeral] })).resolves.toEqual([
      ephemeral,
    ]);
    expect(store.puts).toHaveLength(0);
  });

  it("sanitizes filenames and de-duplicates keys in the same tool call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 })),
    );
    const store = fakeStore();
    const copied = await persistAssets(store, {
      ...ids,
      assets: [
        { url: "https://cdn.example/a.png", mimeType: "image/png", filename: "../weird name.png" },
        { url: "https://cdn.example/b.png", mimeType: "image/png", filename: "../weird name.png" },
      ],
    });
    expect(copied.map((asset) => asset.filename)).toEqual(["weird_name.png", "weird_name_2.png"]);
    expect(objectKey({ ...ids, filename: "out.png" })).toBe(
      `generated/${ids.chatId}/${ids.runId}/${ids.toolCallId}/out.png`,
    );
  });
});
