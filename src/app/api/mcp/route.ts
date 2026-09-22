import { handleMcpHttp } from "@/server/mcp/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export function GET() {
  return handleMcpHttp(new Request("http://localhost/api/mcp", { method: "GET" }));
}

export function DELETE() {
  return handleMcpHttp(new Request("http://localhost/api/mcp", { method: "DELETE" }));
}

export function POST(request: Request) {
  return handleMcpHttp(request);
}
