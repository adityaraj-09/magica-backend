import { NextResponse } from "next/server";
import { jsonError } from "@/server/http/json-error";
import { requireApiUser } from "@/server/public/api-keys";
import { persistApiUploadFiles, readPublicRequest } from "@/server/uploads/api-upload";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requireApiUser({ authorization: request.headers.get("authorization") });
    const { fields, files } = await readPublicRequest(request);
    const chatId = typeof fields.chatId === "string" ? fields.chatId : undefined;
    const result = await persistApiUploadFiles({
      userId: user.id,
      chatId,
      files,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
