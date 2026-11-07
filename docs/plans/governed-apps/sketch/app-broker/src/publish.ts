/**
 * packages/app-broker/src/publish.ts  (NEW; the security argument, in one function)
 *
 * Imports (moved verbatim from deploy/candidate-1): ./cloudflare-api (transport + retry policy),
 * ./edge (assertFloor, ensureAccess -> AccessGrant, attach, detach, revokeAccess),
 * ./backends (HostingBackend workers | dispatch-namespace; put(spec) leaves the script reachable by NO hostname).
 *
 * Publish order:
 *   1. names.assertDeployable(name)            pattern + reserved (deployer, dispatcher, ...)
 *   2. edge.assertFloor()                      Terraform wildcard app exists with the visitor policy
 *   3. grant = edge.ensureAccess(hostname)     per-app Access app, exactly [policyId]; drift repaired; dups removed
 *   4. backend.put({ script, bundle, guardModule: GUARD_SOURCE, userModule, bindings: request.bindings + platformVars(grant) })
 *        main_module = "guard.mjs"; modules = [guard.mjs, app.mjs]; assets.config = { run_worker_first: true, not_found_handling }
 *        bindings = [assets ASSETS] + [plain_text CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD(=grant.aud), APP_HOSTNAME, OI_APP_NAME]
 *                   + request.bindings (d1 | kv_namespace | r2_bucket | secret_text)
 *        annotation "workers/message" = `oi-deployment:${deploymentId}`
 *        workers backend: subdomain { enabled:false, previews_enabled:false } created BEFORE code; read back AFTER; on=true -> delete script, throw AccessGuardError
 *   5. edge.attach(grant, backend.ingressService(script))   re-reads the Access app; first moment the hostname resolves
 *   6. return { url, backend: backend.kind, cfVersionId, accessAud: grant.aud, firstDeploy }
 *
 * Type gate: attach() accepts only an AccessGrant and only ensureAccess() mints one, so "attach without
 * Access" does not compile. Order gate: platformVars(grant) is the only way to produce CF_ACCESS_AUD.
 * Edge gate: the Terraform floor covers every one-label hostname regardless of this code.
 * In-script gate: the guard pins Host and verifies the per-app AUD JWT before the user module runs.
 */
import type { BrokerDeployRequest, BrokerDeployResponse } from "@open-inspect/shared/app-broker";
import type { BrokerEnv } from "./index";

export interface ParsedBundleParts {
  assets: ReadonlyArray<{ path: string; bytes: Uint8Array; hash: string; contentType: string }>;
  userModule: Uint8Array | null; // null => "export default null;" (guard serves assets)
}

export async function publish(
  env: BrokerEnv,
  request: BrokerDeployRequest,
  parts: ParsedBundleParts,
  signal: AbortSignal
): Promise<BrokerDeployResponse> {
  void [env, request, parts, signal];
  throw new Error("not implemented");
}

/** Reverse order: detach hostname -> remove script -> revoke per-app Access app (never the floor). Absent = done. */
export async function takedown(
  env: BrokerEnv,
  name: string,
  signal: AbortSignal
): Promise<{
  cleanupComplete: boolean;
  failedStep?: "detach" | "remove_script" | "revoke_access";
}> {
  void [env, name, signal];
  throw new Error("not implemented");
}

// names.ts
//   appHostname(env, name) = `${name}.${env.APPS_DOMAIN}`      appScriptName(env, name) = `${env.APPS_SCRIPT_PREFIX}${name}`
//   assertDeployable(name): APP_NAME_PATTERN && !RESERVED_APP_NAMES.includes(name) else BrokerRefusal(invalid_name|reserved_name)
//   assertAppResourceName(name): APP_RESOURCE_NAME_PATTERN else BrokerRefusal("refused")   (data.ts)
//   The dispatcher's scriptNameForHost(host) must equal appScriptName over a table (contract test).
