import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      service: "galaxy-agent-backend",
      db: "up",
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        service: "galaxy-agent-backend",
        db: "down",
      },
      { status: 503 },
    );
  }
}
