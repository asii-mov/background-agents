/**
 * What app data means, with no I/O: a declaration under the organization's policy, the name of
 * each resource, how long a retired resource is kept, what a migration file does to existing data,
 * and the text the agent is given. The service and store build on this module; it imports neither.
 */

import type { AppName } from "@open-inspect/shared/apps";
import {
  APP_RESOURCE_NAME_PATTERN,
  APP_RESOURCE_PREFIX,
  type AppResourceName,
} from "@open-inspect/shared/app-broker";
import { sha256Hex } from "@open-inspect/shared/service-auth";
import {
  ACCESS_IDENTITY_HEADERS,
  APP_DATA_MANIFEST_FILE,
  D1_POINT_IN_TIME_RECOVERY_DAYS,
  DATA_JURISDICTIONS,
  DATA_STORE_KINDS,
  DEFAULT_MIGRATIONS_DIR,
  FORBIDDEN_IDENTITY_HEADERS,
  type AppDataBinding,
  type AppDataManifest,
  type AppStage,
  type BindingName,
  type DataAdvisory,
  type DataClassification,
  type DataJurisdiction,
  type DataStoreKind,
  type MigrationFile,
  type MigrationStatus,
} from "@open-inspect/shared/types/app-data";
import type { RepositoryPair } from "@open-inspect/shared/types/repositories";
import type { DataStorePolicy } from "@open-inspect/shared/types/stack-policy";

// ---- Policy -----------------------------------------------------------------------------------

/** The data-store slice of the stack policy for one repository and environment. */
export interface DataPolicyLookup {
  resolveForApp(
    repository: RepositoryPair | null,
    environmentId: string | null
  ): Promise<DataStorePolicy>;
}

export interface AppDataConfig {
  /** Mirrors the broker's APP_DATA_JURISDICTION; null when data is not pinned to one. */
  readonly jurisdiction: DataJurisdiction | null;
}

/** Null when APP_DATA_JURISDICTION is set to something Cloudflare does not offer. */
export function parseAppDataConfig(env: { APP_DATA_JURISDICTION?: string }): AppDataConfig | null {
  const raw = env.APP_DATA_JURISDICTION?.trim() ?? "";
  if (raw === "") return { jurisdiction: null };
  const jurisdiction = DATA_JURISDICTIONS.find((candidate) => candidate === raw);
  return jurisdiction ? { jurisdiction } : null;
}

export type DataDenial =
  | { code: "kind_denied"; binding: BindingName; kind: DataStoreKind }
  /** KV replicates globally, so with a jurisdiction pinned it may hold only internal data. */
  | { code: "kv_not_jurisdiction_bound"; binding: BindingName };

export interface PolicyEvaluation {
  readonly denials: readonly DataDenial[];
  readonly advisories: readonly DataAdvisory[];
}

/** Pure. Denials and advisories come out in binding-name order. */
export function evaluateDataPolicy(
  manifest: AppDataManifest,
  policy: DataStorePolicy,
  classification: DataClassification,
  config: AppDataConfig
): PolicyEvaluation {
  const declarations = Object.entries(manifest.data).sort(([a], [b]) => compareText(a, b));
  const denials: DataDenial[] = [];
  for (const [name, declaration] of declarations) {
    const binding = name as BindingName;
    if (policy.stances[declaration.kind] === "denied") {
      denials.push({ code: "kind_denied", binding, kind: declaration.kind });
    } else if (
      declaration.kind === "kv" &&
      config.jurisdiction !== null &&
      classification !== "internal"
    ) {
      denials.push({ code: "kv_not_jurisdiction_bound", binding });
    }
  }
  const kinds = new Set(declarations.map(([, declaration]) => declaration.kind));
  const advisories: DataAdvisory[] =
    kinds.has("kv") && !kinds.has("d1") && policy.stances.d1 === "preferred"
      ? [
          {
            code: "kv_holds_records_hint",
            message:
              "KV is for caches and small ephemeral state. If the app keeps records, declare a D1 database for them.",
          },
        ]
      : [];
  return { denials, advisories };
}

export function describeDenial(denial: DataDenial): string {
  switch (denial.code) {
    case "kind_denied":
      return `${denial.binding} declares ${denial.kind}, which your organization does not allow.`;
    case "kv_not_jurisdiction_bound":
      return `${denial.binding} declares kv, which cannot hold confidential or restricted data in this jurisdiction; use d1.`;
  }
}

// ---- Names ------------------------------------------------------------------------------------

const STAGE_LABEL = { production: "prod", preview: "prev" } as const satisfies Record<
  AppStage,
  string
>;
const MAX_RESOURCE_NAME_LENGTH = 63;
const NAME_HASH_LENGTH = 8;

/**
 * `app-<app>--<prod|prev>-<binding>`, the adoption key that makes create-or-adopt safe after a
 * crash between "row inserted" and "resource created". App names never contain `--`, so the
 * separator keeps names of different apps apart. A name that would be too long, or would end in a
 * hyphen, keeps its readable head and ends with 8 hex characters of sha256(full name).
 */
export async function mintResourceName(
  app: AppName,
  stage: AppStage,
  binding: BindingName
): Promise<AppResourceName> {
  const full = `${APP_RESOURCE_PREFIX}${app}--${STAGE_LABEL[stage]}-${binding.toLowerCase().replaceAll("_", "-")}`;
  if (APP_RESOURCE_NAME_PATTERN.test(full)) return full as AppResourceName;
  const head = full.slice(0, MAX_RESOURCE_NAME_LENGTH - NAME_HASH_LENGTH - 1).replace(/-+$/, "");
  const hash = (await sha256Hex(full)).slice(0, NAME_HASH_LENGTH);
  return `${head}-${hash}` as AppResourceName;
}

// ---- Retention --------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** How long a retired resource stays intact, unbound and reinstatable before the purge sweep. */
export const APP_DATA_RETENTION_MS = {
  production: 30 * DAY_MS,
  preview: 7 * DAY_MS,
} as const satisfies Record<AppStage, number>;

export const D1_POINT_IN_TIME_RECOVERY_MS = D1_POINT_IN_TIME_RECOVERY_DAYS * DAY_MS;

/** Restricted data is restored only by someone who manages every app. */
export function restoreRequiresScope(classification: DataClassification): "own" | "any" {
  return classification === "restricted" ? "any" : "own";
}

// ---- Migrations -------------------------------------------------------------------------------

type SqlToken =
  | { kind: "word"; value: string }
  | { kind: "name"; value: string }
  | { kind: "string" }
  | { kind: "symbol"; value: string };

interface SqlStatement {
  /** The statement as written, for the approver. */
  text: string;
  tokens: readonly SqlToken[];
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] !== quote) return index + 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return sql.length;
}

function isTriggerHead(tokens: readonly SqlToken[]): boolean {
  const words = tokens.flatMap((token) => (token.kind === "word" ? [token.value] : []));
  const object = words[1] === "TEMP" || words[1] === "TEMPORARY" ? words[2] : words[1];
  return words[0] === "CREATE" && object === "TRIGGER";
}

/**
 * Splits on `;` outside strings, quoted names, comments and trigger bodies (`BEGIN ... END`,
 * counting `CASE ... END` inside). Enough of SQLite's grammar to find each statement's head; it
 * never evaluates anything.
 */
function scanSql(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let tokens: SqlToken[] = [];
  let start = 0;
  let inTriggerBody = false;
  let caseDepth = 0;
  const finish = (end: number) => {
    if (tokens.length > 0) statements.push({ text: sql.slice(start, end).trim(), tokens });
    tokens = [];
    inTriggerBody = false;
    caseDepth = 0;
  };
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
    } else if (char === "'") {
      index = skipQuoted(sql, index, char);
      tokens.push({ kind: "string" });
    } else if (char === '"' || char === "`") {
      const end = skipQuoted(sql, index, char);
      tokens.push({
        kind: "name",
        value: sql.slice(index + 1, end - 1).replaceAll(char + char, char),
      });
      index = end;
    } else if (char === "[") {
      const close = sql.indexOf("]", index + 1);
      const end = close === -1 ? sql.length : close + 1;
      tokens.push({ kind: "name", value: sql.slice(index + 1, end - 1) });
      index = end;
    } else if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end += 1;
      const word = sql.slice(index, end).toUpperCase();
      tokens.push({ kind: "word", value: word });
      if (word === "BEGIN" && !inTriggerBody && isTriggerHead(tokens)) inTriggerBody = true;
      else if (word === "CASE" && inTriggerBody) caseDepth += 1;
      else if (word === "END" && inTriggerBody) {
        if (caseDepth > 0) caseDepth -= 1;
        else inTriggerBody = false;
      }
      index = end;
    } else if (char === ";" && !inTriggerBody) {
      finish(index);
      start = index + 1;
      index += 1;
    } else {
      if (!/\s/.test(char)) tokens.push({ kind: "symbol", value: char });
      index += 1;
    }
  }
  finish(sql.length);
  return statements;
}

/** The statements of a migration file, as written. */
export function splitSqlStatements(sql: string): readonly string[] {
  return scanSql(sql).map((statement) => statement.text);
}

export type StatementClass =
  | {
      class: "additive";
      form:
        | "create_table"
        | "create_index"
        | "create_view"
        | "add_column"
        | "insert"
        | "select"
        | "foreign_keys_pragma";
    }
  | {
      class: "destructive";
      form:
        | "drop_table"
        | "drop_index"
        | "drop_view"
        | "drop_trigger"
        | "create_trigger"
        | "drop_column"
        | "rename_table"
        | "rename_column"
        | "update_rows"
        | "delete_rows"
        | "replace_rows"
        | "unrecognized";
    }
  | {
      class: "forbidden";
      form: "pragma" | "attach" | "detach" | "vacuum" | "transaction_control" | "platform_table";
    };

/**
 * Where the platform records, inside each app database and in the same D1 batch as the file,
 * which files it applied. A lost response is then recognized on the next deploy instead of the
 * file running twice.
 */
export const MIGRATION_LEDGER_TABLE = "_openinspect_migrations";

const CREATE_FORMS = {
  TABLE: { class: "additive", form: "create_table" },
  INDEX: { class: "additive", form: "create_index" },
  VIEW: { class: "additive", form: "create_view" },
  TRIGGER: { class: "destructive", form: "create_trigger" },
} as const satisfies Record<string, StatementClass>;
const DROP_FORMS = {
  TABLE: "drop_table",
  INDEX: "drop_index",
  VIEW: "drop_view",
  TRIGGER: "drop_trigger",
} as const;
const CREATE_MODIFIERS = new Set(["TEMP", "TEMPORARY", "UNIQUE", "VIRTUAL"]);
const ALLOWED_PRAGMAS = new Set(["FOREIGN_KEYS", "DEFER_FOREIGN_KEYS"]);
const TRANSACTION_CONTROL = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]);

function lookup<T>(table: Record<string, T>, key: string | null): T | null {
  return key !== null && Object.hasOwn(table, key) ? table[key]! : null;
}

/**
 * Head-keyword classification, conservative by construction: anything that is not a known
 * additive form needs approval in production. `PRAGMA foreign_keys` and `defer_foreign_keys` are
 * additive because D1 migrations legitimately use them; every other PRAGMA, ATTACH, DETACH,
 * VACUUM and transaction control is forbidden, since the broker runs each file as one batch. A
 * trigger is destructive whatever its body: it runs later, on every matching write, and even an
 * INSERT in it can replace rows or fire other triggers.
 */
function classifyTokens(tokens: readonly SqlToken[]): StatementClass {
  const word = (index: number) => {
    const token = tokens[index];
    return token?.kind === "word" ? token.value : null;
  };
  const destructive = (form: Extract<StatementClass, { class: "destructive" }>["form"]) =>
    ({ class: "destructive", form }) as const;
  if (
    tokens.some(
      (token) =>
        (token.kind === "word" || token.kind === "name") &&
        token.value.toLowerCase() === MIGRATION_LEDGER_TABLE
    )
  ) {
    return { class: "forbidden", form: "platform_table" };
  }
  const head = word(0);
  if (head !== null && TRANSACTION_CONTROL.has(head)) {
    return { class: "forbidden", form: "transaction_control" };
  }
  switch (head) {
    case "CREATE": {
      let index = 1;
      while (CREATE_MODIFIERS.has(word(index) ?? "")) index += 1;
      return lookup(CREATE_FORMS, word(index)) ?? destructive("unrecognized");
    }
    case "DROP": {
      const form = lookup(DROP_FORMS, word(1));
      return form ? destructive(form) : destructive("unrecognized");
    }
    case "ALTER": {
      if (word(1) !== "TABLE") return destructive("unrecognized");
      let index = 3;
      if (tokens[index]?.kind === "symbol" && (tokens[index] as { value: string }).value === ".") {
        index += 2;
      }
      const action = word(index);
      if (action === "ADD") return { class: "additive", form: "add_column" };
      if (action === "DROP") return destructive("drop_column");
      if (action === "RENAME") {
        return destructive(word(index + 1) === "TO" ? "rename_table" : "rename_column");
      }
      return destructive("unrecognized");
    }
    case "INSERT": {
      const upsertsRows = tokens.some(
        (token, index) =>
          token.kind === "word" && token.value === "DO" && word(index + 1) === "UPDATE"
      );
      if ((word(1) === "OR" && word(2) === "REPLACE") || upsertsRows) {
        return destructive("replace_rows");
      }
      return { class: "additive", form: "insert" };
    }
    case "REPLACE":
      return destructive("replace_rows");
    case "UPDATE":
      return destructive("update_rows");
    case "DELETE":
      return destructive("delete_rows");
    case "SELECT":
      return { class: "additive", form: "select" };
    case "PRAGMA": {
      const words: string[] = [];
      for (const token of tokens.slice(1)) {
        if (token.kind === "symbol" && (token.value === "=" || token.value === "(")) break;
        if (token.kind === "word") words.push(token.value);
      }
      return ALLOWED_PRAGMAS.has(words.at(-1) ?? "")
        ? { class: "additive", form: "foreign_keys_pragma" }
        : { class: "forbidden", form: "pragma" };
    }
    case "ATTACH":
      return { class: "forbidden", form: "attach" };
    case "DETACH":
      return { class: "forbidden", form: "detach" };
    case "VACUUM":
      return { class: "forbidden", form: "vacuum" };
    default:
      return destructive("unrecognized");
  }
}

export function classifyStatement(statement: string): StatementClass {
  const [scanned] = scanSql(statement);
  return scanned ? classifyTokens(scanned.tokens) : { class: "additive", form: "select" };
}

export type MigrationClass =
  | { class: "additive" }
  | { class: "destructive"; statements: readonly string[] }
  | { class: "forbidden"; statements: readonly string[] };

/** Forbidden wins over destructive; the statements listed are the ones that decided it. */
export function classifyMigration(file: Pick<MigrationFile, "sql">): MigrationClass {
  const classified = scanSql(file.sql).map((statement) => ({
    text: statement.text,
    verdict: classifyTokens(statement.tokens),
  }));
  for (const decisive of ["forbidden", "destructive"] as const) {
    const statements = classified
      .filter((entry) => entry.verdict.class === decisive)
      .map((entry) => entry.text);
    if (statements.length > 0) return { class: decisive, statements };
  }
  return { class: "additive" };
}

/**
 * The one body the broker sends to D1 for a file: the ledger row first, then the file. D1 runs a
 * body as one transaction, so the row exists exactly when the file applied. Names and hashes are
 * validated patterns (`0001_x.sql`, hex), so they are safe to inline.
 */
export function migrationBatchSql(file: MigrationFile): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (name TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (name, sha256));`,
    `INSERT INTO ${MIGRATION_LEDGER_TABLE} (name, sha256) VALUES ('${file.name}', '${file.sha256}');`,
    file.sql,
  ].join("\n");
}

/** D1's answer when these exact bytes already applied: the ledger row's primary key collided. */
export function isAlreadyAppliedError(message: string): boolean {
  return message.includes(`UNIQUE constraint failed: ${MIGRATION_LEDGER_TABLE}.`);
}

export interface MigrationRecord {
  readonly name: string;
  readonly sha256: string;
  readonly status: MigrationStatus;
}

export type MigrationPlan =
  | { ok: true; pending: readonly MigrationFile[] }
  | {
      ok: false;
      problem: "migration_file_changed" | "migration_file_missing" | "migration_out_of_order";
      name: string;
    };

/**
 * Pure. Every applied file must still be declared with the same bytes, and no file that has not
 * applied may sort before the last one that has. Blocked, approved, applying and failed records
 * are not applied: their files are pending again, compared against current bytes.
 */
export function planMigrations(
  declared: readonly MigrationFile[],
  records: readonly MigrationRecord[]
): MigrationPlan {
  const files = new Map(declared.map((file) => [file.name, file]));
  const applied = records
    .filter((record) => record.status === "applied")
    .sort((a, b) => compareText(a.name, b.name));
  for (const record of applied) {
    const file = files.get(record.name);
    if (!file) return { ok: false, problem: "migration_file_missing", name: record.name };
    if (file.sha256 !== record.sha256) {
      return { ok: false, problem: "migration_file_changed", name: record.name };
    }
  }
  const appliedNames = new Set(applied.map((record) => record.name));
  const pending = [...declared]
    .filter((file) => !appliedNames.has(file.name))
    .sort((a, b) => compareText(a.name, b.name));
  const lastApplied = applied.at(-1)?.name;
  const early = lastApplied ? pending.find((file) => file.name < lastApplied) : undefined;
  if (early) return { ok: false, problem: "migration_out_of_order", name: early.name };
  return { ok: true, pending };
}

// ---- Digest -----------------------------------------------------------------------------------

/** sha256 over binding references, secret names and applied migrations. Values never enter. */
export async function appDataDigest(
  bindings: readonly AppDataBinding[],
  appliedMigrations: readonly string[]
): Promise<string> {
  const references = bindings
    .map((binding) => {
      switch (binding.kind) {
        case "d1":
          return `d1:${binding.name}:${binding.databaseId}`;
        case "kv":
          return `kv:${binding.name}:${binding.namespaceId}`;
        case "r2":
          return `r2:${binding.name}:${binding.bucketName}`;
        case "secret":
          return `secret:${binding.name}`;
      }
    })
    .sort(compareText);
  return sha256Hex(
    JSON.stringify({ bindings: references, migrations: [...appliedMigrations].sort(compareText) })
  );
}

// ---- Always-on instructions -------------------------------------------------------------------

export const MAX_DATA_INSTRUCTION_BYTES = 3 * 1024;

const STORE_USES = {
  d1: `\`{"kind":"d1"}\`: records in SQLite. Schema changes are numbered files such as \`${DEFAULT_MIGRATIONS_DIR}/0001_create-notes.sql\`; never edit or delete a file after it has deployed. A change that drops or rewrites existing data waits until the user approves it on the app's page.`,
  kv: '`{"kind":"kv"}`: caches and small ephemeral state, never records.',
  r2: '`{"kind":"r2"}`: private files, served only through the app.',
} as const satisfies Record<DataStoreKind, string>;

/**
 * The data block of the operator instructions, rendered into the stack policy text whenever data
 * stores are governed, so a session has one governance text. Deterministic and bounded: it
 * depends only on which stores the policy allows.
 */
export function renderDataInstructions(policy: DataStorePolicy): string {
  const allowed = DATA_STORE_KINDS.filter((kind) => policy.stances[kind] !== "denied");
  const denied = DATA_STORE_KINDS.filter((kind) => policy.stances[kind] === "denied");
  const forbiddenHeaders = FORBIDDEN_IDENTITY_HEADERS.map((header) => `\`${header}\``);
  const lines = [
    "### Data for internal apps",
    `Declare what an app stores in \`${APP_DATA_MANIFEST_FILE}\` under \`data\`, keyed by an UPPER_SNAKE_CASE binding name; the platform provisions a dedicated resource and binds it as \`env.<NAME>\`. Never create, name or reference a database, bucket, namespace, connection string or Cloudflare credential, and never write a wrangler config.`,
    ...allowed.map((kind) => `- ${STORE_USES[kind]}`),
    ...(denied.length > 0 ? [`- Not available: ${denied.join(", ")}.`] : []),
    "- SQL goes only through `prepare(sql).bind(...)` with a constant SQL string. Never build SQL from strings or template literals.",
    `- The signed-in user is the \`${ACCESS_IDENTITY_HEADERS.sub}\` request header (email: \`${ACCESS_IDENTITY_HEADERS.email}\`), set by the platform after it verifies sign-in. Never read ${forbiddenHeaders.slice(0, -1).join(", ")} or ${forbiddenHeaders.at(-1)} as identity. Tables that hold a person's data have \`owner_sub TEXT NOT NULL\`, and every query on them filters by it.`,
    "- Secrets are names under `secrets` in the manifest; a person enters each value on the app's page. Never ask for a secret value in chat.",
    "- Set `classification` to `internal`, `confidential` or `restricted`, and store only what the feature needs.",
    "- To run the app locally with every binding, run `python -m sandbox_runtime.conformance app-dev --entry <worker file>` and follow its output.",
  ];
  return lines.join("\n");
}

/** Code-unit order, so output never depends on the runtime's locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
