/**
 * The whole control plane <-> app broker protocol: deploy, takedown, data. Parsed with zod at both
 * ends.
 *
 * The broker (packages/app-broker, deployed by Terraform into the apps account) is the only holder
 * of the apps-account token. It derives every Cloudflare object it touches from the app name
 * (script, hostname, Access application) or requires the `app-` prefix on the resolved resource
 * (data). Nothing in this protocol can name a Worker, hostname, policy or bucket outside those
 * grammars, and no op can make data public.
 *
 * Auth: sig1 (service-auth.ts) signed as APP_BROKER_SERVICE; the broker verifies with its
 * SERVICE_AUTH_SECRET_CONTROL_PLANE. In front of it, Terraform puts an exact-hostname Access
 * application with a service-token policy; the control plane sends CF-Access-Client-Id/Secret.
 */

import { z } from "zod";
import {
  appAssetEntrySchema,
  appNameSchema,
  APP_BUNDLE_LIMITS,
  HOSTING_BACKEND_KINDS,
} from "./apps";
import type { SigningServiceName } from "./service-auth";
import { APP_DATA_LIMITS, bindingNameSchema, d1RestoreTargetSchema } from "./types/app-data";

export const APP_BROKER_SERVICE = "control-plane" satisfies SigningServiceName;
export const APP_BROKER_ROUTES = {
  deploy: "/deploy",
  takedown: "/takedown",
  data: "/data",
  health: "/health",
} as const;
/** The broker's hostname label under the apps domain; listed in RESERVED_APP_NAMES. */
export const APP_BROKER_HOST_LABEL = "deployer";

/** Every Cloudflare data resource the broker creates, adopts or deletes starts with this. */
export const APP_RESOURCE_PREFIX = "app-";
export type AppResourceName = string & { readonly __brand: "AppResourceName" };
/** 5 to 63 characters: valid for D1, KV and R2 names alike. */
export const APP_RESOURCE_NAME_PATTERN = /^app-[a-z0-9](?:[a-z0-9-]{1,57}[a-z0-9])?$/;
export const appResourceNameSchema = z
  .string()
  .regex(APP_RESOURCE_NAME_PATTERN)
  .transform((name) => name as AppResourceName);

const providerId = z.string().min(1).max(128);
const bookmark = z.string().min(1).max(256);

// ---- /deploy: multipart, part BROKER_DEPLOY_REQUEST_PART = JSON below; asset and worker parts as in apps.ts

export const BROKER_DEPLOY_REQUEST_PART = "request";

/** Bindings the control plane asks for, already resolved by app-data. The broker adds the platform ones. */
export const brokerBindingSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("d1"), name: bindingNameSchema, databaseId: providerId }),
  z.strictObject({
    type: z.literal("kv_namespace"),
    name: bindingNameSchema,
    namespaceId: providerId,
  }),
  z.strictObject({
    type: z.literal("r2_bucket"),
    name: bindingNameSchema,
    bucketName: appResourceNameSchema,
  }),
  z.strictObject({
    type: z.literal("secret_text"),
    name: bindingNameSchema,
    value: z.string().min(1).max(APP_DATA_LIMITS.maxSecretValueBytes),
  }),
]);
export type BrokerBinding = z.output<typeof brokerBindingSchema>;

export const APP_NOT_FOUND_HANDLING = ["404-page", "single-page-application", "none"] as const;

export const brokerDeployRequestSchema = z
  .strictObject({
    name: appNameSchema,
    /** app_deployments.id; written as the script annotation for drift correlation. */
    deploymentId: providerId,
    assets: z.array(appAssetEntrySchema).max(APP_BUNDLE_LIMITS.maxAssetCount),
    worker: z.strictObject({ part: z.literal("worker") }).nullable(),
    notFoundHandling: z.enum(APP_NOT_FOUND_HANDLING),
    bindings: z
      .array(brokerBindingSchema)
      .max(APP_DATA_LIMITS.maxBindings + APP_DATA_LIMITS.maxSecrets),
  })
  .superRefine((request, ctx) => {
    const names = new Set<string>();
    request.bindings.forEach((binding, index) => {
      if (names.has(binding.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["bindings", index, "name"],
          message: `Binding ${binding.name} is declared twice`,
        });
      }
      names.add(binding.name);
    });
  });
export type BrokerDeployRequest = z.output<typeof brokerDeployRequestSchema>;

export const brokerDeployResponseSchema = z.strictObject({
  url: z.url(),
  backend: z.enum(HOSTING_BACKEND_KINDS),
  cfVersionId: z.string().min(1),
  accessAud: z.string().min(1),
  firstDeploy: z.boolean(),
});
export type BrokerDeployResponse = z.output<typeof brokerDeployResponseSchema>;

// ---- /takedown ----------------------------------------------------------------------------------

export const BROKER_TAKEDOWN_STEPS = ["detach", "remove_script", "revoke_access"] as const;

export const brokerTakedownRequestSchema = z.strictObject({ name: appNameSchema });
export const brokerTakedownResponseSchema = z.strictObject({
  cleanupComplete: z.boolean(),
  failedStep: z.enum(BROKER_TAKEDOWN_STEPS).optional(),
});
export type BrokerTakedownResponse = z.output<typeof brokerTakedownResponseSchema>;

// ---- /data: one op per request; `op` is the discriminator ---------------------------------------

export const brokerDataRequestSchema = z.discriminatedUnion("op", [
  /** Create-or-adopt by exact name. */
  z.strictObject({ op: z.literal("d1.ensure"), name: appResourceNameSchema }),
  /** One migration file per call. D1 runs it as one transaction; the caller records a bookmark first regardless. */
  z.strictObject({
    op: z.literal("d1.execute"),
    databaseId: providerId,
    sql: z.string().min(1).max(APP_DATA_LIMITS.maxMigrationBytes),
  }),
  z.strictObject({ op: z.literal("d1.bookmark"), databaseId: providerId }),
  z.strictObject({
    op: z.literal("d1.restore"),
    databaseId: providerId,
    target: d1RestoreTargetSchema,
  }),
  z.strictObject({ op: z.literal("d1.describe"), databaseId: providerId }),
  z.strictObject({ op: z.literal("d1.delete"), databaseId: providerId }),
  z.strictObject({ op: z.literal("kv.ensure"), name: appResourceNameSchema }),
  z.strictObject({ op: z.literal("kv.delete"), namespaceId: providerId }),
  /** A private bucket. No op exists for public access or custom domains. */
  z.strictObject({ op: z.literal("r2.ensure"), name: appResourceNameSchema }),
  /** Lifecycle expire-all, then DELETE; "deleted" once Cloudflare has emptied it. Repeated by the purge sweep. */
  z.strictObject({ op: z.literal("r2.purge"), bucketName: appResourceNameSchema }),
]);
export type BrokerDataRequest = z.output<typeof brokerDataRequestSchema>;
export type BrokerDataOp = BrokerDataRequest["op"];

/** `created: false` means adopted: every ensure is idempotent. */
export const brokerDataResponseSchema = {
  "d1.ensure": z.strictObject({ databaseId: providerId, created: z.boolean() }),
  "d1.execute": z.strictObject({ ok: z.literal(true) }),
  "d1.bookmark": z.strictObject({ bookmark }),
  "d1.restore": z.strictObject({ bookmark, previousBookmark: bookmark }),
  "d1.describe": z.strictObject({
    name: appResourceNameSchema,
    fileSize: z.number().int().nonnegative(),
    numTables: z.number().int().nonnegative(),
  }),
  "d1.delete": z.strictObject({ ok: z.literal(true) }),
  "kv.ensure": z.strictObject({ namespaceId: providerId, created: z.boolean() }),
  "kv.delete": z.strictObject({ ok: z.literal(true) }),
  "r2.ensure": z.strictObject({ bucketName: appResourceNameSchema, created: z.boolean() }),
  "r2.purge": z.strictObject({ status: z.enum(["emptying", "deleted"]) }),
} as const satisfies Record<BrokerDataOp, z.ZodType>;
export type BrokerDataResponse<Op extends BrokerDataOp> = z.output<
  (typeof brokerDataResponseSchema)[Op]
>;

// ---- Errors, classified once by the broker -----------------------------------------------------

export const BROKER_ERRORS = [
  /** A non-app resource or name: a security event, never retried. */
  "refused",
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
  /** Safe to relay to an agent for script_rejected and sql_error; generic otherwise. */
  message: z.string().max(4000),
  retryAfterSeconds: z.number().int().positive().optional(),
});
export type BrokerError = z.output<typeof brokerErrorSchema>;

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
