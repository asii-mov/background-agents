import { APP_RESOURCE_NAME_PATTERN, type AppResourceName } from "@open-inspect/shared/app-broker";
import { parseAppName, type AppName } from "@open-inspect/shared/apps";
import type { BrokerConfig } from "./env";
import { BrokerRefusal } from "./errors";

export type ScriptName = string & { readonly __brand: "ScriptName" };
export type AppHostname = string & { readonly __brand: "AppHostname" };

/**
 * Every Cloudflare object an app owns, derived from its name and nothing else. No request field
 * can name a script, hostname or Access application.
 */
export interface AppTarget {
  readonly name: AppName;
  readonly script: ScriptName;
  readonly hostname: AppHostname;
}

export function appTarget(
  config: Pick<BrokerConfig, "appsDomain" | "scriptPrefix">,
  name: AppName
): AppTarget {
  return {
    name,
    script: `${config.scriptPrefix}${name}` as ScriptName,
    hostname: `${name}.${config.appsDomain}` as AppHostname,
  };
}

/** The app name a request carries, with the reason the protocol reports when it is unusable. */
export function parseRequestedAppName(raw: unknown): AppName {
  if (typeof raw !== "string") throw new BrokerRefusal("invalid_name", "An app name is required.");
  const parsed = parseAppName(raw);
  if (!parsed.ok) throw new BrokerRefusal(parsed.reason, parsed.message);
  return parsed.name;
}

/**
 * A data resource the broker may create, adopt or delete. Checked on request names and again on
 * the name Cloudflare reports for an id, so a caller can never reach a resource it did not create.
 */
export function assertAppResourceName(name: string): AppResourceName {
  if (!APP_RESOURCE_NAME_PATTERN.test(name)) {
    throw new BrokerRefusal("refused", "The broker manages app-owned resources only.");
  }
  return name as AppResourceName;
}
