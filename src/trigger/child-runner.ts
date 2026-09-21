import { ToolError } from "@/agent/tools/errors.js";
import type { ToolExecutionResult } from "@/agent/tools/types.js";
import type { ChildTaskRunner, ChildToolRequest } from "@/agent/runtime/execute-tool.js";
import type { MagicaToolPayload, E2BSandboxPayload, ExaSearchPayload } from "./payloads.js";
import { executeE2BSandbox } from "./e2b.js";
import { executeExaSearch } from "./exa.js";
import { executeMagicaTool } from "./magica.js";

export const triggerChildTasks: ChildTaskRunner = {
  async run(request: ChildToolRequest): Promise<ToolExecutionResult<unknown>> {
    const payload = {
      toolName: request.toolName,
      input: request.input,
      ctx: request.ctx,
    };
    const options = { idempotencyKey: request.ctx.toolCallId };
    const result =
      request.provider === "MAGICA"
        ? await executeMagicaTool.triggerAndWait(payload as MagicaToolPayload, options)
        : request.provider === "E2B"
          ? await executeE2BSandbox.triggerAndWait(payload as E2BSandboxPayload, options)
          : request.provider === "EXA"
            ? await executeExaSearch.triggerAndWait(payload as ExaSearchPayload, options)
            : null;

    if (!result) {
      throw new ToolError("FAILED", `No child task is registered for ${request.toolName}`);
    }
    if (!result.ok) {
      throw new ToolError("FAILED", "The tool task failed", { cause: result.error });
    }
    return result.output;
  },
};
