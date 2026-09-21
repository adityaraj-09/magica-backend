import { NextResponse } from "next/server";
import { HttpError } from "@/server/http/errors";
import { jsonError } from "@/server/http/json-error";
import { persistSignedWebhook } from "@/server/uploads/transloadit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { payload, signature } = await readWebhook(request);
    const result = await persistSignedWebhook({ payload, signature });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof HttpError && error.code === "CHAT_NOT_FOUND") {
      return NextResponse.json({ attachments: [] });
    }
    return jsonError(error);
  }
}

async function readWebhook(request: Request): Promise<{ payload: string; signature: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new HttpError("Invalid Transloadit payload", 400, "INVALID_REQUEST");
    }
    const record = body as Record<string, unknown>;
    const payload =
      typeof record.transloadit === "string" ? record.transloadit : JSON.stringify(record);
    const signature = typeof record.signature === "string" ? record.signature : "";
    return { payload, signature };
  }

  const form = await request.formData();
  const payload = String(form.get("transloadit") ?? "");
  const signature = String(form.get("signature") ?? "");
  return { payload, signature };
}
