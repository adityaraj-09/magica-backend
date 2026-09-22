import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemSkillLoaderAdapter } from "../tools/adapters/skills";
import { ToolError } from "../tools/errors";
import type { ToolExecutionContext } from "../tools/types";
import { SkillRegistry } from "./registry";

const shippedSkills = path.resolve(process.cwd(), "agent-skills");

function ctx(): ToolExecutionContext {
  return {
    chatId: "chat_1",
    userId: "user_1",
    runId: "run_1",
    messageId: "msg_1",
    toolCallId: "tool_1",
    traceId: "trace_1",
    signal: new AbortController().signal,
  };
}

async function writeSkill(
  root: string,
  folder: string,
  markdown: string,
  assets: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), markdown, "utf8");
  for (const [relative, content] of Object.entries(assets)) {
    const file = path.join(dir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return dir;
}

describe("SkillRegistry", () => {
  it("exposes only names and descriptions until a skill is loaded", async () => {
    const registry = await SkillRegistry.load([shippedSkills]);
    const metadata = registry.listMetadata();
    expect(metadata.map((skill) => skill.name).sort()).toEqual([
      "image-editing",
      "sandbox-python",
      "video-merge",
    ]);
    expect(metadata.every((skill) => "name" in skill && "description" in skill)).toBe(true);
    expect(metadata.some((skill) => "body" in skill)).toBe(false);
  });

  it("rejects malformed frontmatter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skills-bad-"));
    await writeSkill(root, "broken", "# no frontmatter\n");
    await expect(SkillRegistry.load([root])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await rm(root, { recursive: true, force: true });
  });

  it("rejects duplicate skill names across approved directories", async () => {
    const a = await mkdtemp(path.join(tmpdir(), "skills-a-"));
    const b = await mkdtemp(path.join(tmpdir(), "skills-b-"));
    const markdown = `---\nname: shared-skill\ndescription: Duplicate fixture\n---\n\nBody\n`;
    await writeSkill(a, "shared-skill", markdown);
    await writeSkill(b, "shared-skill", markdown);
    await expect(SkillRegistry.load([a, b])).rejects.toMatchObject({ code: "FAILED" });
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  });

  it("returns the same content hash after a rescan (durable resume)", async () => {
    const first = await SkillRegistry.load([shippedSkills]);
    const second = await SkillRegistry.load([shippedSkills]);
    expect(first.get("video-merge").contentHash).toBe(second.get("video-merge").contentHash);
  });
});

describe("FilesystemSkillLoaderAdapter", () => {
  it("loads one skill body on demand and dedupes by hash", async () => {
    const registry = await SkillRegistry.load([shippedSkills]);
    const adapter = new FilesystemSkillLoaderAdapter(registry);
    const first = await adapter.loadSkill({ name: "video-merge" }, ctx());
    const second = await adapter.loadSkill({ name: "video-merge" }, ctx());
    expect(first.output.body).toContain("merge_videos");
    expect(first.output.contentHash).toBe(second.output.contentHash);
    expect(first.output.contentHash).toHaveLength(64);
  });

  it("reads a skill asset and rejects unknown skills", async () => {
    const registry = await SkillRegistry.load([shippedSkills]);
    const adapter = new FilesystemSkillLoaderAdapter(registry);
    const asset = await adapter.readSkillAsset(
      { name: "image-editing", path: "examples.md" },
      ctx(),
    );
    expect(asset.output.contentType).toBe("text/markdown");
    expect(asset.output.content).toContain("x_percent");
    expect(asset.output.contentHash).toHaveLength(64);

    await expect(adapter.loadSkill({ name: "not-a-skill" }, ctx())).rejects.toBeInstanceOf(
      ToolError,
    );
  });

  it("rejects path traversal and unsupported files", async () => {
    const registry = await SkillRegistry.load([shippedSkills]);
    const adapter = new FilesystemSkillLoaderAdapter(registry);

    await expect(
      adapter.readSkillAsset({ name: "image-editing", path: "../video-merge/SKILL.md" }, ctx()),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      adapter.readSkillAsset({ name: "image-editing", path: "SKILL.md" }, ctx()),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const root = await mkdtemp(path.join(tmpdir(), "skills-exec-"));
    await writeSkill(
      root,
      "sandbox-python",
      `---\nname: sandbox-python\ndescription: Fixture\n---\n\nBody\n`,
      { "payload.js": "console.log(1)" },
    );
    const isolated = new FilesystemSkillLoaderAdapter(await SkillRegistry.load([root]));
    await expect(
      isolated.readSkillAsset({ name: "sandbox-python", path: "payload.js" }, ctx()),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await rm(root, { recursive: true, force: true });
  });
});
