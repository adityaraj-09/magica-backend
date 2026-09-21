import { NextResponse } from "next/server";
import { admitTurn } from "@/server/chat/admit-turn";
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

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireApiUser({ authorization: request.headers.get("authorization") });
    const { chatId } = await context.params;
    const body: unknown = await request.json().catch(() => null);
    const admitted = await admitTurn({ user, chatId, body });
    return NextResponse.json(
      {
        chatId: admitted.chatId,
        messageId: admitted.messageId,
        runId: admitted.runId,
        triggerRunId: admitted.triggerRunId,
        status: "queued",
      },
      { status: admitted.replayed ? 200 : 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
