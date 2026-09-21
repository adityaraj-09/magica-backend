import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { listCreditLedger } from "@/server/credits/ledger";
import { queryFromUrl } from "@/server/chat/chats";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const result = await listCreditLedger({
      userId: user.id,
      creditBalance: user.creditBalance,
      query: queryFromUrl(request.url),
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
