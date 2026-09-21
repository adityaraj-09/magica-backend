import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { jsonError } from "@/server/http/json-error";
import { loadRunSnapshot } from "@/server/realtime/snapshot";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string; runId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId, runId } = await context.params;
    const snapshot = await loadRunSnapshot({ userId: user.id, chatId, runId });
    return NextResponse.json(snapshot);
  } catch (error) {
    return jsonError(error);
  }
}
