import path from "node:path";
import { Sandbox } from "@e2b/code-interpreter";
import { ToolError } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  sandboxRunCodeInputSchema,
  sandboxRunCodeOutputSchema,
  type SandboxRunCodeInput,
  type SandboxRunCodeOutput,
} from "../schemas";
import type { E2BAdapter } from "./types";
import { isAbortError, throwIfAborted } from "./http";

const WORK_DIR = "/home/user/work";
const ARTIFACT_DIR = "/home/user/artifacts";
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_STDOUT_CHARS = 256_000;
const MAX_ARTIFACTS = 20;
/** Signed download URL lifetime (E2B measures this in seconds). */
const DOWNLOAD_URL_TTL_SECONDS = 3_600;

export class E2BSandboxAdapter implements E2BAdapter {
  constructor(private readonly apiKey: string) {}

  async runCode(
    raw: SandboxRunCodeInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult<SandboxRunCodeOutput>> {
    const input = sandboxRunCodeInputSchema.parse(raw);
    throwIfAborted(ctx.signal, "Sandbox run cancelled");
    const started = Date.now();

    let sandbox: Sandbox | undefined;
    try {
      sandbox = await Sandbox.create({
        apiKey: this.apiKey,
        timeoutMs: input.timeoutMs + 60_000,
        signal: ctx.signal,
        metadata: {
          chatId: ctx.chatId,
          runId: ctx.runId,
          toolCallId: ctx.toolCallId,
        },
      });

      throwIfAborted(ctx.signal, "Sandbox run cancelled");
      await sandbox.files.makeDir(WORK_DIR, { signal: ctx.signal });
      await sandbox.files.makeDir(ARTIFACT_DIR, { signal: ctx.signal });
      await this.stageInputFiles(sandbox, input.files ?? [], ctx.signal);

      const execution =
        input.language === "python"
          ? await this.runPython(sandbox, input, ctx.signal)
          : await this.runBash(sandbox, input, ctx.signal);

      const artifacts = await this.collectArtifacts(sandbox);
      const output = sandboxRunCodeOutputSchema.parse({
        stdout: truncate(execution.stdout),
        stderr: truncate(execution.stderr),
        exitCode: execution.exitCode,
        artifacts,
      });

      return {
        output,
        creditCost: "0",
        providerRunId: sandbox.sandboxId,
        durationMs: Date.now() - started,
        assets: artifacts.map((artifact) => ({
          url: artifact.url,
          mimeType: artifact.mimeType,
          filename: path.posix.basename(artifact.path),
        })),
      };
    } catch (cause) {
      throw this.mapError(cause, ctx.signal);
    } finally {
      if (sandbox) {
        await sandbox.kill().catch(() => undefined);
      }
    }
  }

  private async runPython(
    sandbox: Sandbox,
    input: SandboxRunCodeInput,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const scriptPath = `${WORK_DIR}/main.py`;
    const script = `import os\nos.chdir(${JSON.stringify(WORK_DIR)})\nos.makedirs(${JSON.stringify(ARTIFACT_DIR)}, exist_ok=True)\n${input.code}`;
    await sandbox.files.write(scriptPath, script, { signal });
    throwIfAborted(signal, "Sandbox run cancelled");
    return runCommand(sandbox, `python ${scriptPath}`, input.timeoutMs, signal);
  }

  private async runBash(
    sandbox: Sandbox,
    input: SandboxRunCodeInput,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const scriptPath = `${WORK_DIR}/main.sh`;
    await sandbox.files.write(scriptPath, input.code, { signal });
    throwIfAborted(signal, "Sandbox run cancelled");
    return runCommand(sandbox, `bash ${scriptPath}`, input.timeoutMs, signal);
  }

  private async stageInputFiles(
    sandbox: Sandbox,
    files: NonNullable<SandboxRunCodeInput["files"]>,
    signal: AbortSignal,
  ): Promise<void> {
    for (const file of files) {
      throwIfAborted(signal, "Sandbox run cancelled");
      const destination = safeJoin(WORK_DIR, file.path);
      const bytes = await downloadBytes(file.url, signal);
      await sandbox.files.makeDir(path.posix.dirname(destination), { signal });
      const payload = new Uint8Array(bytes.byteLength);
      payload.set(bytes);
      await sandbox.files.write(destination, payload.buffer, { signal });
    }
  }

  private async collectArtifacts(sandbox: Sandbox): Promise<SandboxRunCodeOutput["artifacts"]> {
    const paths = await listFilesRecursive(sandbox, ARTIFACT_DIR);
    const selected = paths.slice(0, MAX_ARTIFACTS);
    const artifacts: SandboxRunCodeOutput["artifacts"] = [];

    for (const filePath of selected) {
      const url = await sandbox.downloadUrl(filePath, {
        useSignatureExpiration: DOWNLOAD_URL_TTL_SECONDS,
      });
      artifacts.push({
        path: path.posix.relative(ARTIFACT_DIR, filePath) || path.posix.basename(filePath),
        url,
        mimeType: mimeFromPath(filePath),
      });
    }
    return artifacts;
  }

  private mapError(cause: unknown, signal: AbortSignal): ToolError {
    if (cause instanceof ToolError) return cause;
    if (signal.aborted || isAbortError(cause)) {
      return new ToolError("CANCELLED", "Sandbox run cancelled", { cause });
    }
    const message = cause instanceof Error ? cause.message : "";
    if (/401|unauthorized|invalid api key/i.test(message)) {
      return new ToolError("UNAUTHORIZED", "Sandbox provider rejected the request", { cause });
    }
    if (/429|rate limit/i.test(message)) {
      return new ToolError("RATE_LIMITED", "Sandbox is rate limited. Try again shortly.", {
        retryable: true,
        cause,
      });
    }
    if (/timeout/i.test(message)) {
      return new ToolError("TIMEOUT", "Sandbox run timed out", { cause });
    }
    return new ToolError("FAILED", "Sandbox execution failed", { cause });
  }
}

export function createE2BAdapter(env: NodeJS.ProcessEnv = process.env): E2BAdapter {
  const apiKey = env.E2B_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("E2B_API_KEY is required for the E2B sandbox adapter");
  }
  return new E2BSandboxAdapter(apiKey);
}

async function runCommand(
  sandbox: Sandbox,
  command: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await sandbox.commands.run(command, {
      cwd: WORK_DIR,
      timeoutMs,
      requestTimeoutMs: timeoutMs + 10_000,
      signal,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (error) {
    if (isCommandResult(error)) {
      return {
        stdout: error.stdout,
        stderr: error.stderr,
        exitCode: error.exitCode,
      };
    }
    throw error;
  }
}

function isCommandResult(
  error: unknown,
): error is { stdout: string; stderr: string; exitCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "stdout" in error &&
    "stderr" in error &&
    "exitCode" in error &&
    typeof (error as { exitCode: unknown }).exitCode === "number"
  );
}

function safeJoin(root: string, relative: string): string {
  const normalized = path.posix.normalize(relative).replace(/^\/+/, "");
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new ToolError("INVALID_INPUT", "Sandbox file path is not allowed");
  }
  const full = path.posix.join(root, normalized);
  if (full !== root && !full.startsWith(`${root}/`)) {
    throw new ToolError("INVALID_INPUT", "Sandbox file path is not allowed");
  }
  return full;
}

async function downloadBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    if (isAbortError(cause) || signal.aborted) {
      throw new ToolError("CANCELLED", "Sandbox file download cancelled", { cause });
    }
    throw new ToolError("FAILED", "Could not download a sandbox input file", { cause });
  }
  if (!response.ok) {
    throw new ToolError("FAILED", "Could not download a sandbox input file");
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_INPUT_BYTES) {
    throw new ToolError("INVALID_INPUT", "Sandbox input file exceeds the 50 MB limit");
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_INPUT_BYTES) {
    throw new ToolError("INVALID_INPUT", "Sandbox input file exceeds the 50 MB limit");
  }
  return buffer;
}

async function listFilesRecursive(sandbox: Sandbox, directory: string): Promise<string[]> {
  let entries: Awaited<ReturnType<Sandbox["files"]["list"]>> = [];
  try {
    entries = await sandbox.files.list(directory);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.path || entry.path === directory) continue;
    if (entry.type === "dir") {
      files.push(...(await listFilesRecursive(sandbox, entry.path)));
    } else if (entry.type !== "symlink") {
      files.push(entry.path);
    }
  }
  return files;
}

function mimeFromPath(filePath: string): string {
  const ext = path.posix.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".py":
      return "text/x-python";
    case ".csv":
      return "text/csv";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function truncate(value: string): string {
  if (value.length <= MAX_STDOUT_CHARS) return value;
  return `${value.slice(0, MAX_STDOUT_CHARS)}\n… truncated`;
}
