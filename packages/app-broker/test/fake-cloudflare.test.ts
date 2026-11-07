import { describe, expect, it } from "vitest";
import {
  type CloudflareClient,
  type SubdomainSetting,
  assetHash,
  createCloudflareClient,
  must,
} from "../scripts/live-smoke";
import {
  FAKE_CLOUDFLARE_API_BASE_URL,
  type FakeCloudflareOptions,
  createFakeCloudflare,
} from "./fake-cloudflare";

const OPTIONS: FakeCloudflareOptions = {
  accountId: "acct-test",
  zoneId: "zone-test",
  appsDomain: "apps.example.test",
  policyId: "policy-visitors",
  floorAppId: "floor-app",
  scriptPrefix: "app-",
  dispatchNamespace: "apps-namespace",
  dispatcherService: "apps-dispatcher",
  apiToken: "test-token",
};
const HOST = "inventory.apps.example.test";
const SCRIPT = "app-inventory";
const OFF: SubdomainSetting = { enabled: false, previews_enabled: false };

function setup(overrides: Partial<FakeCloudflareOptions> = {}) {
  const fake = createFakeCloudflare({ ...OPTIONS, ...overrides });
  const api = createCloudflareClient({
    baseUrl: FAKE_CLOUDFLARE_API_BASE_URL,
    accountId: OPTIONS.accountId,
    token: OPTIONS.apiToken ?? "",
    fetch: fake.fetch,
  });
  return { fake, api };
}

async function createAccessApp(
  api: CloudflareClient,
  hostname = HOST,
  policyId = OPTIONS.policyId
) {
  return must<{ id: string; aud: string }>(
    await api.request("POST", "/access/apps", {
      body: { type: "self_hosted", domain: hostname, policies: [{ id: policyId, precedence: 1 }] },
    }),
    "create Access app"
  );
}

function moduleVersion(aud: string, extra: Record<string, unknown> = {}) {
  return {
    main_module: "app.mjs",
    modules: [
      {
        name: "app.mjs",
        content_type: "application/javascript+module",
        content_base64: btoa("export default {}"),
      },
    ],
    bindings: [{ type: "plain_text", name: "CF_ACCESS_AUD", text: aud }],
    ...extra,
  };
}

async function deployWorker(
  api: CloudflareClient,
  options: { aud: string; subdomain?: SubdomainSetting; name?: string }
) {
  const name = options.name ?? SCRIPT;
  const worker = must<{ id: string }>(
    await api.request("POST", "/workers/workers", {
      body: { name, ...(options.subdomain ? { subdomain: options.subdomain } : {}) },
    }),
    "create Worker"
  );
  const version = must<{ id: string }>(
    await api.request("POST", `/workers/workers/${worker.id}/versions`, {
      body: moduleVersion(options.aud),
    }),
    "create version"
  );
  must(
    await api.request("POST", `/workers/scripts/${name}/deployments`, {
      body: { strategy: "percentage", versions: [{ version_id: version.id, percentage: 100 }] },
    }),
    "deploy"
  );
}

function attach(api: CloudflareClient, service = SCRIPT, hostname = HOST) {
  return api.request("PUT", "/workers/domains", {
    body: { hostname, service, zone_id: OPTIONS.zoneId },
  });
}

function putNamespaceScript(api: CloudflareClient, script: string, aud: string) {
  const form = new FormData();
  const { modules: _modules, ...metadata } = moduleVersion(aud);
  form.append("metadata", JSON.stringify(metadata));
  form.append("app.mjs", new File(["export default {}"], "app.mjs"));
  return api.request(
    "PUT",
    `/workers/dispatch/namespaces/${OPTIONS.dispatchNamespace}/scripts/${script}`,
    {
      form,
    }
  );
}

describe("ingress invariant", () => {
  it("records a custom domain attached without a per-app Access app", async () => {
    const { fake, api } = setup();
    await deployWorker(api, { aud: "unrelated-aud", subdomain: OFF });

    must(await attach(api), "attach");

    expect(fake.violations).toEqual([`domains.put: ${HOST}: no per-app Access app`]);
  });

  it("records a custom domain attached while the floor is missing", async () => {
    const { fake, api } = setup();
    const accessApp = await createAccessApp(api);
    await deployWorker(api, { aud: accessApp.aud, subdomain: OFF });
    fake.deleteFloor();

    must(await attach(api), "attach");

    expect(fake.violations).toEqual([
      `domains.put: ${HOST}: the *.domain floor Access app is missing`,
    ]);
  });

  it("records a plain Workers script with workers.dev or previews on", async () => {
    const { fake, api } = setup();
    const accessApp = await createAccessApp(api);
    await deployWorker(api, {
      aud: accessApp.aud,
      subdomain: { enabled: false, previews_enabled: true },
    });

    must(await attach(api), "attach");

    expect(fake.violations).toEqual([
      `domains.put: ${HOST}: workers.dev or preview URLs are enabled on ${SCRIPT}`,
    ]);
  });

  it("records a script whose CF_ACCESS_AUD is not the per-app Access AUD", async () => {
    const { fake, api } = setup();
    await createAccessApp(api);
    await deployWorker(api, { aud: "another-apps-aud", subdomain: OFF });

    must(await attach(api), "attach");

    expect(fake.violations).toEqual([
      `domains.put: ${HOST}: CF_ACCESS_AUD on ${SCRIPT} is not the per-app Access AUD`,
    ]);
  });

  it("records a per-app Access app carrying a policy other than the visitor policy", async () => {
    const { fake, api } = setup();
    const accessApp = await createAccessApp(api, HOST, "policy-everyone");
    await deployWorker(api, { aud: accessApp.aud, subdomain: OFF });

    must(await attach(api), "attach");

    expect(fake.violations).toEqual([
      `domains.put: ${HOST}: the per-app Access app does not carry exactly the visitor policy`,
    ]);
  });

  it("records revoking Access before detaching, and accepts detaching first", async () => {
    const { fake, api } = setup();
    const accessApp = await createAccessApp(api);
    await deployWorker(api, { aud: accessApp.aud, subdomain: OFF });
    const domain = must<{ id: string }>(await attach(api), "attach");
    expect(fake.violations).toEqual([]);

    must(await api.request("DELETE", `/workers/domains/${domain.id}`), "detach");
    must(await api.request("DELETE", `/access/apps/${accessApp.id}`), "revoke");
    expect(fake.violations).toEqual([]);

    const second = setup();
    const secondApp = await createAccessApp(second.api);
    await deployWorker(second.api, { aud: secondApp.aud, subdomain: OFF });
    must(await attach(second.api), "attach");
    must(await second.api.request("DELETE", `/access/apps/${secondApp.id}`), "revoke");
    expect(second.fake.violations).toEqual([`access.delete: ${HOST}: no per-app Access app`]);
  });

  it("checks the namespace script the dispatcher routes the hostname to", async () => {
    const { fake, api } = setup();
    const accessApp = await createAccessApp(api);
    must(await putNamespaceScript(api, SCRIPT, accessApp.aud), "upload namespace script");

    must(await attach(api, OPTIONS.dispatcherService), "attach to the dispatcher");
    expect(fake.violations).toEqual([]);
    expect(fake.dispatchScript(SCRIPT)?.vars.CF_ACCESS_AUD).toBe(accessApp.aud);

    must(await putNamespaceScript(api, SCRIPT, "another-apps-aud"), "re-upload namespace script");
    expect(fake.violations).toEqual([
      `dispatch.put: ${HOST}: CF_ACCESS_AUD on ${SCRIPT} is not the per-app Access AUD`,
    ]);
  });

  it("refuses a hostname with foreign DNS records and records overriding them", async () => {
    const { fake, api } = setup({ foreignHostnames: [HOST] });
    const accessApp = await createAccessApp(api);
    await deployWorker(api, { aud: accessApp.aud, subdomain: OFF });

    expect((await attach(api)).status).toBe(409);
    expect(fake.domainFor(HOST)).toBeNull();

    must(
      await api.request("PUT", "/workers/domains", {
        body: {
          hostname: HOST,
          service: SCRIPT,
          zone_id: OPTIONS.zoneId,
          override_existing_dns_record: true,
        },
      }),
      "override"
    );
    expect(fake.violations).toEqual([
      `domains.put: ${HOST}: overrode a DNS record the platform does not own`,
    ]);
  });

  it("records a request to an endpoint it does not model", async () => {
    const { fake, api } = setup();

    const response = await api.request("DELETE", `/workers/scrpts/${SCRIPT}`);

    expect(response.status).toBe(404);
    expect(fake.violations).toEqual([
      `unrouted request: DELETE /accounts/${OPTIONS.accountId}/workers/scrpts/${SCRIPT}`,
    ]);
  });
});

describe("injected failures", () => {
  it("returns the error status without applying the request", async () => {
    const { fake, api } = setup();
    fake.inject({ step: "workers.create", status: 503 });

    const failed = await api.request("POST", "/workers/workers", { body: { name: SCRIPT } });
    expect(failed).toMatchObject({ status: 503, success: false });
    expect(fake.script(SCRIPT)).toBeNull();

    must(await api.request("POST", "/workers/workers", { body: { name: SCRIPT } }), "retry");
    expect(fake.script(SCRIPT)).not.toBeNull();
  });

  it("sends Retry-After with a throttled response", async () => {
    const { fake, api } = setup();
    fake.inject({ step: "access.list", status: 429, retryAfterSeconds: 7 });

    const throttled = await api.request("GET", "/access/apps");

    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("7");
  });

  it("rejects fetch like a network error when the status is null", async () => {
    const { fake, api } = setup();
    fake.inject({ step: "access.create", status: null });

    await expect(createAccessApp(api)).rejects.toThrow(TypeError);
    expect(fake.accessAppsFor(HOST)).toEqual([]);
  });

  it("applies the request, then fails, with applyThenFail", async () => {
    const { fake, api } = setup();
    fake.inject({ step: "access.create", status: 500, applyThenFail: true });

    await expect(createAccessApp(api)).rejects.toThrow(/HTTP 500/);
    expect(fake.accessAppsFor(HOST)).toHaveLength(1);
  });

  it("fails as many matching requests as times says", async () => {
    const { fake, api } = setup();
    fake.inject({ step: "access.list", status: 502, times: 2 });

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await api.request("GET", "/access/apps")).status);
    }

    expect(statuses).toEqual([502, 502, 200]);
  });
});

describe("onStep", () => {
  it("runs the hook once, before the step takes effect", async () => {
    const { fake, api } = setup();
    const accessApp = await createAccessApp(api);
    await deployWorker(api, { aud: accessApp.aud, subdomain: OFF });
    let runs = 0;
    fake.onStep("domains.put", async () => {
      runs += 1;
      must(await api.request("DELETE", `/workers/scripts/${SCRIPT}`), "delete during attach");
    });

    expect((await attach(api)).status).toBe(404);
    expect(fake.domainFor(HOST)).toBeNull();

    await deployWorker(api, { aud: accessApp.aud, subdomain: OFF });
    must(await attach(api), "attach");
    expect(runs).toBe(1);
    expect(fake.calls.map((call) => call.step)).toContain("scripts.delete");
  });
});

describe("Workers subdomain setting", () => {
  it("gives a Worker created without a setting Cloudflare's default: both on", async () => {
    const { api } = setup();

    must(await api.request("POST", "/workers/workers", { body: { name: SCRIPT } }), "create");

    expect(must(await api.request("GET", `/workers/scripts/${SCRIPT}/subdomain`), "read")).toEqual({
      enabled: true,
      previews_enabled: true,
    });
  });

  it("honours newWorkerSubdomainDefault", async () => {
    const { api } = setup({ newWorkerSubdomainDefault: OFF });

    must(await api.request("POST", "/workers/workers", { body: { name: SCRIPT } }), "create");

    expect(must(await api.request("GET", `/workers/scripts/${SCRIPT}/subdomain`), "read")).toEqual(
      OFF
    );
  });

  it("makes previews follow workers.dev when the request does not set them", async () => {
    const { api } = setup();
    must(await api.request("POST", "/workers/workers", { body: { name: SCRIPT } }), "create");

    const updated = must(
      await api.request("POST", `/workers/scripts/${SCRIPT}/subdomain`, {
        body: { enabled: false },
      }),
      "disable"
    );

    expect(updated).toEqual(OFF);
  });
});

describe("static assets", () => {
  const files = {
    "/index.html": "<h1>inventory</h1>",
    "/app.js": "console.log('inventory')",
    "/style.css": "h1 { color: teal }",
  };
  const manifestOf = (entries: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(entries).map(([path, text]) => [
        path,
        { hash: assetHash(btoa(text), path), size: text.length },
      ])
    );

  it("asks only for hashes it lacks and completes after the last bucket", async () => {
    const { api } = setup({ assetsPerBucket: 2 });
    const manifest = manifestOf(files);
    const session = must<{ jwt: string; buckets: string[][] }>(
      await api.request("POST", `/workers/scripts/${SCRIPT}/assets-upload-session`, {
        body: { manifest },
      }),
      "start session"
    );
    expect(session.buckets.flat().sort()).toEqual(
      Object.values(manifest)
        .map((entry) => entry.hash)
        .sort()
    );
    expect(session.buckets.map((bucket) => bucket.length)).toEqual([2, 1]);

    const upload = (bucket: string[], bearer: string) => {
      const form = new FormData();
      for (const hash of bucket) {
        const [path] = Object.entries(manifest).find(([, entry]) => entry.hash === hash) ?? [];
        form.append(hash, btoa(files[path as keyof typeof files]));
      }
      return api.request("POST", "/workers/assets/upload", {
        form,
        query: { base64: "true" },
        bearer,
      });
    };
    expect((await upload(session.buckets[0], "test-token")).status).toBe(401);
    const first = await upload(session.buckets[0], session.jwt);
    expect(first).toMatchObject({ status: 202, success: true });
    const last = await upload(session.buckets[1], session.jwt);
    expect(last.status).toBe(201);

    const again = must<{ jwt: string; buckets: string[][] }>(
      await api.request("POST", `/workers/scripts/${SCRIPT}/assets-upload-session`, {
        body: { manifest },
      }),
      "start a second session"
    );
    expect(again.buckets).toEqual([]);
    const worker = must<{ id: string }>(
      await api.request("POST", "/workers/workers", { body: { name: SCRIPT, subdomain: OFF } }),
      "create"
    );
    must(
      await api.request("POST", `/workers/workers/${worker.id}/versions`, {
        body: moduleVersion("aud", {
          assets: { jwt: again.jwt, config: { run_worker_first: true } },
        }),
      }),
      "version with assets"
    );
  });

  it("rejects a manifest hash that is not 32 hex characters", async () => {
    const { api } = setup();

    const response = await api.request("POST", `/workers/scripts/${SCRIPT}/assets-upload-session`, {
      body: { manifest: { "/index.html": { hash: "not-a-hash", size: 3 } } },
    });

    expect(response.status).toBe(400);
  });

  it("refuses a completion token from another script's upload session", async () => {
    const { api } = setup();
    const otherSession = must<{ jwt: string; buckets: string[][] }>(
      await api.request("POST", "/workers/scripts/app-other/assets-upload-session", {
        body: { manifest: {} },
      }),
      "empty session"
    );
    const worker = must<{ id: string }>(
      await api.request("POST", "/workers/workers", { body: { name: SCRIPT, subdomain: OFF } }),
      "create"
    );

    const response = await api.request("POST", `/workers/workers/${worker.id}/versions`, {
      body: moduleVersion("aud", { assets: { jwt: otherSession.jwt } }),
    });

    expect(response.status).toBe(400);
  });
});

describe("D1", () => {
  async function createDatabase(api: CloudflareClient) {
    return must<{ uuid: string }>(
      await api.request("POST", "/d1/database", { body: { name: "app-inventory-db" } }),
      "create database"
    ).uuid;
  }
  const query = (api: CloudflareClient, id: string, sql: string) =>
    api.request("POST", `/d1/database/${id}/query`, { body: { sql } });

  it("rolls back every statement of a body when one fails, and commits a body that succeeds", async () => {
    const { fake, api } = setup();
    const id = await createDatabase(api);

    const failed = await query(
      api,
      id,
      "CREATE TABLE items (id INTEGER); INSERT INTO missing VALUES (1);"
    );
    expect(failed.status).toBe(400);
    expect(failed.errors[0]?.message).toContain("no such table: missing");
    expect(fake.d1(id)?.tables).toEqual([]);

    const applied = await query(
      api,
      id,
      "CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1);"
    );
    expect(applied.status).toBe(200);
    expect(applied.result).toHaveLength(2);
    expect(fake.d1(id)?.tables).toEqual(["items"]);
  });

  it("restores to a bookmark and to a timestamp, reporting the bookmark it replaced", async () => {
    const { fake, api } = setup();
    const id = await createDatabase(api);
    must(await query(api, id, "CREATE TABLE items (id INTEGER)"), "create items");
    const afterItems = must<{ bookmark: string }>(
      await api.request("GET", `/d1/database/${id}/time_travel/bookmark`),
      "bookmark"
    ).bookmark;
    fake.advanceTime(60_000);
    must(await query(api, id, "CREATE TABLE orders (id INTEGER)"), "create orders");
    const latest = must<{ bookmark: string }>(
      await api.request("GET", `/d1/database/${id}/time_travel/bookmark`),
      "bookmark"
    ).bookmark;

    const restored = must<{ bookmark: string; previous_bookmark: string }>(
      await api.request("POST", `/d1/database/${id}/time_travel/restore`, {
        query: { bookmark: afterItems },
      }),
      "restore"
    );
    expect(restored).toMatchObject({ bookmark: afterItems, previous_bookmark: latest });
    expect(fake.d1(id)?.tables).toEqual(["items"]);

    const atTimestamp = must<{ bookmark: string }>(
      await api.request("GET", `/d1/database/${id}/time_travel/bookmark`, {
        query: { timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 30)).toISOString() },
      }),
      "bookmark at timestamp"
    );
    expect(atTimestamp.bookmark).toBe(afterItems);
  });

  it("matches the list name filter as a substring, so callers must compare names exactly", async () => {
    const { fake, api } = setup();
    fake.seedD1("app-inventory");
    fake.seedD1("prod-app-inventory");

    const listed = must<{ name: string }[]>(
      await api.request("GET", "/d1/database", { query: { name: "app-inventory" } }),
      "list"
    );

    expect(listed.map((db) => db.name).sort()).toEqual(["app-inventory", "prod-app-inventory"]);
  });
});

describe("KV and R2", () => {
  it("pages KV namespaces and refuses a duplicate title", async () => {
    const { fake, api } = setup({ kvPageSize: 2 });
    for (const title of ["app-a", "app-b", "app-c"]) fake.seedKv(title);

    const firstPage = await api.request("GET", "/storage/kv/namespaces");
    const secondPage = await api.request("GET", "/storage/kv/namespaces", { query: { page: "2" } });
    const duplicate = await api.request("POST", "/storage/kv/namespaces", {
      body: { title: "app-a" },
    });

    expect((firstPage.result as unknown[]).length).toBe(2);
    expect((secondPage.result as { title: string }[]).map((ns) => ns.title)).toEqual(["app-c"]);
    expect(duplicate.status).toBe(400);
  });

  it("keeps R2 buckets per jurisdiction", async () => {
    const { api } = setup();
    const eu = { "cf-r2-jurisdiction": "eu" };
    must(
      await api.request("POST", "/r2/buckets", { body: { name: "app-files" }, headers: eu }),
      "create"
    );

    expect((await api.request("GET", "/r2/buckets/app-files")).status).toBe(404);
    expect((await api.request("GET", "/r2/buckets/app-files", { headers: eu })).status).toBe(200);
  });

  it("refuses to delete a bucket until its expire-all lifecycle rule has emptied it", async () => {
    const { fake, api } = setup();
    fake.seedR2("app-files", { objects: 3 });
    expect((await api.request("DELETE", "/r2/buckets/app-files")).status).toBe(409);

    must(
      await api.request("PUT", "/r2/buckets/app-files/lifecycle", {
        body: {
          rules: [
            {
              id: "oi-purge",
              enabled: true,
              conditions: { prefix: "" },
              deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
            },
          ],
        },
      }),
      "set lifecycle"
    );
    expect((await api.request("DELETE", "/r2/buckets/app-files")).status).toBe(409);
    fake.runR2Lifecycle();

    must(await api.request("DELETE", "/r2/buckets/app-files"), "delete");
    expect(fake.r2Bucket("app-files")).toBeNull();
  });
});
