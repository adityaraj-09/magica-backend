import { describe, expect, it, vi } from "vitest";
import { createProject, deleteProject, listProjects } from "./projects";

const ids = {
  userId: "22222222-2222-2222-2222-222222222222",
  projectId: "33333333-3333-3333-3333-333333333333",
};

const createdAt = new Date("2026-09-23T05:00:00.000Z");

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.projectId,
    userId: ids.userId,
    name: "Launch",
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    _count: { chats: 2 },
    ...overrides,
  };
}

describe("projects", () => {
  it("creates a named project", async () => {
    const create = vi.fn(async () => projectRow());
    const project = await createProject({
      userId: ids.userId,
      body: { name: "Launch" },
      db: { project: { create } } as never,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: ids.userId, name: "Launch" }),
      }),
    );
    expect(project.taskCount).toBe(2);
  });

  it("lists owned projects and hides deleted ones", async () => {
    const findMany = vi.fn(async () => [projectRow()]);
    const result = await listProjects({
      userId: ids.userId,
      query: { q: "lau" },
      db: { project: { findMany } } as never,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: ids.userId,
          deletedAt: null,
          name: { contains: "lau", mode: "insensitive" },
        }),
      }),
    );
    expect(result.items[0]?.name).toBe("Launch");
  });

  it("unassigns tasks before soft-deleting a project", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const update = vi.fn(async () => projectRow({ deletedAt: new Date() }));
    await deleteProject({
      userId: ids.userId,
      projectId: ids.projectId,
      db: {
        project: {
          findUnique: vi.fn(async () => projectRow()),
          update,
        },
        chat: { updateMany },
        $transaction: (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
      } as never,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { projectId: null },
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});
