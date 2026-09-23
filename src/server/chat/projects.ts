import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import {
  createdAtIdWhere,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
} from "@/server/http/cursor";
import { memoryUsedPercent } from "@/agent/runtime/project-memory";

const iconSchema = z.enum(["investing", "homework", "writing", "health"]);

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  icon: iconSchema.optional(),
  memoryEnabled: z.boolean().optional(),
});

export const updateProjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    icon: iconSchema.optional(),
    memoryEnabled: z.boolean().optional(),
    instructions: z.string().max(4000).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.icon !== undefined ||
      body.memoryEnabled !== undefined ||
      body.instructions !== undefined,
    { message: "Provide a field to update" },
  );

export type ProjectJson = {
  id: string;
  name: string;
  icon: string;
  memoryEnabled: boolean;
  instructions: string;
  memory: string;
  memoryUsedPercent: number;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
};

const projectSelect = {
  id: true,
  name: true,
  icon: true,
  memoryEnabled: true,
  instructions: true,
  memory: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { chats: { where: { deletedAt: null } } } },
} as const;

function toProjectJson(row: {
  id: string;
  name: string;
  icon?: string | null;
  memoryEnabled?: boolean | null;
  instructions?: string | null;
  memory?: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { chats: number };
}): ProjectJson {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon ?? "writing",
    memoryEnabled: row.memoryEnabled ?? true,
    instructions: row.instructions ?? "",
    memory: row.memory ?? "",
    memoryUsedPercent: memoryUsedPercent(row.memory ?? ""),
    taskCount: row._count.chats,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function requireOwnedProject(
  userId: string,
  projectId: string,
  db: PrismaClient = prisma,
): Promise<void> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { userId: true, deletedAt: true },
  });
  if (!project || project.userId !== userId || project.deletedAt) {
    throw new HttpError("Project not found", 404, "PROJECT_NOT_FOUND");
  }
}

export async function createProject(input: {
  userId: string;
  body: unknown;
  db?: PrismaClient;
}): Promise<ProjectJson> {
  const body = createProjectBodySchema.parse(input.body ?? {});
  const db = input.db ?? prisma;
  const row = await db.project.create({
    data: {
      userId: input.userId,
      name: body.name,
      icon: body.icon ?? "writing",
      memoryEnabled: body.memoryEnabled ?? true,
    },
    select: projectSelect,
  });
  return toProjectJson(row);
}

export async function getProject(input: {
  userId: string;
  projectId: string;
  db?: PrismaClient;
}): Promise<ProjectJson> {
  const db = input.db ?? prisma;
  await requireOwnedProject(input.userId, input.projectId, db);
  const row = await db.project.findUniqueOrThrow({
    where: { id: input.projectId },
    select: projectSelect,
  });
  return toProjectJson(row);
}

export async function listProjects(input: {
  userId: string;
  query: unknown;
  db?: PrismaClient;
}): Promise<{ items: ProjectJson[]; nextCursor: string | null }> {
  const query = paginationQuerySchema.extend({ q: z.string().trim().min(1).max(200).optional() }).parse(
    input.query,
  );
  const db = input.db ?? prisma;
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const search = query.q;
  const rows = await db.project.findMany({
    where: {
      userId: input.userId,
      deletedAt: null,
      ...createdAtIdWhere(cursor),
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: projectSelect,
  });
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);
  return {
    items: items.map(toProjectJson),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function updateProject(input: {
  userId: string;
  projectId: string;
  body: unknown;
  db?: PrismaClient;
}): Promise<ProjectJson> {
  const body = updateProjectBodySchema.parse(input.body);
  const db = input.db ?? prisma;
  await requireOwnedProject(input.userId, input.projectId, db);
  const row = await db.project.update({
    where: { id: input.projectId },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.icon !== undefined ? { icon: body.icon } : {}),
      ...(body.memoryEnabled !== undefined ? { memoryEnabled: body.memoryEnabled } : {}),
      ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
    },
    select: projectSelect,
  });
  return toProjectJson(row);
}

export async function deleteProject(input: {
  userId: string;
  projectId: string;
  db?: PrismaClient;
}): Promise<void> {
  const db = input.db ?? prisma;
  await requireOwnedProject(input.userId, input.projectId, db);
  await db.$transaction([
    db.chat.updateMany({
      where: { userId: input.userId, projectId: input.projectId, deletedAt: null },
      data: { projectId: null },
    }),
    db.project.update({
      where: { id: input.projectId },
      data: { deletedAt: new Date() },
    }),
  ]);
}
