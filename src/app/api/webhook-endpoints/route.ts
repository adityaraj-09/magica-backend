import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { jsonError } from "@/server/http/json-error";
import { createWebhookEndpoint, listWebhookEndpoints } from "@/server/public/webhooks";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(await listWebhookEndpoints({ userId: user.id }));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const created = await createWebhookEndpoint({ userId: user.id, body });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
