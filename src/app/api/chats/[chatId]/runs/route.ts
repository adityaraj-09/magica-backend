import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { requireOwnedChat } from "@/server/chat/owned";
import { prisma } from "@/server/db";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string }> };

const ACTIVE = ["QUEUED", "THINKING", "WORKING", "WAITING", "STOPPING"] as const;

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId } = await context.params;
    await requireOwnedChat(user.id, chatId);
    const run = await prisma.agentRun.findFirst({
      where: { chatId, userId: user.id, status: { in: [...ACTIVE] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, triggerRunId: true, status: true },
    });
    return NextResponse.json({
      runId: run?.id ?? null,
      triggerRunId: run?.triggerRunId ?? null,
      status: run?.status ?? null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
