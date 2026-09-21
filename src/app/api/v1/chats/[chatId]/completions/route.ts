import { NextResponse } from "next/server";
import { admitTurn } from "@/server/chat/admit-turn";
import { jsonError } from "@/server/http/json-error";
import { requireApiUser } from "@/server/public/api-keys";
import { publicCompletionBodySchema } from "@/server/public/completions";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireApiUser({ authorization: request.headers.get("authorization") });
    const { chatId } = await context.params;
    const raw: unknown = await request.json().catch(() => ({}));
    const body = publicCompletionBodySchema.parse(raw);
    const admitted = await admitTurn({ user, chatId, body });
    return NextResponse.json(
      {
        chatId: admitted.chatId,
        messageId: admitted.messageId,
        runId: admitted.runId,
        triggerRunId: admitted.triggerRunId,
        status: "queued",
      },
      { status: admitted.replayed ? 200 : 202 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
