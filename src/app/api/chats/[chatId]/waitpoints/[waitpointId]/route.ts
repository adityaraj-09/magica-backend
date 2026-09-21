import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { completeWaitpoint } from "@/server/chat/complete-waitpoint";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string; waitpointId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId, waitpointId } = await context.params;
    const body: unknown = await request.json().catch(() => null);
    const result = await completeWaitpoint({
      userId: user.id,
      chatId,
      waitpointId,
      body,
    });
    return NextResponse.json({
      chatId: result.chatId,
      runId: result.runId,
      waitpointId: result.waitpointId,
      decision: result.decision,
      waitpoint: result.overlay,
    });
  } catch (error) {
    return jsonError(error);
  }
}
