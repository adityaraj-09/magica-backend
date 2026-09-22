import { NextResponse } from "next/server";
import { z } from "zod";
import { findAttachmentByUrl } from "@/server/chat/attachments";
import { requireUser } from "@/server/auth/require-user";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  url: z.string().url(),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = bodySchema.parse(await request.json());
    const attachment = await findAttachmentByUrl({ userId: user.id, url: body.url });
    return NextResponse.json(attachment);
  } catch (error) {
    return jsonError(error);
  }
}
