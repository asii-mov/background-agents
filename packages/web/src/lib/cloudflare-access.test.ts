import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAccessRequest } from "./cloudflare-access";

let trustedKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let untrustedKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let teamNumber = 0;
let issuer: string;

beforeAll(async () => {
  [trustedKeys, untrustedKeys] = await Promise.all([
    generateKeyPair("RS256", { extractable: true }),
    generateKeyPair("RS256"),
  ]);
});

beforeEach(async () => {
  issuer = `https://team-${++teamNumber}.cloudflareaccess.com`;
  const publicKey = await exportJWK(trustedKeys.publicKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [{ ...publicKey, kid: "trusted", alg: "RS256" }] }))
  );
});

afterEach(() => vi.unstubAllGlobals());

function environment() {
  return {
    NODE_ENV: "production",
    CF_ACCESS_TEAM_DOMAIN: issuer,
    CF_ACCESS_AUD: "openinspect-audience",
  };
}

function verify(assertion: string | null, overrides = {}) {
  return verifyAccessRequest({
    assertion,
    environment: { ...environment(), ...overrides },
    hostname: "inspect.example.com",
  });
}

function signToken(payload: JWTPayload = {}, key = trustedKeys.privateKey) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: ["openinspect-audience"],
    sub: "human-123",
    email: "person@example.com",
    type: "app",
    exp: nowSeconds + 300,
    nbf: nowSeconds - 1,
    iat: nowSeconds - 1,
    ...payload,
  })
    .setProtectedHeader({ alg: "RS256", kid: "trusted" })
    .sign(key);
}

describe("Cloudflare Access human verification", () => {
  it("verifies a signed human token and returns only the domain identity", async () => {
    const token = await signToken({ groups: ["private-group"], custom: "private-claim" });
    expect(await verify(token)).toEqual({
      kind: "verified-human",
      subject: "human-123",
      email: "person@example.com",
    });
    expect(fetch).toHaveBeenCalledWith(`${issuer}/cdn-cgi/access/certs`, expect.any(Object));
  });

  it("reuses the team's JWKS for successive requests", async () => {
    const token = await signToken();
    await verify(token);
    await verify(token);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a signature from another key with the same key id", async () => {
    expect(await verify(await signToken({}, untrustedKeys.privateKey))).toEqual({
      kind: "rejected",
      reason: "invalid-assertion",
    });
  });

  it.each([
    ["another issuer", { iss: "https://other.cloudflareaccess.com" }],
    ["another audience", { aud: "other-audience" }],
    ["an audience prefix", { aud: "openinspect-audience-suffix" }],
    ["no audience", { aud: undefined }],
    ["no issuer", { iss: undefined }],
    ["no expiration", { exp: undefined }],
    ["no not-before time", { nbf: undefined }],
    ["no issued-at time", { iat: undefined }],
    ["an expired token", { exp: 1 }],
    ["a future not-before time", { nbf: 4_000_000_000 }],
    ["no subject", { sub: undefined }],
  ])("rejects %s", async (_label, payload) => {
    expect(await verify(await signToken(payload))).toEqual({
      kind: "rejected",
      reason: "invalid-assertion",
    });
  });

  it.each([
    ["an empty subject", { sub: "" }],
    ["a blank subject", { sub: "   " }],
    ["no email", { email: undefined }],
    ["an empty email", { email: "" }],
    ["a blank email", { email: "   " }],
    ["a non-string email", { email: 123 }],
    ["an organization token", { type: "org" }],
    ["no token type", { type: undefined }],
    ["a service token", { sub: "", email: undefined, common_name: "service.access" }],
    ["a service token carrying human claims", { common_name: "service.access" }],
    ["a service-token id", { service_token_id: "service.access" }],
    ["service-token authentication", { service_token_status: true }],
  ])("rejects %s", async (_label, payload) => {
    expect(await verify(await signToken(payload))).toEqual({
      kind: "rejected",
      reason: "not-human",
    });
  });

  it("rejects an HMAC token even when it contains valid human claims", async () => {
    const token = await new SignJWT({ sub: "human", email: "person@example.com", type: "app" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience("openinspect-audience")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("not-a-trusted-signing-key"));
    expect(await verify(token)).toEqual({ kind: "rejected", reason: "invalid-assertion" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["malformed", "", null])(
    "rejects an absent or malformed assertion: %s",
    async (token) => {
      expect(await verify(token)).toMatchObject({ kind: "rejected" });
    }
  );

  it("fails closed when the signing keys cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("JWKS unavailable")));
    expect(await verify(await signToken())).toEqual({
      kind: "rejected",
      reason: "invalid-assertion",
    });
  });
});

describe("Cloudflare Access configuration", () => {
  it.each([
    { CF_ACCESS_TEAM_DOMAIN: undefined },
    { CF_ACCESS_AUD: undefined },
    { CF_ACCESS_AUD: "  " },
    { CF_ACCESS_AUD: "audience with spaces" },
    { CF_ACCESS_TEAM_DOMAIN: "not-a-url" },
    { CF_ACCESS_TEAM_DOMAIN: "http://team.cloudflareaccess.com" },
    { CF_ACCESS_TEAM_DOMAIN: "https://untrusted.example.com" },
    { CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com.attacker.example" },
    { CF_ACCESS_TEAM_DOMAIN: "https://cloudflareaccess.com" },
    { CF_ACCESS_TEAM_DOMAIN: "https://-team.cloudflareaccess.com" },
    { CF_ACCESS_TEAM_DOMAIN: "https://user:password@team.cloudflareaccess.com" },
    { CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com:8443" },
    { CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/path" },
    { CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/path/.." },
    { CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com?query=yes" },
    { CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com#fragment" },
  ])("fails closed with invalid configuration: %j", async (overrides) => {
    expect(await verify(await signToken(), overrides)).toEqual({
      kind: "rejected",
      reason: "configuration",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not implicitly bypass missing configuration in development", async () => {
    expect(
      await verifyAccessRequest({
        assertion: null,
        environment: { NODE_ENV: "development" },
        hostname: "localhost",
      })
    ).toEqual({ kind: "rejected", reason: "configuration" });
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows explicit development bypass on %s",
    async (hostname) => {
      expect(
        await verifyAccessRequest({
          assertion: null,
          environment: { NODE_ENV: "development", AUTH_DEV_BYPASS: "1" },
          hostname,
        })
      ).toEqual({ kind: "development-bypass" });
    }
  );

  it.each(["production", "test", undefined])(
    "refuses bypass in %s even on loopback",
    async (NODE_ENV) => {
      expect(
        await verifyAccessRequest({
          assertion: await signToken(),
          environment: { ...environment(), NODE_ENV, AUTH_DEV_BYPASS: "1" },
          hostname: "localhost",
        })
      ).toEqual({ kind: "rejected", reason: "development-bypass-forbidden" });
    }
  );

  it("refuses development bypass for a public hostname", async () => {
    expect(await verify(null, { NODE_ENV: "development", AUTH_DEV_BYPASS: "1" })).toEqual({
      kind: "rejected",
      reason: "development-bypass-forbidden",
    });
  });

  it("requires the exact bypass value", async () => {
    expect(
      await verifyAccessRequest({
        assertion: null,
        environment: { NODE_ENV: "development", AUTH_DEV_BYPASS: "true" },
        hostname: "localhost",
      })
    ).toEqual({ kind: "rejected", reason: "configuration" });
  });
});
