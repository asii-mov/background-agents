import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppName } from "@open-inspect/shared/apps";
import { BUILT_IN_ROLE_REGISTRY, type BuiltInRoleKey } from "@open-inspect/shared/rbac";
import type { AppDataBinding, BindingName } from "@open-inspect/shared/types/app-data";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionIndexStore } from "../db/session-index";
import { TeamMembershipStore } from "../db/team-memberships";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import type { DeployRequestBody } from "./bundle";
import {
  deployApp,
  getApp,
  listApps,
  releaseHold,
  takeDownApp,
  type AppDataSeam,
  type AppsDeps,
} from "./deploy";
import {
  createFakeAppHost,
  FAKE_APPS_DOMAIN,
  type FakeAppHost,
} from "./fake-app-host.test-support";
import { AppHostError } from "./host";
import { ABANDONED_DEPLOYMENT_AGE_MS } from "./store";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

const NOTES = "notes" as AppName;
const MANAGER = () => true;

function body(name: AppName = NOTES): DeployRequestBody {
  const bytes = new TextEncoder().encode("<h1>notes</h1>");
  return {
    name,
    bundle: {
      assets: [{ path: "/index.html" as never, bytes }],
      worker: null,
      notFoundHandling: "single-page-application",
      bytes: bytes.byteLength,
      sha256: "a".repeat(64),
    },
    data: { manifest: null, migrations: new Map() },
  };
}

interface RecordingData extends AppDataSeam {
  bindings: AppDataBinding[];
  blocked: Awaited<ReturnType<AppDataSeam["prepare"]>> | null;
  retired: AppName[];
}

function recordingData(): RecordingData {
  const data: RecordingData = {
    bindings: [],
    blocked: null,
    retired: [],
    async prepare({ app }) {
      if (data.blocked) return data.blocked;
      return {
        kind: "ready",
        bindings: {
          appName: app.name,
          stage: "production",
          classification: "internal",
          bindings: data.bindings,
          dataDigest: "b".repeat(64),
        },
        advisories: [],
      };
    },
    async retire(name) {
      data.retired.push(name);
    },
  };
  return data;
}

describe("app deploy and takedown", () => {
  let db: NodeSqlDatabase;
  let host: FakeAppHost;
  let data: RecordingData;
  let clock: number;
  let deps: AppsDeps;

  beforeEach(() => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite, MIGRATIONS_DIR);
    db = createNodeSqlDatabase(sqlite);
    host = createFakeAppHost();
    data = recordingData();
    clock = 1_700_000_000_000;
    deps = { db, host, appData: data, appsDomain: FAKE_APPS_DOMAIN, now: () => clock++ };
  });

  async function user(id: string, role: BuiltInRoleKey = "member") {
    await db
      .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .bind(id, `User ${id}`)
      .run();
    await db
      .prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY[role].id, id)
      .run();
    return id;
  }

  async function team(id: string, members: string[]) {
    await db
      .prepare(
        "INSERT INTO teams (id, slug, name, default_visibility, created_at, updated_at) VALUES (?, ?, ?, 'team', 1, 1)"
      )
      .bind(id, id, id)
      .run();
    for (const member of members) await new TeamMembershipStore(db).add(id, member);
    return id;
  }

  async function session(userId: string | null, ownerTeamId: string | null = null) {
    const id = `session-${crypto.randomUUID()}`;
    await new SessionIndexStore(db).create({
      id,
      title: null,
      repoOwner: "acme/platform",
      repoName: "notes",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "created",
      ownerTeamId,
      visibility: "workspace",
      userId,
      createdAt: 1,
      updatedAt: 1,
    });
    return id;
  }

  const deploy = (sessionId: string, request = body()) =>
    deployApp(deps, {
      sessionId,
      requestId: "request",
      body: request,
      signal: new AbortController().signal,
    });

  const takedown = (name: AppName, userId: string, scope: "own" | "any") =>
    takeDownApp(deps, {
      name,
      actor: { userId, scope },
      reason: "No longer needed",
      signal: new AbortController().signal,
    });

  it("publishes, then redeploys as version 2 with one live deployment", async () => {
    const alice = await session(await user("alice"));

    const first = await deploy(alice);
    const second = await deploy(alice);

    expect(first).toMatchObject({
      ok: true,
      url: "https://notes.apps.example.test",
      version: 1,
      firstDeploy: true,
    });
    expect(second).toMatchObject({ ok: true, version: 2, firstDeploy: false });
    const app = await getApp(deps, NOTES, MANAGER);
    expect(app?.app).toMatchObject({
      status: "live",
      version: 2,
      owner: { userId: "alice", displayName: "User alice", teamId: null },
      lastRepo: { owner: "acme/platform", name: "notes" },
      takedown: null,
    });
    expect(app?.deployments.map((row) => [row.version, row.status])).toEqual([
      [2, "live"],
      [1, "superseded"],
    ]);
  });

  it("refuses another owner's name without calling the host", async () => {
    await deploy(await session(await user("alice")));

    const outcome = await deploy(await session(await user("bob")));

    expect(outcome).toMatchObject({ ok: false, reason: "name_taken" });
    expect(host.calls.filter((call) => call.op === "deploy")).toHaveLength(1);
    expect((await getApp(deps, NOTES, MANAGER))?.app.owner.userId).toBe("alice");
  });

  it("lets a teammate redeploy a team-owned app", async () => {
    const [alice, bob] = [await user("alice"), await user("bob")];
    const platform = await team("platform", [alice, bob]);
    await deploy(await session(alice, platform));

    const outcome = await deploy(await session(bob));

    expect(outcome).toMatchObject({ ok: true, version: 2 });
    expect((await getApp(deps, NOTES, MANAGER))?.app.owner).toMatchObject({
      userId: "alice",
      teamId: "platform",
    });
  });

  it("gives a contested new name to exactly one owner", async () => {
    const sessions = [await session(await user("alice")), await session(await user("bob"))];

    const outcomes = await Promise.all(sessions.map((id) => deploy(id)));

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => !outcome.ok && outcome.reason === "name_taken")
    ).toHaveLength(1);
  });

  it("denies a session owner without apps.deploy and a session without an owner", async () => {
    const viewer = await deploy(await session(await user("victor", "viewer")));
    const ownerless = await deploy(await session(null));

    expect(viewer).toMatchObject({ ok: false, reason: "permission_denied" });
    expect(ownerless).toMatchObject({ ok: false, reason: "permission_denied" });
    expect(host.calls).toEqual([]);
    expect(await listApps(deps, MANAGER)).toEqual([]);
  });

  it("records a refused publish as failed and commits nothing", async () => {
    host.deployFailures.push(new AppHostError("access_guard_failed", "floor missing"));

    const outcome = await deploy(await session(await user("alice")));

    expect(outcome).toMatchObject({ ok: false, reason: "access_guard_failed" });
    expect(outcome.ok === false && outcome.message).not.toContain("floor missing");
    const app = await getApp(deps, NOTES, MANAGER);
    expect(app?.app).toMatchObject({
      status: "failed",
      version: 0,
      lastErrorReason: "access_guard_failed",
    });
    expect(app?.deployments).toMatchObject([
      { version: 1, status: "failed", failureReason: "access_guard_failed" },
    ]);
  });

  it("reports a transient hosting failure, then converges when deployed again", async () => {
    const alice = await session(await user("alice"));
    host.deployFailures.push(new AppHostError("upstream_unavailable", "edge 502", 5));

    const failed = await deploy(alice);
    const retried = await deploy(alice);

    expect(failed).toMatchObject({
      ok: false,
      reason: "hosting_unavailable",
      retryAfterSeconds: 5,
    });
    expect(retried).toMatchObject({ ok: true, version: 2 });
    expect((await getApp(deps, NOTES, MANAGER))?.deployments.map((row) => row.status)).toEqual([
      "live",
      "failed",
    ]);
  });

  it("relays the broker's script rejection message to the agent", async () => {
    host.deployFailures.push(new AppHostError("script_rejected", "Uncaught SyntaxError at line 3"));

    const outcome = await deploy(await session(await user("alice")));

    expect(outcome).toMatchObject({
      ok: false,
      reason: "hosting_rejected_script",
      message: "Uncaught SyntaxError at line 3",
    });
  });

  it("keeps the live version serving when a redeploy fails", async () => {
    const alice = await session(await user("alice"));
    await deploy(alice);
    host.deployFailures.push(new AppHostError("hostname_conflict", "taken"));

    expect(await deploy(alice)).toMatchObject({ ok: false, reason: "hostname_conflict" });
    expect((await getApp(deps, NOTES, MANAGER))?.app).toMatchObject({
      status: "live",
      version: 1,
      lastErrorReason: "hostname_conflict",
    });
  });

  it("refuses to commit a redeploy once the hosting backend changed", async () => {
    const alice = await session(await user("alice"));
    await deploy(alice);
    host.backend = "dispatch-namespace";

    expect(await deploy(alice)).toMatchObject({ ok: false, reason: "hosting_backend_changed" });
    expect((await getApp(deps, NOTES, MANAGER))?.app).toMatchObject({
      status: "live",
      version: 1,
      backend: "workers",
    });
  });

  it("passes resolved data bindings to the host and reports their names", async () => {
    data.bindings = [
      { kind: "d1", name: "DB" as BindingName, databaseId: "db-1" },
      { kind: "kv", name: "CACHE" as BindingName, namespaceId: "kv-1" },
    ];

    const outcome = await deploy(await session(await user("alice")));

    expect(outcome).toMatchObject({ ok: true, bindings: ["DB", "CACHE"] });
    expect(host.published.get(NOTES)?.bindings).toEqual(["DB", "CACHE"]);
  });

  it("stops before the host when app data blocks the deploy", async () => {
    data.blocked = {
      kind: "blocked",
      reason: "secret_missing",
      message: "Set STRIPE_KEY",
      detail: { missing: ["STRIPE_KEY"] },
    };

    const outcome = await deploy(await session(await user("alice")));

    expect(outcome).toEqual({
      ok: false,
      reason: "secret_missing",
      message: "Set STRIPE_KEY",
      detail: { missing: ["STRIPE_KEY"] },
    });
    expect(host.calls).toEqual([]);
    expect((await getApp(deps, NOTES, MANAGER))?.deployments).toMatchObject([
      { status: "failed", failureReason: "secret_missing" },
    ]);
  });

  it("sweeps whatever a deploy attached when a takedown raced it", async () => {
    const admin = await user("ada", "administrator");
    const alice = await session(await user("alice"));
    host.afterPublish = async (name) => {
      host.afterPublish = undefined;
      await takedown(name, admin, "any");
    };

    const outcome = await deploy(alice);

    expect(outcome).toMatchObject({ ok: false, reason: "app_taken_down" });
    expect(host.published.has(NOTES)).toBe(false);
    const app = await getApp(deps, NOTES, MANAGER);
    expect(app?.app).toMatchObject({
      status: "taken_down",
      takedown: { kind: "admin_takedown", cleanupComplete: true },
    });
    expect(app?.deployments).toMatchObject([{ status: "taken_down" }]);
  });

  it("blocks redeploys after an administrator's takedown until an administrator releases it", async () => {
    const admin = await user("ada", "administrator");
    const alice = await user("alice");
    await deploy(await session(alice));

    const down = await takedown(NOTES, admin, "any");
    const blocked = await deploy(await session(alice));
    const ownerRelease = await releaseHold(deps, { name: NOTES, actor: { scope: "own" } });
    const adminRelease = await releaseHold(deps, { name: NOTES, actor: { scope: "any" } });
    const redeployed = await deploy(await session(alice));

    expect(down).toMatchObject({
      ok: true,
      cleanupComplete: true,
      app: { status: "taken_down", takedown: { kind: "admin_takedown", byUserId: "ada" } },
    });
    expect(data.retired).toEqual([NOTES]);
    expect(blocked).toMatchObject({ ok: false, reason: "app_taken_down" });
    expect(ownerRelease).toEqual({ ok: false, reason: "forbidden" });
    expect(adminRelease).toMatchObject({ ok: true, app: { status: "pending", takedown: null } });
    expect(redeployed).toMatchObject({ ok: true, version: 2 });
    expect(host.published.has(NOTES)).toBe(true);
  });

  it("lets an owner redeploy after unpublishing their own app", async () => {
    const alice = await user("alice");
    await deploy(await session(alice));

    const down = await takedown(NOTES, alice, "own");
    const redeployed = await deploy(await session(alice));

    expect(down).toMatchObject({ ok: true, app: { takedown: { kind: "owner_unpublished" } } });
    expect(redeployed).toMatchObject({ ok: true, version: 2 });
    expect((await getApp(deps, NOTES, MANAGER))?.app).toMatchObject({
      status: "live",
      takedown: null,
    });
  });

  it("never lets an owner's unpublish replace an administrator's hold", async () => {
    const admin = await user("ada", "administrator");
    const alice = await user("alice");
    await deploy(await session(alice));

    await takedown(NOTES, admin, "any");
    await takedown(NOTES, alice, "own");

    expect((await getApp(deps, NOTES, MANAGER))?.app.takedown).toMatchObject({
      kind: "admin_takedown",
      byUserId: "ada",
    });
    expect(await deploy(await session(alice))).toMatchObject({ reason: "app_taken_down" });
  });

  it("reports a partial sweep, and running takedown again completes it", async () => {
    const alice = await user("alice");
    await deploy(await session(alice));
    host.takedownStops.push("remove_script");

    const partial = await takedown(NOTES, alice, "own");
    const early = await releaseHold(deps, { name: NOTES, actor: { scope: "own" } });
    const finished = await takedown(NOTES, alice, "own");

    expect(partial).toMatchObject({
      ok: true,
      cleanupComplete: false,
      failedStep: "remove_script",
      app: { takedown: { cleanupComplete: false } },
    });
    expect(data.retired).toEqual([NOTES]);
    expect(early).toEqual({ ok: false, reason: "sweep_incomplete" });
    expect(finished).toMatchObject({ ok: true, cleanupComplete: true });
    expect(finished.ok && "failedStep" in finished).toBe(false);
    expect(host.published.has(NOTES)).toBe(false);
  });

  it("treats an unreachable broker during takedown as cleanup still to do", async () => {
    const alice = await user("alice");
    await deploy(await session(alice));
    host.takedownStops.push(new AppHostError("network", "unreachable"));

    expect(await takedown(NOTES, alice, "own")).toMatchObject({
      ok: true,
      cleanupComplete: false,
      app: { status: "taken_down" },
    });
    expect(data.retired).toEqual([]);
  });

  it("allows one deploy of an app at a time and reclaims an abandoned one", async () => {
    const alice = await session(await user("alice"));
    await deploy(alice);
    await db
      .prepare(
        `INSERT INTO app_deployments (id, app_name, version, status, bundle_sha256, has_worker,
           asset_count, bundle_bytes, user_id, created_at)
         VALUES ('crashed', 'notes', 2, 'pending', ?, 0, 1, 1, 'alice', ?)`
      )
      .bind("c".repeat(64), clock)
      .run();

    const busy = await deploy(alice);
    clock += ABANDONED_DEPLOYMENT_AGE_MS;
    const reclaimed = await deploy(alice);

    expect(busy).toMatchObject({ ok: false, reason: "hosting_unavailable" });
    expect(reclaimed).toMatchObject({ ok: true, version: 3 });
    expect((await getApp(deps, NOTES, MANAGER))?.deployments).toMatchObject([
      { version: 3, status: "live" },
      { version: 2, status: "failed", failureReason: "deadline_exceeded" },
      { version: 1, status: "superseded" },
    ]);
  });

  it("lists every app with its derived URL", async () => {
    await deploy(await session(await user("alice")));
    await deploy(await session(await user("bob")), body("budget" as AppName));

    expect(
      (await listApps(deps, MANAGER)).map((app) => [app.name, app.url, app.owner.userId])
    ).toEqual([
      ["budget", "https://budget.apps.example.test", "bob"],
      ["notes", "https://notes.apps.example.test", "alice"],
    ]);
  });
});
