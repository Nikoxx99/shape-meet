import { NextRequest, NextResponse } from "next/server";

const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN ?? "*");

export function proxy(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return withCors(new NextResponse(null, { status: 204 }), request);
  }

  return withCors(NextResponse.next(), request);
}

function withCors(response: NextResponse, request: NextRequest) {
  const origin = corsOriginForRequest(request);

  if (origin) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("vary", "Origin");
  }

  response.headers.set(
    "access-control-allow-methods",
    "GET,POST,PATCH,DELETE,OPTIONS",
  );
  response.headers.set(
    "access-control-allow-headers",
    "content-type,authorization",
  );
  response.headers.set("access-control-max-age", "86400");
  return response;
}

function corsOriginForRequest(request: NextRequest) {
  if (corsOrigins.includes("*")) return "*";

  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && corsOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return null;
}

function parseCorsOrigins(value: string) {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : ["*"];
}

export const config = {
  matcher: "/api/:path*",
};
