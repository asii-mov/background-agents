/**
 * The Workers for Platforms dispatcher, deployed by Terraform in the apps account with workers.dev
 * off. It is reached only through the per-app Custom Domains the broker attaches after Access is in
 * place, and it holds no policy: the guard inside each app script checks Access. The script name
 * comes from the Host header by the broker's own derivation, so there is no table to keep in sync.
 */

import { parseAppName } from "@open-inspect/shared/apps";
import { parseScriptPrefix } from "../src/env";
import { appTarget } from "../src/names";

interface DispatchNamespace {
  get(name: string): { fetch(request: Request): Promise<Response> };
}

export interface DispatcherEnv {
  DISPATCHER: DispatchNamespace;
  APPS_DOMAIN?: string;
  APPS_SCRIPT_PREFIX?: string;
}

/** The namespace script for `host`, or null when no app could ever be served there. */
export function scriptNameForHost(
  host: string,
  appsDomain: string,
  scriptPrefix: string
): string | null {
  const domain = appsDomain.toLowerCase();
  const suffix = `.${domain}`;
  const hostname = host.toLowerCase();
  if (!domain || !hostname.endsWith(suffix)) return null;
  const parsed = parseAppName(hostname.slice(0, -suffix.length));
  return parsed.ok ? appTarget({ appsDomain: domain, scriptPrefix }, parsed.name).script : null;
}

const notFound = () => new Response("Not found.", { status: 404 });

export default {
  async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
    const scriptPrefix = parseScriptPrefix(env.APPS_SCRIPT_PREFIX);
    const script =
      scriptPrefix === null
        ? null
        : scriptNameForHost(new URL(request.url).hostname, env.APPS_DOMAIN ?? "", scriptPrefix);
    if (script === null) return notFound();
    try {
      return await env.DISPATCHER.get(script).fetch(request);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Worker not found")) return notFound();
      throw error;
    }
  },
};
