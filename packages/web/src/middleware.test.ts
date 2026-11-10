import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, middleware } from "./middleware";

const issuer = "https://middleware-team.cloudflareaccess.com";
let assertion: string;
let jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] };

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "middleware", alg: "RS256" }] };
  assertion = await new SignJWT({ type: "app", email: "person@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "middleware" })
    .setIssuer(issuer)
    .setAudience("openinspect-audience")
    .setSubject("human-123")
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .sign(privateKey);
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", issuer);
  vi.stubEnv("CF_ACCESS_AUD", "openinspect-audience");
  vi.stubEnv("AUTH_DEV_BYPASS", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(jwks))
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("API middleware correlation", () => {
  it("preserves a valid incoming trace id and generates a fresh request id", async () => {
    const response = await middleware(
      new NextRequest("http://localhost/api/sessions", {
        headers: {
          "Cf-Access-Jwt-Assertion": assertion,
          "x-trace-id": "trace-123",
          "x-request-id": "client-request-id",
        },
      })
    );

    expect(response.headers.get("x-trace-id")).toBe("trace-123");
    expect(response.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(response.headers.get("x-request-id")).not.toBe("client-request-id");
  });

  it("generates correlation headers when the incoming trace id is invalid", async () => {
    const response = await middleware(
      new NextRequest("http://localhost/api/sessions", {
        headers: {
          "Cf-Access-Jwt-Assertion": assertion,
          "x-trace-id": "invalid trace id",
        },
      })
    );

    expect(response.headers.get("x-trace-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(response.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9]{8}$/);
  });
});

describe("Access request boundary", () => {
  it.each(["/", "/settings", "/api/auth/get-session", "/api/sessions/session-1/ws-token"])(
    "denies %s without an assertion",
    async (pathname) => {
      const response = await middleware(new NextRequest(`https://origin.example.com${pathname}`));
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.has("x-middleware-next")).toBe(false);
    }
  );

  it("does not trust the email hint or an Access cookie without the signed assertion header", async () => {
    const response = await middleware(
      new NextRequest("https://origin.example.com/", {
        headers: {
          "Cf-Access-Authenticated-User-Email": "person@example.com",
          Cookie: `CF_Authorization=${assertion}`,
        },
      })
    );
    expect(response.status).toBe(403);
  });

  it("uses the same generic denial for an invalid token and missing configuration", async () => {
    const request = new NextRequest("https://origin.example.com/", {
      headers: { "Cf-Access-Jwt-Assertion": "invalid-token" },
    });
    const invalid = await middleware(request);
    vi.stubEnv("CF_ACCESS_AUD", undefined);
    const unconfigured = await middleware(request);
    expect(invalid.status).toBe(403);
    expect(unconfigured.status).toBe(403);
    expect(await invalid.text()).toBe("Forbidden");
    expect(await unconfigured.text()).toBe("Forbidden");
  });

  it("admits a verified request without forwarding Access credentials or identity hints", async () => {
    const response = await middleware(
      new NextRequest("https://origin.example.com/api/sessions/session-1/ws-token", {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": assertion,
          "Cf-Access-Authenticated-User-Email": "spoofed@example.com",
          "CF-Access-Client-Id": "service-id",
          "CF-Access-Client-Secret": "service-secret",
          Cookie: `openinspect.session_token=opaque%2fsession+value==; CF_Authorization=${assertion}; preference=%2Fraw`,
        },
      })
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
    for (const name of [
      "cf-access-jwt-assertion",
      "cf-access-authenticated-user-email",
      "cf-access-client-id",
      "cf-access-client-secret",
    ]) {
      expect(response.headers.has(`x-middleware-request-${name}`)).toBe(false);
    }
    expect(response.headers.get("x-middleware-request-cookie")).toBe(
      "openinspect.session_token=opaque%2fsession+value==; preference=%2Fraw"
    );
  });

  it("refuses production bypass even with a valid assertion", async () => {
    vi.stubEnv("AUTH_DEV_BYPASS", "1");
    const response = await middleware(
      new NextRequest("http://localhost/settings", {
        headers: { "Cf-Access-Jwt-Assertion": assertion },
      })
    );
    expect(response.status).toBe(403);
  });
});

describe("Access middleware route coverage", () => {
  it.each([
    "/",
    "/login",
    "/settings",
    "/session/session-1",
    "/api/sessions",
    "/api/sessions/session-1/ws-token",
    "/api/auth/callback/github",
    "/api/sessions/export.json",
    "/session/session.css",
    "/_next/data/build-id/settings.json",
    "/_next/image?url=%2Fapi%2Fprivate-image&w=640&q=75",
    "/_next/static-private",
    "/favicon.ico/private",
    "/branding/logo.svg/private",
    "/settings?_rsc=prefetch",
  ])("protects %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
  });

  it.each([
    "/_next/static/chunks/app.js",
    "/favicon.ico",
    "/branding/logo.svg",
    "/hljs-themes/github.css",
    "/hljs-themes/github-dark.css",
    "/hljs-themes/atom-one-dark.css",
    "/hljs-themes/atom-one-light.css",
  ])("excludes the static asset %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
  });
});
