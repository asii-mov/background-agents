/**
 * The app-deployment contract shared by the control plane, the web settings UI, the sandbox
 * `deploy-app` tool and the app broker.
 *
 * `npm run generate:app-deploy-contract -w @open-inspect/shared` writes APP_DEPLOY_CONTRACT into
 * the sandbox runtime as JSON (Python) and an ES module (OpenCode tool); `apps.test.ts` fails
 * when either is stale.
 */

import { z } from "zod";
import { SERVICE_REQUEST_MAX_BODY_BYTES } from "./service-auth";
import {
  ACCESS_IDENTITY_HEADERS,
  APP_DATA_BLOCK_GUIDANCE,
  APP_DATA_BLOCK_REASONS,
  APP_DATA_BLOCK_STATUS,
  APP_DATA_LIMITS,
  APP_DATA_MANIFEST_FILE,
  DEFAULT_MIGRATIONS_DIR,
  MIGRATION_FILE_PATTERN,
  bindingNameSchema,
  type DataAdvisory,
} from "./types/app-data";

// ---- Names ------------------------------------------------------------------------------------

/**
 * One validated lowercase DNS label. The hostname `<name>.<apps domain>`, the Worker script and
 * the Access application all derive from it, so nothing else names them.
 */
export type AppName = string & { readonly __brand: "AppName" };

export const APP_NAME_MAX_LENGTH = 40;
export const APP_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Platform labels and identity-looking labels. Security extends this by code review only. */
export const RESERVED_APP_NAMES = [
  "access",
  "admin",
  "api",
  "app",
  "apps",
  "assets",
  "auth",
  "cdn",
  "deployer",
  "dispatcher",
  "internal",
  "login",
  "logout",
  "mail",
  "oauth",
  "preview",
  "previews",
  "root",
  "signin",
  "sso",
  "static",
  "status",
  "www",
] as const;

export type AppNameRejection = {
  ok: false;
  reason: "invalid_name" | "reserved_name";
  message: string;
};

/**
 * Pure, and never repairs: uppercase, punycode (`xn--`) and any `--` are rejected rather than
 * rewritten, so the name a user sees is the name that is served.
 */
export function parseAppName(raw: string): { ok: true; name: AppName } | AppNameRejection {
  if (!APP_NAME_PATTERN.test(raw) || raw.includes("--")) {
    return {
      ok: false,
      reason: "invalid_name",
      message: `App names are 1-${APP_NAME_MAX_LENGTH} lowercase letters, digits and single hyphens, starting and ending with a letter or digit.`,
    };
  }
  if ((RESERVED_APP_NAMES as readonly string[]).includes(raw)) {
    return { ok: false, reason: "reserved_name", message: `"${raw}" is reserved by the platform.` };
  }
  return { ok: true, name: raw as AppName };
}

/** {@link parseAppName} as a schema, for request bodies that name an app. */
export const appNameSchema = z.string().transform((raw, ctx): AppName => {
  const parsed = parseAppName(raw);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.message });
    return z.NEVER;
  }
  return parsed.name;
});

// ---- Bundle wire format (sandbox -> control plane -> broker), multipart/form-data -------------

export const APP_BUNDLE_LIMITS = {
  /** The whole multipart body. The control plane -> broker hop is sig1-signed over the body. */
  maxRequestBytes: SERVICE_REQUEST_MAX_BODY_BYTES,
  maxAssetCount: 2_000,
  maxAssetBytes: SERVICE_REQUEST_MAX_BODY_BYTES,
  maxWorkerBytes: 3 * 1024 * 1024,
  maxAssetPathLength: 256,
  maxMigrationFiles: APP_DATA_LIMITS.maxMigrationFiles,
} as const;

/** Part names. Assets are `a<n>`, migrations `m<n>`; paths come from the manifest, never from filenames. */
export const APP_DEPLOY_PARTS = {
  manifest: "manifest",
  app: "app",
  worker: "worker",
  assetPrefix: "a",
  migrationPrefix: "m",
} as const;

export const appAssetEntrySchema = z.strictObject({
  path: z.string().min(2).max(APP_BUNDLE_LIMITS.maxAssetPathLength),
  part: z.string().regex(/^a\d{1,4}$/),
});

export const appDeployManifestSchema = z.strictObject({
  /** Required unless the `app` part (openinspect.app.json) names the app; both present must agree. */
  name: z.string().min(1).max(APP_NAME_MAX_LENGTH).optional(),
  assets: z.array(appAssetEntrySchema).max(APP_BUNDLE_LIMITS.maxAssetCount),
  worker: z.strictObject({ part: z.literal(APP_DEPLOY_PARTS.worker) }).nullable(),
  /** Present iff an `app` part is sent. */
  app: z.strictObject({ part: z.literal(APP_DEPLOY_PARTS.app) }).nullable(),
  /** Per D1 binding, its migration files (sorted by name) and their parts. */
  migrations: z
    .array(
      z.strictObject({
        binding: bindingNameSchema,
        name: z.string().regex(MIGRATION_FILE_PATTERN),
        part: z.string().regex(/^m\d{1,4}$/),
      })
    )
    .max(APP_BUNDLE_LIMITS.maxMigrationFiles),
});
export type AppDeployManifest = z.output<typeof appDeployManifestSchema>;

// ---- Outcomes ---------------------------------------------------------------------------------

/** The control plane's budget for one deploy request, the broker call included. */
export const APP_DEPLOY_DEADLINE_MS = 120_000;
/** The sandbox tool waits longer than the control plane, so the control plane's own deadline answers. */
const APP_DEPLOY_TOOL_TIMEOUT_MS = APP_DEPLOY_DEADLINE_MS + 30_000;

export const APP_DEPLOY_FAILURE_REASONS = [
  "feature_unavailable",
  "invalid_bundle",
  "bundle_too_large",
  "invalid_name",
  "reserved_name",
  "name_taken",
  "app_taken_down",
  "permission_denied",
  "hostname_conflict",
  "hosting_backend_changed",
  "hosting_rejected_script",
  "access_guard_failed",
  "hosting_unavailable",
  "deadline_exceeded",
  ...APP_DATA_BLOCK_REASONS,
] as const;
export type AppDeployFailureReason = (typeof APP_DEPLOY_FAILURE_REASONS)[number];

export const APP_DEPLOY_FAILURE_STATUS = {
  feature_unavailable: 503,
  invalid_bundle: 400,
  bundle_too_large: 413,
  invalid_name: 400,
  reserved_name: 400,
  name_taken: 409,
  app_taken_down: 403,
  permission_denied: 403,
  hostname_conflict: 409,
  hosting_backend_changed: 409,
  hosting_rejected_script: 422,
  access_guard_failed: 503,
  hosting_unavailable: 502,
  deadline_exceeded: 504,
  ...APP_DATA_BLOCK_STATUS,
} as const satisfies Record<AppDeployFailureReason, number>;

export const APP_DEPLOY_REASON_GUIDANCE = {
  feature_unavailable:
    "App hosting is not set up for this workspace. Tell the user; do not try other hosting.",
  invalid_bundle:
    "The build output could not be packaged. Fix the reported path or file and call deploy-app again.",
  bundle_too_large:
    "The build output is over 16 MiB. Remove source maps, media and unused files, then retry.",
  invalid_name:
    "Use a short lowercase name: letters, digits and single hyphens, starting and ending with a letter or digit.",
  reserved_name:
    "That name is reserved. Choose a more specific name and tell the user the new URL.",
  name_taken:
    "Another person already owns an app with this name. Choose a different name and tell the user.",
  app_taken_down:
    "An administrator took this app down. Do not redeploy under another name; tell the user to contact an administrator.",
  permission_denied:
    "The session owner is not allowed to deploy apps. Tell the user to ask an administrator.",
  hostname_conflict: "That web address is already used by something else. Choose a different name.",
  hosting_backend_changed:
    "The hosting platform changed since this app was deployed. Tell the user an administrator must migrate it.",
  hosting_rejected_script:
    "Cloudflare rejected the Worker code. Read the message, fix the Worker, rebuild, and deploy again.",
  access_guard_failed:
    "The sign-in protection for apps is misconfigured, so nothing was published. Tell the user to contact an administrator. Do not retry.",
  hosting_unavailable:
    "The deploy did not complete. Wait briefly and call deploy-app once more; every step is safe to repeat.",
  deadline_exceeded:
    "The deploy took too long. Call deploy-app once more; completed steps are reused.",
  ...APP_DATA_BLOCK_GUIDANCE,
} as const satisfies Record<AppDeployFailureReason, string>;

export interface AppDeploySuccess {
  ok: true;
  name: AppName;
  url: string;
  firstDeploy: boolean;
  version: number;
  hasWorker: boolean;
  assetCount: number;
  /** Binding names provisioned for the app (no ids, no values). */
  bindings: readonly string[];
  /** Tracked preferences the agent did not follow; never blocks. */
  advisories: readonly DataAdvisory[];
}

export interface AppDeployFailure {
  ok: false;
  reason: AppDeployFailureReason;
  message: string;
  retryAfterSeconds?: number;
  /** For data blocks: binding, migration name, missing secret names, destructive statements. */
  detail?: Record<string, unknown>;
}

// ---- Inventory (web) --------------------------------------------------------------------------

export type AppStatus = "pending" | "live" | "failed" | "taken_down";
export const HOSTING_BACKEND_KINDS = ["workers", "dispatch-namespace"] as const;
export type HostingBackendKind = (typeof HOSTING_BACKEND_KINDS)[number];
export type AppHoldKind = "owner_unpublished" | "admin_takedown";

export interface AppSummary {
  name: AppName;
  url: string;
  status: AppStatus;
  owner: { userId: string; displayName: string | null; teamId: string | null };
  backend: HostingBackendKind | null;
  hasWorker: boolean;
  assetCount: number;
  bundleBytes: number;
  version: number;
  lastDeployedAt: number | null;
  lastSessionId: string | null;
  lastRepo: { owner: string; name: string } | null;
  lastErrorReason: AppDeployFailureReason | null;
  takedown: {
    kind: AppHoldKind;
    at: number;
    byUserId: string;
    reason: string;
    cleanupComplete: boolean;
  } | null;
}

export interface AppDeploymentView {
  id: string;
  version: number;
  status: "pending" | "live" | "superseded" | "failed" | "taken_down";
  bundleSha256: string;
  hasWorker: boolean;
  requestedBy: { userId: string; sessionId: string | null };
  failureReason: AppDeployFailureReason | null;
  createdAt: number;
}

export const appTakedownRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

// ---- Tool contract (generated into the sandbox) -----------------------------------------------

/** What the tool tells the agent when it cannot reach the control plane or gets no usable answer. */
const APP_DEPLOY_BRIDGE_ERROR_GUIDANCE =
  "deploy-app could not reach the publishing service. Call deploy-app once more; if it fails again, tell the user that publishing is unavailable right now.";

export const APP_DEPLOY_CONTRACT = {
  tool: {
    name: "deploy-app",
    /** Below `/sessions/:id`. */
    path: "/apps",
    timeoutSeconds: APP_DEPLOY_TOOL_TIMEOUT_MS / 1000,
    description:
      "Publish a built web app at https://<name>.<company apps domain>. Every visitor signs in through " +
      "Cloudflare Access with company SSO; the platform configures that and verifies it in front of your code. " +
      `If the app stores data, declare it in ${APP_DATA_MANIFEST_FILE} (data, secrets) and put schema files in ` +
      `${DEFAULT_MIGRATIONS_DIR}/; the platform provisions and binds them. Build first, then pass the build output directory ` +
      "and, if the app has server code, one bundled ES-module Worker file. Calling again with the same name updates the app.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: `Directory containing ${APP_DATA_MANIFEST_FILE} (default: the repository root).`,
        },
        name: {
          type: "string",
          description: `Lowercase app name; first label of the URL. Optional when ${APP_DATA_MANIFEST_FILE} names the app.`,
        },
        assetsDir: {
          type: "string",
          description: "Directory of built static files (for example dist).",
        },
        workerFile: {
          type: "string",
          description: `Optional bundled ES-module Worker. It receives env.ASSETS, your declared bindings and secrets, and the signed-in user's identity in the ${ACCESS_IDENTITY_HEADERS.sub} header.`,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  appManifestFile: APP_DATA_MANIFEST_FILE,
  /** A D1 declaration without `migrations` reads its files from here. */
  defaultMigrationsDir: DEFAULT_MIGRATIONS_DIR,
  migrationFilePattern: MIGRATION_FILE_PATTERN.source,
  parts: APP_DEPLOY_PARTS,
  limits: APP_BUNDLE_LIMITS,
  reasons: APP_DEPLOY_REASON_GUIDANCE,
  /** The tool's own `bridge_error`: no usable answer from the control plane. */
  bridgeErrorGuidance: APP_DEPLOY_BRIDGE_ERROR_GUIDANCE,
  /** The reason to assume when a response carries none. */
  statusFallback: {
    400: "invalid_bundle",
    403: "permission_denied",
    409: "name_taken",
    413: "bundle_too_large",
    422: "hosting_rejected_script",
    423: "destructive_migration_requires_approval",
    424: "secret_missing",
    502: "hosting_unavailable",
    503: "feature_unavailable",
    504: "deadline_exceeded",
  } satisfies Record<number, AppDeployFailureReason>,
} as const;

const APP_DEPLOY_CONTRACT_HEADER =
  "Generated from packages/shared/src/apps.ts by `npm run generate:app-deploy-contract -w @open-inspect/shared`. Do not edit.";

/** Repo-relative output paths for {@link formatAppDeployContractFiles}. */
export const APP_DEPLOY_CONTRACT_FILES = {
  json: "packages/sandbox-runtime/src/sandbox_runtime/app_deploy_contract.json",
  module: "packages/sandbox-runtime/src/sandbox_runtime/tools/_app-deploy-contract.js",
} as const;

export function formatAppDeployContractFiles(): Record<
  keyof typeof APP_DEPLOY_CONTRACT_FILES,
  string
> {
  const json = JSON.stringify(APP_DEPLOY_CONTRACT, null, 2);
  return {
    json: `${JSON.stringify({ $comment: APP_DEPLOY_CONTRACT_HEADER, ...APP_DEPLOY_CONTRACT }, null, 2)}\n`,
    module: `// ${APP_DEPLOY_CONTRACT_HEADER}\nexport const APP_DEPLOY_CONTRACT = ${json};\n`,
  };
}
