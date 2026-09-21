import { z } from "zod";
import { ToolError } from "./errors.js";
import { toOpenRouterParameters } from "./json-schema.js";
import type {
  AnyToolDefinition,
  OpenRouterTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolName,
} from "./types.js";
import { toolNameSchema } from "./types.js";

/**
 * Authoritative tool catalog. Discovery, Zod validation, credit estimates,
 * OpenRouter schemas, and execution all read from here. Orchestration must
 * not branch on tool names.
 */
export class ToolRegistry {
  private readonly tools = new Map<ToolName, AnyToolDefinition>();

  register<TInput extends z.ZodType, TOutput extends z.ZodType>(
    definition: ToolDefinition<TInput, TOutput>,
  ): this {
    if (this.tools.has(definition.name)) {
      throw new ToolError(
        "FAILED",
        `Duplicate tool registration: ${definition.name}`,
      );
    }
    this.tools.set(definition.name, definition as AnyToolDefinition);
    return this;
  }

  get(name: string): AnyToolDefinition {
    const parsed = toolNameSchema.safeParse(name);
    if (!parsed.success) {
      throw new ToolError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
    }
    const tool = this.tools.get(parsed.data);
    if (!tool) {
      throw new ToolError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
    }
    return tool;
  }

  has(name: string): boolean {
    const parsed = toolNameSchema.safeParse(name);
    return parsed.success && this.tools.has(parsed.data);
  }

  /** Tools the model is allowed to call this turn. */
  listForAgent(): OpenRouterTool[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toOpenRouterParameters(tool.input),
      },
    }));
  }

  listAll(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  parseInput(name: string, raw: unknown): unknown {
    const tool = this.get(name);
    const result = tool.input.safeParse(raw);
    if (!result.success) {
      throw new ToolError(
        "INVALID_INPUT",
        result.error.issues.map((issue) => issue.message).join("; "),
      );
    }
    return result.data;
  }

  async estimateCredits(name: string, raw: unknown): Promise<string> {
    const tool = this.get(name);
    const input = this.parseInput(name, raw);
    return tool.estimateCredits(input);
  }

  async execute(
    name: string,
    raw: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult<unknown>> {
    const tool = this.get(name);
    const input = this.parseInput(name, raw);
    if (ctx.signal.aborted) {
      throw new ToolError("CANCELLED", "Tool execution cancelled", {
        retryable: false,
      });
    }

    const result = await tool.execute(input, ctx);
    const output = tool.output.safeParse(result.output);
    if (!output.success) {
      throw new ToolError(
        "INVALID_OUTPUT",
        "Tool returned a payload that failed its output contract",
      );
    }

    return { ...result, output: output.data };
  }
}
