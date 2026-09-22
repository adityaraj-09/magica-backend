import type { PrismaClient, User } from "@prisma/client";
import { ZodError } from "zod";
import { admitTurn } from "@/server/chat/admit-turn";
import {
  createChat,
  deleteChat,
  getChat,
  listChats,
  listMessages,
} from "@/server/chat/chats";
import { HttpError } from "@/server/http/errors";
import { publicCompletionBodySchema } from "@/server/public/completions";
import { executePublicMagicaTool } from "@/server/public/magica";
import { loadRunSnapshot } from "@/server/realtime/snapshot";

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type JsonSchema = Record<string, unknown>;

type McpTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

const uuid = { type: "string", format: "uuid" };
const chatId = { ...uuid, description: "Chat id." };

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_chats",
    description: "List the API key owner's chats, newest first.",
    inputSchema: object({
      limit: { type: "integer", minimum: 1, maximum: 50 },
      cursor: { type: "string" },
      q: { type: "string", description: "Search title and message text." },
      favorite: { type: "boolean" },
    }),
  },
  {
    name: "get_chat",
    description: "Read one chat. Another user's id is not found.",
    inputSchema: object({ chatId }, ["chatId"]),
  },
  {
    name: "create_chat",
    description: "Create a chat. Title is optional.",
    inputSchema: object({ title: { type: "string", maxLength: 120 } }),
  },
  {
    name: "delete_chat",
    description: "Soft-delete a chat owned by the API key user.",
    inputSchema: object({ chatId }, ["chatId"]),
  },
  {
    name: "list_messages",
    description: "List messages in a chat, newest first.",
    inputSchema: object({ chatId, limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "string" } }, [
      "chatId",
    ]),
  },
  {
    name: "send_message",
    description: "Persist a user turn and queue one agent run. Returns immediately with runId.",
    inputSchema: object(
      {
        chatId,
        text: { type: "string", maxLength: 8192 },
        planMode: { type: "boolean" },
        clientMessageId: uuid,
        attachmentIds: { type: "array", items: uuid },
      },
      ["chatId", "text"],
    ),
  },
  {
    name: "complete",
    description:
      "Queue a chat-style completion. Omit chatId to create a chat. text, prompt, or the last user message is the turn.",
    inputSchema: object({
      chatId: { ...uuid, description: "Existing chat. Omitted creates one." },
      text: { type: "string", maxLength: 8192 },
      prompt: { type: "string", maxLength: 8192 },
      planMode: { type: "boolean" },
      clientMessageId: uuid,
      attachmentIds: { type: "array", items: uuid },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: { role: { type: "string" }, content: { type: "string" } },
        },
      },
    }),
  },
  {
    name: "get_run",
    description: "Poll a run until status is COMPLETE, FAILED, or CANCELLED. No realtime token is returned.",
    inputSchema: object({ chatId, runId: uuid }, ["chatId", "runId"]),
  },
  {
    name: "crop_image",
    description:
      "Crop an image with Magica. Provide image_url and exactly one rectangle: percent, pixels, or crop.{x,y,width,height}. Blocks until the provider finishes.",
    inputSchema: object(
      {
        image_url: { type: "string" },
        x_percent: { type: "number" },
        y_percent: { type: "number" },
        width_percent: { type: "number" },
        height_percent: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        crop: { type: "object" },
      },
      ["image_url"],
    ),
  },
  {
    name: "gpt_image_2",
    description: "Generate an image with GPT Image 2. Pass image_url to edit an existing image. Blocks until Magica finishes.",
    inputSchema: object({ prompt: { type: "string" }, image_url: { type: "string" } }, ["prompt"]),
  },
  {
    name: "merge_videos",
    description: "Merge 2–100 videos. transition is none, fade, or dissolve. Blocks until Magica finishes.",
    inputSchema: object(
      {
        video_urls: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 100 },
        transition: { type: "string", enum: ["none", "fade", "dissolve"] },
      },
      ["video_urls"],
    ),
  },
];

export async function callMcpTool(input: {
  user: User;
  name: string;
  args: unknown;
  db?: PrismaClient;
}): Promise<McpToolResult> {
  const args = record(input.args);
  try {
    switch (input.name) {
      case "list_chats":
        return jsonResult(
          await listChats({
            userId: input.user.id,
            db: input.db,
            query: {
              limit: args.limit,
              cursor: args.cursor,
              q: args.q,
              favorite: args.favorite === true ? "true" : args.favorite === false ? "false" : undefined,
            },
          }),
        );
      case "get_chat":
        return jsonResult(await getChat({ userId: input.user.id, chatId: stringField(args, "chatId"), db: input.db }));
      case "create_chat":
        return jsonResult(await createChat({ userId: input.user.id, body: { title: args.title }, db: input.db }));
      case "delete_chat":
        await deleteChat({ userId: input.user.id, chatId: stringField(args, "chatId"), db: input.db });
        return jsonResult({ deleted: true });
      case "list_messages":
        return jsonResult(
          await listMessages({
            userId: input.user.id,
            chatId: stringField(args, "chatId"),
            db: input.db,
            query: { limit: args.limit, cursor: args.cursor },
          }),
        );
      case "send_message": {
        const admitted = await admitTurn({
          user: input.user,
          chatId: stringField(args, "chatId"),
          db: input.db,
          body: {
            text: args.text,
            planMode: args.planMode,
            clientMessageId: args.clientMessageId,
            attachmentIds: args.attachmentIds,
          },
        });
        return jsonResult(queued(admitted));
      }
      case "complete": {
        const chatId =
          typeof args.chatId === "string"
            ? args.chatId
            : (await createChat({ userId: input.user.id, body: {}, db: input.db })).id;
        const body = publicCompletionBodySchema.parse(args);
        const admitted = await admitTurn({ user: input.user, chatId, body, db: input.db });
        return jsonResult(queued(admitted));
      }
      case "get_run":
        return jsonResult(
          await loadRunSnapshot({
            userId: input.user.id,
            chatId: stringField(args, "chatId"),
            runId: stringField(args, "runId"),
            db: input.db,
            mintToken: false,
          }),
        );
      case "crop_image":
      case "gpt_image_2":
      case "merge_videos":
        return jsonResult(
          await executePublicMagicaTool({
            userId: input.user.id,
            toolName: input.name,
            body: args,
          }),
        );
      default:
        return textResult(`Unknown tool: ${input.name}`, true);
    }
  } catch (error) {
    return toolFailure(error);
  }
}

function queued(admitted: {
  chatId: string;
  messageId: string;
  runId: string;
  triggerRunId: string | null;
}): { chatId: string; messageId: string; runId: string; triggerRunId: string | null; status: "queued" } {
  return {
    chatId: admitted.chatId,
    messageId: admitted.messageId,
    runId: admitted.runId,
    triggerRunId: admitted.triggerRunId,
    status: "queued",
  };
}

function toolFailure(error: unknown): McpToolResult {
  if (error instanceof HttpError) {
    return textResult(error.code ? `${error.message} (${error.code})` : error.message, true);
  }
  if (error instanceof ZodError) return textResult("Invalid request", true);
  return textResult(error instanceof Error ? error.message : "Tool failed", true);
}

function jsonResult(value: unknown): McpToolResult {
  return textResult(JSON.stringify(value));
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function object(properties: JsonSchema, required?: string[]): JsonSchema {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required ? { required } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringField(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) {
    throw new HttpError(`Missing ${key}`, 400, "INVALID_REQUEST");
  }
  return value;
}
