import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { jsonError } from "@/server/http/json-error";
import { revokeApiKey } from "@/server/public/api-keys";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ keyId: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { keyId } = await context.params;
    await revokeApiKey({ userId: user.id, keyId });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
