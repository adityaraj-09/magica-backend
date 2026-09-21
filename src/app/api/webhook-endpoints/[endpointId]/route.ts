import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { jsonError } from "@/server/http/json-error";
import { deleteWebhookEndpoint } from "@/server/public/webhooks";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ endpointId: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { endpointId } = await context.params;
    await deleteWebhookEndpoint({ userId: user.id, endpointId });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
