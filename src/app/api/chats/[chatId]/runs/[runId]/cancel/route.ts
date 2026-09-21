import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { jsonError } from "@/server/http/json-error";
import { cancelRun } from "@/server/jobs/cancel";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string; runId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId, runId } = await context.params;
    const result = await cancelRun({ userId: user.id, chatId, runId });
    return NextResponse.json({
      chatId: result.chatId,
      runId: result.runId,
      status: result.status,
    });
  } catch (error) {
    return jsonError(error);
  }
}
