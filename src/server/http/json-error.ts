import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/errors";

export function jsonError(error: unknown): NextResponse {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}
