import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { jsonError } from "@/server/http/json-error";
import { persistAssembly } from "@/server/uploads/transloadit";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ chatId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { chatId } = await context.params;
    const body: unknown = await request.json().catch(() => null);
    const assembly = unwrapAssembly(body);
    const result = await persistAssembly({ userId: user.id, chatId, assembly });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}

function unwrapAssembly(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  if (typeof record.transloadit === "string") {
    try {
      return JSON.parse(record.transloadit) as unknown;
    } catch {
      return record;
    }
  }
  if (record.assembly && typeof record.assembly === "object") return record.assembly;
  return record;
}
