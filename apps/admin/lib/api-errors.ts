import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

type ApiErrorOptions = {
  fallbackMessage: string;
  status?: number;
};

export function apiErrorResponse(error: unknown, options: ApiErrorOptions) {
  const requestId = randomUUID();
  const status = error instanceof ZodError ? 400 : options.status ?? 500;
  const message = error instanceof ZodError ? "Revisa los campos enviados." : options.fallbackMessage;

  console.error(`[shape-admin-api] ${requestId}`, error);

  return NextResponse.json(
    {
      error: message,
      code: errorCode(error),
      requestId,
      detail: shouldExposeDebugErrors() ? errorDetail(error) : undefined
    },
    { status }
  );
}

function shouldExposeDebugErrors() {
  return process.env.SHAPE_DEBUG_ERRORS === "true" || process.env.NODE_ENV !== "production";
}

function errorCode(error: unknown) {
  if (error instanceof ZodError) return "VALIDATION_ERROR";

  const record = errorRecord(error);
  const cause = errorRecord(record?.cause);
  return stringValue(cause?.originalCode) ?? stringValue(cause?.code) ?? stringValue(record?.code) ?? stringValue(record?.name) ?? "INTERNAL_ERROR";
}

function errorDetail(error: unknown) {
  const record = errorRecord(error);
  const cause = errorRecord(record?.cause);

  return {
    name: stringValue(record?.name) ?? constructorName(error),
    message: truncate(stringValue(record?.message) ?? String(error)),
    cause: cause
      ? {
          code: stringValue(cause.originalCode) ?? stringValue(cause.code),
          message: truncate(stringValue(cause.originalMessage) ?? stringValue(cause.message) ?? "")
        }
      : undefined
  };
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function constructorName(value: unknown) {
  return value && typeof value === "object" ? value.constructor?.name : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncate(value: string) {
  return value.length > 360 ? `${value.slice(0, 357)}...` : value;
}
