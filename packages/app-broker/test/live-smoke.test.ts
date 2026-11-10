import { describe, expect, it } from "vitest";
import {
  Cleanup,
  type DnsResolver,
  attachDomain,
  authoritativeAddresses,
  checkD1Atomicity,
  createCloudflareClient,
  describeFetchError,
  describeProbe,
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

  it.each([
    [204, true],
    [404, false],
  ])("reads an empty HTTP %i body as success %s", async (status, success) => {
    const api = createCloudflareClient({
      baseUrl: FAKE_CLOUDFLARE_API_BASE_URL,
      accountId: OPTIONS.accountId,
      token: OPTIONS.apiToken,
      fetch: async () => new Response(null, { status }),
    });

    expect(await api.request("DELETE", "/workers/domains/d1")).toMatchObject({ status, success });
  });
});

describe("the live smoke's probe diagnostics", () => {
  it("names each fetch failure cause and its code", () => {
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND smoke-a.apps.example.test"), {
      code: "ENOTFOUND",
    });

    expect(describeFetchError(new TypeError("fetch failed", { cause: dns }))).toBe(
      "fetch failed, caused by ENOTFOUND getaddrinfo ENOTFOUND smoke-a.apps.example.test"
    );
  });

  it("shows an Access redirect without its query string or cookies", () => {
    const headers = new Headers({
      location:
        "https://team.cloudflareaccess.com/cdn-cgi/access/login/smoke-a.apps.example.test?kid=k&meta=secret-meta",
      "set-cookie": "CF_Authorization=secret-cookie",
      server: "cloudflare",
    });

    const observed = describeProbe({ status: 302, servedByRun: false, body: "", headers });

    expect(observed).toBe(
      "HTTP 302 location=https://team.cloudflareaccess.com/cdn-cgi/access/login/smoke-a.apps.example.test server=cloudflare"
    );
  });
});

const NAMESERVER_IP = "192.0.2.53";

/**
 * A caching resolver that serves the zone's NS records and already holds an NXDOMAIN for every app
 * hostname, and nameservers at NAMESERVER_IP that serve `published`.
 */
function fakeDns(published: Record<string, { a?: string[]; aaaa?: string[] }>) {
  const asked: { servers: string[] | null; type: string; name: string }[] = [];
  const nxdomain = (name: string) =>
    Object.assign(new Error(`queryA ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  const nodata = (name: string) =>
    Object.assign(new Error(`queryNs ENODATA ${name}`), { code: "ENODATA" });
  const newResolver = (): DnsResolver => {
    let servers: string[] | null = null;
    const answer = async (type: "NS" | "A" | "AAAA", name: string): Promise<string[]> => {
      asked.push({ servers, type, name });
      if (servers === null) {
        if (type === "NS" && name === "example.test") return ["ns1.dns.test"];
        if (type === "A" && name === "ns1.dns.test") return [NAMESERVER_IP];
        if (name === "apps.example.test") throw nodata(name);
        throw nxdomain(name);
      }
      const records = servers.includes(NAMESERVER_IP) ? published[name] : undefined;
      if (!records) throw nxdomain(name);
      return (type === "A" ? records.a : records.aaaa) ?? [];
    };
    return {
      setServers: (next) => {
        servers = next;
      },
      resolveNs: (name) => answer("NS", name),
      resolve4: (name) => answer("A", name),
      resolve6: (name) => answer("AAAA", name),
    };
  };
  return { newResolver, asked };
}

describe("the live smoke's authoritative DNS lookup", () => {
  const hostname = "smoke-a.apps.example.test";

  it("returns what the zone's nameservers serve, A records first", async () => {
    const dns = fakeDns({ [hostname]: { a: ["198.51.100.7"], aaaa: ["2001:db8::7"] } });

    expect(await authoritativeAddresses(hostname, dns.newResolver)).toEqual([
      "198.51.100.7",
      "2001:db8::7",
    ]);
  });

  it("reports an unpublished hostname as having no addresses", async () => {
    const dns = fakeDns({});

    expect(await authoritativeAddresses(hostname, dns.newResolver)).toEqual([]);
  });

  it("never asks the caching resolver about the hostname itself", async () => {
    const dns = fakeDns({ [hostname]: { a: ["198.51.100.7"] } });

    await authoritativeAddresses(hostname, dns.newResolver);

    const hostnameQueries = dns.asked.filter((query) => query.name === hostname);
    expect(hostnameQueries.length).toBeGreaterThan(0);
    expect(hostnameQueries.every((query) => query.servers?.includes(NAMESERVER_IP))).toBe(true);
  });

  it("fails when no nameserver can be found", async () => {
    const dns = fakeDns({});

    await expect(authoritativeAddresses("smoke-a.elsewhere.test", dns.newResolver)).rejects.toThrow(
      "no nameserver addresses"
    );
  });
});
