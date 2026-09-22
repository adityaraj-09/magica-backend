import { describe, expect, it, vi } from "vitest";
import { API_KEY_PREFIX, generateApiKey, hashApiKey, requireApiUser } from "./api-keys";

describe("api keys", () => {
  it("hashes a generated key and authenticates it", async () => {
    const generated = generateApiKey();
    expect(generated.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(generated.hashedKey).toBe(hashApiKey(generated.key));
    const findUnique = vi.fn(async () => ({
      id: "key_1",
      revokedAt: null,
      user: { id: "user_1", email: "ada@example.com", creditBalance: "10" },
    }));
    const update = vi.fn(async () => ({}));
    const user = await requireApiUser({
      authorization: `Bearer ${generated.key}`,
      db: { apiKey: { findUnique, update } } as never,
    });
    expect(user.id).toBe("user_1");
    expect(findUnique).toHaveBeenCalledWith({
      where: { hashedKey: generated.hashedKey },
      include: { user: true },
    });
  });

  it("rejects a missing, malformed, or revoked key", async () => {
    await expect(requireApiUser({ authorization: null })).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    await expect(requireApiUser({ authorization: "Bearer nope" })).rejects.toMatchObject({
      status: 401,
    });
    const findUnique = vi.fn(async () => ({
      id: "key_1",
      revokedAt: new Date(),
      user: { id: "user_1" },
    }));
    await expect(
      requireApiUser({
        authorization: `Bearer ${generateApiKey().key}`,
        db: { apiKey: { findUnique, update: vi.fn() } } as never,
      }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });
});
