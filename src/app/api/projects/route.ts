import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { queryFromUrl } from "@/server/chat/chats";
import { createProject, listProjects } from "@/server/chat/projects";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const result = await listProjects({ userId: user.id, query: queryFromUrl(request.url) });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => ({}));
    const project = await createProject({ userId: user.id, body });
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
