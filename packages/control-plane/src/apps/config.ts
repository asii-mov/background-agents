/**
 * App hosting configuration, parsed once at the boundary. The control plane knows a broker URL,
 * the apps domain and two credentials; everything Cloudflare-specific lives in the broker.
 * Hosting is off until every field is set, and a partial configuration names each gap.
 */

import type { AppName } from "@open-inspect/shared/apps";
import type { EnvConfig } from "../types";

export interface AppsConfig {
  /** `https://deployer.<apps domain>`: an origin, so signed request URLs match what the broker sees. */
  readonly brokerOrigin: string;
  /** Bare hostname; app `<name>` is served at `https://<name>.<appsDomain>`. */
  readonly appsDomain: string;
  /** sig1 secret the control plane signs broker calls with. */
  readonly brokerSecret: string;
  /** Cloudflare Access service token in front of the broker hostname. */
  readonly accessClientId: string;
  readonly accessClientSecret: string;
}

export type AppsAvailability =
  | { kind: "available"; config: AppsConfig }
  | { kind: "not_configured" }
  | { kind: "invalid"; problems: readonly string[] };

type AppsEnv = Pick<
  EnvConfig,
  | "APP_BROKER_URL"
  | "APPS_DOMAIN"
  | "SERVICE_AUTH_SECRET_APP_BROKER"
  | "APP_BROKER_ACCESS_CLIENT_ID"
  | "APP_BROKER_ACCESS_CLIENT_SECRET"
>;

const FIELDS = [
  "APP_BROKER_URL",
  "APPS_DOMAIN",
  "SERVICE_AUTH_SECRET_APP_BROKER",
  "APP_BROKER_ACCESS_CLIENT_ID",
  "APP_BROKER_ACCESS_CLIENT_SECRET",
] as const satisfies readonly (keyof AppsEnv)[];

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isBareHostname(value: string): boolean {
  const labels = value.split(".");
  return labels.length >= 2 && value.length <= 253 && labels.every((l) => HOSTNAME_LABEL.test(l));
}

/** The origin of an `https://host` URL with no path, query or credentials; null otherwise. */
function brokerOriginOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const bare =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  return bare ? url.origin : null;
}

/** Pure. Never repairs a value: a scheme is not added and case is not folded. */
export function parseAppsConfig(env: AppsEnv): AppsAvailability {
  const value = (field: (typeof FIELDS)[number]) => env[field] ?? "";
  if (FIELDS.every((field) => value(field) === "")) return { kind: "not_configured" };

  const problems = FIELDS.filter((field) => value(field) === "").map(
    (field) => `${field} is not set`
  );
  const brokerUrl = value("APP_BROKER_URL");
  const brokerOrigin = brokerUrl ? brokerOriginOf(brokerUrl) : null;
  if (brokerUrl && !brokerOrigin) {
    problems.push("APP_BROKER_URL must be an https:// origin with no path");
  }
  const appsDomain = value("APPS_DOMAIN");
  if (appsDomain && !isBareHostname(appsDomain)) {
    problems.push("APPS_DOMAIN must be a lowercase hostname such as apps.example.com");
  }
  if (problems.length > 0 || !brokerOrigin) return { kind: "invalid", problems };

  return {
    kind: "available",
    config: {
      brokerOrigin,
      appsDomain,
      brokerSecret: value("SERVICE_AUTH_SECRET_APP_BROKER"),
      accessClientId: value("APP_BROKER_ACCESS_CLIENT_ID"),
      accessClientSecret: value("APP_BROKER_ACCESS_CLIENT_SECRET"),
    },
  };
}

export function appHostname(appsDomain: string, name: AppName): string {
  return `${name}.${appsDomain}`;
}

/** Exactly the URL the broker reports: no trailing slash. */
export function appUrl(appsDomain: string, name: AppName): string {
  return `https://${appHostname(appsDomain, name)}`;
}
