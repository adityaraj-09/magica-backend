import { NextResponse } from "next/server";
import { admitTurn } from "@/server/chat/admit-turn";
import { createChat } from "@/server/chat/chats";
import { jsonError } from "@/server/http/json-error";
import { requireApiUser } from "@/server/public/api-keys";
import { publicCompletionBodySchema } from "@/server/public/completions";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    chatId: z.string().uuid().optional(),
  })
  .passthrough();

export async function POST(request: Request) {
  try {
    const user = await requireApiUser({ authorization: request.headers.get("authorization") });
    const raw: unknown = await request.json().catch(() => ({}));
    const parsed = bodySchema.parse(raw ?? {});
    const chatId =
      parsed.chatId ?? (await createChat({ userId: user.id, body: {} })).id;
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
      { status: 202 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
