import { NextResponse } from "next/server";
import { deleteChat, getChat } from "@/server/chat/chats";
import { jsonError } from "@/server/http/json-error";
import { requireApiUser } from "@/server/public/api-keys";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireApiUser({ authorization: request.headers.get("authorization") });
    const { chatId } = await context.params;
    const chat = await getChat({ userId: user.id, chatId });
    return NextResponse.json(chat);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const user = await requireApiUser({ authorization: request.headers.get("authorization") });
    const { chatId } = await context.params;
    await deleteChat({ userId: user.id, chatId });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
