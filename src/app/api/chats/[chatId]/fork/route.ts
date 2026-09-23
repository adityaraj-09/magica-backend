import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { forkChat } from "@/server/chat/fork";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId } = await context.params;
    const body: unknown = await request.json().catch(() => null);
    const chat = await forkChat({ userId: user.id, chatId, body });
    return NextResponse.json(chat, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
