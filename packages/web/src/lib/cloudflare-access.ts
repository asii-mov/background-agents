import { createRemoteJWKSet, jwtVerify } from "jose";

export interface VerifiedAccessHuman {
  readonly kind: "verified-human";
  readonly subject: string;
  readonly email: string;
}

interface AccessRejection {
  readonly kind: "rejected";
  readonly reason:
    | "configuration"
    | "development-bypass-forbidden"
    | "missing-assertion"
    | "invalid-assertion"
    | "not-human";
}

type DevelopmentBypass = { readonly kind: "development-bypass" };
type AccessDecision = VerifiedAccessHuman | DevelopmentBypass | AccessRejection;

interface AccessEnvironment {
  readonly NODE_ENV?: string;
  readonly CF_ACCESS_TEAM_DOMAIN?: string;
  readonly CF_ACCESS_AUD?: string;
  readonly AUTH_DEV_BYPASS?: string;
}

type AccessConfiguration =
  | { readonly kind: "enforced"; readonly issuer: string; readonly audience: string }
  | DevelopmentBypass
  | AccessRejection;

let cachedJwks:
  | { readonly issuer: string; readonly keys: ReturnType<typeof createRemoteJWKSet> }
  | undefined;

function parseConfiguration(environment: AccessEnvironment, hostname: string): AccessConfiguration {
  if (environment.AUTH_DEV_BYPASS === "1") {
    if (
      environment.NODE_ENV === "development" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
    ) {
      return { kind: "development-bypass" };
    }
    return { kind: "rejected", reason: "development-bypass-forbidden" };
  }

  const teamDomain = environment.CF_ACCESS_TEAM_DOMAIN;
  const audience = environment.CF_ACCESS_AUD;
  if (
    !teamDomain ||
    !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com\/?$/.test(
      teamDomain
    ) ||
    !audience ||
    !/^[A-Za-z0-9_-]+$/.test(audience)
  ) {
    return { kind: "rejected", reason: "configuration" };
  }
  return { kind: "enforced", issuer: teamDomain.replace(/\/$/, ""), audience };
}

export async function verifyAccessRequest({
  assertion,
  environment,
  hostname,
}: {
  readonly assertion: string | null;
  readonly environment: AccessEnvironment;
  readonly hostname: string;
}): Promise<AccessDecision> {
  const configuration = parseConfiguration(environment, hostname);
  if (configuration.kind !== "enforced") return configuration;
  if (!assertion) return { kind: "rejected", reason: "missing-assertion" };

  try {
    if (cachedJwks?.issuer !== configuration.issuer) {
      cachedJwks = {
        issuer: configuration.issuer,
        keys: createRemoteJWKSet(new URL("/cdn-cgi/access/certs", configuration.issuer)),
      };
    }

    const { payload } = await jwtVerify(assertion, cachedJwks.keys, {
      algorithms: ["RS256"],
      issuer: configuration.issuer,
      audience: configuration.audience,
      requiredClaims: ["exp", "nbf", "iat", "iss", "aud", "sub"],
    });

    if (
      payload.type !== "app" ||
      typeof payload.sub !== "string" ||
      payload.sub.trim().length === 0 ||
      typeof payload.email !== "string" ||
      payload.email.trim().length === 0 ||
      payload.common_name !== undefined ||
      payload.service_token_id !== undefined ||
      payload.service_token_status === true
    ) {
      return { kind: "rejected", reason: "not-human" };
    }

    return { kind: "verified-human", subject: payload.sub, email: payload.email };
  } catch {
    return { kind: "rejected", reason: "invalid-assertion" };
  }
}
