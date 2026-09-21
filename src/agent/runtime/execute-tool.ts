import { ToolError } from "@/agent/tools/errors.js";
import type { ToolRegistry } from "@/agent/tools/registry.js";
import type { ToolExecutionContext, ToolExecutionResult, ToolProvider } from "@/agent/tools/types.js";

export type ChildToolRequest = {
  provider: ToolProvider;
  toolName: string;
  input: unknown;
  ctx: Omit<ToolExecutionContext, "signal">;
};

export type ChildTaskRunner = {
  run(request: ChildToolRequest): Promise<ToolExecutionResult<unknown>>;
};

export async function executeRegisteredTool(input: {
  registry: ToolRegistry;
  children: ChildTaskRunner;
  name: string;
  raw: unknown;
  ctx: ToolExecutionContext;
}): Promise<ToolExecutionResult<unknown>> {
  const tool = input.registry.get(input.name);
  const parsed = input.registry.parseInput(input.name, input.raw);
  if (tool.execution === "inline") {
    return input.registry.execute(input.name, input.raw, input.ctx);
  }
  const result = await input.children.run({
    provider: tool.provider,
    toolName: tool.name,
    input: parsed,
    ctx: {
      chatId: input.ctx.chatId,
      userId: input.ctx.userId,
      runId: input.ctx.runId,
      messageId: input.ctx.messageId,
      toolCallId: input.ctx.toolCallId,
      traceId: input.ctx.traceId,
    },
  });
  const output = tool.output.safeParse(result.output);
  if (!output.success) {
    throw new ToolError(
      "INVALID_OUTPUT",
      "Tool returned a payload that failed its output contract",
    );
  }
  return { ...result, output: output.data };
}
