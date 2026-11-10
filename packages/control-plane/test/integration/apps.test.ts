import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brokerDeployRequestSchema } from "@open-inspect/shared/app-broker";
import type { BuiltInRoleKey } from "@open-inspect/shared/rbac";
import {
  SERVICE_SIGNATURE_HEADER,
  sha256Hex,
  verifyServiceSignature,
} from "@open-inspect/shared/service-auth";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSessionDO,
  routeRequest,
  seedActiveUser,
  seedSandboxAuth,
  serviceRequestHeaders,
} from "./helpers";
import { seedTeam } from "./ownership-test-helpers";

const ALICE = "a1".repeat(16);
const BOB = "b2".repeat(16);
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

/** The broker as the control plane sees it: verifies sig1 and the request schema, then answers. */
function fakeBroker() {
  const requests: Array<{ path: string; json: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        headers: { "content-type": headers["Content-Type"] },
      }).formData();
      const request = brokerDeployRequestSchema.parse(JSON.parse(form.get("request") as string));
      requests.push({ path: url.pathname, json: request });
      return Response.json({
        url: `https://${request.name}.${HOSTING.APPS_DOMAIN}`,
        backend: "workers",
        cfVersionId: `cf-${requests.length}`,
        accessAud: `aud-${request.name}`,
        firstDeploy: requests.length === 1,
      });
    }
    const json = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    requests.push({ path: url.pathname, json });
    return Response.json({ cleanupComplete: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

async function sandboxSession(userId: string) {
  const sessionName = `apps-${crypto.randomUUID()}`;
  const { stub } = await initNamedSessionDO(sessionName, { userId });
  const token = `sandbox-token-${crypto.randomUUID()}`;
  await seedSandboxAuth(stub, { authToken: token, sandboxId: `sandbox-${sessionName}` });
  await new SessionIndexStore(env.DB).create({
    id: sessionName,
    ownerTeamId: null,
    visibility: "workspace",
    title: null,
    repoOwner: "acme",
    repoName: "web-app",
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

function deployRequest(sessionName: string, token: string, app?: Record<string, unknown>): Request {
  const form = new FormData();
  form.append(
    "manifest",
    JSON.stringify({
      name: "notes",
      assets: [{ path: "/index.html", part: "a0" }],
      worker: null,
      app: app ? { part: "app" } : null,
      migrations: [],
    })
  );
  if (app) form.append("app", new File([JSON.stringify(app)], "app"));
  form.append("a0", new File(["<h1>notes</h1>"], "a0"));
  return new Request(`https://test.local/sessions/${sessionName}/apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

async function seedLiveApp(name: string, ownerUserId: string, ownerTeamId: string | null = null) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO apps (name, owner_user_id, owner_team_id, status, backend, version, cf_version_id,
         last_deployed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'live', 'workers', 1, 'cf-1', 1, 1, 1)`
    ).bind(name, ownerUserId, ownerTeamId),
    env.DB.prepare(
      `INSERT INTO app_deployments (id, app_name, version, status, bundle_sha256, has_worker,
         asset_count, bundle_bytes, cf_version_id, user_id, created_at, finished_at)
       VALUES (?, ?, 1, 'live', ?, 0, 1, 1, 'cf-1', ?, 1, 1)`
    ).bind(`deployment-${name}`, name, "a".repeat(64), ownerUserId),
  ]);
}

describe("apps", () => {
  beforeEach(cleanD1Tables);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("migration 0105", () => {
    beforeEach(() => seedActiveUser(ALICE));

    it.each([
      ["taken down without a hold", "status, created_at, updated_at", "'taken_down', 1, 1"],
      [
        "held while pending",
        "status, hold_kind, hold_at, hold_by, hold_reason, created_at, updated_at",
        `'pending', 'admin_takedown', 1, '${ALICE}', 'x', 1, 1`,
      ],
      [
        "live without a version",
        "status, backend, last_deployed_at, created_at, updated_at",
        "'live', 'workers', 1, 1, 1",
      ],
      [
        "swept without a hold",
        "status, sweep_completed_at, created_at, updated_at",
        "'pending', 1, 1, 1",
      ],
      [
        "a repo owner without a name",
        "status, last_repo_owner, created_at, updated_at",
        "'pending', 'acme', 1, 1",
      ],
    ])("refuses an app %s", async (_case, columns, values) => {
      await expect(
        env.DB.prepare(
          `INSERT INTO apps (name, owner_user_id, ${columns}) VALUES ('notes', ?, ${values})`
        )
          .bind(ALICE)
          .run()
      ).rejects.toThrow(/CHECK constraint failed/);
    });

    it("holds one live and one pending deployment per app", async () => {
      await seedLiveApp("notes", ALICE);
      const deployment = (id: string, version: number, status: string) =>
        env.DB.prepare(
          `INSERT INTO app_deployments (id, app_name, version, status, bundle_sha256, has_worker,
             asset_count, bundle_bytes, cf_version_id, user_id, created_at, finished_at)
           VALUES (?, 'notes', ?, ?, ?, 0, 1, 1, 'cf-x', ?, 1, ?)`
        )
          .bind(id, version, status, "a".repeat(64), ALICE, status === "pending" ? null : 1)
          .run();

      await expect(deployment("second-live", 2, "live")).rejects.toThrow(/UNIQUE/);
      await deployment("pending", 2, "pending");
      await expect(deployment("second-pending", 3, "pending")).rejects.toThrow(/UNIQUE/);
      await expect(deployment("same-version", 2, "failed")).rejects.toThrow(/constraint failed/);
    });

    it("grants the catalogue editor role the member app permissions", async () => {
      const rows = await env.DB.prepare(
        "SELECT permission_id FROM role_permissions WHERE role_id = 'role_fork_catalog_editor' AND permission_id LIKE 'apps.%' ORDER BY permission_id"
      ).all<{ permission_id: string }>();
      expect(rows.results.map((row) => row.permission_id)).toEqual([
        "apps.deploy",
        "apps.manage.own",
        "apps.read",
      ]);
    });
  });

  describe("POST /sessions/:id/apps", () => {
    it("publishes through the broker and lists the app as live", async () => {
      await seedActiveUser(ALICE);
      const { sessionName, token } = await sandboxSession(ALICE);
      const broker = fakeBroker();

      const response = await call(deployRequest(sessionName, token));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        name: "notes",
        url: "https://notes.apps.example.test",
        version: 1,
        firstDeploy: true,
      });
      expect(broker.requests).toMatchObject([
        { path: "/deploy", json: { name: "notes", assets: [{ path: "/index.html" }] } },
      ]);
      const listed = await asUser("/apps", { userId: BOB, role: "member" });
      await expect(listed.json()).resolves.toMatchObject({
        apps: [{ name: "notes", status: "live", url: "https://notes.apps.example.test" }],
      });
      const detail = await asUser("/apps/notes", { userId: BOB, role: "member" });
      await expect(detail.json()).resolves.toMatchObject({
        app: { owner: { userId: ALICE } },
        deployments: [{ version: 1, status: "live", requestedBy: { sessionId: sessionName } }],
      });
    });

    it("refuses a sandbox token issued for another session", async () => {
      await seedActiveUser(ALICE);
      const mine = await sandboxSession(ALICE);
      const other = await sandboxSession(ALICE);
      const broker = fakeBroker();

      const response = await call(deployRequest(other.sessionName, mine.token));

      expect(response.status).toBe(401);
      expect(broker.fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a user's credentials on the sandbox route", async () => {
      await seedActiveUser(ALICE);
      const { sessionName } = await sandboxSession(ALICE);
      const url = `https://test.local/sessions/${sessionName}/apps`;
      const headers = await serviceRequestHeaders(url, {
        method: "POST",
        as: { userId: ALICE, role: "owner" },
      });

      const response = await call(new Request(url, { method: "POST", headers }));

      expect(response.status).toBe(401);
    });

    it("answers feature_unavailable when hosting is not configured", async () => {
      await seedActiveUser(ALICE);
      const { sessionName, token } = await sandboxSession(ALICE);

      const deploy = await call(deployRequest(sessionName, token), false);
      const list = await asUser("/apps", { userId: ALICE, role: "member" }, {}, false);

      expect(deploy.status).toBe(503);
      await expect(deploy.json()).resolves.toMatchObject({
        ok: false,
        reason: "feature_unavailable",
      });
      expect(list.status).toBe(503);
    });
  });

  describe("GET /apps", () => {
    it("requires apps.read", async () => {
      expect((await asUser("/apps", { userId: VICTOR, role: "viewer" })).status).toBe(403);
    });

    describe("session and repository linkage", () => {
      beforeEach(async () => {
        for (const id of [ALICE, BOB, CAROL]) await seedActiveUser(id);
        await seedTeam("platform", [
          [ALICE, "member"],
          [BOB, "member"],
        ]);
        await seedLiveApp("notes", ALICE, "platform");
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE apps SET last_session_id = 'session-notes', last_repo_owner = 'acme',
               last_repo_name = 'notes' WHERE name = 'notes'`
          ),
          env.DB.prepare(
            "UPDATE app_deployments SET session_id = 'session-notes' WHERE app_name = 'notes'"
          ),
        ]);
      });

      async function viewAs(userId: string, role: BuiltInRoleKey) {
        const list = await asUser("/apps", { userId, role });
        const detail = await asUser("/apps/notes", { userId, role });
        expect([list.status, detail.status]).toEqual([200, 200]);
        const { apps } = await list.json<{ apps: Record<string, unknown>[] }>();
        const { app, deployments } = await detail.json<{
          app: Record<string, unknown>;
          deployments: { requestedBy: Record<string, unknown> }[];
        }>();
        return { listed: apps[0], app, requestedBy: deployments[0]?.requestedBy };
      }

      it.each([
        ["the owner", ALICE, "member"],
        ["a teammate of the owner team", BOB, "member"],
        ["an administrator", ADA, "administrator"],
      ] as const)("shows %s the deploying session and repository", async (_case, userId, role) => {
        const view = await viewAs(userId, role);

        for (const app of [view.listed, view.app]) {
          expect(app).toMatchObject({
            lastSessionId: "session-notes",
            lastRepo: { owner: "acme", name: "notes" },
          });
        }
        expect(view.requestedBy).toEqual({ userId: ALICE, sessionId: "session-notes" });
      });

      it("hides them from a member who cannot manage the app", async () => {
        const view = await viewAs(CAROL, "member");

        for (const app of [view.listed, view.app]) {
          expect(app).toMatchObject({ name: "notes", owner: { userId: ALICE } });
          expect(app).not.toHaveProperty("lastSessionId");
          expect(app).not.toHaveProperty("lastRepo");
        }
        expect(view.requestedBy).toEqual({ userId: ALICE });
      });
    });
  });

  describe("POST /apps/:name/takedown", () => {
    beforeEach(async () => {
      for (const id of [ALICE, BOB, CAROL]) await seedActiveUser(id);
      await seedTeam("platform", [
        [ALICE, "member"],
        [BOB, "member"],
      ]);
      await seedLiveApp("notes", ALICE, "platform");
      fakeBroker();
    });

    it.each([
      ["the owner", ALICE, "member", 200, "owner_unpublished"],
      ["a teammate of the owner team", BOB, "member", 200, "owner_unpublished"],
      ["an administrator", ADA, "administrator", 200, "admin_takedown"],
      ["another member", CAROL, "member", 403, null],
      ["a viewer", VICTOR, "viewer", 403, null],
    ] as const)("answers %s with %i", async (_case, userId, role, status, kind) => {
      const response = await asUser(
        "/apps/notes/takedown",
        { userId, role },
        { method: "POST", body: { reason: "Retired" } }
      );

      expect(response.status).toBe(status);
      if (kind) {
        await expect(response.json()).resolves.toMatchObject({
          cleanupComplete: true,
          app: { status: "taken_down", takedown: { kind, byUserId: userId } },
        });
      }
    });

    it("answers 404 for an app that does not exist", async () => {
      const response = await asUser(
        "/apps/missing/takedown",
        { userId: ALICE, role: "member" },
        { method: "POST", body: { reason: "Retired" } }
      );
      expect(response.status).toBe(404);
    });

    it("keeps an administrator's hold until an administrator releases it", async () => {
      await asUser(
        "/apps/notes/takedown",
        { userId: ADA, role: "administrator" },
        { method: "POST", body: { reason: "Policy breach" } }
      );

      const byOwner = await asUser(
        "/apps/notes/release-hold",
        { userId: ALICE, role: "member" },
        { method: "POST" }
      );
      const byAdmin = await asUser(
        "/apps/notes/release-hold",
        { userId: ADA, role: "administrator" },
        { method: "POST" }
      );

      expect(byOwner.status).toBe(403);
      expect(byAdmin.status).toBe(200);
      await expect(byAdmin.json()).resolves.toMatchObject({
        app: { status: "pending", takedown: null },
      });
    });
  });
});
