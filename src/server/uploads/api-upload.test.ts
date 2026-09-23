import { describe, expect, it } from "vitest";
import { HttpError } from "@/server/http/errors";
import { API_UPLOAD_MAX_BYTES, formDataToPublicInput, persistApiUploadFiles } from "./api-upload";

describe("formDataToPublicInput", () => {
  it("reads text fields and file parts", async () => {
    const form = new FormData();
    form.set("text", "what is this");
    form.set("planMode", "false");
    form.append("file", new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
    const parsed = await formDataToPublicInput(form);
    expect(parsed.fields).toMatchObject({ text: "what is this", planMode: false });
    expect(parsed.files).toEqual([
      expect.objectContaining({ filename: "shot.png", mimeType: "image/png" }),
    ]);
    expect(parsed.files[0]?.bytes.byteLength).toBe(3);
  });
});

describe("persistApiUploadFiles", () => {
  it("rejects disallowed types and oversized files before storage", async () => {
    await expect(
      persistApiUploadFiles({
        userId: "22222222-2222-2222-2222-222222222222",
        files: [{ filename: "notes.txt", mimeType: "text/plain", bytes: new Uint8Array([1]) }],
      }),
    ).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED_TYPE" });

    await expect(
      persistApiUploadFiles({
        userId: "22222222-2222-2222-2222-222222222222",
        files: [
          {
            filename: "big.png",
            mimeType: "image/png",
            bytes: new Uint8Array(API_UPLOAD_MAX_BYTES + 1),
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, code: "FILE_TOO_LARGE" });
  });

  it("returns 503 when neither S3 nor Transloadit is configured", async () => {
    await expect(
      persistApiUploadFiles({
        userId: "22222222-2222-2222-2222-222222222222",
        files: [{ filename: "shot.png", mimeType: "image/png", bytes: new Uint8Array([1]) }],
        env: {},
      }),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      persistApiUploadFiles({
        userId: "22222222-2222-2222-2222-222222222222",
        files: [{ filename: "shot.png", mimeType: "image/png", bytes: new Uint8Array([1]) }],
        env: {},
      }),
    ).rejects.toMatchObject({ status: 503, code: "UPLOADS_UNAVAILABLE" });
  });
});
