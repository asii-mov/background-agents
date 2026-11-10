/**
 * End to end for app data: the sandbox deploy-app tool (Python) against the control plane's
 * POST /sessions/:id/apps on the Node host, whose broker client reaches the real app broker Worker
 * app, which talks to U1's fake Cloudflare. The app declares a D1 database, a secret and
 * migrations. Human steps (set a secret, approve a destructive migration) call the same service
 * the routes call. Asserts the fake recorded no ingress-invariant violation at any point.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strict as assert } from "node:assert";
import { createBrokerApp, type BrokerEnv } from "worktree/packages/app-broker/src/index";
import {
  FAKE_CLOUDFLARE_API_BASE_URL,
  createFakeCloudflare,
} from "worktree/packages/app-broker/test/fake-cloudflare";
import { appsFromEnv, takeDownApp } from "worktree/packages/control-plane/src/apps";
import { hashToken } from "worktree/packages/control-plane/src/auth/crypto";
import { SessionIndexStore } from "worktree/packages/control-plane/src/db/session-index";
import { startNodeHost } from "worktree/packages/control-plane/src/node/host";
import { openSessionStore } from "worktree/packages/control-plane/src/node/session-store";
import { createNodeSqlDatabase } from "worktree/packages/control-plane/src/node/sqlite-database";

const worktree = process.argv[2]!;
const BACKEND = (process.argv[3] ?? "workers") as "workers" | "dispatch-namespace";
const APPS_DOMAIN = "apps.example.test";
const BROKER_ORIGIN = `https://deployer.${APPS_DOMAIN}`;
const BROKER_SECRET = "placeholder-control-plane-secret";
const KEY = Buffer.alloc(32, 7).toString("base64");
const OWNER = "a1".repeat(16);
const SESSION_ID = "e2e-session";
const SANDBOX_TOKEN = "placeholder-sandbox-token";
const SECRET_VALUE = "placeholder-api-key-value";
const DATABASE = "app-inventory--prod-db";

const fake = createFakeCloudflare({
  accountId: "acct-test",
  zoneId: "zone-test",
  appsDomain: APPS_DOMAIN,
  policyId: "policy-visitors",
  floorAppId: "floor-app",
  scriptPrefix: "app-",
  dispatchNamespace: "apps-namespace",
  dispatcherService: "apps-dispatcher",
  apiToken: "placeholder-apps-api-token",
});
const brokerEnv: BrokerEnv = {
  APPS_ACCOUNT_ID: "acct-test",
  APPS_ZONE_ID: "zone-test",
  APPS_DOMAIN,
  APPS_SCRIPT_PREFIX: "app-",
  APPS_HOSTING_BACKEND: BACKEND,
  ...(BACKEND === "dispatch-namespace"
    ? { APPS_DISPATCH_NAMESPACE: "apps-namespace", APPS_DISPATCHER_SERVICE: "apps-dispatcher" }
    : {}),
  APPS_ACCESS_TEAM_DOMAIN: "https://example-team.cloudflareaccess.com",
  APPS_ACCESS_POLICY_ID: "policy-visitors",
  APPS_ACCESS_FLOOR_APP_ID: "floor-app",
  APP_DATA_JURISDICTION: "",
  APPS_API_TOKEN: "placeholder-apps-api-token",
  SERVICE_AUTH_SECRET_CONTROL_PLANE: BROKER_SECRET,
};
const broker = createBrokerApp({
  guard: {
    modules: [
      { name: "guard.mjs", source: "export { default } from './guard-core.mjs';\n" },
      { name: "guard-core.mjs", source: "export default {};\n" },
    ],
    userModuleName: "app.mjs",
  },
  fetch: (request) => fake.fetch(request),
  sleep: async () => {},
  apiBaseUrl: FAKE_CLOUDFLARE_API_BASE_URL,
});

const brokerCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin !== BROKER_ORIGIN) return realFetch(input, init);
  const path = new URL(request.url).pathname;
  brokerCalls.push(
    path === "/data"
      ? `/data ${(JSON.parse(await request.clone().text()) as { op: string }).op}`
      : path
  );
  assert.equal(request.headers.get("cf-access-client-id"), "placeholder-client-id");
  return broker.fetch(request, brokerEnv);
}) as typeof fetch;

const dataDir = mkdtempSync(join(tmpdir(), "u8-e2e-"));
const config = {
  DEPLOYMENT_NAME: "e2e",
  GITHUB_BOT_USERNAME: "open-inspect[bot]",
  TOKEN_ENCRYPTION_KEY: KEY,
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY: KEY,
  REPO_SECRETS_ENCRYPTION_KEY: KEY,
  LOG_LEVEL: "error",
  MODAL_API_SECRET: "placeholder-modal-secret",
  MODAL_WORKSPACE: "e2e",
  APP_BROKER_URL: BROKER_ORIGIN,
  APPS_DOMAIN,
  SERVICE_AUTH_SECRET_APP_BROKER: BROKER_SECRET,
  APP_BROKER_ACCESS_CLIENT_ID: "placeholder-client-id",
  APP_BROKER_ACCESS_CLIENT_SECRET: "placeholder-client-secret",
};

const session = openSessionStore({ dataDir, sessionId: SESSION_ID });
session.storage.sql.exec(
  "INSERT INTO sandbox (id, modal_sandbox_id, auth_token_hash, status, created_at) VALUES (?, ?, ?, 'ready', 1)",
  "sandbox-row",
  "sandbox-e2e",
  await hashToken(SANDBOX_TOKEN)
);
session.close();

const host = await startNodeHost({
  config,
  settings: {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    migrationsDir: join(worktree, "terraform/d1/migrations"),
    shutdownTimeoutMs: 5_000,
  },
  objectStorage: { bucket: "media", region: "us-east-1" },
});
const db = createNodeSqlDatabase(new DatabaseSync(join(dataDir, "global.db")));

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(directory, entry.name))
      : [readFileSync(join(directory, entry.name), "utf8")]
  );
}

try {
  await db
    .prepare(
      "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'Owner', 1, 1)"
    )
    .bind(OWNER)
    .run();
  await new SessionIndexStore(db).create({
    id: SESSION_ID,
    title: null,
    repoOwner: "acme/platform",
    repoName: "inventory",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: "active",
    ownerTeamId: null,
    visibility: "workspace",
    userId: OWNER,
    createdAt: 1,
    updatedAt: 1,
  });

  const project = mkdtempSync(join(tmpdir(), "u8-e2e-app-"));
  mkdirSync(join(project, "dist"), { recursive: true });
  mkdirSync(join(project, "migrations"), { recursive: true });
  writeFileSync(join(project, "dist", "index.html"), "<h1>Inventory</h1>");
  writeFileSync(
    join(project, "worker.mjs"),
    [
      'const LIST = "SELECT id FROM items WHERE owner_sub = ?";',
      "export default {",
      "  async fetch(request, env) {",
      '    const sub = request.headers.get("x-openinspect-user-sub");',
      "    const items = await env.DB.prepare(LIST).bind(sub).all();",
      "    return Response.json({ items, keyed: Boolean(env.API_KEY) });",
      "  },",
      "};",
    ].join("\n")
  );
  writeFileSync(
    join(project, "openinspect.app.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "inventory",
      classification: "confidential",
      data: { DB: { kind: "d1" } },
      secrets: ["API_KEY"],
    })
  );
  writeFileSync(
    join(project, "migrations", "0001_create-items.sql"),
    "CREATE TABLE items (id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL);\nINSERT INTO items (id, owner_sub) VALUES ('seed', 'user-1');\n"
  );

  const python = (args: string[]) =>
    promisify(execFile)(
      "uv",
      [
        "run",
        "--frozen",
        "--extra",
        "dev",
        "--project",
        join(worktree, "packages/sandbox-runtime"),
        "python",
        ...args,
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          UV_NO_CONFIG: "1",
          CONTROL_PLANE_URL: `http://127.0.0.1:${host.address.port}`,
          SANDBOX_AUTH_TOKEN: SANDBOX_TOKEN,
          SESSION_CONFIG: JSON.stringify({ sessionId: SESSION_ID }),
        },
      }
    );
  const toolOutputs: string[] = [];
  const runTool = async () => {
    const { stdout } = await python([
      "-m",
      "sandbox_runtime.app_deploy",
      "--args-json",
      JSON.stringify({ projectDir: project, assetsDir: "dist", workerFile: "worker.mjs" }),
    ]);
    toolOutputs.push(stdout);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  };

  const conformance = await python(["-m", "sandbox_runtime.conformance", "app-data"]).then(
    (result) => ({ code: 0, stdout: result.stdout }),
    (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout })
  );
  console.log("conformance on the app:", JSON.stringify(conformance));
  assert.deepEqual(conformance, { code: 0, stdout: "" });

  const missing = await runTool();
  console.log("deploy without the secret:", JSON.stringify(missing));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "secret_missing");
  assert.equal(fake.d1(DATABASE), null, "nothing is provisioned before a deploy can succeed");

  const apps = appsFromEnv(config, db);
  assert.ok(apps.ok);
  const owner = { userId: OWNER, scope: "own" as const, requestId: "e2e-ui" };
  const set = await apps.data.setSecrets({
    appName: "inventory" as never,
    stage: "production",
    secrets: { API_KEY: SECRET_VALUE },
    actor: owner,
  });
  assert.deepEqual(set, { ok: true, value: { keys: ["API_KEY"] } });

  const first = await runTool();
  console.log("first deploy:", JSON.stringify(first));
  assert.equal(first.ok, true, first.agentMessage);
  assert.deepEqual(first.bindings, ["API_KEY", "DB"]);
  const database = fake.d1(DATABASE);
  assert.ok(database, "the D1 database exists under its app- name");
  assert.deepEqual(database.tables, ["_openinspect_migrations", "items"]);
  const hostname = `inventory.${APPS_DOMAIN}`;
  const active = () =>
    BACKEND === "workers"
      ? (fake.script("app-inventory")?.activeVersion ?? null)
      : fake.dispatchScript("app-inventory");
  const bound = active()
    ?.bindings.map((binding) => `${binding.type}:${binding.name}`)
    .sort();
  console.log("script bindings:", JSON.stringify(bound));
  assert.ok(bound?.includes("d1:DB"));
  assert.ok(bound?.includes("secret_text:API_KEY"));
  assert.deepEqual(fake.violations, []);

  for (const text of [...toolOutputs, ...filesUnder(project)]) {
    assert.ok(!text.includes(SECRET_VALUE), "the secret never reaches the sandbox or the repo");
    assert.ok(!text.includes(database.uuid), "no database id reaches the sandbox or the repo");
  }

  const drop = "DROP TABLE items;\n";
  writeFileSync(join(project, "migrations", "0002_drop-items.sql"), drop);
  const held = await runTool();
  console.log("destructive deploy:", JSON.stringify(held));
  assert.equal(held.ok, false);
  assert.equal(held.reason, "destructive_migration_requires_approval");
  assert.deepEqual(fake.d1(DATABASE)?.tables, ["_openinspect_migrations", "items"]);

  const approved = await apps.data.approveMigration({
    appName: "inventory" as never,
    stage: "production",
    binding: "DB" as never,
    name: "0002_drop-items.sql",
    sha256: createHash("sha256").update(drop).digest("hex"),
    actor: owner,
  });
  assert.deepEqual(approved, { ok: true, value: { status: "approved" } });
  const callsBefore = brokerCalls.length;
  const afterApproval = await runTool();
  console.log("deploy after approval:", JSON.stringify(afterApproval));
  assert.equal(afterApproval.ok, true, afterApproval.agentMessage);
  assert.deepEqual(fake.d1(DATABASE)?.tables, ["_openinspect_migrations"]);
  assert.deepEqual(brokerCalls.slice(callsBefore), [
    "/data d1.bookmark",
    "/data d1.execute",
    "/deploy",
  ]);

  const summary = await apps.data.summary("inventory" as never);
  console.log(
    "migrations:",
    JSON.stringify(summary.migrations.map((m) => [m.name, m.status, m.classification]))
  );
  assert.deepEqual(
    summary.migrations.map((migration) => [migration.name, migration.status]),
    [
      ["0001_create-items.sql", "applied"],
      ["0002_drop-items.sql", "applied"],
    ]
  );
  assert.equal(summary.classification, "confidential");

  const down = await takeDownApp(apps.deps, {
    name: "inventory" as never,
    actor: { userId: OWNER, scope: "own" },
    reason: "End of the e2e run",
    signal: new AbortController().signal,
  });
  assert.ok(down.ok && down.cleanupComplete);
  assert.equal(fake.domainFor(hostname), null);
  const retired = await apps.data.summary("inventory" as never);
  assert.deepEqual(
    retired.resources.map((resource) => resource.status),
    ["retired"]
  );
  assert.ok(fake.d1(DATABASE), "takedown keeps the data for its retention window");
  assert.deepEqual(await apps.data.purgeDue(50), { purged: 0, emptying: 0, failed: 0 });

  await db.prepare("UPDATE app_data_resources SET purge_after = 0").run();
  assert.deepEqual(await apps.data.purgeDue(50), { purged: 1, emptying: 0, failed: 0 });
  assert.equal(fake.d1(DATABASE), null, "purged after the window");

  const ledger = await db
    .prepare(
      "SELECT kind || ':' || result AS entry FROM app_data_operations ORDER BY occurred_at, rowid"
    )
    .all<{ entry: string }>();
  console.log("ledger:", JSON.stringify(ledger.results.map((row) => row.entry)));
  assert.ok(!JSON.stringify(ledger.results).includes(SECRET_VALUE));
  console.log("broker calls:", JSON.stringify(brokerCalls));
  console.log("fake violations:", JSON.stringify(fake.violations));
  assert.deepEqual(fake.violations, []);
  console.log(`E2E PASS (${BACKEND})`);
  rmSync(project, { recursive: true, force: true });
} finally {
  await host.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
}
