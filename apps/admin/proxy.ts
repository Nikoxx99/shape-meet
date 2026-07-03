import { NextRequest, NextResponse } from "next/server";

const allowedOrigin = process.env.CORS_ORIGIN ?? "*";

export function proxy(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return withCors(new NextResponse(null, { status: 204 }));
  }

  return withCors(NextResponse.next());
}

function withCors(response: NextResponse) {
  response.headers.set("access-control-allow-origin", allowedOrigin);
  response.headers.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.headers.set("access-control-allow-headers", "content-type,authorization");
  response.headers.set("access-control-max-age", "86400");
  return response;
}

export const config = {
  matcher: "/api/:path*"
};
