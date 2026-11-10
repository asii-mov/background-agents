/**
 * Opt-in live check of the Cloudflare behaviours the app broker relies on, run against a dedicated
 * test account. test/fake-cloudflare.ts encodes the same behaviours for unit tests, and
 * test/live-smoke.test.ts runs this script's API steps against that fake.
 *
 *   APP_BROKER_LIVE_SMOKE=1 npm run smoke -w @open-inspect/app-broker
 *
 * Every object it creates carries a per-run id and is deleted before it exits. README.md lists the
 * environment variables and token permissions.
 */
import { createHash, randomBytes } from "node:crypto";
import { NODATA, NOTFOUND } from "node:dns";
import { Resolver } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { pathToFileURL } from "node:url";
import { Agent, fetch as fetchVia } from "undici";

export const ASSUMPTIONS = {
  exactAccessAppWins:
    "An exact-hostname Access app takes precedence over the *.<domain> floor and issues its own AUD",
  perAppTokenRefusedAtSibling:
    "A token issued for one app's Access app is refused at a sibling app",
  subdomainStaysDisabled:
    "A Worker created with workers.dev and previews off stays off after versions and deployments",
  sha256AssetHashesAccepted:
    "Static asset uploads accept sha256(base64 + extension) truncated to 32 hex characters",
  certificateIssued:
    "A custom domain gets a certificate (authoritative DNS publish and first HTTPS times recorded)",
  d1QueryIsAtomic: "A D1 /query body whose second statement fails leaves the first unapplied",
  takedownStopsResolution:
    "Removing the custom domain, script and Access app stops the hostname resolving",
} as const;
export type AssumptionId = keyof typeof ASSUMPTIONS;

export interface CheckResult {
  id: AssumptionId;
  passed: boolean;
  detail: string;
}

export interface SubdomainSetting {
  enabled: boolean;
  previews_enabled: boolean;
}

const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const COMPATIBILITY_DATE = "2026-06-01";
const SMOKE_MODULE = "smoke.mjs";
const ASSET_PATH = "/asset.txt";
const RUN_HEADER = "x-oi-smoke-run";
const DNS_PUBLISH_TIMEOUT_MS = 10 * 60_000;
const DNS_QUERY_TIMEOUT_MS = 5_000;
const CERT_WAIT_TIMEOUT_MS = 10 * 60_000;
const ACCESS_PROPAGATION_TIMEOUT_MS = 2 * 60_000;
const RESOLUTION_WAIT_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const REQUIRED_ENV = [
  "APP_BROKER_SMOKE_ACCOUNT_ID",
  "APP_BROKER_SMOKE_API_TOKEN",
  "APP_BROKER_SMOKE_ZONE_ID",
  "APP_BROKER_SMOKE_DOMAIN",
] as const;

const SMOKE_WORKER_SOURCE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/echo") return env.ASSETS.fetch(request);
    return Response.json(
      { host: url.host, assertion: request.headers.get("cf-access-jwt-assertion") },
      { headers: { "${RUN_HEADER}": env.SMOKE_RUN_ID } }
    );
  },
};
`;

// ---- Cloudflare API transport -------------------------------------------------------------------

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface CloudflareEnvelope {
  status: number;
  success: boolean;
  result: unknown;
  errors: { code: number; message: string }[];
  headers: Headers;
}

export interface RequestOptions {
  body?: unknown;
  form?: FormData;
  query?: Record<string, string>;
  /** Replaces the account token, e.g. with an assets upload session JWT. */
  bearer?: string;
  headers?: Record<string, string>;
}

export interface CloudflareClient {
  request(method: string, path: string, options?: RequestOptions): Promise<CloudflareEnvelope>;
}

export class SmokeError extends Error {}

export function createCloudflareClient(input: {
  baseUrl: string;
  accountId: string;
  token: string;
  fetch?: FetchLike;
}): CloudflareClient {
  const fetchImpl: FetchLike = input.fetch ?? fetch;
  return {
    async request(method, path, options = {}) {
      const url = new URL(`${input.baseUrl}/accounts/${input.accountId}${path}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        url.searchParams.set(key, value);
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.bearer ?? input.token}`,
        ...options.headers,
      };
      let body: RequestInit["body"] = options.form;
      if (!body && options.body !== undefined) {
        body = JSON.stringify(options.body);
        headers["content-type"] = "application/json";
      }
      const response = await fetchImpl(url, { method, headers, body });
      const text = await response.text();
      // Some deletes succeed with an empty body (204) instead of an envelope.
      const noContent = response.ok && text === "";
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const envelope = isRecord(parsed) ? parsed : {};
      return {
        status: response.status,
        success: noContent || envelope.success === true,
        result: envelope.result,
        errors: Array.isArray(envelope.errors) ? envelope.errors : [],
        headers: response.headers,
      };
    },
  };
}

/** The result of a successful call; any other outcome throws with the status and error codes. */
export function must<T>(envelope: CloudflareEnvelope, what: string): T {
  if (!envelope.success) {
    const codes = envelope.errors.map((error) => error.code).join(",") || "none";
    throw new SmokeError(`${what} failed: HTTP ${envelope.status}, codes ${codes}`);
  }
  return envelope.result as T;
}

async function remove(
  api: CloudflareClient,
  path: string,
  query?: Record<string, string>
): Promise<void> {
  const response = await api.request("DELETE", path, { query });
  if (!response.success && response.status !== 404) must(response, `DELETE ${path}`);
}

/** Deletes what a run created, newest first, and reports what it could not delete. */
export class Cleanup {
  private readonly steps: { what: string; run: () => Promise<void> }[] = [];

  add(what: string, run: () => Promise<void>): void {
    this.steps.push({ what, run });
  }

  async run(): Promise<string[]> {
    const failures: string[] = [];
    for (const step of this.steps.splice(0).reverse()) {
      try {
        await step.run();
      } catch (error) {
        failures.push(`${step.what}: ${describe(error)}`);
      }
    }
    return failures;
  }
}

// ---- API steps (also run against the fake) -----------------------------------------------------

/** The hash wrangler computes with BLAKE3, computed with SHA-256 instead. */
export function assetHash(base64: string, path: string): string {
  const extension = /\.([^./]+)$/.exec(path)?.[1] ?? "";
  return createHash("sha256")
    .update(base64 + extension)
    .digest("hex")
    .slice(0, 32);
}

function accessAppBody(domain: string, policyId: string): Record<string, unknown> {
  return {
    name: `oi-smoke ${domain}`,
    type: "self_hosted",
    domain,
    destinations: [{ type: "public", uri: domain }],
    policies: [{ id: policyId, precedence: 1 }],
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
  };
}

async function uploadAssets(
  api: CloudflareClient,
  script: string,
  files: Readonly<Record<string, string>>
): Promise<string> {
  const encoded = Object.entries(files).map(([path, text]) => {
    const base64 = Buffer.from(text).toString("base64");
    return { path, base64, hash: assetHash(base64, path), size: Buffer.byteLength(text) };
  });
  const manifest = Object.fromEntries(
    encoded.map((file) => [file.path, { hash: file.hash, size: file.size }])
  );
  const session = must<{ jwt: string; buckets?: string[][] }>(
    await api.request("POST", `/workers/scripts/${script}/assets-upload-session`, {
      body: { manifest },
    }),
    "start an assets upload session"
  );
  let completionJwt = session.jwt;
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = encoded.find((candidate) => candidate.hash === hash);
      if (!file) throw new SmokeError(`Cloudflare asked for unknown asset hash ${hash}`);
      form.append(hash, new File([file.base64], hash, { type: "text/plain" }));
    }
    const uploaded = must<{ jwt?: string | null }>(
      await api.request("POST", "/workers/assets/upload", {
        form,
        query: { base64: "true" },
        bearer: session.jwt,
      }),
      "upload an asset bucket"
    );
    if (uploaded?.jwt) completionJwt = uploaded.jwt;
  }
  return completionJwt;
}

export interface ProvisionedApp {
  hostname: string;
  script: string;
  accessAppId: string;
  aud: string;
  /** The subdomain setting read back after each of two deployments. */
  subdomainReads: SubdomainSetting[];
  assetContent: string;
}

/**
 * The broker's publish order up to, not including, the custom domain: per-app Access app, a
 * Worker created with workers.dev and previews off, assets, a version, a 100% deployment. It
 * deploys twice and reads the subdomain setting back after each deployment.
 */
export async function provisionApp(
  api: CloudflareClient,
  cleanup: Cleanup,
  input: { hostname: string; script: string; policyId: string; runId: string }
): Promise<ProvisionedApp> {
  const { hostname, script, runId } = input;
  const accessApp = must<{ id: string; aud: string }>(
    await api.request("POST", "/access/apps", { body: accessAppBody(hostname, input.policyId) }),
    `create the Access app for ${hostname}`
  );
  cleanup.add(`Access app ${hostname}`, () => remove(api, `/access/apps/${accessApp.id}`));

  const worker = must<{ id: string }>(
    await api.request("POST", "/workers/workers", {
      body: { name: script, subdomain: { enabled: false, previews_enabled: false } },
    }),
    `create Worker ${script}`
  );
  cleanup.add(`Worker ${script}`, () =>
    remove(api, `/workers/scripts/${script}`, { force: "true" })
  );

  const assetContent = `oi smoke asset ${runId}`;
  const subdomainReads: SubdomainSetting[] = [];
  for (let round = 0; round < 2; round += 1) {
    const assetsJwt = await uploadAssets(api, script, { [ASSET_PATH]: assetContent });
    const version = must<{ id: string }>(
      await api.request("POST", `/workers/workers/${worker.id}/versions`, {
        body: {
          compatibility_date: COMPATIBILITY_DATE,
          main_module: SMOKE_MODULE,
          modules: [
            {
              name: SMOKE_MODULE,
              content_type: "application/javascript+module",
              content_base64: Buffer.from(SMOKE_WORKER_SOURCE).toString("base64"),
            },
          ],
          bindings: [
            { type: "assets", name: "ASSETS" },
            { type: "plain_text", name: "SMOKE_RUN_ID", text: runId },
            { type: "plain_text", name: "CF_ACCESS_AUD", text: accessApp.aud },
          ],
          assets: {
            jwt: assetsJwt,
            config: { run_worker_first: true, not_found_handling: "none" },
          },
        },
      }),
      `create a version of ${script}`
    );
    must(
      await api.request("POST", `/workers/scripts/${script}/deployments`, {
        body: { strategy: "percentage", versions: [{ version_id: version.id, percentage: 100 }] },
      }),
      `deploy ${script}`
    );
    subdomainReads.push(
      must<SubdomainSetting>(
        await api.request("GET", `/workers/scripts/${script}/subdomain`),
        `read the subdomain setting of ${script}`
      )
    );
  }
  return {
    hostname,
    script,
    accessAppId: accessApp.id,
    aud: accessApp.aud,
    subdomainReads,
    assetContent,
  };
}

export async function attachDomain(
  api: CloudflareClient,
  cleanup: Cleanup,
  input: { hostname: string; script: string; zoneId: string }
): Promise<string> {
  const domain = must<{ id: string }>(
    await api.request("PUT", "/workers/domains", {
      body: {
        hostname: input.hostname,
        service: input.script,
        zone_id: input.zoneId,
        environment: "production",
      },
    }),
    `attach ${input.hostname}`
  );
  cleanup.add(`custom domain ${input.hostname}`, () =>
    remove(api, `/workers/domains/${domain.id}`)
  );
  return domain.id;
}

/** The broker's takedown order: detach the hostname, delete the script, revoke the Access app. */
export async function takeDownApp(
  api: CloudflareClient,
  input: { domainId: string; script: string; accessAppId: string }
): Promise<void> {
  await remove(api, `/workers/domains/${input.domainId}`);
  await remove(api, `/workers/scripts/${input.script}`, { force: "true" });
  await remove(api, `/access/apps/${input.accessAppId}`);
}

export interface D1AtomicityObservation {
  firstStatementPersisted: boolean;
  failure: { status: number; codes: number[]; message: string };
}

export async function checkD1Atomicity(
  api: CloudflareClient,
  cleanup: Cleanup,
  input: { name: string; jurisdiction?: string }
): Promise<D1AtomicityObservation> {
  const db = must<{ uuid: string }>(
    await api.request("POST", "/d1/database", {
      body: {
        name: input.name,
        ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
      },
    }),
    `create D1 database ${input.name}`
  );
  cleanup.add(`D1 database ${input.name}`, () => remove(api, `/d1/database/${db.uuid}`));
  const failing = await api.request("POST", `/d1/database/${db.uuid}/query`, {
    body: {
      sql: "CREATE TABLE oi_smoke_first (id INTEGER); INSERT INTO oi_smoke_missing VALUES (1);",
    },
  });
  if (failing.success) throw new SmokeError("a body whose second statement fails succeeded");
  const lookup = must<{ results?: unknown[] }[]>(
    await api.request("POST", `/d1/database/${db.uuid}/query`, {
      body: {
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oi_smoke_first'",
      },
    }),
    "look up the first statement's table"
  );
  return {
    firstStatementPersisted: (lookup[0]?.results?.length ?? 0) > 0,
    failure: {
      status: failing.status,
      codes: failing.errors.map((error) => error.code),
      message: failing.errors[0]?.message ?? "",
    },
  };
}

// ---- Edge probes (live only) --------------------------------------------------------------------

interface ProbeResponse {
  status: number;
  servedByRun: boolean;
  body: string;
  headers: Headers;
}
export type Probe = ProbeResponse | { error: string };

/** Response headers that tell TLS, DNS and Access failures apart without carrying a credential. */
const DIAGNOSTIC_HEADERS = ["location", "server", "cf-ray", "cf-mitigated", "content-type"];

/** The node:dns/promises Resolver methods the authoritative lookup uses. */
export interface DnsResolver {
  setServers(servers: string[]): void;
  resolveNs(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

const newSystemResolver = (): DnsResolver =>
  new Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: 2 });

async function noRecordsIsEmpty(lookup: Promise<string[]>): Promise<string[]> {
  try {
    return await lookup;
  } catch (error) {
    if (isRecord(error) && (error.code === NOTFOUND || error.code === NODATA)) return [];
    throw error;
  }
}

/**
 * The hostname's A then AAAA addresses as its zone's nameservers serve them. Caching resolvers
 * hold an early NXDOMAIN for the zone's SOA minimum (30 minutes on Cloudflare); authoritative
 * servers answer from the zone itself. The hostname is only ever asked of those servers.
 */
export async function authoritativeAddresses(
  hostname: string,
  newResolver: () => DnsResolver = newSystemResolver
): Promise<string[]> {
  const system = newResolver();
  let nameservers: string[] = [];
  for (let name = hostname; nameservers.length === 0 && name.includes(".");) {
    name = name.slice(name.indexOf(".") + 1);
    nameservers = await noRecordsIsEmpty(system.resolveNs(name));
  }
  const serverIps = (await Promise.all(nameservers.map((ns) => system.resolve4(ns)))).flat();
  if (serverIps.length === 0) throw new SmokeError(`no nameserver addresses for ${hostname}`);
  const authoritative = newResolver();
  authoritative.setServers(serverIps);
  const [v4, v6] = await Promise.all([
    noRecordsIsEmpty(authoritative.resolve4(hostname)),
    noRecordsIsEmpty(authoritative.resolve6(hostname)),
  ]);
  return [...v4, ...v6];
}

/** Connects every request to `address`; the URL still sets SNI and Host. */
function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

async function probe(
  url: string,
  address: string,
  headers: Record<string, string>,
  runId: string
): Promise<Probe> {
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(address) } });
  try {
    const response = await fetchVia(url, { headers, redirect: "manual", dispatcher });
    return {
      status: response.status,
      servedByRun: response.headers.get(RUN_HEADER) === runId,
      body: await response.text(),
      headers: response.headers,
    };
  } catch (error) {
    return { error: describeFetchError(error) };
  } finally {
    await dispatcher.close();
  }
}

/** A fetch failure with each `cause` and its code, e.g. ENOTFOUND or ERR_TLS_CERT_ALTNAME_INVALID. */
export function describeFetchError(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  while (current !== undefined && parts.length < 4) {
    const code = isRecord(current) && typeof current.code === "string" ? `${current.code} ` : "";
    parts.push(`${code}${describe(current)}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(", caused by ");
}

/** The status and allowlisted headers of a probe, with any query string cut from `location`. */
export function describeProbe(result: Probe): string {
  if ("error" in result) return result.error;
  const shown = DIAGNOSTIC_HEADERS.flatMap((name) => {
    const value = result.headers.get(name);
    if (value === null) return [];
    return [`${name}=${name === "location" ? value.split(/[?#]/)[0] : value}`];
  });
  return [`HTTP ${result.status}`, ...shown].join(" ");
}

async function poll<T>(
  timeoutMs: number,
  attempt: () => Promise<T | null>
): Promise<{ value: T; elapsedMs: number } | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await attempt();
    if (value !== null) return { value, elapsedMs: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

type Reachability =
  | { reachable: true; address: string; publishedMs: number; firstHttpsMs: number }
  | { reachable: false; detail: string };

/**
 * Waits for the zone's nameservers to serve the hostname, then for a TLS handshake to succeed at
 * that address. Both times are measured from `attachedAt`, the custom domain PUT.
 */
async function waitUntilReachable(
  hostname: string,
  headers: Record<string, string>,
  runId: string,
  attachedAt: number
): Promise<Reachability> {
  let lastLookup = "no lookup completed";
  const published = await poll(DNS_PUBLISH_TIMEOUT_MS, async () => {
    try {
      const [address] = await authoritativeAddresses(hostname);
      if (address) return address;
      lastLookup = "no A/AAAA record";
    } catch (error) {
      lastLookup = describeFetchError(error);
    }
    return null;
  });
  if (!published) {
    return {
      reachable: false,
      detail: `no authoritative A/AAAA within ${DNS_PUBLISH_TIMEOUT_MS} ms; last lookup: ${lastLookup}`,
    };
  }
  const address = published.value;
  const publishedMs = Date.now() - attachedAt;
  let lastProbe = "no probe completed";
  const https = await poll(CERT_WAIT_TIMEOUT_MS, async () => {
    const response = await probe(`https://${hostname}/echo`, address, headers, runId);
    if (!("error" in response)) return response;
    lastProbe = response.error;
    return null;
  });
  if (!https) {
    return {
      reachable: false,
      detail:
        `authoritative A/AAAA ${publishedMs} ms after the domain PUT, but no HTTPS response ` +
        `within ${CERT_WAIT_TIMEOUT_MS} ms; last probe: ${lastProbe}`,
    };
  }
  return { reachable: true, address, publishedMs, firstHttpsMs: Date.now() - attachedAt };
}

type EchoOutcome =
  { answered: true; assertion: string | null } | { answered: false; lastProbe: string };

async function waitForEcho(
  hostname: string,
  reach: Reachability,
  headers: Record<string, string>,
  runId: string
): Promise<EchoOutcome> {
  if (!reach.reachable) return { answered: false, lastProbe: reach.detail };
  let lastProbe = "no probe completed";
  const served = await poll(ACCESS_PROPAGATION_TIMEOUT_MS, async () => {
    const response = await probe(`https://${hostname}/echo`, reach.address, headers, runId);
    if ("error" in response || !response.servedByRun) {
      lastProbe = describeProbe(response);
      return null;
    }
    return response;
  });
  if (!served) return { answered: false, lastProbe };
  const echo: unknown = JSON.parse(served.value.body);
  return {
    answered: true,
    assertion: isRecord(echo) && typeof echo.assertion === "string" ? echo.assertion : null,
  };
}

function audiences(jwt: string | null): string[] {
  const payload = jwt?.split(".")[1];
  if (!payload) return [];
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const aud = isRecord(claims) ? claims.aud : undefined;
  return (Array.isArray(aud) ? aud : [aud]).filter((value) => typeof value === "string");
}

async function resolvesToAddress(hostname: string): Promise<boolean> {
  try {
    return (await authoritativeAddresses(hostname)).length > 0;
  } catch {
    return true;
  }
}

// ---- Live run -----------------------------------------------------------------------------------

interface SmokeEnv {
  accountId: string;
  apiToken: string;
  zoneId: string;
  domain: string;
  apiBaseUrl: string;
  d1Jurisdiction?: string;
}

async function runLiveSmoke(env: SmokeEnv): Promise<{ runId: string; results: CheckResult[] }> {
  const api = createCloudflareClient({
    baseUrl: env.apiBaseUrl,
    accountId: env.accountId,
    token: env.apiToken,
  });
  const runId = randomBytes(4).toString("hex");
  const cleanup = new Cleanup();
  const results: CheckResult[] = [];
  const record = (id: AssumptionId, passed: boolean, detail: string) =>
    results.push({ id, passed, detail });
  const names = (label: string) => ({
    hostname: `oi-smoke-${runId}-${label}.${env.domain}`,
    script: `oi-smoke-${runId}-${label}`,
  });

  try {
    const token = must<{ id: string; client_id: string; client_secret: string }>(
      await api.request("POST", "/access/service_tokens", { body: { name: `oi-smoke-${runId}` } }),
      "create a service token"
    );
    cleanup.add("service token", () => remove(api, `/access/service_tokens/${token.id}`));
    const servicePolicy = must<{ id: string }>(
      await api.request("POST", "/access/policies", {
        body: {
          name: `oi-smoke-${runId}-service-token`,
          decision: "non_identity",
          include: [{ service_token: { token_id: token.id } }],
        },
      }),
      "create the service token policy"
    );
    cleanup.add("service token policy", () => remove(api, `/access/policies/${servicePolicy.id}`));
    // The floor admits nobody this run can present, so a response from the Worker proves the
    // exact-hostname app, not the floor, decided the request.
    const floorPolicy = must<{ id: string }>(
      await api.request("POST", "/access/policies", {
        body: {
          name: `oi-smoke-${runId}-floor`,
          decision: "allow",
          include: [{ email_domain: { domain: "example.invalid" } }],
        },
      }),
      "create the floor policy"
    );
    cleanup.add("floor policy", () => remove(api, `/access/policies/${floorPolicy.id}`));
    const floor = must<{ id: string; aud: string }>(
      await api.request("POST", "/access/apps", {
        body: accessAppBody(`*.${env.domain}`, floorPolicy.id),
      }),
      "create the floor Access app"
    );
    cleanup.add("floor Access app", () => remove(api, `/access/apps/${floor.id}`));
    const serviceHeaders = {
      "cf-access-client-id": token.client_id,
      "cf-access-client-secret": token.client_secret,
    };

    const a = await provisionApp(api, cleanup, {
      ...names("a"),
      policyId: servicePolicy.id,
      runId,
    });
    record(
      "subdomainStaysDisabled",
      a.subdomainReads.every((read) => !read.enabled && !read.previews_enabled),
      `read back after each of two deployments: ${JSON.stringify(a.subdomainReads)}`
    );
    const domainA = await attachDomain(api, cleanup, { ...names("a"), zoneId: env.zoneId });
    const reachA = await waitUntilReachable(a.hostname, serviceHeaders, runId, Date.now());
    record(
      "certificateIssued",
      reachA.reachable,
      reachA.reachable
        ? `authoritative A/AAAA ${reachA.publishedMs} ms, first HTTPS response ` +
            `${reachA.firstHttpsMs} ms after the domain PUT`
        : reachA.detail
    );

    const echoA = await waitForEcho(a.hostname, reachA, serviceHeaders, runId);
    const audA = audiences(echoA.answered ? echoA.assertion : null);
    record(
      "exactAccessAppWins",
      echoA.answered && audA.includes(a.aud) && !audA.includes(floor.aud),
      echoA.answered
        ? `JWT aud ${JSON.stringify(audA)}; per-app ${a.aud}; floor ${floor.aud}`
        : `the Worker never answered with the service token within ` +
            `${ACCESS_PROPAGATION_TIMEOUT_MS} ms; last probe: ${echoA.lastProbe}`
    );
    const asset = reachA.reachable
      ? await probe(`https://${a.hostname}${ASSET_PATH}`, reachA.address, serviceHeaders, runId)
      : { error: reachA.detail };
    record(
      "sha256AssetHashesAccepted",
      !("error" in asset) && asset.status === 200 && asset.body === a.assetContent,
      "error" in asset ? asset.error : `GET ${ASSET_PATH} returned HTTP ${asset.status}`
    );

    const b = await provisionApp(api, cleanup, {
      ...names("b"),
      policyId: servicePolicy.id,
      runId,
    });
    await attachDomain(api, cleanup, { ...names("b"), zoneId: env.zoneId });
    const reachB = await waitUntilReachable(b.hostname, serviceHeaders, runId, Date.now());
    const echoB = await waitForEcho(b.hostname, reachB, serviceHeaders, runId);
    if (!echoA.answered || !echoA.assertion || !echoB.answered || !reachB.reachable) {
      record(
        "perAppTokenRefusedAtSibling",
        false,
        "precondition failed: both apps must answer the service token first" +
          (echoB.answered ? "" : `; app B last probe: ${echoB.lastProbe}`)
      );
    } else {
      const replay = await probe(
        `https://${b.hostname}/echo`,
        reachB.address,
        { "cf-access-token": echoA.assertion },
        runId
      );
      record(
        "perAppTokenRefusedAtSibling",
        "error" in replay || !replay.servedByRun,
        "error" in replay ? replay.error : `app A's token at app B: HTTP ${replay.status}`
      );
    }

    const d1 = await checkD1Atomicity(api, cleanup, {
      name: `app-oi-smoke-${runId}`,
      jurisdiction: env.d1Jurisdiction,
    });
    record(
      "d1QueryIsAtomic",
      !d1.firstStatementPersisted,
      `failing body: HTTP ${d1.failure.status}, codes ${d1.failure.codes.join(",")}, ` +
        `"${d1.failure.message}"; first statement persisted: ${d1.firstStatementPersisted}`
    );

    await takeDownApp(api, { domainId: domainA, script: a.script, accessAppId: a.accessAppId });
    const gone = await poll(RESOLUTION_WAIT_TIMEOUT_MS, async () =>
      (await resolvesToAddress(a.hostname)) ? null : true
    );
    record(
      "takedownStopsResolution",
      gone !== null,
      gone
        ? `no authoritative A/AAAA ${gone.elapsedMs} ms after takedown`
        : `still resolving ${RESOLUTION_WAIT_TIMEOUT_MS} ms after takedown`
    );
  } catch (error) {
    for (const id of Object.keys(ASSUMPTIONS) as AssumptionId[]) {
      if (!results.some((result) => result.id === id)) {
        record(id, false, `not reached: ${describe(error)}`);
      }
    }
  } finally {
    const leftovers = await cleanup.run();
    if (leftovers.length > 0) {
      console.error(`Could not delete (remove by hand):\n  ${leftovers.join("\n  ")}`);
    }
  }
  return { runId, results };
}

function formatReport(runId: string, results: readonly CheckResult[]): string {
  const rows = results.map(
    (result) =>
      `| ${ASSUMPTIONS[result.id]} | ${result.passed ? "pass" : "FAIL"} | ${result.detail.replaceAll("|", "\\|")} |`
  );
  return [
    `App broker live smoke, run ${runId}, ${new Date().toISOString()}`,
    "",
    "| Assumption | Result | Observed |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

async function main(env: NodeJS.ProcessEnv): Promise<number> {
  if (env.APP_BROKER_LIVE_SMOKE !== "1") {
    console.log("App broker live smoke SKIPPED: set APP_BROKER_LIVE_SMOKE=1 to run it.");
    return 0;
  }
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(`App broker live smoke needs ${missing.join(", ")}.`);
    return 1;
  }
  const { runId, results } = await runLiveSmoke({
    accountId: env.APP_BROKER_SMOKE_ACCOUNT_ID ?? "",
    apiToken: env.APP_BROKER_SMOKE_API_TOKEN ?? "",
    zoneId: env.APP_BROKER_SMOKE_ZONE_ID ?? "",
    domain: (env.APP_BROKER_SMOKE_DOMAIN ?? "").toLowerCase(),
    apiBaseUrl: env.APP_BROKER_SMOKE_API_BASE_URL || DEFAULT_API_BASE_URL,
    d1Jurisdiction: env.APP_BROKER_SMOKE_D1_JURISDICTION || undefined,
  });
  console.log(formatReport(runId, results));
  return results.every((result) => result.passed) ? 0 : 1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.env);
}
