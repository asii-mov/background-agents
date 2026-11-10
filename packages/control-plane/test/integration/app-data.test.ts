import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brokerDeployRequestSchema, type AppResourceName } from "@open-inspect/shared/app-broker";
import type { BuiltInRoleKey } from "@open-inspect/shared/rbac";
import {
  SERVICE_SIGNATURE_HEADER,
  sha256Hex,
  verifyServiceSignature,
} from "@open-inspect/shared/service-auth";
import type { BindingName } from "@open-inspect/shared/types/app-data";
import { AppDataStore, type OperationInput } from "../../src/db/app-data";
import { SecurityPipelineStore } from "../../src/db/security-pipelines";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSessionDO,
  routeRequest,
  seedActiveUser,
  seedSandboxAuth,
  serviceRequestHeaders,
} from "./helpers";

const ALICE = "a1".repeat(16);
const CAROL = "c3".repeat(16);
const ADA = "ad".repeat(16);
const VICTOR = "f6".repeat(16);

const HOSTING = {
  APP_BROKER_URL: "https://deployer.apps.example.test",
  APPS_DOMAIN: "apps.example.test",
  SERVICE_AUTH_SECRET_APP_BROKER: "placeholder-broker-secret",
  APP_BROKER_ACCESS_CLIENT_ID: "placeholder-client-id",
  APP_BROKER_ACCESS_CLIENT_SECRET: "placeholder-client-secret",
};

const CREATE_NOTES = "CREATE TABLE notes (id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL);";
const DROP_NOTES = "DROP TABLE notes;";
const PURGE_TRIGGER =
  "CREATE TRIGGER purge AFTER INSERT ON notes BEGIN DELETE FROM notes WHERE id <> NEW.id; END;";
const SECRET_VALUE = "placeholder-secret-value";

function store(): AppDataStore {
  return new AppDataStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
}

function call(request: Request, hosting = true): Promise<Response> {
  return routeRequest(request, hosting ? { ...env, ...HOSTING } : env, createExecutionContext());
}

async function asUser(
  path: string,
  as: { userId: string; role: BuiltInRoleKey },
  init: { method?: string; body?: unknown } = {},
  hosting = true
): Promise<Response> {
  const url = `https://test.local${path}`;
  const method = init.method ?? "GET";
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const headers = await serviceRequestHeaders(url, { method, body, as });
  return call(new Request(url, { method, body, headers }), hosting);
}

/**
 * The broker as the control plane sees it: verifies sig1 on every call, answers the data ops
 * from an in-memory account, and records what each deploy asked to bind.
 */
function fakeBroker() {
  const deploys: Array<ReturnType<typeof brokerDeployRequestSchema.parse>> = [];
  const dataOps: Array<{ op: string; sql?: string }> = [];
  const databases = new Map<string, { id: string; executed: number }>();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== HOSTING.APP_BROKER_URL) throw new Error(`Unexpected fetch: ${url}`);
    const headers = init?.headers as Record<string, string>;
    const body = init?.body as Uint8Array | string;
    const verified = await verifyServiceSignature({
      signatureHeader: headers[SERVICE_SIGNATURE_HEADER],
      service: "control-plane",
      secret: HOSTING.SERVICE_AUTH_SECRET_APP_BROKER,
      method: "POST",
      url: url.toString(),
      bodySha256Hex: await sha256Hex(body),
      actor: "",
    });
    if (!verified.ok) {
      return Response.json({ error: "invalid_request", message: "Unauthorized" }, { status: 401 });
    }
    if (url.pathname === "/deploy") {
      const form = await new Response(body, {
        headers: { "content-type": headers["Content-Type"]! },
      }).formData();
      const request = brokerDeployRequestSchema.parse(JSON.parse(form.get("request") as string));
      deploys.push(request);
      return Response.json({
        url: `https://${request.name}.${HOSTING.APPS_DOMAIN}`,
        backend: "workers",
        cfVersionId: `cf-${deploys.length}`,
        accessAud: `aud-${request.name}`,
        firstDeploy: deploys.length === 1,
      });
    }
    if (url.pathname === "/takedown") return Response.json({ cleanupComplete: true });
    const request = JSON.parse(String(body)) as Record<string, string>;
    dataOps.push({ op: request.op!, ...(request.sql ? { sql: request.sql } : {}) });
    const database = [...databases.values()].find((db) => db.id === request.databaseId);
    switch (request.op) {
      case "d1.ensure": {
        const existing = databases.get(request.name!);
        const created = { id: `d1-${databases.size + 1}`, executed: 0 };
        if (!existing) databases.set(request.name!, created);
        return Response.json({ databaseId: (existing ?? created).id, created: !existing });
      }
      case "d1.bookmark":
        return Response.json({ bookmark: `${database!.id}@${database!.executed}` });
      case "d1.describe":
        return Response.json({
          name: "app-notes--prod-db",
          fileSize: 4096,
          numTables: database!.executed,
        });
      case "d1.execute":
        database!.executed += 1;
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "invalid_request", message: "unsupported" }, { status: 400 });
    }
  });
  return { deploys, dataOps };
}

async function sandboxSession(userId: string) {
  const sessionName = `app-data-${crypto.randomUUID()}`;
  const { stub } = await initNamedSessionDO(sessionName, { userId });
  const token = `sandbox-token-${crypto.randomUUID()}`;
  await seedSandboxAuth(stub, { authToken: token, sandboxId: `sandbox-${sessionName}` });
  await new SessionIndexStore(env.DB).create({
    id: sessionName,
    ownerTeamId: null,
    visibility: "workspace",
    title: null,
    repoOwner: "acme",
    repoName: "notes",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: "active",
    userId,
    createdAt: 1,
    updatedAt: 1,
  });
  return { sessionName, token };
}

function deployRequest(
  session: { sessionName: string; token: string },
  app: Record<string, unknown>,
  migrations: Record<string, string>
): Request {
  const form = new FormData();
  const names = Object.keys(migrations).sort();
  form.append(
    "manifest",
    JSON.stringify({
      assets: [{ path: "/index.html", part: "a0" }],
      worker: null,
      app: { part: "app" },
      migrations: names.map((name, index) => ({ binding: "DB", name, part: `m${index}` })),
    })
  );
  form.append("app", new File([JSON.stringify(app)], "app"));
  names.forEach((name, index) => form.append(`m${index}`, new File([migrations[name]!], name)));
  form.append("a0", new File(["<h1>notes</h1>"], "a0"));
  return new Request(`https://test.local/sessions/${session.sessionName}/apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.token}` },
    body: form,
  });
}

async function seedApp(name: string, ownerUserId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO apps (name, owner_user_id, status, created_at, updated_at) VALUES (?, ?, 'pending', 1, 1)"
  )
    .bind(name, ownerUserId)
    .run();
}

/** The shipped default policy (D1 preferred, KV and R2 allowed); cleanup empties the catalogue. */
async function reseedDefaultPolicy(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0104"));
  const seed = (migration?.queries ?? []).filter((query) =>
    /INSERT INTO (component_categories|approved_components|approved_component_signals) \(/.test(
      query
    )
  );
  await env.DB.batch(seed.map((query) => env.DB.prepare(query)));
}

const SYSTEM_OP: OperationInput = {
  kind: "provision",
  result: "applied",
  stage: "production",
  actor: { kind: "system", job: "test" },
  detail: {},
};

beforeEach(cleanD1Tables);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("migration 0106", () => {
  beforeEach(async () => {
    await seedActiveUser(ALICE);
    await seedApp("notes", ALICE);
  });

  const resource = (columns: string, values: string) =>
    env.DB.prepare(
      `INSERT INTO app_data_resources (id, app_name, stage, binding_name, kind, provider_name,
         created_at, updated_at, ${columns})
       VALUES ('r1', 'notes', 'production', 'DB', 'd1', 'app-notes--prod-db', 1, 1, ${values})`
    ).run();

  it.each([
    ["ready without a provider reference", "status", "'ready'"],
    ["provisioning with a provider reference", "status, provider_ref", "'provisioning', 'd1-1'"],
    ["retired without a retirement time", "status, provider_ref", "'retired', 'd1-1'"],
    [
      "retired without a purge time",
      "status, provider_ref, retired_at, retire_reason",
      "'retired', 'd1-1', 1, 'takedown'",
    ],
    [
      "purged without a purge time",
      "status, provider_ref, retired_at, retire_reason, purge_after",
      "'purged', 'd1-1', 1, 'takedown', 2",
    ],
  ])("refuses a resource %s", async (_case, columns, values) => {
    await expect(resource(columns, values)).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses a resource name outside the app- prefix", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO app_data_resources (id, app_name, stage, binding_name, kind, provider_name,
           provider_ref, status, created_at, updated_at)
         VALUES ('r1', 'notes', 'production', 'DB', 'd1', 'platform-db', 'd1-1', 'ready', 1, 1)`
      ).run()
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it.each([
    ["applied without a bookmark", "'applied', NULL, NULL, 1"],
    ["applying without a bookmark", "'applying', NULL, NULL, NULL"],
    ["approved without an approver", "'approved', 'bm', NULL, NULL"],
  ])("refuses a migration %s", async (_case, values) => {
    await resource("status, provider_ref", "'ready', 'd1-1'");
    await expect(
      env.DB.prepare(
        `INSERT INTO app_data_migrations (resource_id, name, sha256, classification, created_at,
           updated_at, status, bookmark_before, approved_by, applied_at)
         VALUES ('r1', '0001_init.sql', '${"a".repeat(64)}', 'additive', 1, 1, ${values})`
      ).run()
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("holds one live resource per binding and one unpurged row per resource name", async () => {
    const claim = () =>
      store().insertProvisioning({
        appName: "notes",
        stage: "production",
        binding: "DB" as BindingName,
        kind: "d1",
        providerName: "app-notes--prod-db" as AppResourceName,
        now: 1,
      });
    const [first, second] = await Promise.all([claim(), claim()]);
    expect(first?.id).toBeDefined();
    expect(second?.id).toBe(first?.id);
    await expect(resource("status", "'provisioning'")).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("seeds the app-data conformance pipeline for every repository", async () => {
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0106"));
    const seed = (migration?.queries ?? []).filter((query) =>
      query.includes("INSERT INTO security_pipelines")
    );
    expect(seed).toHaveLength(1);
    await env.DB.batch(seed.map((query) => env.DB.prepare(query)));

    const pipelines = new SecurityPipelineStore(env.DB);
    for (const repositories of [[], [{ repoOwner: "group/sub", repoName: "anything" }]]) {
      expect(await pipelines.getForSession(repositories, null)).toEqual([
        expect.objectContaining({
          name: "Platform: app data conformance",
          blocking: true,
          repoScopes: null,
          commands: [
            {
              name: "app-data-conformance",
              command: ["python", "-m", "sandbox_runtime.conformance", "app-data"],
              timeoutSeconds: 120,
            },
          ],
        }),
      ]);
    }
  });
});

describe("AppDataStore on D1", () => {
  beforeEach(async () => {
    await seedActiveUser(ALICE);
    await seedApp("notes", ALICE);
  });

  async function readyDatabase() {
    const claimed = await store().insertProvisioning({
      appName: "notes",
      stage: "production",
      binding: "DB" as BindingName,
      kind: "d1",
      providerName: "app-notes--prod-db" as AppResourceName,
      now: 1,
    });
    await store().markReady(claimed!, "d1-1", SYSTEM_OP, 2);
    return (await store().listResources("notes"))[0]!;
  }

  it("retires and reinstates a resource, with a ledger row for each step", async () => {
    const database = await readyDatabase();
    const op = (kind: OperationInput["kind"]): OperationInput => ({ ...SYSTEM_OP, kind });

    expect(
      await store().retire(database, { reason: "takedown", purgeAfter: 100 }, op("retire"), 3)
    ).toBe(true);
    expect(
      await store().retire(database, { reason: "takedown", purgeAfter: 100 }, op("retire"), 4)
    ).toBe(false);
    expect((await store().listResources("notes"))[0]).toMatchObject({
      status: "retired",
      retiredAt: 3,
      purgeAfter: 100,
      providerRef: "d1-1",
    });
    expect(await store().reinstate(database, op("reinstate"), 5)).toBe(true);
    expect((await store().listResources("notes"))[0]).toMatchObject({
      status: "ready",
      retiredAt: null,
      purgeAfter: null,
      providerRef: "d1-1",
    });
    const kinds = await env.DB.prepare(
      "SELECT kind FROM app_data_operations ORDER BY occurred_at"
    ).all<{ kind: string }>();
    expect(kinds.results.map((row) => row.kind)).toEqual(["provision", "retire", "reinstate"]);
  });

  it("encrypts secrets per stage, so a preview never reads a production value", async () => {
    const op: OperationInput = { ...SYSTEM_OP, kind: "secret_set" };
    await store().setSecrets("notes", "production", { API_KEY: SECRET_VALUE }, op, 1);

    const stored = await env.DB.prepare("SELECT encrypted_value FROM app_data_secrets").all<{
      encrypted_value: string;
    }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]!.encrypted_value).not.toContain(SECRET_VALUE);
    const names = ["API_KEY" as BindingName];
    expect(await store().decryptedSecrets("notes", "production", names)).toEqual({
      API_KEY: SECRET_VALUE,
    });
    expect(await store().decryptedSecrets("notes", "preview", names)).toEqual({});
    expect(await store().secretKeys("notes", "preview")).toEqual([]);
  });

  it("pages the ledger newest first without gaps or repeats", async () => {
    for (let index = 0; index < 5; index += 1) {
      await store().appendOperation("notes", { ...SYSTEM_OP, detail: { index } }, 10 + (index % 2));
    }
    const seen: unknown[] = [];
    let cursor = null;
    do {
      const page: Awaited<ReturnType<AppDataStore["listOperations"]>> =
        await store().listOperations("notes", cursor, 2);
      seen.push(...page.operations.map((operation) => operation.detail.index));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.slice(0, 2).sort()).toEqual([1, 3]);
  });
});

describe("app data routes", () => {
  beforeEach(async () => {
    await seedActiveUser(ALICE);
    await seedApp("notes", ALICE);
    await store().recordManifest(
      "notes",
      { classification: "internal", declaredSecrets: ["API_KEY" as BindingName] },
      ALICE,
      1
    );
  });

  it.each([
    ["the owner", ALICE, "member", 200],
    ["an administrator", ADA, "administrator", 200],
    ["another member", CAROL, "member", 403],
    ["a viewer", VICTOR, "viewer", 403],
  ] as const)("answers %s with %i, never cached", async (_case, userId, role, status) => {
    const response = await asUser("/apps/notes/data", { userId, role });
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("takes secret values and never answers with them", async () => {
    const set = await asUser(
      "/apps/notes/data/secrets",
      { userId: ALICE, role: "member" },
      { method: "POST", body: { stage: "production", secrets: { API_KEY: SECRET_VALUE } } }
    );
    const summary = await asUser("/apps/notes/data", { userId: ALICE, role: "member" });
    const ledger = await asUser("/apps/notes/data/operations", { userId: ALICE, role: "member" });
    const byOther = await asUser(
      "/apps/notes/data/secrets",
      { userId: CAROL, role: "member" },
      { method: "POST", body: { stage: "production", secrets: { API_KEY: "other-value" } } }
    );

    expect(set.status).toBe(200);
    const texts = [await set.text(), await summary.text(), await ledger.text()];
    expect(JSON.parse(texts[0]!)).toEqual({ keys: ["API_KEY"] });
    for (const text of texts) expect(text).not.toContain(SECRET_VALUE);
    expect(JSON.parse(texts[1]!).secrets).toEqual([
      { name: "API_KEY", stage: "production", updatedAt: expect.any(Number) },
    ]);
    expect(byOther.status).toBe(403);
    expect(
      (
        await asUser(
          "/apps/notes/data/secrets/API_KEY?stage=production",
          { userId: ALICE, role: "member" },
          { method: "DELETE" }
        )
      ).status
    ).toBe(200);
  });

  it("lets only an administrator lock the classification", async () => {
    const classify = (userId: string, role: BuiltInRoleKey) =>
      asUser(
        "/apps/notes/data/classification",
        { userId, role },
        { method: "PUT", body: { classification: "restricted" } }
      );
    const byOwner = await classify(ALICE, "member");
    const byAdmin = await classify(ADA, "administrator");

    expect(byOwner.status).toBe(403);
    await expect(byOwner.json()).resolves.toMatchObject({ code: "requires_manage_any" });
    expect(byAdmin.status).toBe(200);
    await expect(byAdmin.json()).resolves.toEqual({
      classification: "restricted",
      classificationSource: "admin",
    });
  });

  it("shows the workspace inventory to governance readers only, with or without hosting", async () => {
    expect((await asUser("/app-data/inventory", { userId: ALICE, role: "member" })).status).toBe(
      403
    );
    const inventory = await asUser(
      "/app-data/inventory",
      { userId: ADA, role: "administrator" },
      {},
      false
    );
    expect(inventory.status).toBe(200);
    await expect(inventory.json()).resolves.toEqual({ rows: [], nextCursor: null });
    expect(
      (await asUser("/apps/notes/data", { userId: ALICE, role: "member" }, {}, false)).status
    ).toBe(503);
  });
});

describe("deploying an app that declares a database", () => {
  it("provisions, migrates and binds it, holds a destructive change for approval, and retires it on takedown", async () => {
    await reseedDefaultPolicy();
    await seedActiveUser(ALICE);
    const session = await sandboxSession(ALICE);
    const broker = fakeBroker();
    const app = { schemaVersion: 1, name: "notes", data: { DB: { kind: "d1" } } };

    const first = await call(deployRequest(session, app, { "0001_init.sql": CREATE_NOTES }));
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(JSON.parse(firstBody)).toMatchObject({ ok: true, bindings: ["DB"] });
    expect(firstBody).not.toContain("d1-1");
    expect(broker.dataOps.map((entry) => entry.op)).toEqual([
      "d1.ensure",
      "d1.bookmark",
      "d1.execute",
    ]);
    expect(broker.dataOps[2]!.sql).toContain("_openinspect_migrations");
    expect(broker.dataOps[2]!.sql).toContain(CREATE_NOTES);
    expect(broker.deploys[0]!.bindings).toEqual([{ type: "d1", name: "DB", databaseId: "d1-1" }]);

    const withDrop = { "0001_init.sql": CREATE_NOTES, "0002_drop.sql": DROP_NOTES };
    const held = await call(deployRequest(session, app, withDrop));
    expect(held.status).toBe(423);
    const heldBody = (await held.json()) as { reason: string; detail: { sha256: string } };
    expect(heldBody.reason).toBe("destructive_migration_requires_approval");
    expect(broker.deploys).toHaveLength(1);

    const approve = await asUser(
      "/apps/notes/data/migrations/approve",
      { userId: ALICE, role: "member" },
      {
        method: "POST",
        body: {
          stage: "production",
          binding: "DB",
          name: "0002_drop.sql",
          sha256: heldBody.detail.sha256,
        },
      }
    );
    expect(approve.status).toBe(200);

    const applied = await call(deployRequest(session, app, withDrop));
    expect(applied.status).toBe(200);
    expect(broker.dataOps.slice(-2).map((entry) => entry.op)).toEqual([
      "d1.bookmark",
      "d1.execute",
    ]);
    expect(broker.dataOps.at(-1)!.sql).toContain(DROP_NOTES);

    const takedown = await asUser(
      "/apps/notes/takedown",
      { userId: ALICE, role: "member" },
      { method: "POST", body: { reason: "Done" } }
    );
    expect(takedown.status).toBe(200);
    const summary = (await (
      await asUser("/apps/notes/data", { userId: ALICE, role: "member" })
    ).json()) as { resources: Array<{ status: string; purgeAfter: number }> };
    expect(summary.resources).toEqual([
      expect.objectContaining({ status: "retired", purgeAfter: expect.any(Number) }),
    ]);
  });

  it("holds a trigger until its exact bytes are approved", async () => {
    await reseedDefaultPolicy();
    await seedActiveUser(ALICE);
    const session = await sandboxSession(ALICE);
    const broker = fakeBroker();
    const app = { schemaVersion: 1, name: "notes", data: { DB: { kind: "d1" } } };
    const initial = await call(deployRequest(session, app, { "0001_init.sql": CREATE_NOTES }));
    expect(initial.status).toBe(200);

    const withTrigger = { "0001_init.sql": CREATE_NOTES, "0002_purge.sql": PURGE_TRIGGER };
    const approve = (sha256: string) =>
      asUser(
        "/apps/notes/data/migrations/approve",
        { userId: ALICE, role: "member" },
        {
          method: "POST",
          body: { stage: "production", binding: "DB", name: "0002_purge.sql", sha256 },
        }
      );
    const ranTrigger = () => broker.dataOps.some((entry) => entry.sql?.includes(PURGE_TRIGGER));

    const held = await call(deployRequest(session, app, withTrigger));
    expect(held.status).toBe(423);
    await expect(held.json()).resolves.toMatchObject({
      reason: "destructive_migration_requires_approval",
      detail: { sha256: await sha256Hex(PURGE_TRIGGER) },
    });
    expect((await approve("ab".repeat(32))).ok).toBe(false);
    expect((await call(deployRequest(session, app, withTrigger))).status).toBe(423);
    expect(ranTrigger()).toBe(false);
    expect(broker.deploys).toHaveLength(1);

    expect((await approve(await sha256Hex(PURGE_TRIGGER))).status).toBe(200);
    expect((await call(deployRequest(session, app, withTrigger))).status).toBe(200);
    expect(ranTrigger()).toBe(true);
  });
});
