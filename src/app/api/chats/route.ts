import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { createChat, listChats, queryFromUrl } from "@/server/chat/chats";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const result = await listChats({ userId: user.id, query: queryFromUrl(request.url) });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => ({}));
    const chat = await createChat({ userId: user.id, body });
    return NextResponse.json(chat, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
