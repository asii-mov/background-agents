import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { verifyAccessRequest } from "@/lib/cloudflare-access";
import {
  applyCorrelationHeaders,
  createRequestId,
  INTERNAL_REQUEST_ID_HEADER,
  resolveTraceId,
} from "@/lib/request-correlation";

export async function middleware(request: NextRequest) {
  const access = await verifyAccessRequest({
    assertion: request.headers.get("Cf-Access-Jwt-Assertion"),
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN,
      CF_ACCESS_AUD: process.env.CF_ACCESS_AUD,
      AUTH_DEV_BYPASS: process.env.AUTH_DEV_BYPASS,
    },
    hostname: request.nextUrl.hostname,
  });
  if (access.kind === "rejected") {
    return new NextResponse("Forbidden", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const correlation = {
    traceId: resolveTraceId(request.headers.get("x-trace-id")),
    requestId: createRequestId(),
  };

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("Cf-Access-Jwt-Assertion");
  requestHeaders.delete("Cf-Access-Authenticated-User-Email");
  requestHeaders.delete("CF-Access-Client-Id");
  requestHeaders.delete("CF-Access-Client-Secret");
  const cookies = request.headers
    .get("Cookie")
    ?.split(";")
    .filter((cookie) => cookie.split("=", 1)[0].trim() !== "CF_Authorization")
    .join(";");
  if (cookies?.trim()) requestHeaders.set("Cookie", cookies);
  else requestHeaders.delete("Cookie");
  applyCorrelationHeaders(requestHeaders, correlation);
  requestHeaders.set(INTERNAL_REQUEST_ID_HEADER, correlation.requestId);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  applyCorrelationHeaders(response.headers, correlation);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static(?:/|$)|favicon\\.ico$|branding/logo\\.svg$|hljs-themes/(?:github-dark|github|atom-one-light|atom-one-dark)\\.css$).*)",
  ],
};
