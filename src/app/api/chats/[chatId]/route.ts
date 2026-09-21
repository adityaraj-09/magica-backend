import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { deleteChat, getChat, updateChat } from "@/server/chat/chats";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId } = await context.params;
    const chat = await getChat({ userId: user.id, chatId });
    return NextResponse.json(chat);
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId } = await context.params;
    const body: unknown = await request.json().catch(() => null);
    const chat = await updateChat({ userId: user.id, chatId, body });
    return NextResponse.json(chat);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId } = await context.params;
    await deleteChat({ userId: user.id, chatId });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
