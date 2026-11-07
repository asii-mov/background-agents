/**
 * packages/app-broker/guard/guard.ts  (NEW; built with esbuild + jose into dist/guard.mjs, embedded by
 * publish.ts as the main module of EVERY app script, both backends)
 *
 * Resolves data design R2: the guard is where the identity header contract becomes real.
 */
import {
  ACCESS_IDENTITY_HEADERS,
  FORBIDDEN_IDENTITY_HEADERS,
} from "@open-inspect/shared/types/app-data";
// import * as guardCore from "./access-jwt";   // imported FIRST: captures crypto.subtle/fetch refs before app.mjs init
// import * as app from "./app.mjs";             // the user module (or `export default null`)

export interface GuardEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CF_ACCESS_TEAM_DOMAIN: string; // https://<team>.cloudflareaccess.com
  CF_ACCESS_AUD: string; // this app's own Access AUD
  APP_HOSTNAME: string; // <name>.<apps domain>
  OI_APP_NAME: string;
}

/**
 * fetch(request, env, ctx):
 *   1. missing env -> 503 (fail closed)
 *   2. host !== env.APP_HOSTNAME -> 404     (kills workers.dev, preview, version and stray-route URLs)
 *   3. token = Cf-Access-Jwt-Assertion header or CF_Authorization cookie
 *      verify RS256 via `${TEAM}/cdn-cgi/access/certs` (JWKS cached per isolate, refetched on kid miss),
 *      iss === TEAM, aud includes CF_ACCESS_AUD, exp/nbf, type "app", sub && email non-empty
 *      -> else 403 with a plain-language body (no redirect: Access already redirected unauthenticated visitors)
 *   4. headers = new Headers(request.headers)
 *      for h of [...FORBIDDEN_IDENTITY_HEADERS, ACCESS_IDENTITY_HEADERS.sub, ACCESS_IDENTITY_HEADERS.email]: headers.delete(h)
 *      headers.set(ACCESS_IDENTITY_HEADERS.sub, claims.sub); headers.set(ACCESS_IDENTITY_HEADERS.email, claims.email)
 *   5. app.default?.fetch ? app.default.fetch(new Request(request, { headers }), env, ctx) : env.ASSETS.fetch(request)
 * `run_worker_first: true` makes step 3 cover static assets.
 */
export const guard = {
  async fetch(_request: Request, _env: GuardEnv, _ctx: unknown): Promise<Response> {
    void [ACCESS_IDENTITY_HEADERS, FORBIDDEN_IDENTITY_HEADERS];
    throw new Error("not implemented");
  },
};
export default guard;

// dispatcher/dispatcher.ts (WfP only; Terraform-deployed in the apps account, workers.dev off):
//   label = host minus `.${APPS_DOMAIN}`; one label matching APP_NAME_PATTERN else 404;
//   env.DISPATCHER.get(`${APPS_SCRIPT_PREFIX}${label}`).fetch(request); "Worker not found" -> 404.
//   Holds no policy: the guard inside each script does the Access check.
