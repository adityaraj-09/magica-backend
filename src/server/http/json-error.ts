import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/server/auth/errors";
import { HttpError } from "@/server/http/errors";

export function jsonError(error: unknown): NextResponse {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof HttpError) {
    const retryAfter = error.details?.retryAfter;
    const headers =
      typeof retryAfter === "number" || typeof retryAfter === "string"
        ? { "Retry-After": String(retryAfter) }
        : undefined;
    return NextResponse.json(
      {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.details ?? {}),
      },
      { status: error.status, headers },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid request", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }
  throw error;
}
