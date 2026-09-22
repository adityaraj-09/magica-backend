import path from "node:path";
import { ToolError } from "../tools/errors";

const MAX_RELATIVE_LENGTH = 256;
const MAX_DEPTH = 6;

export function assertSafeRelativePath(relative: string): string {
  const trimmed = relative.trim();
  if (!trimmed || trimmed.length > MAX_RELATIVE_LENGTH) {
    throw new ToolError("INVALID_INPUT", "Skill asset path is invalid");
  }
  if (trimmed.includes("\0") || trimmed.includes("%2e") || trimmed.includes("%2E")) {
    throw new ToolError("INVALID_INPUT", "Skill asset path is invalid");
  }

  const posix = trimmed.replaceAll("\\", "/");
  if (path.posix.isAbsolute(posix) || posix.startsWith("/") || posix.includes(":")) {
    throw new ToolError("INVALID_INPUT", "Skill asset path is invalid");
  }

  const segments = posix.split("/").filter((part) => part.length > 0);
  if (segments.length === 0 || segments.length > MAX_DEPTH) {
    throw new ToolError("INVALID_INPUT", "Skill asset path is invalid");
  }
  if (segments.some((part) => part === "." || part === ".." || part.startsWith("."))) {
    throw new ToolError("INVALID_INPUT", "Skill asset path is invalid");
  }

  return path.posix.join(...segments);
}

export function resolveInside(root: string, relative: string): string {
  const safe = assertSafeRelativePath(relative);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...safe.split("/"));
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new ToolError("INVALID_INPUT", "Skill asset path is invalid");
  }
  return resolved;
}
