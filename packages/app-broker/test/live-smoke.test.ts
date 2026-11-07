import { describe, expect, it } from "vitest";
import {
  Cleanup,
  attachDomain,
  checkD1Atomicity,
  createCloudflareClient,
  provisionApp,
  takeDownApp,
} from "../scripts/live-smoke";
import { FAKE_CLOUDFLARE_API_BASE_URL, createFakeCloudflare } from "./fake-cloudflare";

const OPTIONS = {
  accountId: "acct-smoke",
  zoneId: "zone-smoke",
  appsDomain: "apps.example.test",
  policyId: "policy-visitors",
  floorAppId: "floor-app",
  scriptPrefix: "app-",
  apiToken: "test-token",
};

function smokeAgainstFake() {
  const fake = createFakeCloudflare(OPTIONS);
  const api = createCloudflareClient({
    baseUrl: FAKE_CLOUDFLARE_API_BASE_URL,
    accountId: OPTIONS.accountId,
    token: OPTIONS.apiToken,
    fetch: fake.fetch,
  });
  return { fake, api, cleanup: new Cleanup() };
}

describe("the live smoke's API steps against the fake", () => {
  it("publishes, attaches and takes down an app without breaking the ingress invariant", async () => {
    const { fake, api, cleanup } = smokeAgainstFake();
    const hostname = "smoke-a.apps.example.test";
    const script = "oi-smoke-a";

    const app = await provisionApp(api, cleanup, {
      hostname,
      script,
      policyId: OPTIONS.policyId,
      runId: "run1",
    });
    expect(app.subdomainReads).toEqual([
      { enabled: false, previews_enabled: false },
      { enabled: false, previews_enabled: false },
    ]);
    expect(fake.script(script)?.activeVersion?.assetPaths).toEqual(["/asset.txt"]);

    const domainId = await attachDomain(api, cleanup, { hostname, script, zoneId: OPTIONS.zoneId });
    expect(fake.domainFor(hostname)).toEqual({ id: domainId, service: script });

    await takeDownApp(api, { domainId, script, accessAppId: app.accessAppId });
    expect(fake.domainFor(hostname)).toBeNull();
    expect(fake.script(script)).toBeNull();
    expect(fake.accessAppsFor(hostname)).toEqual([]);
    expect(await cleanup.run()).toEqual([]);
    expect(fake.violations).toEqual([]);
  });

  it("sees a failing two-statement D1 body leave the first statement unapplied", async () => {
    const { fake, api, cleanup } = smokeAgainstFake();

    const observed = await checkD1Atomicity(api, cleanup, { name: "app-oi-smoke-run1" });

    expect(observed.firstStatementPersisted).toBe(false);
    expect(observed.failure.status).toBe(400);
    expect(observed.failure.message).toContain("no such table: oi_smoke_missing");
    expect(await cleanup.run()).toEqual([]);
    expect(fake.d1("app-oi-smoke-run1")).toBeNull();
    expect(fake.violations).toEqual([]);
  });
});
