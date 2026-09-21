import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { jsonError } from "@/server/http/json-error";
import { signChatUpload } from "@/server/uploads/transloadit";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId } = await context.params;
    const signed = await signChatUpload({ userId: user.id, chatId });
    return NextResponse.json(signed);
  } catch (error) {
    return jsonError(error);
  }
}
