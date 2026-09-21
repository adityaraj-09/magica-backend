import { NextResponse } from "next/server";
import { jsonError } from "@/server/http/json-error";
import { requireApiUser } from "@/server/public/api-keys";
import { executePublicMagicaTool, magicaPublicToolSchema } from "@/server/public/magica";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ toolName: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireApiUser({ authorization: request.headers.get("authorization") });
    const { toolName } = await context.params;
    const parsed = magicaPublicToolSchema.safeParse(toolName);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Unknown Magica tool", code: "UNKNOWN_TOOL" },
        { status: 404 },
      );
    }
    const body: unknown = await request.json().catch(() => null);
    const result = await executePublicMagicaTool({
      userId: user.id,
      toolName: parsed.data,
      body,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
