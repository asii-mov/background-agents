/**
 * End to end: the sandbox deploy-app tool (Python, as the OpenCode shim runs it) against the
 * control plane's POST /sessions/:id/apps on the Node host, whose broker client reaches the real
 * app broker Worker app, which talks to U1's fake Cloudflare. Then a takedown through apps/.
 * Asserts the fake recorded no ingress-invariant violation at any point.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// The control plane reaches the broker over the public internet; here, in process.
const brokerCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin !== BROKER_ORIGIN) return realFetch(input, init);
  brokerCalls.push(new URL(request.url).pathname);
  assert.equal(request.headers.get("cf-access-client-id"), "placeholder-client-id");
  return broker.fetch(request, brokerEnv);
}) as typeof fetch;

const dataDir = mkdtempSync(join(tmpdir(), "u5-e2e-"));
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

// A sandbox generation for the session, as the lifecycle leaves it once booted.
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

  const project = mkdtempSync(join(tmpdir(), "u5-e2e-app-"));
  mkdirSync(join(project, "dist", "assets"), { recursive: true });
  writeFileSync(join(project, "dist", "index.html"), "<h1>Inventory</h1>");
  writeFileSync(join(project, "dist", "assets", "app.js"), "console.log('inventory');");
  writeFileSync(join(project, "worker.mjs"), "export default { fetch: () => new Response('ok') };");
  writeFileSync(
    join(project, "openinspect.app.json"),
    JSON.stringify({ schemaVersion: 1, name: "inventory" })
  );

  // Async: the control plane answering the tool runs in this process.
  const runTool = async (args: Record<string, string>, token = SANDBOX_TOKEN) => {
    const { stdout } = await promisify(execFile)(
      "uv",
      [
        "run",
        "--frozen",
        "--extra",
        "dev",
        "--project",
        join(worktree, "packages/sandbox-runtime"),
        "python",
        "-m",
        "sandbox_runtime.app_deploy",
        "--args-json",
        JSON.stringify(args),
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          UV_NO_CONFIG: "1",
          CONTROL_PLANE_URL: `http://127.0.0.1:${host.address.port}`,
          SANDBOX_AUTH_TOKEN: token,
          SESSION_CONFIG: JSON.stringify({ sessionId: SESSION_ID }),
        },
      }
    );
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  };
  const args = { projectDir: project, assetsDir: "dist", workerFile: "worker.mjs" };

  const first = await runTool(args);
  console.log("first deploy:", JSON.stringify(first));
  assert.equal(first.ok, true, first.agentMessage);
  assert.equal(first.url, `https://inventory.${APPS_DOMAIN}`);
  assert.equal(first.firstDeploy, true);
  assert.equal(first.version, 1);
  assert.deepEqual(fake.violations, []);

  const hostname = `inventory.${APPS_DOMAIN}`;
  const access = fake.accessAppsFor(hostname);
  const active = () =>
    BACKEND === "workers"
      ? (fake.script("app-inventory")?.activeVersion ?? null)
      : fake.dispatchScript("app-inventory");
  assert.equal(access.length, 1);
  assert.deepEqual(access[0]!.policyIds, ["policy-visitors"]);
  assert.equal(
    fake.domainFor(hostname)?.service,
    BACKEND === "workers" ? "app-inventory" : "apps-dispatcher"
  );
  assert.equal(active()?.mainModule, "guard.mjs");
  assert.equal(active()?.vars.CF_ACCESS_AUD, access[0]!.aud);
  if (BACKEND === "workers") {
    assert.deepEqual(fake.script("app-inventory")?.subdomain, {
      enabled: false,
      previews_enabled: false,
    });
  }

  const second = await runTool(args);
  console.log("redeploy:", JSON.stringify(second));
  assert.equal(second.ok, true, second.agentMessage);
  assert.equal(second.version, 2);
  assert.equal(second.firstDeploy, false);

  const forged = await runTool(args, "placeholder-forged-token");
  console.log("forged sandbox token:", JSON.stringify(forged));
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, "bridge_error");
  assert.equal(brokerCalls.filter((path) => path === "/deploy").length, 2);

  const row = await db
    .prepare(
      "SELECT status, version, cf_version_id, backend, owner_user_id FROM apps WHERE name = 'inventory'"
    )
    .first<{
      status: string;
      version: number;
      cf_version_id: string;
      backend: string;
      owner_user_id: string;
    }>();
  const ledger = await db
    .prepare(
      "SELECT version, status, cf_version_id FROM app_deployments WHERE app_name = 'inventory' ORDER BY version"
    )
    .all<{ version: number; status: string; cf_version_id: string }>();
  console.log("apps row:", JSON.stringify(row));
  console.log("ledger:", JSON.stringify(ledger.results));
  assert.deepEqual(
    {
      status: row?.status,
      version: row?.version,
      backend: row?.backend,
      owner: row?.owner_user_id,
    },
    { status: "live", version: 2, backend: BACKEND, owner: OWNER }
  );
  assert.deepEqual(
    ledger.results.map((entry) => [entry.version, entry.status]),
    [
      [1, "superseded"],
      [2, "live"],
    ]
  );
  assert.equal(row?.cf_version_id, ledger.results[1]!.cf_version_id);
  console.log("served version:", JSON.stringify(active()));
  assert.equal(row?.cf_version_id, active()?.id);
  assert.deepEqual(fake.violations, []);

  const apps = appsFromEnv(config, db);
  assert.ok(apps.ok);
  const down = await takeDownApp(apps.deps, {
    name: "inventory" as never,
    actor: { userId: OWNER, scope: "own" },
    reason: "End of the e2e run",
    signal: new AbortController().signal,
  });
  console.log("takedown:", JSON.stringify(down));
  assert.ok(down.ok && down.cleanupComplete);
  assert.equal(fake.domainFor(hostname), null);
  assert.equal(fake.script("app-inventory"), null);
  assert.equal(fake.dispatchScript("app-inventory"), null);
  assert.deepEqual(fake.accessAppsFor(hostname), []);

  console.log("broker calls:", JSON.stringify(brokerCalls));
  console.log("fake violations:", JSON.stringify(fake.violations));
  assert.deepEqual(fake.violations, []);
  console.log(`E2E PASS (${BACKEND})`);
  rmSync(project, { recursive: true, force: true });
} finally {
  await host.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
}
