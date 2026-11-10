import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppName } from "@open-inspect/shared/apps";
import { sha256Hex } from "@open-inspect/shared/service-auth";
import {
  appDataManifestSchema,
  type AppStage,
  type BindingName,
  type MigrationFile,
  type SecretText,
} from "@open-inspect/shared/types/app-data";
import type { DataStorePolicy } from "@open-inspect/shared/types/stack-policy";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovedComponentStore } from "../db/approved-components";
import { AppDataStore } from "../db/app-data";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  createFakeDataHost,
  type DataHostOp,
  type FakeDataHost,
} from "./fake-data-host.test-support";
import { APP_DATA_RETENTION_MS, MIGRATION_LEDGER_TABLE } from "./model";
import { AppDataService, type PrepareResult, type UserActor } from "./service";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);
const KEY = Buffer.alloc(32, 7).toString("base64");
const OWNER = "a1".repeat(16);
const APP = "notes" as AppName;
const DAY_MS = 86_400_000;
const OWNER_ACTOR: UserActor = { userId: OWNER, scope: "own", requestId: "req-owner" };
const ADMIN_ACTOR: UserActor = { userId: "ad".repeat(16), scope: "any", requestId: "req-admin" };

const CREATE_NOTES = "CREATE TABLE notes (id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL);";
const SEED_NOTE = "INSERT INTO notes (id, owner_sub) VALUES ('n1', 'user-1');";
const DROP_NOTES = "DROP TABLE notes;";

interface World {
  db: NodeSqlDatabase;
  host: FakeDataHost;
  service: AppDataService;
  clock: { now: number };
}

const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.db.close();
});

function createWorld(options: { policy?: DataStorePolicy; jurisdiction?: "eu" } = {}): World {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, MIGRATIONS_DIR);
  sqlite
    .prepare(
      "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'Owner', 1, 1)"
    )
    .run(OWNER);
  sqlite
    .prepare(
      "INSERT INTO apps (name, owner_user_id, status, created_at, updated_at) VALUES (?, ?, 'pending', 1, 1)"
    )
    .run(APP, OWNER);
  const db = createNodeSqlDatabase(sqlite);
  const host = createFakeDataHost();
  const clock = { now: 1_800_000_000_000 };
  const policy = options.policy;
  const service = new AppDataService({
    db,
    store: new AppDataStore(db, KEY),
    host,
    policy: policy ? { resolveForApp: async () => policy } : new ApprovedComponentStore(db),
    config: { jurisdiction: options.jurisdiction ?? null },
    now: () => clock.now,
  });
  const world = { db, host, service, clock };
  worlds.push(world);
  return world;
}

async function migrationFiles(files: Record<string, string>): Promise<MigrationFile[]> {
  return Promise.all(
    Object.entries(files).map(async ([name, sql]) => ({ name, sql, sha256: await sha256Hex(sql) }))
  );
}

async function deploy(
  world: World,
  declaration: {
    data?: Record<string, unknown>;
    secrets?: string[];
    classification?: string;
    migrations?: Record<string, Record<string, string>>;
    stage?: AppStage;
  }
): Promise<PrepareResult> {
  const manifest = appDataManifestSchema.parse({
    schemaVersion: 1,
    name: APP,
    data: declaration.data ?? {},
    secrets: declaration.secrets ?? [],
    ...(declaration.classification ? { classification: declaration.classification } : {}),
  });
  const migrations = new Map<BindingName, MigrationFile[]>();
  for (const [binding, files] of Object.entries(declaration.migrations ?? {})) {
    migrations.set(binding as BindingName, await migrationFiles(files));
  }
  return world.service.prepare({
    app: {
      name: APP,
      ownerUserId: OWNER,
      repository: { repoOwner: "acme", repoName: "notes" },
      environmentId: null,
    },
    stage: declaration.stage ?? "production",
    manifest,
    migrations,
    actor: { kind: "session", sessionId: "session-1", userId: OWNER, requestId: "req-deploy" },
  });
}

function ready(result: PrepareResult) {
  if (result.kind !== "ready") throw new Error(`blocked: ${result.reason}: ${result.message}`);
  return result.bindings;
}

function blocked(result: PrepareResult) {
  if (result.kind !== "blocked") throw new Error("expected a blocked deploy");
  return result;
}

async function operations(world: World) {
  return (
    await world.db
      .prepare(
        "SELECT kind, result, actor_kind, detail_json FROM app_data_operations ORDER BY rowid"
      )
      .all<{ kind: string; result: string; actor_kind: string; detail_json: string }>()
  ).results;
}

const FULL_APP = {
  data: { DB: { kind: "d1" }, CACHE: { kind: "kv" }, FILES: { kind: "r2" } },
  migrations: { DB: { "0001_init.sql": CREATE_NOTES } },
};

describe("prepare", () => {
  it("provisions one dedicated resource per declared binding and binds exactly those", async () => {
    const world = createWorld();
    const bindings = ready(await deploy(world, FULL_APP));

    expect(bindings.bindings.map((binding) => [binding.kind, binding.name])).toEqual([
      ["kv", "CACHE"],
      ["d1", "DB"],
      ["r2", "FILES"],
    ]);
    expect(world.host.database("app-notes--prod-db")?.tables).toEqual([
      MIGRATION_LEDGER_TABLE,
      "notes",
    ]);
    expect(world.host.kvNamespaces()).toEqual(["app-notes--prod-cache"]);
    expect(world.host.bucket("app-notes--prod-files")).toEqual({ objects: 0, lifecycle: false });
    expect(bindings.dataDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("converges: a second deploy binds the same resources with no host call or new operation", async () => {
    const world = createWorld();
    const first = ready(await deploy(world, FULL_APP));
    const calls = world.host.calls.length;
    const ledger = (await operations(world)).length;

    const second = ready(await deploy(world, FULL_APP));

    expect(second).toEqual(first);
    expect(world.host.calls).toHaveLength(calls);
    expect(await operations(world)).toHaveLength(ledger);
  });

  describe("converges after a fault at any host call", () => {
    const FIRST_DEPLOY_CALLS: DataHostOp[] = [
      "ensureKv",
      "ensureD1",
      "ensureR2",
      "bookmarkD1",
      "executeD1",
    ];

    it("makes each host call once on a first deploy", async () => {
      const world = createWorld();
      ready(await deploy(world, FULL_APP));
      expect(world.host.calls.map((call) => call.op)).toEqual(FIRST_DEPLOY_CALLS);
    });

    for (const when of ["before", "after"] as const) {
      for (const op of FIRST_DEPLOY_CALLS) {
        it(`${op} failing ${when} it applies`, async () => {
          const world = createWorld();
          world.host.inject(op, when);

          expect(blocked(await deploy(world, FULL_APP)).reason).toBe("data_unavailable");
          const bindings = ready(await deploy(world, FULL_APP));

          const database = world.host.database("app-notes--prod-db")!;
          expect(database.tables).toEqual([MIGRATION_LEDGER_TABLE, "notes"]);
          expect(database.rows(`SELECT name FROM ${MIGRATION_LEDGER_TABLE}`)).toEqual([
            { name: "0001_init.sql" },
          ]);
          expect(world.host.databaseCount()).toBe(1);
          expect(world.host.kvNamespaces()).toEqual(["app-notes--prod-cache"]);
          expect(bindings.bindings.find((binding) => binding.name === "DB")).toEqual({
            kind: "d1",
            name: "DB",
            databaseId: database.id,
          });
          const summary = await world.service.summary(APP);
          expect(summary.migrations.map((migration) => migration.status)).toEqual(["applied"]);
        });
      }
    }
  });

  it("retires a removed binding and reinstates the same resource when it returns", async () => {
    const world = createWorld();
    const first = ready(
      await deploy(world, { data: { DB: { kind: "d1" }, FILES: { kind: "r2" } } })
    );
    const retiredAt = (world.clock.now += 1_000);

    const without = ready(await deploy(world, { data: { DB: { kind: "d1" } } }));
    expect(without.bindings.map((binding) => binding.name)).toEqual(["DB"]);
    const files = (await world.service.summary(APP)).resources.find(
      (resource) => resource.binding === "FILES"
    );
    expect(files).toMatchObject({
      status: "retired",
      retiredAt,
      purgeAfter: retiredAt + APP_DATA_RETENTION_MS.production,
    });

    world.clock.now += 10 * DAY_MS;
    const ensures = world.host.calls.filter((call) => call.op === "ensureR2").length;
    const again = ready(
      await deploy(world, { data: { DB: { kind: "d1" }, FILES: { kind: "r2" } } })
    );

    expect(again.bindings).toEqual(first.bindings);
    expect(world.host.calls.filter((call) => call.op === "ensureR2")).toHaveLength(ensures);
    expect((await operations(world)).map((op) => op.kind)).toContain("reinstate");
  });

  it("keeps preview resources and secrets apart from production", async () => {
    const world = createWorld();
    const declaration = { data: { DB: { kind: "d1" } }, secrets: ["API_KEY"] };
    const setKey = (stage: AppStage, value: string) =>
      world.service.setSecrets({
        appName: APP,
        stage,
        secrets: { API_KEY: value },
        actor: OWNER_ACTOR,
      });
    expect(blocked(await deploy(world, declaration)).reason).toBe("secret_missing");
    await setKey("production", "production-placeholder");
    const production = ready(await deploy(world, declaration));

    expect(blocked(await deploy(world, { ...declaration, stage: "preview" }))).toMatchObject({
      reason: "secret_missing",
      detail: { secrets: ["API_KEY"] },
    });
    await setKey("preview", "preview-placeholder");
    const preview = ready(await deploy(world, { ...declaration, stage: "preview" }));

    const database = (bindings: typeof preview) =>
      bindings.bindings.find((binding) => binding.kind === "d1");
    const secret = (bindings: typeof preview) =>
      bindings.bindings.find((binding) => binding.kind === "secret") as { value: SecretText };
    expect(database(preview)).not.toEqual(database(production));
    expect(world.host.database("app-notes--prev-db")).not.toBeNull();
    expect(secret(preview).value.reveal()).toBe("preview-placeholder");
    expect(secret(production).value.reveal()).toBe("production-placeholder");
  });

  it("holds a destructive production migration for approval of its exact bytes", async () => {
    const world = createWorld();
    const initial = { "0001_init.sql": `${CREATE_NOTES}\n${SEED_NOTE}` };
    ready(await deploy(world, { data: { DB: { kind: "d1" } }, migrations: { DB: initial } }));
    const destructive = {
      data: { DB: { kind: "d1" } },
      migrations: { DB: { ...initial, "0002_drop.sql": DROP_NOTES } },
    };

    const held = blocked(await deploy(world, destructive));
    const sha256 = await sha256Hex(DROP_NOTES);
    expect(held).toMatchObject({
      reason: "destructive_migration_requires_approval",
      detail: {
        binding: "DB",
        migration: "0002_drop.sql",
        sha256,
        statements: ["DROP TABLE notes"],
      },
    });
    expect(world.host.database("app-notes--prod-db")?.tables).toContain("notes");
    expect(blocked(await deploy(world, destructive)).reason).toBe(
      "destructive_migration_requires_approval"
    );

    const approve = (sha: string) =>
      world.service.approveMigration({
        appName: APP,
        stage: "production",
        binding: "DB" as BindingName,
        name: "0002_drop.sql",
        sha256: sha,
        actor: OWNER_ACTOR,
      });
    expect(await approve("0".repeat(64))).toMatchObject({ ok: false, code: "sha_mismatch" });
    expect(await approve(sha256)).toEqual({ ok: true, value: { status: "approved" } });
    expect(await approve(sha256)).toMatchObject({ ok: false, code: "not_blocked" });

    const before = world.host.calls.length;
    ready(await deploy(world, destructive));

    expect(world.host.database("app-notes--prod-db")?.tables).not.toContain("notes");
    expect(world.host.calls.slice(before).map((call) => call.op)).toEqual([
      "bookmarkD1",
      "executeD1",
    ]);
    const applied = (await world.service.summary(APP)).migrations.find(
      (migration) => migration.name === "0002_drop.sql"
    );
    expect(applied).toMatchObject({
      status: "applied",
      classification: "destructive",
      approvedBy: OWNER,
    });
    const ledger = await operations(world);
    expect(ledger.map((op) => `${op.kind}:${op.result}`)).toEqual(
      expect.arrayContaining(["approve_migration:applied", "migrate:blocked", "migrate:applied"])
    );
    const appliedOp = ledger.find(
      (op) => op.kind === "migrate" && op.result === "applied" && op.detail_json.includes("0002")
    );
    expect(JSON.parse(appliedOp!.detail_json).bookmarkBefore).toMatch(/@\d+$/);
  });

  it("blocks an edited file again, and its earlier approval does not carry over", async () => {
    const world = createWorld();
    const initial = { "0001_init.sql": `${CREATE_NOTES}\n${SEED_NOTE}` };
    ready(await deploy(world, { data: { DB: { kind: "d1" } }, migrations: { DB: initial } }));
    const withDrop = (sql: string) => ({
      data: { DB: { kind: "d1" } },
      migrations: { DB: { ...initial, "0002_drop.sql": sql } },
    });
    blocked(await deploy(world, withDrop(DROP_NOTES)));
    await world.service.approveMigration({
      appName: APP,
      stage: "production",
      binding: "DB" as BindingName,
      name: "0002_drop.sql",
      sha256: await sha256Hex(DROP_NOTES),
      actor: OWNER_ACTOR,
    });

    const edited = "DELETE FROM notes;";
    expect(blocked(await deploy(world, withDrop(edited)))).toMatchObject({
      reason: "destructive_migration_requires_approval",
      detail: { sha256: await sha256Hex(edited) },
    });
    expect(world.host.database("app-notes--prod-db")?.rows("SELECT id FROM notes")).toEqual([
      { id: "n1" },
    ]);
  });

  it("lets a database with no tables take destructive statements without approval", async () => {
    const world = createWorld();
    const result = await deploy(world, {
      data: { DB: { kind: "d1" } },
      migrations: { DB: { "0001_init.sql": `DROP TABLE IF EXISTS notes;\n${CREATE_NOTES}` } },
    });
    ready(result);
    expect(world.host.database("app-notes--prod-db")?.tables).toContain("notes");
  });

  it("applies destructive migrations in a preview without approval", async () => {
    const world = createWorld();
    const initial = { "0001_init.sql": `${CREATE_NOTES}\n${SEED_NOTE}` };
    const preview = { data: { DB: { kind: "d1" } }, stage: "preview" as const };
    ready(await deploy(world, { ...preview, migrations: { DB: initial } }));
    ready(
      await deploy(world, {
        ...preview,
        migrations: { DB: { ...initial, "0002_drop.sql": DROP_NOTES } },
      })
    );
    expect(world.host.database("app-notes--prev-db")?.tables).not.toContain("notes");
  });

  it("refuses a forbidden statement before anything runs", async () => {
    const world = createWorld();
    const result = blocked(
      await deploy(world, {
        data: { DB: { kind: "d1" } },
        migrations: { DB: { "0001_init.sql": `${CREATE_NOTES}\nPRAGMA journal_mode = OFF;` } },
      })
    );
    expect(result).toMatchObject({
      reason: "migration_forbidden_statement",
      detail: { statements: ["PRAGMA journal_mode = OFF"] },
    });
    expect(world.host.calls.map((call) => call.op)).not.toContain("executeD1");
  });

  it("relays D1's error and leaves the file unapplied until it is fixed", async () => {
    const world = createWorld();
    const broken = blocked(
      await deploy(world, {
        data: { DB: { kind: "d1" } },
        migrations: { DB: { "0001_init.sql": "CREATE TABLE notes (id TEXT PRIMARY KEY,);" } },
      })
    );
    expect(broken.reason).toBe("migration_failed");
    expect(broken.message).toMatch(/^0001_init\.sql for DB: .*syntax error/);
    expect(world.host.database("app-notes--prod-db")?.tables).toEqual([]);

    ready(
      await deploy(world, {
        data: { DB: { kind: "d1" } },
        migrations: { DB: { "0001_init.sql": CREATE_NOTES } },
      })
    );
    expect(world.host.database("app-notes--prod-db")?.tables).toContain("notes");
  });

  it("keeps applied files immutable and in order", async () => {
    const world = createWorld();
    const one = { "0001_init.sql": CREATE_NOTES };
    const two = { "0002_more.sql": "CREATE TABLE tags (id TEXT);" };
    ready(
      await deploy(world, { data: { DB: { kind: "d1" } }, migrations: { DB: { ...one, ...two } } })
    );
    const attempt = (files: Record<string, string>) =>
      deploy(world, { data: { DB: { kind: "d1" } }, migrations: { DB: files } });

    expect(blocked(await attempt({ "0001_init.sql": `${CREATE_NOTES} `, ...two })).reason).toBe(
      "migration_file_changed"
    );
    expect(blocked(await attempt(two)).reason).toBe("migration_file_missing");
    expect(
      blocked(await attempt({ ...one, ...two, "0000_early.sql": "CREATE TABLE early (x);" })).reason
    ).toBe("migration_out_of_order");
  });

  it("blocks until a person sets each declared secret, and binds values write-only", async () => {
    const world = createWorld();
    const declaration = { data: { DB: { kind: "d1" } }, secrets: ["STRIPE_KEY"] };
    expect(blocked(await deploy(world, declaration))).toMatchObject({
      reason: "secret_missing",
      detail: { secrets: ["STRIPE_KEY"] },
    });
    expect(world.host.calls).toEqual([]);

    expect(
      await world.service.setSecrets({
        appName: APP,
        stage: "production",
        secrets: { OTHER_KEY: "placeholder" },
        actor: OWNER_ACTOR,
      })
    ).toMatchObject({ ok: false, code: "undeclared_secret" });
    expect(
      await world.service.setSecrets({
        appName: APP,
        stage: "production",
        secrets: { STRIPE_KEY: "placeholder-secret-value" },
        actor: OWNER_ACTOR,
      })
    ).toEqual({ ok: true, value: { keys: ["STRIPE_KEY"] } });

    const bindings = ready(await deploy(world, declaration));
    const secret = bindings.bindings.find((binding) => binding.kind === "secret");
    expect((secret as { value: SecretText }).value.reveal()).toBe("placeholder-secret-value");
    expect(JSON.stringify(bindings)).not.toContain("placeholder-secret-value");
    expect(JSON.stringify(await operations(world))).not.toContain("placeholder-secret-value");
    expect(JSON.stringify(await world.service.summary(APP))).not.toContain(
      "placeholder-secret-value"
    );
  });

  it("blocks a denied store before any resource exists", async () => {
    const world = createWorld({
      policy: { stances: { d1: "preferred", kv: "denied", r2: "allowed" }, guidance: {} },
    });
    expect(
      blocked(await deploy(world, { data: { DB: { kind: "d1" }, CACHE: { kind: "kv" } } }))
    ).toMatchObject({ reason: "data_policy_denied", detail: { denials: [{ binding: "CACHE" }] } });
    expect(world.host.calls).toEqual([]);
    expect((await operations(world)).map((op) => op.kind)).toEqual(["policy_block"]);
  });

  it("keeps confidential data out of KV when a jurisdiction is pinned", async () => {
    const world = createWorld({ jurisdiction: "eu" });
    expect(
      blocked(
        await deploy(world, { data: { CACHE: { kind: "kv" } }, classification: "confidential" })
      ).reason
    ).toBe("data_policy_denied");
    ready(await deploy(world, { data: { CACHE: { kind: "kv" } }, classification: "internal" }));
  });

  it("never lets a binding change kind, live or retired", async () => {
    const world = createWorld();
    ready(await deploy(world, { data: { DB: { kind: "d1" } } }));
    expect(blocked(await deploy(world, { data: { DB: { kind: "kv" } } })).reason).toBe(
      "binding_kind_changed"
    );
    ready(await deploy(world, { data: {} }));
    expect(blocked(await deploy(world, { data: { DB: { kind: "kv" } } })).reason).toBe(
      "binding_kind_changed"
    );
  });

  it("keeps an administrator's classification over the manifest's", async () => {
    const world = createWorld();
    const classify = (actor: UserActor) =>
      world.service.setClassification({ appName: APP, classification: "restricted", actor });
    expect(await classify(OWNER_ACTOR)).toMatchObject({ ok: false, code: "requires_manage_any" });
    expect(await classify(ADMIN_ACTOR)).toMatchObject({ ok: true });

    const result = await deploy(world, {
      data: { DB: { kind: "d1" } },
      classification: "internal",
    });

    expect(ready(result).classification).toBe("restricted");
    expect(result.advisories.map((advisory) => advisory.code)).toContain(
      "classification_overridden_by_admin"
    );
  });
});

describe("retire and purgeDue", () => {
  async function takenDown(world: World) {
    ready(await deploy(world, FULL_APP));
    world.host.putObjects("app-notes--prod-files", 3);
    await world.service.retire(APP, "production", { kind: "user", userId: OWNER }, "takedown");
  }

  it("retires every live resource on takedown and deletes nothing inside the window", async () => {
    const world = createWorld();
    await takenDown(world);

    const summary = await world.service.summary(APP);
    expect(summary.resources.map((resource) => resource.status)).toEqual([
      "retired",
      "retired",
      "retired",
    ]);
    world.clock.now += APP_DATA_RETENTION_MS.production - 1;
    expect(await world.service.purgeDue(50)).toEqual({ purged: 0, emptying: 0, failed: 0 });
    expect(world.host.databaseCount()).toBe(1);
  });

  it("purges after the window and resumes an emptying bucket on the next sweep", async () => {
    const world = createWorld();
    await takenDown(world);
    world.clock.now += APP_DATA_RETENTION_MS.production + 1;

    expect(await world.service.purgeDue(50)).toEqual({ purged: 2, emptying: 1, failed: 0 });
    expect(world.host.databaseCount()).toBe(0);
    expect(world.host.kvNamespaces()).toEqual([]);
    expect(world.host.bucket("app-notes--prod-files")).toEqual({ objects: 3, lifecycle: true });
    expect(blocked(await deploy(world, FULL_APP))).toMatchObject({
      reason: "data_unavailable",
      detail: { binding: "FILES" },
    });

    world.host.runLifecycle();
    expect(await world.service.purgeDue(50)).toEqual({ purged: 1, emptying: 0, failed: 0 });
    expect(world.host.bucket("app-notes--prod-files")).toBeNull();
    const purges = (await operations(world)).filter((op) => op.kind === "purge");
    expect(purges.map((op) => op.actor_kind)).toEqual(["system", "system", "system"]);
    expect(await world.service.purgeDue(50)).toEqual({ purged: 0, emptying: 0, failed: 0 });
  });

  it("retries a failed delete on the next sweep", async () => {
    const world = createWorld();
    await takenDown(world);
    world.clock.now += APP_DATA_RETENTION_MS.production + 1;
    world.host.inject("deleteD1", "before");

    expect(await world.service.purgeDue(50)).toEqual({ purged: 1, emptying: 1, failed: 1 });
    expect(world.host.databaseCount()).toBe(1);
    world.host.runLifecycle();
    expect(await world.service.purgeDue(50)).toEqual({ purged: 2, emptying: 0, failed: 0 });
    expect(world.host.databaseCount()).toBe(0);
  });

  it("leaves a resource a redeploy reinstated before the sweep", async () => {
    const world = createWorld();
    await takenDown(world);
    world.clock.now += APP_DATA_RETENTION_MS.production + 1;

    ready(await deploy(world, FULL_APP));

    expect(await world.service.purgeDue(50)).toEqual({ purged: 0, emptying: 0, failed: 0 });
    expect(world.host.database("app-notes--prod-db")?.tables).toContain("notes");
  });
});

describe("restoreToPointInTime", () => {
  it("restores inside the window and records both bookmarks", async () => {
    const world = createWorld();
    ready(await deploy(world, FULL_APP));
    const restore = (target: { timestamp: number } | { bookmark: string }, confirm = "DB") =>
      world.service.restoreToPointInTime({
        appName: APP,
        stage: "production",
        binding: "DB" as BindingName,
        target,
        confirmBinding: confirm as BindingName,
        actor: OWNER_ACTOR,
      });

    expect(await restore({ timestamp: world.clock.now }, "CACHE")).toMatchObject({
      ok: false,
      code: "confirm_mismatch",
    });
    expect(await restore({ timestamp: world.clock.now - 31 * DAY_MS })).toMatchObject({
      ok: false,
      code: "outside_recovery_window",
    });
    expect(await restore({ timestamp: world.clock.now + 1 })).toMatchObject({
      ok: false,
      code: "outside_recovery_window",
    });
    expect(world.host.restores).toEqual([]);

    const target = { timestamp: world.clock.now - DAY_MS };
    const restored = await restore(target);

    expect(restored).toMatchObject({ ok: true, value: { previousBookmark: expect.any(String) } });
    expect(world.host.restores).toEqual([{ databaseId: expect.any(String), target }]);
    const op = (await operations(world)).find((entry) => entry.kind === "restore");
    expect(JSON.parse(op!.detail_json)).toMatchObject({ target, bookmark: expect.any(String) });
  });

  it("asks an administrator to restore restricted data", async () => {
    const world = createWorld();
    ready(await deploy(world, { ...FULL_APP, classification: "restricted" }));
    const restore = (actor: UserActor) =>
      world.service.restoreToPointInTime({
        appName: APP,
        stage: "production",
        binding: "DB" as BindingName,
        target: { bookmark: "d1-1@0" },
        confirmBinding: "DB" as BindingName,
        actor,
      });

    expect(await restore(OWNER_ACTOR)).toMatchObject({ ok: false, code: "requires_manage_any" });
    expect(await restore(ADMIN_ACTOR)).toMatchObject({ ok: true });
  });
});
