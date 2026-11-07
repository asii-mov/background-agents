/**
 * Cloudflare Access JWT verification for the platform guard.
 *
 * guard.mjs imports the guard core before the app's own module, so the primitives below are
 * captured before any app code runs. An app that replaces WebCrypto, fetch, Response reading,
 * JSON or base64 decoding, or the clock at load time therefore cannot change whether a token's
 * signature and claims check out. jose is not used here because it looks those globals up at
 * call time.
 */

const apply = Reflect.apply;
const subtle = crypto.subtle;
const importKey = subtle.importKey;
const verifySignature = subtle.verify;
const fetchRequest = fetch;
const readText = Response.prototype.text;
const parseJson = JSON.parse;
const decodeBase64 = atob;
const encoder = new TextEncoder();
const encodeUtf8 = encoder.encode;
const decoder = new TextDecoder();
const decodeUtf8 = decoder.decode;
const now = Date.now;
const globalScope = globalThis;

/** A kid the cached key set lacks triggers at most one refetch per interval. */
const JWKS_REFETCH_INTERVAL_MS = 60_000;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export interface AccessIdentity {
  readonly sub: string;
  readonly email: string;
}

export type AccessVerdict =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | { readonly ok: false; readonly reason: "missing" | "malformed" | "signature" | "claims" };

interface KeySet {
  readonly teamDomain: string;
  readonly keys: Map<string, CryptoKey>;
  readonly fetchedAt: number;
}

let cachedKeys: KeySet | null = null;

const nowMs = (): number => apply(now, Date, []) as number;

function base64UrlBytes(segment: string): Uint8Array {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = apply(decodeBase64, globalScope, [padded]) as string;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64UrlJson(segment: string): unknown {
  const text = apply(decodeUtf8, decoder, [base64UrlBytes(segment)]) as string;
  return apply(parseJson, JSON, [text]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchKeys(teamDomain: string): Promise<KeySet> {
  const keys = new Map<string, CryptoKey>();
  const response = (await apply(fetchRequest, globalScope, [
    `${teamDomain}/cdn-cgi/access/certs`,
  ])) as Response;
  let body: unknown = null;
  if (response.ok) {
    try {
      body = apply(parseJson, JSON, [await apply(readText, response, [])]);
    } catch {
      body = null;
    }
  }
  const jwks = isRecord(body) && Array.isArray(body.keys) ? body.keys : [];
  for (const jwk of jwks) {
    if (!isRecord(jwk) || typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
    const key = (await apply(importKey, subtle, [
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      RS256,
      false,
      ["verify"],
    ])) as CryptoKey;
    keys.set(jwk.kid, key);
  }
  return { teamDomain, keys, fetchedAt: nowMs() };
}

async function keyFor(teamDomain: string, kid: string): Promise<CryptoKey | null> {
  const current = cachedKeys?.teamDomain === teamDomain ? cachedKeys : null;
  const cached = current?.keys.get(kid);
  if (cached) return cached;
  if (current !== null && nowMs() - current.fetchedAt < JWKS_REFETCH_INTERVAL_MS) return null;
  cachedKeys = await fetchKeys(teamDomain);
  return cachedKeys.keys.get(kid) ?? null;
}

function claimsHold(claims: unknown, expected: { teamDomain: string; aud: string }): boolean {
  if (!isRecord(claims)) return false;
  const nowSeconds = nowMs() / 1000;
  const audiences: unknown[] = typeof claims.aud === "string" ? [claims.aud] : [];
  if (Array.isArray(claims.aud)) for (const audience of claims.aud) audiences.push(audience);
  let audienceMatches = false;
  for (const audience of audiences) if (audience === expected.aud) audienceMatches = true;
  return (
    claims.iss === expected.teamDomain &&
    audienceMatches &&
    typeof claims.exp === "number" &&
    claims.exp > nowSeconds &&
    (claims.nbf === undefined || (typeof claims.nbf === "number" && claims.nbf <= nowSeconds)) &&
    claims.type === "app" &&
    typeof claims.sub === "string" &&
    claims.sub !== "" &&
    typeof claims.email === "string" &&
    claims.email !== ""
  );
}

/**
 * Verify an Access application token: RS256 signed by the team's current keys, issued by the
 * team domain, for this app's AUD, unexpired, of type `app`, and naming a user.
 */
export async function verifyAccessJwt(
  token: string | null,
  expected: { teamDomain: string; aud: string }
): Promise<AccessVerdict> {
  if (!token) return { ok: false, reason: "missing" };
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    return { ok: false, reason: "malformed" };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;

  let header: unknown;
  let claims: unknown;
  try {
    header = base64UrlJson(encodedHeader);
    claims = base64UrlJson(encodedPayload);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isRecord(header) || header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, reason: "malformed" };
  }

  const key = await keyFor(expected.teamDomain, header.kid);
  if (!key) return { ok: false, reason: "signature" };
  const signed = apply(encodeUtf8, encoder, [`${encodedHeader}.${encodedPayload}`]) as Uint8Array;
  const valid = (await apply(verifySignature, subtle, [
    RS256,
    key,
    base64UrlBytes(encodedSignature),
    signed,
  ])) as unknown;
  if (valid !== true) return { ok: false, reason: "signature" };
  if (!claimsHold(claims, expected)) return { ok: false, reason: "claims" };
  const identity = claims as { sub: string; email: string };
  return { ok: true, identity: { sub: identity.sub, email: identity.email } };
}
