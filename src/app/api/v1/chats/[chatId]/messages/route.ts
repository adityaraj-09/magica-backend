import { NextResponse } from "next/server";
import { listMessages, queryFromUrl } from "@/server/chat/chats";
import { jsonError } from "@/server/http/json-error";
import { requireApiUser } from "@/server/public/api-keys";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireApiUser({ authorization: request.headers.get("authorization") });
    const { chatId } = await context.params;
    const result = await listMessages({
      userId: user.id,
      chatId,
      query: queryFromUrl(request.url),
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
