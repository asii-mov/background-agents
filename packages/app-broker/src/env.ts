import { APP_RESOURCE_PREFIX } from "@open-inspect/shared/app-broker";
import type { HostingBackendKind } from "@open-inspect/shared/apps";
import { DATA_JURISDICTIONS, type DataJurisdiction } from "@open-inspect/shared/types/app-data";

/** The broker Worker's bindings, as Terraform sets them in the apps account. */
export interface BrokerEnv {
  APPS_ACCOUNT_ID?: string;
  APPS_ZONE_ID?: string;
  /** Each app is served at `<name>.<APPS_DOMAIN>`. */
  APPS_DOMAIN?: string;
  /** Prefix of every app script; must start with the data-resource prefix, so one grammar covers both. */
  APPS_SCRIPT_PREFIX?: string;
  APPS_HOSTING_BACKEND?: string;
  APPS_DISPATCH_NAMESPACE?: string;
  APPS_DISPATCHER_SERVICE?: string;
  /** `https://<team>.cloudflareaccess.com` of the apps account's Zero Trust org. */
  APPS_ACCESS_TEAM_DOMAIN?: string;
  /** The Terraform-owned visitor policy: the only policy the broker ever attaches. */
  APPS_ACCESS_POLICY_ID?: string;
  /** The Terraform-owned `*.<APPS_DOMAIN>` Access application. */
  APPS_ACCESS_FLOOR_APP_ID?: string;
  /** Empty, `eu` or `fedramp`; applied to every D1 database and R2 bucket the broker creates. */
  APP_DATA_JURISDICTION?: string;
  APPS_API_TOKEN?: string;
  SERVICE_AUTH_SECRET_CONTROL_PLANE?: string;
}

type HostingConfig =
  | { readonly kind: Extract<HostingBackendKind, "workers"> }
  | {
      readonly kind: Extract<HostingBackendKind, "dispatch-namespace">;
      readonly namespace: string;
      readonly dispatcherService: string;
    };

export interface BrokerConfig {
  readonly accountId: string;
  readonly zoneId: string;
  readonly appsDomain: string;
  readonly scriptPrefix: string;
  readonly hosting: HostingConfig;
  readonly access: {
    readonly teamDomain: string;
    readonly policyId: string;
    readonly floorAppId: string;
  };
  readonly jurisdiction: DataJurisdiction | null;
  readonly apiToken: string;
}

const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const SCRIPT_PREFIX_PATTERN = /^[a-z0-9-]*$/;

/**
 * An app script prefix the broker accepts: it starts with the data-resource prefix, so a script
 * the broker writes can never be the broker's, the dispatcher's, or anything else in the account.
 */
export function parseScriptPrefix(raw: string | undefined): string | null {
  return raw !== undefined && raw.startsWith(APP_RESOURCE_PREFIX) && SCRIPT_PREFIX_PATTERN.test(raw)
    ? raw
    : null;
}

export type BrokerConfigResult =
  | { readonly ok: true; readonly config: BrokerConfig }
  | { readonly ok: false; readonly invalid: readonly string[] };

/** Parses the bindings once per request; any missing or malformed binding fails closed. */
export function parseBrokerConfig(env: BrokerEnv): BrokerConfigResult {
  const invalid: string[] = [];
  const required = (key: keyof BrokerEnv): string => {
    const value = env[key]?.trim();
    if (!value) invalid.push(key);
    return value ?? "";
  };

  const accountId = required("APPS_ACCOUNT_ID");
  const zoneId = required("APPS_ZONE_ID");
  const appsDomain = required("APPS_DOMAIN").toLowerCase();
  if (appsDomain && !HOSTNAME_PATTERN.test(appsDomain)) invalid.push("APPS_DOMAIN");
  const scriptPrefix = parseScriptPrefix(env.APPS_SCRIPT_PREFIX);
  if (scriptPrefix === null) invalid.push("APPS_SCRIPT_PREFIX");
  const teamDomain = required("APPS_ACCESS_TEAM_DOMAIN").replace(/\/+$/, "");
  if (teamDomain && !/^https:\/\/[^/?#]+$/.test(teamDomain))
    invalid.push("APPS_ACCESS_TEAM_DOMAIN");
  const policyId = required("APPS_ACCESS_POLICY_ID");
  const floorAppId = required("APPS_ACCESS_FLOOR_APP_ID");
  const apiToken = required("APPS_API_TOKEN");

  let hosting: HostingConfig = { kind: "workers" };
  const backend = env.APPS_HOSTING_BACKEND?.trim() || "workers";
  if (backend === "dispatch-namespace") {
    hosting = {
      kind: "dispatch-namespace",
      namespace: required("APPS_DISPATCH_NAMESPACE"),
      dispatcherService: required("APPS_DISPATCHER_SERVICE"),
    };
  } else if (backend !== "workers") {
    invalid.push("APPS_HOSTING_BACKEND");
  }

  const rawJurisdiction = env.APP_DATA_JURISDICTION?.trim() ?? "";
  const jurisdiction = (DATA_JURISDICTIONS as readonly string[]).includes(rawJurisdiction)
    ? (rawJurisdiction as DataJurisdiction)
    : null;
  if (rawJurisdiction && jurisdiction === null) invalid.push("APP_DATA_JURISDICTION");

  if (invalid.length > 0 || scriptPrefix === null) return { ok: false, invalid };
  return {
    ok: true,
    config: {
      accountId,
      zoneId,
      appsDomain,
      scriptPrefix,
      hosting,
      access: { teamDomain, policyId, floorAppId },
      jurisdiction,
      apiToken,
    },
  };
}
