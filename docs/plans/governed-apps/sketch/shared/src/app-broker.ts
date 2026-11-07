/**
 * packages/shared/src/app-broker.ts  (FINAL; replaces data/fable/sketch/shared/src/app-broker-data.ts)
 *
 * The whole control plane <-> broker protocol: deploy, takedown, data. Parsed with zod at both ends.
 * The broker (packages/app-broker, Terraform-deployed INTO THE APPS ACCOUNT) is the only holder of the
 * apps-account token. It derives every Cloudflare object it touches from the app name (script, hostname,
 * Access app) or requires an `app-` prefix on the RESOLVED resource (data). Nothing in this protocol can
 * name a Worker, hostname, policy or bucket outside those grammars, and no op can make data public.
 *
 * Auth: sig1 (service-auth.ts) with ServiceName "control-plane"; the broker verifies with
 * SERVICE_AUTH_SECRET_CONTROL_PLANE. In front of it, Terraform puts an exact-hostname Access app with a
 * service-token policy; the control plane sends CF-Access-Client-Id/Secret on every call.
 */
import { z } from "zod";
import { APP_NAME_PATTERN, type HostingBackendKind } from "./apps";

export const APP_BROKER_SERVICE = "control-plane" as const; // SERVICE_NAMES += "control-plane"
export const APP_BROKER_ROUTES = {
  deploy: "/deploy",
  takedown: "/takedown",
  data: "/data",
  health: "/health",
} as const;
/** The broker hostname label under the apps domain; in RESERVED_APP_NAMES. */
export const APP_BROKER_HOST_LABEL = "deployer";

export const APP_RESOURCE_PREFIX = "app-";
export type AppResourceName = string & { readonly __brand: "AppResourceName" };
export const APP_RESOURCE_NAME_PATTERN = /^app-[a-z0-9](?:[a-z0-9-]{1,57}[a-z0-9])?$/;
const appResourceName = z.string().regex(APP_RESOURCE_NAME_PATTERN);
const id = z.string().min(1).max(128);
const bookmark = z.string().min(1).max(256);
const bindingName = z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/);

// ---- /deploy (multipart: part "request" = JSON below; parts a<n>, worker as in apps.ts) -----------

/** Bindings the control plane asks for, already resolved by app-data. Platform vars are the broker's. */
export const brokerBindingSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("d1"), name: bindingName, databaseId: id }),
  z.strictObject({ type: z.literal("kv_namespace"), name: bindingName, namespaceId: id }),
  z.strictObject({ type: z.literal("r2_bucket"), name: bindingName, bucketName: appResourceName }),
  z.strictObject({
    type: z.literal("secret_text"),
    name: bindingName,
    value: z
      .string()
      .min(1)
      .max(8 * 1024),
  }),
]);
export type BrokerBinding = z.infer<typeof brokerBindingSchema>;

export const brokerDeployRequestSchema = z.strictObject({
  name: z.string().regex(APP_NAME_PATTERN),
  /** app_deployments.id; written as the script annotation for drift correlation. */
  deploymentId: id,
  assets: z
    .array(
      z.strictObject({ path: z.string().min(2).max(256), part: z.string().regex(/^a\d{1,4}$/) })
    )
    .max(2000),
  worker: z.strictObject({ part: z.literal("worker") }).nullable(),
  notFoundHandling: z.enum(["404-page", "single-page-application", "none"]),
  bindings: z.array(brokerBindingSchema).max(32),
});
export type BrokerDeployRequest = z.infer<typeof brokerDeployRequestSchema>;

export const brokerDeployResponseSchema = z.strictObject({
  url: z.string().url(),
  backend: z.enum(["workers", "dispatch-namespace"]),
  cfVersionId: z.string(),
  accessAud: z.string(),
  firstDeploy: z.boolean(),
});
export type BrokerDeployResponse = z.infer<typeof brokerDeployResponseSchema>;

// ---- /takedown ------------------------------------------------------------------------------------

export const brokerTakedownRequestSchema = z.strictObject({
  name: z.string().regex(APP_NAME_PATTERN),
});
export const brokerTakedownResponseSchema = z.strictObject({
  cleanupComplete: z.boolean(),
  failedStep: z.enum(["detach", "remove_script", "revoke_access"]).optional(),
});

// ---- /data (one op per request; `op` is the discriminator) ----------------------------------------

export const brokerDataRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("d1.ensure"), name: appResourceName }),
  /** One migration file = one call. D1 batch semantics are assumed atomic; the caller records a bookmark first regardless (R1). */
  z.strictObject({
    op: z.literal("d1.execute"),
    databaseId: id,
    sql: z
      .string()
      .min(1)
      .max(256 * 1024),
  }),
  z.strictObject({ op: z.literal("d1.bookmark"), databaseId: id }),
  z.strictObject({
    op: z.literal("d1.restore"),
    databaseId: id,
    target: z.union([
      z.strictObject({ bookmark }),
      z.strictObject({ timestamp: z.number().int().positive() }),
    ]),
  }),
  z.strictObject({ op: z.literal("d1.describe"), databaseId: id }),
  z.strictObject({ op: z.literal("d1.delete"), databaseId: id }),
  z.strictObject({ op: z.literal("kv.ensure"), name: appResourceName }),
  z.strictObject({ op: z.literal("kv.delete"), namespaceId: id }),
  /** Private bucket; no op exists for public access or custom domains. */
  z.strictObject({ op: z.literal("r2.ensure"), name: appResourceName }),
  /** Lifecycle expire-all then DELETE; "deleted" once Cloudflare emptied it. Repeated hourly by the purge sweep. */
  z.strictObject({ op: z.literal("r2.purge"), bucketName: appResourceName }),
]);
export type BrokerDataRequest = z.infer<typeof brokerDataRequestSchema>;

export const brokerDataResponseSchema = {
  "d1.ensure": z.strictObject({ databaseId: id, created: z.boolean() }),
  "d1.execute": z.strictObject({ ok: z.literal(true) }),
  "d1.bookmark": z.strictObject({ bookmark }),
  "d1.restore": z.strictObject({ bookmark, previousBookmark: bookmark }),
  "d1.describe": z.strictObject({
    name: appResourceName,
    fileSize: z.number().int().nonnegative(),
    numTables: z.number().int().nonnegative(),
  }),
  "d1.delete": z.strictObject({ ok: z.literal(true) }),
  "kv.ensure": z.strictObject({ namespaceId: id, created: z.boolean() }),
  "kv.delete": z.strictObject({ ok: z.literal(true) }),
  "r2.ensure": z.strictObject({ bucketName: appResourceName, created: z.boolean() }),
  "r2.purge": z.strictObject({ status: z.enum(["emptying", "deleted"]) }),
} as const satisfies Record<BrokerDataRequest["op"], z.ZodTypeAny>;
export type BrokerDataResponse<Op extends BrokerDataRequest["op"]> = z.infer<
  (typeof brokerDataResponseSchema)[Op]
>;

// ---- Errors (classified once, by the broker) -------------------------------------------------------

export const BROKER_ERRORS = [
  "refused", // non-app resource or name: a security event; never retried
  "invalid_name",
  "reserved_name",
  "hostname_conflict",
  "script_rejected",
  "access_guard_failed",
  "not_found",
  "sql_error",
  "rate_limited",
  "upstream_unavailable",
  "invalid_request",
] as const;
export type BrokerErrorCode = (typeof BROKER_ERRORS)[number];
export const brokerErrorSchema = z.strictObject({
  error: z.enum(BROKER_ERRORS),
  /** Safe to relay to an agent for script_rejected and sql_error; otherwise generic. */
  message: z.string().max(4000),
  retryAfterSeconds: z.number().int().positive().optional(),
});
export const BROKER_ERROR_STATUS = {
  refused: 403,
  invalid_name: 400,
  reserved_name: 400,
  hostname_conflict: 409,
  script_rejected: 422,
  access_guard_failed: 503,
  not_found: 404,
  sql_error: 422,
  rate_limited: 429,
  upstream_unavailable: 502,
  invalid_request: 400,
} as const satisfies Record<BrokerErrorCode, number>;

/** Platform vars the broker sets on every script. The control plane never sends these. */
export const APP_PLATFORM_BINDINGS = {
  assets: "ASSETS",
  teamDomain: "CF_ACCESS_TEAM_DOMAIN",
  aud: "CF_ACCESS_AUD",
  hostname: "APP_HOSTNAME",
  appName: "OI_APP_NAME",
} as const;
export type _BackendFromBroker = HostingBackendKind;
