import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({
      id: user.id,
      clerkUserId: user.clerkUserId,
      email: user.email,
      creditBalance: user.creditBalance.toString(),
    });
  } catch (error) {
    return jsonError(error);
  }
}
