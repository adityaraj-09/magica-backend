import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { deleteProject, getProject, updateProject } from "@/server/chat/projects";
import { jsonError } from "@/server/http/json-error";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    return NextResponse.json(await getProject({ userId: user.id, projectId }));
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    const body: unknown = await request.json().catch(() => null);
    const project = await updateProject({ userId: user.id, projectId, body });
    return NextResponse.json(project);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { projectId } = await context.params;
    await deleteProject({ userId: user.id, projectId });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
