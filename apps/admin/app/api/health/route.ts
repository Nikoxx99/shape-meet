import { NextResponse } from "next/server";
import { Client } from "pg";

export async function GET() {
  const checkedAt = new Date().toISOString();
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgresql://shape_meet:shape_meet@localhost:5432/shape_meet?schema=public",
    connectionTimeoutMillis: 2500,
    query_timeout: 2500
  });

  try {
    await client.connect();
    await client.query("select 1");

    return NextResponse.json({
      ok: true,
      service: "shape-meet-admin",
      database: "ok",
      at: checkedAt
    });
  } catch (error) {
    const debug = process.env.SHAPE_DEBUG_ERRORS === "true" || process.env.NODE_ENV !== "production";

    return NextResponse.json(
      {
        ok: false,
        service: "shape-meet-admin",
        database: "unavailable",
        code: "DATABASE_UNAVAILABLE",
        at: checkedAt,
        detail: debug ? healthErrorDetail(error) : undefined
      },
      { status: 503 }
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

function healthErrorDetail(error: unknown) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const cause = record?.cause && typeof record.cause === "object" ? (record.cause as Record<string, unknown>) : null;
  const aggregateErrors = Array.isArray(record?.errors) ? record.errors.slice(0, 4).map(healthErrorSummary) : undefined;

  return {
    name: typeof record?.name === "string" ? record.name : error && typeof error === "object" ? error.constructor?.name : "Error",
    message: truncate(typeof record?.message === "string" ? record.message : String(error)),
    errors: aggregateErrors,
    cause: cause
      ? {
          code: typeof cause.code === "string" ? cause.code : typeof cause.originalCode === "string" ? cause.originalCode : undefined,
          message: truncate(typeof cause.message === "string" ? cause.message : typeof cause.originalMessage === "string" ? cause.originalMessage : "")
        }
      : undefined
  };
}

function healthErrorSummary(error: unknown) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;

  return {
    name: typeof record?.name === "string" ? record.name : error && typeof error === "object" ? error.constructor?.name : "Error",
    code: typeof record?.code === "string" ? record.code : undefined,
    address: typeof record?.address === "string" ? record.address : undefined,
    port: typeof record?.port === "number" ? record.port : undefined,
    message: truncate(typeof record?.message === "string" ? record.message : String(error))
  };
}

function truncate(value: string) {
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}
