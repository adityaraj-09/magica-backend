import { NextResponse } from "next/server";
import { jsonError } from "@/server/http/json-error";
import { requireApiUser } from "@/server/public/api-keys";
import { loadRunSnapshot } from "@/server/realtime/snapshot";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string; runId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireApiUser({ authorization: request.headers.get("authorization") });
    const { chatId, runId } = await context.params;
    const snapshot = await loadRunSnapshot({
      userId: user.id,
      chatId,
      runId,
      mintToken: false,
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    return jsonError(error);
  }
}
