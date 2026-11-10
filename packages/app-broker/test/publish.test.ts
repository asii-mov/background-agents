import { describe, expect, it } from "vitest";
import { CLOUDFLARE_API_MAX_ATTEMPTS } from "../src/cloudflare-api";
import { APP_DOMAIN_DNS_PUBLISH_WAIT_MS } from "../src/publish";
import {
  BACKENDS,
  FAKE_OPTIONS,
  TEAM_DOMAIN,
  activeVersion,
  createHarness,
  deployForm,
  expectServing,
  hostnameOf,
  scriptOf,
  signedRequest,
  type Harness,
} from "./broker-harness";
import type { FakeStep, InjectedFailure } from "./fake-cloudflare";

const NAME = "inventory";
const HOST = hostnameOf(NAME);
const SCRIPT = scriptOf(NAME);

async function deployOk(
  harness: Harness,
  input: Parameters<Harness["deploy"]>[0] = { name: NAME }
) {
  const response = await harness.deploy(input);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as {
    url: string;
    backend: string;
    cfVersionId: string;
    accessAud: string;
    firstDeploy: boolean;
  };
}

async function errorOf(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function seedAccessApp(harness: Harness, policies = [FAKE_OPTIONS.policyId]) {
  const response = await harness.fake.fetch(
    `https://api.cloudflare.fake.invalid/client/v4/accounts/${FAKE_OPTIONS.accountId}/access/apps`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_OPTIONS.apiToken}` },
      body: JSON.stringify({
        type: "self_hosted",
        domain: HOST,
        policies: policies.map((id) => ({ id })),
      }),
    }
  );
  return ((await response.json()) as { result: { id: string; aud: string } }).result;
}

const steps = (harness: Harness, ...wanted: FakeStep[]) =>
  harness.fake.calls.filter((call) => wanted.includes(call.step));

describe("deploy request parsing", () => {
  async function deployWithForm(harness: Harness, form: FormData) {
    return errorOf(await harness.call(await signedRequest("/deploy", { form })));
  }

  it.each(["index.html", "/../etc/passwd", "/assets//app.js", "/a\\b.js"])(
    "refuses the asset path %s before any Cloudflare call",
    async (path) => {
      const harness = createHarness();

      const { status, body } = await errorOf(
        await harness.deploy({ name: NAME, assets: { [path]: "content" } })
      );

      expect(status).toBe(400);
      expect(body.error).toBe("invalid_request");
      expect(harness.fake.calls).toEqual([]);
    }
  );

  it("refuses a part the request does not name, and a named part that is missing", async () => {
    const harness = createHarness();
    const extra = deployForm({ name: NAME });
    extra.append("a9", new File(["unlisted"], "unlisted.txt"));
    const missing = deployForm({ name: NAME, worker: "export default {};" });
    missing.delete("worker");

    for (const form of [extra, missing]) {
      const { status, body } = await deployWithForm(harness, form);
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_request");
    }
    expect(harness.fake.calls).toEqual([]);
  });
});

describe("app names", () => {
  it.each([
    ["deployer", "reserved_name"],
    ["dispatcher", "reserved_name"],
    ["Inventory", "invalid_name"],
    ["xn--inventory", "invalid_name"],
    ["inventory.other", "invalid_name"],
    ["a".repeat(41), "invalid_name"],
  ])("refuses %s as %s before any Cloudflare call", async (name, reason) => {
    const harness = createHarness();

    const { status, body } = await errorOf(await harness.deploy({ name }));

    expect(status).toBe(400);
    expect(body.error).toBe(reason);
    expect(harness.fake.calls).toEqual([]);
  });

  it("refuses a request that tries to name its own script or hostname", async () => {
    const harness = createHarness();

    const { status, body } = await errorOf(
      await harness.deploy({
        name: NAME,
        extra: { script: "open-inspect-app-broker", hostname: "deployer.apps.example.test" },
      })
    );

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
    expect(harness.fake.calls).toEqual([]);
  });

  it("derives every Worker, domain and Access object it touches from the app name", async () => {
    const harness = createHarness();

    await deployOk(harness);

    const scriptPaths = harness.fake.calls
      .map((call) => /\/workers\/(?:scripts|workers)\/([^/]+)/.exec(call.path)?.[1])
      .filter((segment) => segment !== undefined);
    expect(new Set(scriptPaths)).toEqual(
      new Set([SCRIPT, harness.fake.script(SCRIPT)?.id].filter(Boolean))
    );
    expect(harness.fake.accessAppsFor(HOST)).toHaveLength(1);
    expect(harness.fake.domainFor(HOST)?.service).toBe(SCRIPT);
  });
});

describe.each(BACKENDS)("publish on the %s backend", (backend) => {
  it("serves the app only behind its own Access app, and reports what it deployed", async () => {
    const harness = createHarness({ backend });

    const result = await deployOk(harness);

    expectServing(harness, NAME);
    expect(result).toEqual({
      url: `https://${HOST}`,
      backend,
      cfVersionId: expect.any(String),
      accessAud: harness.fake.accessAppsFor(HOST)[0].aud,
      firstDeploy: true,
    });
  });

  it("reuses the Access app and AUD on redeploy and reports it is not the first deploy", async () => {
    const harness = createHarness({ backend });
    const first = await deployOk(harness);

    const second = await deployOk(harness, { name: NAME, deploymentId: "deployment-2" });

    expect(second.accessAud).toBe(first.accessAud);
    expect(second.firstDeploy).toBe(false);
    expect(steps(harness, "access.create")).toHaveLength(1);
    expect(activeVersion(harness, NAME)?.annotations["workers/message"]).toBe(
      "oi-deployment:deployment-2"
    );
    expectServing(harness, NAME);
  });

  it("waits for DNS only when the deploy attaches the hostname", async () => {
    const harness = createHarness({ backend });

    await deployOk(harness);
    expect(harness.sleeps).toEqual([APP_DOMAIN_DNS_PUBLISH_WAIT_MS]);

    await deployOk(harness, { name: NAME, deploymentId: "deployment-2" });
    expect(harness.sleeps).toEqual([APP_DOMAIN_DNS_PUBLISH_WAIT_MS]);

    expect((await harness.takedown(NAME)).status).toBe(200);
    const reattached = await deployOk(harness, { name: NAME, deploymentId: "deployment-3" });
    expect(reattached.firstDeploy).toBe(true);
    expect(harness.sleeps).toEqual([
      APP_DOMAIN_DNS_PUBLISH_WAIT_MS,
      APP_DOMAIN_DNS_PUBLISH_WAIT_MS,
    ]);
  });

  it("binds exactly the assets, the platform values and the requested bindings", async () => {
    const harness = createHarness({ backend, env: { APP_DATA_JURISDICTION: "eu" } });
    harness.fake.seedD1("app-inventory-db");
    const databaseId = harness.fake.d1("app-inventory-db")!.uuid;
    const namespaceId = harness.fake.seedKv("app-inventory-cache");

    await deployOk(harness, {
      name: NAME,
      worker: "export default { fetch() { return new Response('ok'); } };",
      bindings: [
        { type: "d1", name: "DB", databaseId },
        { type: "kv_namespace", name: "CACHE", namespaceId },
        { type: "r2_bucket", name: "FILES", bucketName: "app-inventory-files" },
        { type: "secret_text", name: "PAYMENTS_KEY", value: "placeholder-secret-value" },
      ],
    });

    const version = activeVersion(harness, NAME)!;
    const aud = harness.fake.accessAppsFor(HOST)[0].aud;
    const expected = [
      { type: "assets", name: "ASSETS" },
      { type: "plain_text", name: "APP_HOSTNAME", text: HOST },
      { type: "kv_namespace", name: "CACHE", namespace_id: namespaceId },
      { type: "plain_text", name: "CF_ACCESS_AUD", text: aud },
      { type: "plain_text", name: "CF_ACCESS_TEAM_DOMAIN", text: TEAM_DOMAIN },
      { type: "d1", name: "DB", id: databaseId },
      { type: "r2_bucket", name: "FILES", bucket_name: "app-inventory-files", jurisdiction: "eu" },
      { type: "plain_text", name: "OI_APP_NAME", text: NAME },
      { type: "secret_text", name: "PAYMENTS_KEY", text: "placeholder-secret-value" },
    ];
    expect(version.bindings).toHaveLength(expected.length);
    expect(version.bindings).toEqual(expect.arrayContaining(expected));
    expect(version.mainModule).toBe("guard.mjs");
    expect(version.moduleNames).toEqual(["guard.mjs", "guard-core.mjs", "app.mjs"]);
    expect(version.assetsConfig).toEqual({
      not_found_handling: "single-page-application",
      run_worker_first: true,
    });
    expect(harness.fake.violations).toEqual([]);
  });

  it("refuses to bind a database or namespace that is not an app resource", async () => {
    const harness = createHarness({ backend });
    const foreignDb = harness.fake.seedD1("billing-production");
    const foreignKv = harness.fake.seedKv("sessions");

    for (const binding of [
      { type: "d1", name: "DB", databaseId: foreignDb },
      { type: "kv_namespace", name: "CACHE", namespaceId: foreignKv },
    ]) {
      const { status, body } = await errorOf(
        await harness.deploy({ name: NAME, bindings: [binding] })
      );
      expect(status).toBe(403);
      expect(body.error).toBe("refused");
    }
    expect(harness.fake.accessAppsFor(HOST)).toEqual([]);
    expect(activeVersion(harness, NAME)).toBeNull();
  });

  it("uploads only the asset buckets Cloudflare asks for", async () => {
    const harness = createHarness({ backend });
    const assets = { "/index.html": "<h1>v1</h1>", "/app.js": "run()", "/app.css": "body{}" };

    await deployOk(harness, { name: NAME, assets });
    expect(steps(harness, "assets.upload")).toHaveLength(2);

    await deployOk(harness, { name: NAME, assets });
    expect(steps(harness, "assets.upload")).toHaveLength(2);
    expect(activeVersion(harness, NAME)?.assetPaths).toEqual([
      "/app.css",
      "/app.js",
      "/index.html",
    ]);

    await deployOk(harness, { name: NAME, assets: { ...assets, "/about.html": "<p>new</p>" } });
    expect(steps(harness, "assets.upload")).toHaveLength(3);
    expectServing(harness, NAME);
  });

  it("relays Cloudflare's reason when it rejects the script", async () => {
    const harness = createHarness({ backend });
    harness.fake.inject({
      step: backend === "workers" ? "versions.create" : "dispatch.put",
      status: 400,
      codes: [10021],
    });

    const { status, body } = await errorOf(await harness.deploy({ name: NAME }));

    expect(status).toBe(422);
    expect(body).toEqual({
      error: "script_rejected",
      message: `injected failure on ${backend === "workers" ? "versions.create" : "dispatch.put"}`,
    });
    expect(harness.fake.domainFor(HOST)).toBeNull();
    expect(harness.fake.violations).toEqual([]);
  });
});

describe("edge", () => {
  it("removes duplicate Access apps for the hostname, keeping the oldest", async () => {
    const harness = createHarness();
    const oldest = await seedAccessApp(harness);
    await seedAccessApp(harness);

    const result = await deployOk(harness);

    expect(harness.fake.accessAppsFor(HOST).map((app) => app.id)).toEqual([oldest.id]);
    expect(result.accessAud).toBe(oldest.aud);
    expectServing(harness, NAME);
  });

  it("repairs an Access app whose policy drifted", async () => {
    const harness = createHarness();
    await deployOk(harness);
    harness.fake.setAccessPolicies(HOST, ["policy-everyone"]);

    await deployOk(harness);

    expect(harness.fake.accessAppsFor(HOST)[0].policyIds).toEqual([FAKE_OPTIONS.policyId]);
    expectServing(harness, NAME);
  });

  it("publishes nothing when the apps floor is missing", async () => {
    const harness = createHarness();
    harness.fake.deleteFloor();

    const { status, body } = await errorOf(await harness.deploy({ name: NAME }));

    expect(status).toBe(503);
    expect(body.error).toBe("access_guard_failed");
    expect(harness.fake.accessAppsFor(HOST)).toEqual([]);
    expect(harness.fake.script(SCRIPT)).toBeNull();
    expect(harness.fake.violations).toEqual([]);
  });

  it("does not attach the hostname when the Access app vanished during the deploy", async () => {
    const harness = createHarness();
    harness.fake.onStep("access.get", async () => {
      const [app] = harness.fake.accessAppsFor(HOST);
      await harness.fake.fetch(
        `https://api.cloudflare.fake.invalid/client/v4/accounts/${FAKE_OPTIONS.accountId}/access/apps/${app.id}`,
        { method: "DELETE", headers: { authorization: `Bearer ${FAKE_OPTIONS.apiToken}` } }
      );
    });

    const { status, body } = await errorOf(await harness.deploy({ name: NAME }));

    expect(status).toBe(503);
    expect(body.error).toBe("access_guard_failed");
    expect(steps(harness, "domains.put")).toEqual([]);
    expect(harness.fake.domainFor(HOST)).toBeNull();
    expect(harness.sleeps).toEqual([]);
    expect(harness.fake.violations).toEqual([]);
  });

  it("refuses a hostname that already has DNS records the platform did not create", async () => {
    const harness = createHarness({ fake: { foreignHostnames: [HOST] } });

    const { status, body } = await errorOf(await harness.deploy({ name: NAME }));

    expect(status).toBe(409);
    expect(body.error).toBe("hostname_conflict");
    expect(harness.fake.domainFor(HOST)).toBeNull();
    expect(harness.fake.violations).toEqual([]);
  });
});

describe("the workers backend", () => {
  it("creates the Worker with workers.dev and previews off before any code exists", async () => {
    const harness = createHarness();

    await deployOk(harness);

    expect(steps(harness, "workers.subdomain.set")).toEqual([]);
    expectServing(harness, NAME);
  });

  it("turns workers.dev and previews back off on an existing Worker", async () => {
    const harness = createHarness();
    await deployOk(harness);
    harness.fake.enableSubdomain(SCRIPT);

    await deployOk(harness);

    expect(steps(harness, "workers.subdomain.set")).toHaveLength(1);
    expectServing(harness, NAME);
  });

  it.each([
    ["a first deploy", false],
    ["a redeploy", true],
  ])(
    "removes the script and publishes nothing when workers.dev reads back on after %s",
    async (_case, redeploy) => {
      const harness = createHarness();
      if (redeploy) await deployOk(harness);
      harness.fake.onStep("workers.subdomain.get", () => harness.fake.enableSubdomain(SCRIPT));

      const { status, body } = await errorOf(await harness.deploy({ name: NAME }));

      expect(status).toBe(503);
      expect(body.error).toBe("access_guard_failed");
      expect(harness.fake.script(SCRIPT)).toBeNull();
      expect(harness.fake.domainFor(HOST)).toBeNull();
      expect(harness.fake.violations).toEqual([]);
    }
  );
});

describe.each(BACKENDS)("publish failure sweep on the %s backend", (backend) => {
  const FAILURES: readonly Omit<InjectedFailure, "step">[] = [
    { status: 500, times: CLOUDFLARE_API_MAX_ATTEMPTS },
    { status: null, times: CLOUDFLARE_API_MAX_ATTEMPTS },
    { status: 500, applyThenFail: true },
    { status: 502, applyThenFail: true, times: CLOUDFLARE_API_MAX_ATTEMPTS },
    { status: 429, retryAfterSeconds: 60, times: CLOUDFLARE_API_MAX_ATTEMPTS },
  ];

  async function stepsOfOneDeploy(redeploy: boolean): Promise<FakeStep[]> {
    const harness = createHarness({ backend });
    if (redeploy) await deployOk(harness);
    const before = harness.fake.calls.length;
    await deployOk(harness);
    return [...new Set(harness.fake.calls.slice(before).map((call) => call.step))];
  }

  for (const redeploy of [false, true]) {
    it(`converges after a failure at every step of ${redeploy ? "a redeploy" : "a first deploy"}`, async () => {
      const sweep = await stepsOfOneDeploy(redeploy);
      expect(sweep.length).toBeGreaterThanOrEqual(5);
      let failedDeploys = 0;
      for (const step of sweep) {
        for (const failure of FAILURES) {
          const harness = createHarness({ backend });
          if (redeploy) await deployOk(harness);
          harness.fake.inject({ step, ...failure });
          const label = `${step} ${JSON.stringify(failure)}`;

          let response = await harness.deploy({ name: NAME, deploymentId: "deployment-retry" });
          for (
            let retry = 1;
            response.status !== 200 && retry <= CLOUDFLARE_API_MAX_ATTEMPTS;
            retry++
          ) {
            failedDeploys += 1;
            expect([429, 502], label).toContain(response.status);
            expect(harness.fake.violations, label).toEqual([]);
            response = await harness.deploy({ name: NAME, deploymentId: "deployment-retry" });
          }

          expect(response.status, label).toBe(200);
          expectServing(harness, NAME);
          expect(activeVersion(harness, NAME)?.annotations["workers/message"]).toBe(
            "oi-deployment:deployment-retry"
          );
        }
      }
      expect(failedDeploys).toBeGreaterThan(sweep.length);
    });
  }
});
