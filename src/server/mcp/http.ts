import type { User } from "@prisma/client";
import { HttpError } from "@/server/http/errors";
import { requireApiUser } from "@/server/public/api-keys";
import { MCP_TOOLS, callMcpTool } from "./tools";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

type RpcId = string | number | null;

export async function handleMcpHttp(
  request: Request,
  options?: { authorize?: (authorization: string | null) => Promise<User> },
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" },
      { status: 405, headers: { allow: "POST" } },
    );
  }

  let user: User;
  try {
    const authorize = options?.authorize ?? ((authorization: string | null) => requireApiUser({ authorization }));
    user = await authorize(request.headers.get("authorization"));
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "Missing or invalid API key";
    return Response.json(rpcError(null, -32001, message), { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const outcome = await handleMcpRpc({ user, body });
  if (outcome === null) return new Response(null, { status: 202 });
  return Response.json(outcome);
}

export async function handleMcpRpc(input: { user: User; body: unknown }): Promise<Record<string, unknown> | null> {
  const message = record(input.body);
  const id = rpcId(message.id);
  const method = typeof message.method === "string" ? message.method : "";
  if (!method) return rpcError(id, -32600, "Invalid request");
  if (message.id === undefined || method.startsWith("notifications/")) return null;

  const params = record(message.params);
  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = PROTOCOL_VERSIONS.find((version) => version === requested) ?? PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "galaxy-agent", version: "1.0.0" },
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) return rpcError(id, -32602, "Tool name is required");
      const result = await callMcpTool({ user: input.user, name, args: params.arguments });
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function rpcId(value: unknown): RpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  return null;
}
