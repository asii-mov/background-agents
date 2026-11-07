/**
 * The app-data contract shared by the control plane, the web settings UI, the deploy pipeline
 * (seam: AppDataBindings), the app broker and the sandbox conformance checker.
 *
 * Domain only. Cloudflare wire shapes never appear here: the broker protocol (../app-broker.ts)
 * is parsed at both ends, and the broker is the only code that knows api.cloudflare.com paths.
 * The checker cannot import TypeScript, so `npm run generate:app-data-contract -w
 * @open-inspect/shared` writes APP_DATA_CONTRACT into the sandbox runtime; `app-data.test.ts`
 * fails when that file is stale.
 */

import { z } from "zod";

// ---- Vocabulary -------------------------------------------------------------------------------

/**
 * What an app may declare and the platform provisions: one dedicated resource per binding. The
 * stack policy grades these through `manifest:<kind>` signals. `hyperdrive:<service>` is
 * reserved for approved external databases and is not admitted in v1.
 */
export const DATA_STORE_KINDS = ["d1", "kv", "r2"] as const;
export type DataStoreKind = (typeof DATA_STORE_KINDS)[number];

/**
 * Classification label on an app. There is no `public`: every app is behind Access, so
 * `internal` is the floor.
 */
export const DATA_CLASSIFICATIONS = ["internal", "confidential", "restricted"] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

/**
 * Deployment stage of an app's resources. Named `stage` because Open-Inspect "environments" are
 * sandbox environments. Keying resources and secrets by stage keeps previews from ever sharing
 * production data. v1 deploys production only.
 */
export const APP_STAGES = ["production", "preview"] as const;
export type AppStage = (typeof APP_STAGES)[number];

/** D1 Time Travel window the platform restores within. */
export const D1_POINT_IN_TIME_RECOVERY_DAYS = 30;

/**
 * Cloudflare's data jurisdictions for D1 and R2. The broker pins every create to the configured
 * one, and the control plane keeps confidential and restricted data out of KV when one is set.
 */
export const DATA_JURISDICTIONS = ["eu", "fedramp"] as const;
export type DataJurisdiction = (typeof DATA_JURISDICTIONS)[number];

// ---- Names ------------------------------------------------------------------------------------

/** A validated `env.<NAME>` key. Data bindings and secrets share this namespace. */
export type BindingName = string & { readonly __brand: "BindingName" };

export const BINDING_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

/** Bindings the broker sets on every app script. The control plane never sends these. */
export const APP_PLATFORM_BINDINGS = {
  assets: "ASSETS",
  teamDomain: "CF_ACCESS_TEAM_DOMAIN",
  aud: "CF_ACCESS_AUD",
  hostname: "APP_HOSTNAME",
  appName: "OI_APP_NAME",
} as const;
export const PLATFORM_BINDING_NAMES: readonly string[] = Object.values(APP_PLATFORM_BINDINGS);

/** Prefixes no app may claim, so platform additions never collide with app code. */
export const RESERVED_BINDING_PREFIXES = ["CF_", "CLOUDFLARE_", "OI_", "OPENINSPECT_"] as const;

/**
 * Secret names that would carry a database or Cloudflare credential around the platform. Data
 * reaches an app only through a declared binding.
 */
export const DENIED_SECRET_NAME_PATTERN =
  /(^|_)(DATABASE_URL|DB_URL|CONNECTION_STRING|API_TOKEN_CLOUDFLARE|CLOUDFLARE_API_TOKEN)$/;

/** `0001_create-notes.sql`; ordering is lexical, so the numeric prefix is the order. */
export const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9-]+\.sql$/;

/** Where a D1 declaration's migration files live when the manifest names no directory. */
export const DEFAULT_MIGRATIONS_DIR = "migrations";

export const APP_DATA_LIMITS = {
  maxBindings: 8,
  maxSecrets: 16,
  maxMigrationFiles: 200,
  maxMigrationBytes: 256 * 1024,
  maxManifestBytes: 16 * 1024,
  maxSecretValueBytes: 8 * 1024,
} as const;

export const APP_DATA_MANIFEST_FILE = "openinspect.app.json";

function bindingNameRejection(raw: string): string | null {
  if (!BINDING_NAME_PATTERN.test(raw)) {
    return `${JSON.stringify(raw)} is not a binding name: use UPPER_SNAKE_CASE, at most 32 characters, starting with a letter`;
  }
  if (PLATFORM_BINDING_NAMES.includes(raw)) {
    return `${raw} is set by the platform on every app`;
  }
  const prefix = RESERVED_BINDING_PREFIXES.find((reserved) => raw.startsWith(reserved));
  return prefix ? `Binding names starting with ${prefix} are reserved for the platform` : null;
}

/** Pure. Reserved prefixes and platform names are rejected, never repaired. */
export function parseBindingName(raw: string): BindingName | null {
  return bindingNameRejection(raw) === null ? (raw as BindingName) : null;
}

/** The binding-name grammar as a schema, for every request and manifest that names a binding. */
export const bindingNameSchema = z.string().transform((raw, ctx): BindingName => {
  const rejection = bindingNameRejection(raw);
  if (rejection) {
    ctx.addIssue({ code: "custom", message: rejection });
    return z.NEVER;
  }
  return raw as BindingName;
});

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ---- Manifest (what the agent writes) ---------------------------------------------------------

const relativeDirSchema = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      path.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
    "must be a relative path inside the project"
  );

export const EXTERNAL_DATA_STORE_REJECTION =
  "External databases are not enabled on this platform; tell the user";

export const appDataDeclarationSchema = z.discriminatedUnion("kind", [
  /** A dedicated SQLite database. Schema lives in `<migrations>/*.sql`, applied by the platform. */
  z.strictObject({
    kind: z.literal("d1"),
    migrations: relativeDirSchema.default(DEFAULT_MIGRATIONS_DIR),
  }),
  /** A dedicated key-value namespace, for caches and small ephemeral state rather than records. */
  z.strictObject({ kind: z.literal("kv") }),
  /** A dedicated private bucket for files. Never public; served only through the app. */
  z.strictObject({ kind: z.literal("r2") }),
  z.looseObject({ kind: z.literal("external") }).transform((declaration, ctx) => {
    ctx.addIssue({ code: "custom", message: EXTERNAL_DATA_STORE_REJECTION, input: declaration });
    return z.NEVER;
  }),
]);
export type AppDataDeclaration = z.output<typeof appDataDeclarationSchema>;

/**
 * `openinspect.app.json`. Keys of `data` are binding names, so uniqueness is by construction.
 * The manifest names needs, never resource ids or values: a repository that passes this schema
 * cannot carry a credential.
 */
export const appDataManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** Opaque here; the deploy pipeline parses it with `parseAppName`. */
    name: z.string().min(1),
    classification: z.enum(DATA_CLASSIFICATIONS).default("internal"),
    data: z.record(bindingNameSchema, appDataDeclarationSchema).default({}),
    /** Names only. Values are set by a human on the app's page; the agent never sees them. */
    secrets: z.array(bindingNameSchema).max(APP_DATA_LIMITS.maxSecrets).default([]),
  })
  .superRefine((manifest, ctx) => {
    if (Object.keys(manifest.data).length > APP_DATA_LIMITS.maxBindings) {
      ctx.addIssue({
        code: "custom",
        path: ["data"],
        message: `An app declares at most ${APP_DATA_LIMITS.maxBindings} data bindings`,
      });
    }
    const seen = new Set<string>();
    manifest.secrets.forEach((name, index) => {
      const path = ["secrets", index];
      if (seen.has(name)) {
        ctx.addIssue({ code: "custom", path, message: `Secret ${name} is declared twice` });
      }
      seen.add(name);
      if (Object.hasOwn(manifest.data, name)) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `${name} is both a data binding and a secret`,
        });
      }
      if (DENIED_SECRET_NAME_PATTERN.test(name)) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `${name} would carry a credential; declare the data store under "data" instead`,
        });
      }
    });
  });
export type AppDataManifest = z.output<typeof appDataManifestSchema>;

/** One migration file as declared in the bundle. `sha256` is computed by the control plane. */
export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

// ---- Seam: what the deploy pipeline consumes --------------------------------------------------

/**
 * A secret value in flight to a Worker `secret_text` binding. Serializes and prints as
 * "[redacted]" so a stray `JSON.stringify` or log of a binding cannot leak it; only the publish
 * step calls `reveal()`.
 */
export class SecretText {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[redacted]";
  }

  toString(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

/** Resolved bindings for one (app, stage). The deploy pipeline maps these to broker bindings. */
export type AppDataBinding =
  | { kind: "d1"; name: BindingName; databaseId: string }
  | { kind: "kv"; name: BindingName; namespaceId: string }
  | { kind: "r2"; name: BindingName; bucketName: string }
  | { kind: "secret"; name: BindingName; value: SecretText };

export interface AppDataBindings {
  readonly appName: string;
  readonly stage: AppStage;
  readonly classification: DataClassification;
  /** Sorted by name. Only these may be bound; the broker adds APP_PLATFORM_BINDINGS. */
  readonly bindings: readonly AppDataBinding[];
  /** sha256 over binding refs, secret names (not values) and applied migration hashes. */
  readonly dataDigest: string;
}

/** A tracked preference the agent did not follow. Surfaced to the agent and the inventory; never blocks. */
export interface DataAdvisory {
  code: "preferred_store_not_used" | "classification_overridden_by_admin" | "kv_holds_records_hint";
  message: string;
}

// ---- Outcomes the agent must act on (merged into the deploy failure envelope) -----------------

export const APP_DATA_BLOCK_REASONS = [
  "data_policy_denied",
  "data_manifest_invalid",
  "binding_kind_changed",
  "secret_missing",
  "destructive_migration_requires_approval",
  "migration_file_changed",
  "migration_file_missing",
  "migration_out_of_order",
  "migration_forbidden_statement",
  "migration_failed",
  "data_unavailable",
] as const;
export type AppDataBlockReason = (typeof APP_DATA_BLOCK_REASONS)[number];

export const APP_DATA_BLOCK_STATUS = {
  data_policy_denied: 403,
  data_manifest_invalid: 400,
  binding_kind_changed: 409,
  secret_missing: 424,
  destructive_migration_requires_approval: 423,
  migration_file_changed: 409,
  migration_file_missing: 409,
  migration_out_of_order: 409,
  migration_forbidden_statement: 422,
  migration_failed: 422,
  data_unavailable: 502,
} as const satisfies Record<AppDataBlockReason, number>;

/** Rendered by the deploy tool. Exhaustive, so a new reason cannot ship without guidance. */
export const APP_DATA_BLOCK_GUIDANCE = {
  data_policy_denied:
    "This data store is not allowed for this repository. Use the stores named in the organization standards (D1 for records, KV for caches, R2 for files) and tell the user in one sentence.",
  data_manifest_invalid:
    "Fix openinspect.app.json as described in the message. Binding names are UPPER_SNAKE_CASE; secrets are names only.",
  binding_kind_changed:
    "A binding name cannot change kind because the old data would be lost. Use a new binding name; the old one is retained for 30 days.",
  secret_missing:
    "The app needs a secret value a human must enter. Tell the user exactly which name to set on the app's page (Settings > Apps > this app > Secrets), then deploy again. Never ask the user to paste the value into the chat.",
  destructive_migration_requires_approval:
    "A migration would drop or rewrite production data. A backup point was recorded. Tell the user to review and approve it on the app's page (Schema changes), then deploy again. Do not work around it with a new table or a rename.",
  migration_file_changed:
    "An already-applied migration file was edited. Restore its original contents and add a new numbered migration file for the change.",
  migration_file_missing:
    "An applied migration file was removed. Restore it: applied migrations must stay in the repository.",
  migration_out_of_order:
    "New migration files must have a number higher than every applied migration. Rename the file.",
  migration_forbidden_statement:
    "Migrations may contain DDL and data statements only: no PRAGMA (except foreign_keys/defer_foreign_keys), ATTACH, DETACH or VACUUM.",
  migration_failed:
    "D1 rejected the migration. Read the message, fix the SQL in that file (it was never applied), and deploy again.",
  data_unavailable:
    "Data provisioning did not complete. Wait briefly and deploy again; every step is safe to repeat.",
} as const satisfies Record<AppDataBlockReason, string>;

// ---- Identity contract (guard sets, app reads, conformance checks) ----------------------------

/**
 * The platform guard verifies the Access JWT, strips inbound copies of these headers, and sets
 * them before calling the app. Apps key ownership by `sub`.
 */
export const ACCESS_IDENTITY_HEADERS = {
  sub: "x-openinspect-user-sub",
  email: "x-openinspect-user-email",
} as const;

/** Unsigned or Access-injected headers an app must never read as identity. */
export const FORBIDDEN_IDENTITY_HEADERS = [
  "cf-access-authenticated-user-email",
  "x-forwarded-email",
  "x-forwarded-user",
  "x-auth-user",
] as const;

/** String-literal URL schemes that mean a raw database connection in app code. */
export const FORBIDDEN_CONNECTION_SCHEMES = [
  "postgres",
  "postgresql",
  "mysql",
  "mongodb",
  "mongodb+srv",
  "redis",
  "rediss",
] as const;

// ---- Inventory and admin views (web BFF reads these) ------------------------------------------

export type ResourceStatus = "provisioning" | "ready" | "retired" | "purging" | "purged";

export interface AppDataResourceView {
  id: string;
  stage: AppStage;
  binding: BindingName;
  kind: DataStoreKind;
  status: ResourceStatus;
  /** Cloudflare-side name (`app-...`), so operators can correlate in the apps account. */
  providerName: string;
  /** D1 only, from the last describe. */
  sizeBytes: number | null;
  retiredAt: number | null;
  purgeAfter: number | null;
  createdAt: number;
}

/**
 * `applying` is written, with the bookmark, before a file is sent to D1, so a lost response is
 * recognized and finished on the next deploy instead of running the file twice.
 */
export type MigrationStatus = "blocked" | "approved" | "applying" | "applied" | "failed";

export interface AppDataMigrationView {
  binding: BindingName;
  name: string;
  sha256: string;
  status: MigrationStatus;
  classification: "additive" | "destructive";
  /** Destructive statements, for the approver. Never row data. */
  statements: readonly string[];
  appliedAt: number | null;
  approvedBy: string | null;
  error: string | null;
}

export type DataOperationKind =
  | "provision"
  | "reinstate"
  | "retire"
  | "purge"
  | "migrate"
  | "approve_migration"
  | "secret_set"
  | "secret_delete"
  | "restore"
  | "classify"
  | "policy_block";

export interface AppDataOperationView {
  id: string;
  kind: DataOperationKind;
  result: "applied" | "blocked" | "failed" | "running";
  stage: AppStage | null;
  binding: BindingName | null;
  actor:
    | { kind: "session"; sessionId: string; userId: string | null }
    | { kind: "user"; userId: string }
    | { kind: "system"; job: string };
  /** Structured, secret-free detail (migration name, reason code). */
  detail: Record<string, unknown>;
  occurredAt: number;
}

export interface AppDataSummary {
  appName: string;
  classification: DataClassification;
  classificationSource: "manifest" | "admin";
  resources: readonly AppDataResourceView[];
  migrations: readonly AppDataMigrationView[];
  /** Names and set/unset per stage. Values are write-only. */
  secrets: ReadonlyArray<{ name: BindingName; stage: AppStage; updatedAt: number }>;
  declaredSecrets: readonly BindingName[];
  pendingApprovals: number;
  pointInTimeRecoveryDays: typeof D1_POINT_IN_TIME_RECOVERY_DAYS;
}

export interface AppDataInventoryRow {
  appName: string;
  ownerUserId: string;
  classification: DataClassification;
  stage: AppStage;
  binding: BindingName;
  kind: DataStoreKind;
  status: ResourceStatus;
  sizeBytes: number | null;
  purgeAfter: number | null;
  lastMigrationAt: number | null;
}

// ---- Requests ---------------------------------------------------------------------------------

/** A D1 restore point: a recorded bookmark or a moment inside the Time Travel window. */
export const d1RestoreTargetSchema = z.union([
  z.strictObject({ bookmark: z.string().min(1).max(256) }),
  z.strictObject({ timestamp: z.number().int().positive() }),
]);
export type D1RestoreTarget = z.output<typeof d1RestoreTargetSchema>;

export const setAppSecretsRequestSchema = z
  .strictObject({
    stage: z.enum(APP_STAGES),
    secrets: z.record(
      bindingNameSchema,
      z
        .string()
        .min(1)
        .refine(
          (value) => utf8Length(value) <= APP_DATA_LIMITS.maxSecretValueBytes,
          `Secret values are at most ${APP_DATA_LIMITS.maxSecretValueBytes} bytes`
        )
    ),
  })
  .refine((request) => Object.keys(request.secrets).length > 0, "Set at least one secret");

export const approveMigrationRequestSchema = z.strictObject({
  stage: z.enum(APP_STAGES),
  binding: bindingNameSchema,
  name: z.string().regex(MIGRATION_FILE_PATTERN),
  /** The approver approves these exact bytes; a later edit re-blocks. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const restoreRequestSchema = z.strictObject({
  stage: z.enum(APP_STAGES),
  binding: bindingNameSchema,
  target: d1RestoreTargetSchema,
  /** The UI makes the human type the binding name; the server checks it matches. */
  confirmBinding: bindingNameSchema,
});

export const setClassificationRequestSchema = z.strictObject({
  classification: z.enum(DATA_CLASSIFICATIONS),
});

// ---- Generated sandbox contract (conformance checker and local dev tool read this JSON) -------

export const APP_DATA_CONTRACT = {
  manifestFile: APP_DATA_MANIFEST_FILE,
  dataStoreKinds: DATA_STORE_KINDS,
  bindingNamePattern: BINDING_NAME_PATTERN.source,
  platformBindingNames: PLATFORM_BINDING_NAMES,
  reservedBindingPrefixes: RESERVED_BINDING_PREFIXES,
  deniedSecretNamePattern: DENIED_SECRET_NAME_PATTERN.source,
  migrationFilePattern: MIGRATION_FILE_PATTERN.source,
  identityHeaders: ACCESS_IDENTITY_HEADERS,
  forbiddenIdentityHeaders: FORBIDDEN_IDENTITY_HEADERS,
  forbiddenConnectionSchemes: FORBIDDEN_CONNECTION_SCHEMES,
  /** Hand-written Worker config is denied: the manifest is the single source and the dev tool derives local config. */
  deniedConfigFiles: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"],
  limits: APP_DATA_LIMITS,
} as const;

/** Repo-relative output path for {@link formatAppDataContractFile}. */
export const APP_DATA_CONTRACT_FILE =
  "packages/sandbox-runtime/src/sandbox_runtime/conformance/app_data_contract.json";

export function formatAppDataContractFile(): string {
  const header =
    "Generated from packages/shared/src/types/app-data.ts by `npm run generate:app-data-contract -w @open-inspect/shared`. Do not edit.";
  return `${JSON.stringify({ $comment: header, ...APP_DATA_CONTRACT }, null, 2)}\n`;
}
