import type { AppName } from "@open-inspect/shared/apps";
import { APP_RESOURCE_NAME_PATTERN } from "@open-inspect/shared/app-broker";
import {
  appDataManifestSchema,
  type BindingName,
  type DataClassification,
  type MigrationFile,
} from "@open-inspect/shared/types/app-data";
import type { DataStorePolicy, Stance } from "@open-inspect/shared/types/stack-policy";
import { describe, expect, it } from "vitest";
import {
  MAX_DATA_INSTRUCTION_BYTES,
  MIGRATION_LEDGER_TABLE,
  classifyMigration,
  classifyStatement,
  evaluateDataPolicy,
  isAlreadyAppliedError,
  migrationBatchSql,
  mintResourceName,
  parseAppDataConfig,
  planMigrations,
  renderDataInstructions,
  splitSqlStatements,
  type MigrationRecord,
} from "./model";

const SEED_POLICY: DataStorePolicy = {
  stances: { d1: "preferred", kv: "allowed", r2: "allowed" },
  guidance: {},
};

function manifest(data: Record<string, unknown>, classification: DataClassification = "internal") {
  return appDataManifestSchema.parse({ schemaVersion: 1, name: "notes", classification, data });
}

function file(name: string, sql: string, sha256 = name.slice(0, 4).repeat(16)): MigrationFile {
  return { name, sql, sha256 };
}

describe("evaluateDataPolicy", () => {
  const kinds = ["d1", "kv", "r2"] as const;
  const stances: Stance[] = ["preferred", "allowed", "denied"];
  const classifications: DataClassification[] = ["internal", "confidential", "restricted"];

  it.each(
    kinds.flatMap((kind) =>
      stances.flatMap((stance) =>
        classifications.flatMap((classification) =>
          [null, "eu" as const].map((jurisdiction) => ({
            kind,
            stance,
            classification,
            jurisdiction,
          }))
        )
      )
    )
  )(
    "$kind $stance, $classification, jurisdiction $jurisdiction",
    ({ kind, stance, classification, jurisdiction }) => {
      const policy = { ...SEED_POLICY, stances: { ...SEED_POLICY.stances, [kind]: stance } };
      const { denials } = evaluateDataPolicy(
        manifest({ STORE: { kind } }, classification),
        policy,
        classification,
        { jurisdiction }
      );
      const expected =
        stance === "denied"
          ? "kind_denied"
          : kind === "kv" && jurisdiction !== null && classification !== "internal"
            ? "kv_not_jurisdiction_bound"
            : null;
      expect(denials.map((denial) => denial.code)).toEqual(expected ? [expected] : []);
    }
  );

  it("reports denials in binding order", () => {
    const { denials } = evaluateDataPolicy(
      manifest({ ZED: { kind: "r2" }, ALPHA: { kind: "r2" } }),
      { ...SEED_POLICY, stances: { ...SEED_POLICY.stances, r2: "denied" } },
      "internal",
      { jurisdiction: null }
    );
    expect(denials.map((denial) => denial.binding)).toEqual(["ALPHA", "ZED"]);
  });

  it("hints that records belong in D1 when an app keeps only KV", () => {
    const evaluate = (data: Record<string, unknown>) =>
      evaluateDataPolicy(manifest(data), SEED_POLICY, "internal", { jurisdiction: null })
        .advisories;
    expect(evaluate({ CACHE: { kind: "kv" } }).map((advisory) => advisory.code)).toEqual([
      "kv_holds_records_hint",
    ]);
    expect(evaluate({ CACHE: { kind: "kv" }, DB: { kind: "d1" } })).toEqual([]);
  });
});

describe("parseAppDataConfig", () => {
  it("accepts no jurisdiction or one Cloudflare offers, and nothing else", () => {
    expect(parseAppDataConfig({})).toEqual({ jurisdiction: null });
    expect(parseAppDataConfig({ APP_DATA_JURISDICTION: " " })).toEqual({ jurisdiction: null });
    expect(parseAppDataConfig({ APP_DATA_JURISDICTION: "eu" })).toEqual({ jurisdiction: "eu" });
    expect(parseAppDataConfig({ APP_DATA_JURISDICTION: "fedramp" })).toEqual({
      jurisdiction: "fedramp",
    });
    expect(parseAppDataConfig({ APP_DATA_JURISDICTION: "us" })).toBeNull();
    expect(parseAppDataConfig({ APP_DATA_JURISDICTION: "EU" })).toBeNull();
  });
});

describe("mintResourceName", () => {
  const binding = (name: string) => name as BindingName;

  it("is deterministic and readable", async () => {
    const name = await mintResourceName("notes" as AppName, "production", binding("DB"));
    expect(name).toBe("app-notes--prod-db");
    expect(await mintResourceName("notes" as AppName, "production", binding("DB"))).toBe(name);
    expect(await mintResourceName("notes" as AppName, "preview", binding("USER_FILES"))).toBe(
      "app-notes--prev-user-files"
    );
  });

  it("keeps apps apart even when one app's name ends like another's stage", async () => {
    const short = await mintResourceName("a" as AppName, "production", binding("PROD_X"));
    const long = await mintResourceName("a-prod" as AppName, "production", binding("X"));
    expect(short).not.toBe(long);
  });

  it("caps at 63 characters with a hash tail, so truncated names stay distinct", async () => {
    const app = "a".repeat(40) as AppName;
    const first = await mintResourceName(app, "production", binding(`${"B".repeat(31)}1`));
    const second = await mintResourceName(app, "production", binding(`${"B".repeat(31)}2`));
    for (const name of [first, second]) {
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(APP_RESOURCE_NAME_PATTERN);
      expect(name).toMatch(/-[0-9a-f]{8}$/);
    }
    expect(first).not.toBe(second);
  });

  it("never ends in a hyphen, and keeps DB_ distinct from DB", async () => {
    const trailing = await mintResourceName("notes" as AppName, "production", binding("DB_"));
    expect(trailing).toMatch(APP_RESOURCE_NAME_PATTERN);
    expect(trailing).not.toBe(
      await mintResourceName("notes" as AppName, "production", binding("DB"))
    );
  });
});

describe("classifyStatement", () => {
  it.each([
    ["CREATE TABLE notes (id TEXT PRIMARY KEY)", "additive", "create_table"],
    ["create temp table t (x)", "additive", "create_table"],
    ["CREATE UNIQUE INDEX i ON notes (id)", "additive", "create_index"],
    ["CREATE VIEW v AS SELECT 1", "additive", "create_view"],
    ["ALTER TABLE notes ADD COLUMN body TEXT", "additive", "add_column"],
    ['ALTER TABLE main."my notes" ADD body TEXT', "additive", "add_column"],
    ["INSERT INTO notes (id) VALUES ('1')", "additive", "insert"],
    ["INSERT INTO notes (id) VALUES ('1') ON CONFLICT DO NOTHING", "additive", "insert"],
    ["SELECT 1", "additive", "select"],
    ["PRAGMA defer_foreign_keys = true", "additive", "foreign_keys_pragma"],
    ["PRAGMA main.foreign_keys = ON", "additive", "foreign_keys_pragma"],
    ["DROP TABLE IF EXISTS notes", "destructive", "drop_table"],
    ["DROP INDEX i", "destructive", "drop_index"],
    ["ALTER TABLE notes DROP COLUMN body", "destructive", "drop_column"],
    ["ALTER TABLE notes RENAME TO archive", "destructive", "rename_table"],
    ["ALTER TABLE notes RENAME COLUMN body TO text", "destructive", "rename_column"],
    ["ALTER TABLE notes RENAME body TO text", "destructive", "rename_column"],
    ["UPDATE notes SET body = '' WHERE id = '1'", "destructive", "update_rows"],
    ["DELETE FROM notes WHERE 1", "destructive", "delete_rows"],
    ["INSERT OR REPLACE INTO notes (id) VALUES ('1')", "destructive", "replace_rows"],
    ["REPLACE INTO notes (id) VALUES ('1')", "destructive", "replace_rows"],
    [
      "INSERT INTO notes (id) VALUES ('1') ON CONFLICT (id) DO UPDATE SET body = 'x'",
      "destructive",
      "replace_rows",
    ],
    [
      "CREATE TRIGGER purge AFTER INSERT ON audit BEGIN DELETE FROM users; END",
      "destructive",
      "create_trigger",
    ],
    [
      "CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN UPDATE users SET role = 'admin'; END",
      "destructive",
      "create_trigger",
    ],
    [
      "create temporary trigger if not exists t before insert on a begin select 1; end",
      "destructive",
      "create_trigger",
    ],
    [
      "CREATE TRIGGER IF NOT EXISTS main.t AFTER UPDATE ON a BEGIN INSERT INTO log VALUES (1); END",
      "destructive",
      "create_trigger",
    ],
    [
      'CREATE /* c */ TRIGGER -- c\n"t" AFTER INSERT ON a BEGIN DELETE FROM users; END',
      "destructive",
      "create_trigger",
    ],
    [
      "CrEaTe TrIgGeR t AFTER DELETE ON a FOR EACH ROW WHEN OLD.x = 1 BEGIN SELECT 1; END",
      "destructive",
      "create_trigger",
    ],
    [
      "CREATE TRIGGER t INSTEAD OF INSERT ON v BEGIN INSERT OR REPLACE INTO users VALUES (NEW.id); END",
      "destructive",
      "create_trigger",
    ],
    ["WITH gone AS (SELECT id FROM notes) DELETE FROM notes", "destructive", "unrecognized"],
    ["REINDEX notes", "destructive", "unrecognized"],
    ["PRAGMA journal_mode = DELETE", "forbidden", "pragma"],
    ["ATTACH DATABASE 'x' AS other", "forbidden", "attach"],
    ["DETACH other", "forbidden", "detach"],
    ["VACUUM", "forbidden", "vacuum"],
    ["BEGIN TRANSACTION", "forbidden", "transaction_control"],
    ["COMMIT", "forbidden", "transaction_control"],
    [`DELETE FROM ${MIGRATION_LEDGER_TABLE}`, "forbidden", "platform_table"],
    [
      `INSERT INTO "${MIGRATION_LEDGER_TABLE.toUpperCase()}" VALUES ('x', 'y')`,
      "forbidden",
      "platform_table",
    ],
  ])("%s is %s (%s)", (sql, expectedClass, form) => {
    expect(classifyStatement(sql)).toEqual({ class: expectedClass, form });
  });

  it("reads past comments, strings and quoted names", () => {
    expect(classifyStatement("-- DROP TABLE notes\nCREATE TABLE t (x)")).toEqual({
      class: "additive",
      form: "create_table",
    });
    expect(
      classifyStatement("/* DELETE FROM notes; */ INSERT INTO t VALUES ('DROP TABLE x')")
    ).toEqual({ class: "additive", form: "insert" });
    expect(classifyStatement('CREATE TABLE "drop" (x)')).toEqual({
      class: "additive",
      form: "create_table",
    });
  });
});

describe("splitSqlStatements", () => {
  it("splits on semicolons outside strings, comments, quoted names and trigger bodies", () => {
    const sql = [
      "CREATE TABLE notes (body TEXT DEFAULT 'a;b');",
      "-- a comment; with a semicolon",
      'CREATE TABLE "x;y" (z);',
      "CREATE TRIGGER t AFTER INSERT ON notes BEGIN",
      "  UPDATE notes SET body = CASE WHEN body IS NULL THEN '' ELSE body END;",
      "  DELETE FROM notes WHERE body = '';",
      "END;",
      "/* trailing; */",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[2]).toMatch(/^CREATE TRIGGER t[\s\S]*END$/);
    expect(classifyMigration({ sql })).toEqual({
      class: "destructive",
      statements: [statements[2]],
    });
  });
});

describe("classifyMigration", () => {
  it("lists the statements that decided it, forbidden over destructive", () => {
    expect(classifyMigration({ sql: "CREATE TABLE a (x);\nDROP TABLE b;" })).toEqual({
      class: "destructive",
      statements: ["DROP TABLE b"],
    });
    expect(classifyMigration({ sql: "DROP TABLE b;\nVACUUM;" })).toEqual({
      class: "forbidden",
      statements: ["VACUUM"],
    });
    expect(classifyMigration({ sql: "CREATE TABLE a (x);" })).toEqual({ class: "additive" });
  });

  it("holds every trigger for approval, even one whose body only inserts", () => {
    const trigger = "CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO log VALUES (NEW.x); END";
    expect(classifyMigration({ sql: `CREATE TABLE a (x);\n${trigger};` })).toEqual({
      class: "destructive",
      statements: [trigger],
    });
  });
});

describe("migrationBatchSql", () => {
  it("records the file in the database's own ledger in the same batch", () => {
    const body = migrationBatchSql(file("0001_init.sql", "CREATE TABLE a (x);", "ab".repeat(32)));
    expect(body).toContain(`CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE}`);
    expect(body).toContain(`VALUES ('0001_init.sql', '${"ab".repeat(32)}')`);
    expect(body.endsWith("CREATE TABLE a (x);")).toBe(true);
    expect(
      isAlreadyAppliedError(
        `UNIQUE constraint failed: ${MIGRATION_LEDGER_TABLE}.name, ${MIGRATION_LEDGER_TABLE}.sha256: SQLITE_CONSTRAINT`
      )
    ).toBe(true);
    expect(isAlreadyAppliedError("UNIQUE constraint failed: notes.id")).toBe(false);
  });
});

describe("planMigrations", () => {
  const applied = (name: string, sha256: string): MigrationRecord => ({
    name,
    sha256,
    status: "applied",
  });
  const one = file("0001_init.sql", "CREATE TABLE a (x);");
  const two = file("0002_more.sql", "CREATE TABLE b (x);");

  it("returns the files not yet applied, in name order", () => {
    expect(planMigrations([two, one], [])).toEqual({ ok: true, pending: [one, two] });
    expect(planMigrations([two, one], [applied(one.name, one.sha256)])).toEqual({
      ok: true,
      pending: [two],
    });
  });

  it("refuses an applied file that changed or disappeared", () => {
    expect(
      planMigrations([{ ...one, sha256: "f".repeat(64) }, two], [applied(one.name, one.sha256)])
    ).toEqual({ ok: false, problem: "migration_file_changed", name: one.name });
    expect(planMigrations([two], [applied(one.name, one.sha256)])).toEqual({
      ok: false,
      problem: "migration_file_missing",
      name: one.name,
    });
  });

  it("refuses a new file that sorts before an applied one", () => {
    expect(planMigrations([one, two], [applied(two.name, two.sha256)])).toEqual({
      ok: false,
      problem: "migration_out_of_order",
      name: one.name,
    });
  });

  it("treats blocked, approved, applying and failed files as pending again", () => {
    for (const status of ["blocked", "approved", "applying", "failed"] as const) {
      expect(
        planMigrations(
          [one, two],
          [applied(one.name, one.sha256), { ...applied(two.name, "e".repeat(64)), status }]
        )
      ).toEqual({ ok: true, pending: [two] });
    }
  });
});

describe("renderDataInstructions", () => {
  it("is deterministic, bounded and names the identity contract", () => {
    const text = renderDataInstructions(SEED_POLICY);
    expect(renderDataInstructions(SEED_POLICY)).toBe(text);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_DATA_INSTRUCTION_BYTES);
    expect(text).toContain("`x-openinspect-user-sub`");
    expect(text).toContain("never write a wrangler config");
    expect(text).not.toContain("Not available");
  });

  it("offers only the stores the policy allows", () => {
    const text = renderDataInstructions({
      stances: { d1: "preferred", kv: "denied", r2: "denied" },
      guidance: {},
    });
    expect(text).toContain('`{"kind":"d1"}`');
    expect(text).not.toContain('`{"kind":"kv"}`');
    expect(text).toContain("- Not available: kv, r2.");
  });
});
