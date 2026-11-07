/**
 * An in-memory Cloudflare REST API for the app broker's tests, served as a `fetch` function.
 *
 * It models the endpoints the broker calls and answers with Cloudflare's
 * `{ success, errors, messages, result }` envelope. `scripts/live-smoke.ts` checks the same
 * behaviours against a real account; `test/live-smoke.test.ts` runs that script's API steps against
 * this fake so the two cannot drift apart silently.
 *
 * The ingress invariant is the fake's main job. Whenever a request can change what a hostname under
 * the apps domain serves, the fake checks the facet that request can break and records a violation:
 *   floor      the Terraform `*.<domain>` Access app exists with exactly [policyId] and covers the host
 *   access     exactly one per-app Access app exists for the host, with exactly [policyId]
 *   subdomain  a plain Workers script behind the host has workers.dev and preview URLs off
 *   aud        the script behind the host is deployed and its CF_ACCESS_AUD is that app's AUD
 * A request to an endpoint the fake does not model is a violation too, so a mistyped DELETE cannot
 * pass as "404, already gone". Every scenario should end with `expect(fake.violations).toEqual([])`.
 *
 * The fake never assumes the safe answer. A Worker created without a `subdomain` setting gets
 * `newWorkerSubdomainDefault` (on, Cloudflare's documented default). Access accepts duplicate apps
 * for one hostname, and its `domain` filter matches substrings unless `exact=true`. Deleting a
 * script leaves its custom domain behind.
 *
 * Branch on HTTP status. Error codes are the best-known values (7404 and 10006 are what wrangler
 * branches on); the live smoke prints the real envelope for the D1 failure it provokes.
 */

export const FAKE_CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.fake.invalid/client/v4";

const ACCESS_AUD_BINDING = "CF_ACCESS_AUD";

export const FAKE_STEPS = [
  "access.get_floor",
  "access.get",
  "access.list",
  "access.create",
  "access.update",
  "access.delete",
  "workers.get",
  "workers.create",
  "workers.subdomain.get",
  "workers.subdomain.set",
  "assets.session",
  "assets.upload",
  "versions.create",
  "deployments.create",
  "scripts.delete",
  "dispatch.get",
  "dispatch.put",
  "dispatch.delete",
  "domains.list",
  "domains.put",
  "domains.delete",
  "d1.list",
  "d1.create",
  "d1.get",
  "d1.delete",
  "d1.query",
  "d1.bookmark",
  "d1.restore",
  "kv.list",
  "kv.create",
  "kv.get",
  "kv.delete",
  "r2.get",
  "r2.create",
  "r2.delete",
  "r2.lifecycle.get",
  "r2.lifecycle.put",
] as const;
export type FakeStep = (typeof FAKE_STEPS)[number];

export interface SubdomainSetting {
  enabled: boolean;
  previews_enabled: boolean;
}

export interface FakeCloudflareOptions {
  accountId: string;
  zoneId: string;
  appsDomain: string;
  /** The Terraform-owned visitor policy: the only policy any apps hostname may carry. */
  policyId: string;
  /** The Terraform-owned `*.<appsDomain>` Access app. */
  floorAppId: string;
  /** Prefix of every app script name; the dispatcher maps `<label>.<domain>` to `<prefix><label>`. */
  scriptPrefix: string;
  dispatchNamespace?: string;
  /** The Terraform-owned dispatcher Worker; custom domains may target it. */
  dispatcherService?: string;
  /** When set, every request except an assets upload must carry it as the bearer token. */
  apiToken?: string;
  /** What a Worker created without a `subdomain` setting gets. Defaults to Cloudflare's: both on. */
  newWorkerSubdomainDefault?: SubdomainSetting;
  /** Hostnames with DNS records the platform did not create. */
  foreignHostnames?: readonly string[];
  assetsPerBucket?: number;
  kvPageSize?: number;
}

export interface InjectedFailure {
  step: FakeStep;
  /** HTTP status to return; null makes `fetch` reject as a network error would. */
  status: number | null;
  /** Apply the request's effect, then fail: an ambiguous outcome. */
  applyThenFail?: boolean;
  codes?: readonly number[];
  retryAfterSeconds?: number;
  /** How many matching requests fail. Defaults to 1. */
  times?: number;
}

export interface FakeCall {
  step: FakeStep;
  method: string;
  /** Path below `/accounts/<id>`, without the query. */
  path: string;
}

export type FakeBinding = Readonly<Record<string, unknown>> & {
  readonly type: string;
  readonly name: string;
};

export interface FakeScriptVersionView {
  id: string;
  mainModule: string;
  moduleNames: readonly string[];
  bindings: readonly FakeBinding[];
  /** The `plain_text` bindings by name. */
  vars: Readonly<Record<string, string>>;
  assetPaths: readonly string[];
  assetsConfig: Readonly<Record<string, unknown>> | null;
  annotations: Readonly<Record<string, string>>;
}

export interface FakeWorkerView {
  id: string;
  name: string;
  subdomain: SubdomainSetting;
  activeVersion: FakeScriptVersionView | null;
  versionCount: number;
}

export interface FakeAccessAppView {
  id: string;
  aud: string;
  policyIds: readonly string[];
}

export interface FakeD1View {
  uuid: string;
  name: string;
  jurisdiction: string | null;
  tables: readonly string[];
  /** Statements committed so far, in order. */
  log: readonly string[];
}

export interface FakeR2View {
  name: string;
  jurisdiction: string;
  objects: number;
  lifecycleRules: readonly unknown[];
}

export interface FakeCloudflare {
  readonly fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  readonly calls: readonly FakeCall[];
  readonly violations: readonly string[];
  inject(failure: InjectedFailure): void;
  /** Run `hook` once, the next time `step` is requested, before the request takes effect. */
  onStep(step: FakeStep, hook: () => void | Promise<void>): void;
  advanceTime(ms: number): void;

  accessAppsFor(hostname: string): readonly FakeAccessAppView[];
  domainFor(hostname: string): { id: string; service: string } | null;
  script(name: string): FakeWorkerView | null;
  dispatchScript(name: string): FakeScriptVersionView | null;
  d1(idOrName: string): FakeD1View | null;
  kvNamespaces(): readonly { id: string; title: string }[];
  r2Bucket(name: string, jurisdiction?: string): FakeR2View | null;

  /** Dashboard drift and out-of-band state. None of these trigger invariant checks. */
  deleteFloor(): void;
  setAccessPolicies(hostname: string, policyIds: readonly string[]): void;
  enableSubdomain(script: string): void;
  seedD1(name: string, options?: { jurisdiction?: string }): string;
  seedKv(title: string): string;
  seedR2(name: string, options?: { jurisdiction?: string; objects?: number }): void;
  putR2Objects(name: string, count: number, jurisdiction?: string): void;
  /** Apply every bucket's expire-all lifecycle rule, as Cloudflare eventually does. */
  runR2Lifecycle(): void;
}

const CODE = {
  auth: 10000,
  invalid: 10001,
  internal: 10002,
  throttled: 971,
  noRoute: 7003,
  scriptNotFound: 10007,
  scriptRejected: 10021,
  exists: 10009,
  hostnameTaken: 100117,
  d1NotFound: 7404,
  d1Sql: 7500,
  d1Exists: 7502,
  kvNotFound: 10013,
  kvTitleTaken: 10014,
  r2Exists: 10004,
  r2NotFound: 10006,
  r2NotEmpty: 10008,
} as const;

const R2_JURISDICTIONS = new Set(["default", "eu", "fedramp"]);
const D1_JURISDICTIONS = new Set(["eu", "fedramp"]);
const ASSET_HASH_PATTERN = /^[0-9a-f]{32}$/;
const R2_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

type IngressFacet = "floor" | "access" | "subdomain" | "aud";
const ALL_FACETS: readonly IngressFacet[] = ["floor", "access", "subdomain", "aud"];

class CloudflareFault extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

interface Handled {
  status?: number;
  result: unknown;
  resultInfo?: Record<string, number>;
}

interface RouteContext {
  readonly request: Request;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
}

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
  readonly step: (params: Readonly<Record<string, string>>) => FakeStep;
  readonly handle: (context: RouteContext) => Handled | Promise<Handled>;
}

interface AccessPolicyRef {
  id: string;
  precedence: number;
}

interface AccessApp {
  readonly id: string;
  readonly aud: string;
  readonly createdAt: string;
  domain: string;
  policies: AccessPolicyRef[];
  fields: Record<string, unknown>;
  updatedAt: string;
}

interface ScriptVersion {
  readonly id: string;
  readonly mainModule: string;
  readonly moduleNames: readonly string[];
  readonly bindings: readonly FakeBinding[];
  readonly assets: {
    readonly paths: readonly string[];
    readonly config: Readonly<Record<string, unknown>>;
  } | null;
  readonly annotations: Readonly<Record<string, string>>;
}

interface WorkerScript {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  subdomain: SubdomainSetting;
  readonly versions: Map<string, ScriptVersion>;
  activeVersionId: string | null;
}

interface NamespaceScript {
  readonly createdAt: string;
  modifiedAt: string;
  version: ScriptVersion;
}

interface CustomDomain {
  readonly id: string;
  readonly hostname: string;
  readonly service: string;
  readonly zoneId: string;
  readonly environment: string;
}

interface UploadSession {
  readonly jwt: string;
  /** `worker:<script>` or `dispatch:<script>`: the script the uploaded assets may be used by. */
  readonly key: string;
  readonly manifest: Readonly<Record<string, { hash: string; size: number }>>;
  readonly requested: ReadonlySet<string>;
  readonly pending: Set<string>;
  completionJwt: string | null;
}

interface D1State {
  readonly tables: Map<string, { name: string; rows: number }>;
  readonly log: string[];
}

interface D1Database {
  readonly uuid: string;
  readonly name: string;
  readonly jurisdiction: string | null;
  readonly createdAt: string;
  state: D1State;
  readonly history: { bookmark: string; at: number; state: D1State }[];
}

interface R2Bucket {
  readonly name: string;
  readonly jurisdiction: string;
  readonly creationDate: string;
  objects: number;
  lifecycleRules: unknown[];
}

export function createFakeCloudflare(options: FakeCloudflareOptions): FakeCloudflare {
  const appsDomain = options.appsDomain.toLowerCase();
  const assetsPerBucket = options.assetsPerBucket ?? 2;
  const kvPageSize = options.kvPageSize ?? 20;
  const newWorkerSubdomain = options.newWorkerSubdomainDefault ?? {
    enabled: true,
    previews_enabled: true,
  };
  const foreignHostnames = new Set((options.foreignHostnames ?? []).map((h) => h.toLowerCase()));

  let idCounter = 0;
  const newId = (length = 32): string => {
    idCounter += 1;
    return idCounter.toString(16).padStart(length, "0");
  };
  let clockMs = Date.UTC(2026, 0, 1);
  const isoNow = (): string => new Date(clockMs).toISOString();

  const calls: FakeCall[] = [];
  const violations: string[] = [];
  const injections: (InjectedFailure & { remaining: number })[] = [];
  const hooks = new Map<FakeStep, (() => void | Promise<void>)[]>();

  const accessApps = new Map<string, AccessApp>();
  const workers = new Map<string, WorkerScript>();
  const namespaceScripts = new Map<string, NamespaceScript>();
  const domains = new Map<string, CustomDomain>();
  const uploadSessions = new Map<string, UploadSession>();
  const completedUploads = new Map<string, UploadSession>();
  const assetStore = new Set<string>();
  const databases = new Map<string, D1Database>();
  const kvNamespaces = new Map<string, { id: string; title: string }>();
  const buckets = new Map<string, R2Bucket>();

  accessApps.set(options.floorAppId, {
    id: options.floorAppId,
    aud: newId(64),
    createdAt: isoNow(),
    updatedAt: isoNow(),
    domain: `*.${appsDomain}`,
    policies: [{ id: options.policyId, precedence: 1 }],
    fields: { name: "apps floor", type: "self_hosted" },
  });

  function recordViolation(message: string): void {
    if (!violations.includes(message)) violations.push(message);
  }

  // ---- Ingress invariant ------------------------------------------------------------------------

  function labelOf(hostname: string): string | null {
    const suffix = `.${appsDomain}`;
    if (!hostname.endsWith(suffix)) return null;
    const label = hostname.slice(0, -suffix.length);
    return label && !label.includes(".") ? label : null;
  }

  function perAppAccessApps(hostname: string): AccessApp[] {
    return [...accessApps.values()].filter(
      (app) => app.id !== options.floorAppId && app.domain === hostname
    );
  }

  function hasOnlyVisitorPolicy(app: AccessApp): boolean {
    return app.policies.length === 1 && app.policies[0].id === options.policyId;
  }

  function isDispatcher(service: string): boolean {
    return options.dispatcherService !== undefined && service === options.dispatcherService;
  }

  function versionBehind(domain: CustomDomain): { script: string; version: ScriptVersion | null } {
    if (isDispatcher(domain.service)) {
      const script = `${options.scriptPrefix}${labelOf(domain.hostname) ?? domain.hostname}`;
      return { script, version: namespaceScripts.get(script)?.version ?? null };
    }
    const worker = workers.get(domain.service);
    const version = worker?.activeVersionId ? worker.versions.get(worker.activeVersionId) : null;
    return { script: domain.service, version: version ?? null };
  }

  function ingressProblems(domain: CustomDomain, facets: readonly IngressFacet[]): string[] {
    const problems: string[] = [];
    const { hostname } = domain;
    const perApp = perAppAccessApps(hostname);
    if (facets.includes("floor")) {
      const floor = accessApps.get(options.floorAppId);
      if (!floor) problems.push("the *.domain floor Access app is missing");
      else if (floor.domain !== `*.${appsDomain}` || !hasOnlyVisitorPolicy(floor)) {
        problems.push(
          "the floor Access app no longer covers *.domain with exactly the visitor policy"
        );
      }
      if (labelOf(hostname) === null) {
        problems.push("the hostname is not one label under the floor");
      }
    }
    if (facets.includes("access")) {
      if (perApp.length === 0) problems.push("no per-app Access app");
      else if (perApp.length > 1) problems.push(`${perApp.length} per-app Access apps`);
      else if (!hasOnlyVisitorPolicy(perApp[0])) {
        problems.push("the per-app Access app does not carry exactly the visitor policy");
      }
    }
    if (facets.includes("subdomain") && !isDispatcher(domain.service)) {
      const subdomain = workers.get(domain.service)?.subdomain;
      if (subdomain?.enabled || subdomain?.previews_enabled) {
        problems.push(`workers.dev or preview URLs are enabled on ${domain.service}`);
      }
    }
    if (facets.includes("aud")) {
      const { script, version } = versionBehind(domain);
      if (!version) problems.push(`no deployed script ${script}`);
      else if (perApp.length === 1 && varsOf(version)[ACCESS_AUD_BINDING] !== perApp[0].aud) {
        problems.push(`${ACCESS_AUD_BINDING} on ${script} is not the per-app Access AUD`);
      }
    }
    return problems;
  }

  function checkIngress(
    trigger: FakeStep,
    hostnames: Iterable<string>,
    facets: readonly IngressFacet[]
  ): void {
    for (const hostname of hostnames) {
      const domain = domains.get(hostname);
      if (!domain) continue;
      for (const problem of ingressProblems(domain, facets)) {
        recordViolation(`${trigger}: ${hostname}: ${problem}`);
      }
    }
  }

  function hostnamesServing(service: string, script?: string): string[] {
    return [...domains.values()]
      .filter((domain) => domain.service === service)
      .filter((domain) => script === undefined || versionBehind(domain).script === script)
      .map((domain) => domain.hostname);
  }

  function checkAccessChange(trigger: FakeStep, appId: string, hostnames: string[]): void {
    if (appId === options.floorAppId) checkIngress(trigger, domains.keys(), ["floor"]);
    else checkIngress(trigger, hostnames, ["access"]);
  }

  // ---- Shared parsing ---------------------------------------------------------------------------

  async function readJson(request: Request): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new CloudflareFault(400, CODE.invalid, "request body is not valid JSON");
    }
    if (!isRecord(body)) {
      throw new CloudflareFault(400, CODE.invalid, "request body must be a JSON object");
    }
    return body;
  }

  async function readForm(request: Request): Promise<FormData> {
    try {
      return await request.formData();
    } catch {
      throw new CloudflareFault(400, CODE.invalid, "request body is not multipart form data");
    }
  }

  function paginate<T>(items: readonly T[], query: URLSearchParams, defaultPerPage: number) {
    const perPage = Number(query.get("per_page") ?? defaultPerPage);
    const page = Number(query.get("page") ?? 1);
    const start = (page - 1) * perPage;
    const result = items.slice(start, start + perPage);
    return {
      result,
      resultInfo: {
        page,
        per_page: perPage,
        count: result.length,
        total_count: items.length,
        total_pages: Math.max(1, Math.ceil(items.length / perPage)),
      },
    };
  }

  // ---- Access -----------------------------------------------------------------------------------

  function accessAppView(app: AccessApp): Record<string, unknown> {
    return {
      ...app.fields,
      id: app.id,
      aud: app.aud,
      domain: app.domain,
      policies: app.policies.map((policy) => ({ ...policy })),
      created_at: app.createdAt,
      updated_at: app.updatedAt,
    };
  }

  function parseAccessApp(body: Record<string, unknown>) {
    if (body.type !== "self_hosted") {
      throw new CloudflareFault(400, CODE.invalid, "the fake models self_hosted Access apps only");
    }
    const { id: _id, aud: _aud, domain, policies, ...fields } = body;
    if (typeof domain !== "string" || !domain) {
      throw new CloudflareFault(400, CODE.invalid, "a self_hosted Access app needs a domain");
    }
    return { domain: domain.toLowerCase(), policies: parsePolicies(policies), fields };
  }

  function requireAccessApp(id: string): AccessApp {
    const app = accessApps.get(id);
    if (!app) throw new CloudflareFault(404, CODE.invalid, `Access application ${id} not found`);
    return app;
  }

  // ---- Workers and assets -----------------------------------------------------------------------

  function workerView(worker: WorkerScript): Record<string, unknown> {
    return {
      id: worker.id,
      name: worker.name,
      created_on: worker.createdAt,
      subdomain: { ...worker.subdomain },
    };
  }

  function findWorker(idOrName: string): WorkerScript {
    const worker =
      workers.get(idOrName) ?? [...workers.values()].find((candidate) => candidate.id === idOrName);
    if (!worker) {
      throw new CloudflareFault(404, CODE.scriptNotFound, `Worker ${idOrName} not found`);
    }
    return worker;
  }

  function requireNamespace(namespace: string): void {
    if (namespace !== options.dispatchNamespace) {
      throw new CloudflareFault(404, CODE.invalid, `dispatch namespace ${namespace} not found`);
    }
  }

  function buildVersion(
    input: {
      mainModule: unknown;
      moduleNames: readonly string[];
      bindings: unknown;
      assets: unknown;
      annotations: unknown;
    },
    assetKey: string
  ): ScriptVersion {
    if (typeof input.mainModule !== "string" || !input.moduleNames.includes(input.mainModule)) {
      throw new CloudflareFault(
        400,
        CODE.scriptRejected,
        `main_module ${String(input.mainModule)} is not one of the uploaded modules`
      );
    }
    const bindings = parseBindings(input.bindings);
    let assets: ScriptVersion["assets"] = null;
    if (input.assets !== undefined) {
      if (!isRecord(input.assets)) {
        throw new CloudflareFault(400, CODE.scriptRejected, "assets must be an object");
      }
      let paths: string[] = [];
      if (input.assets.jwt !== undefined) {
        const session =
          typeof input.assets.jwt === "string" ? completedUploads.get(input.assets.jwt) : undefined;
        if (!session || session.key !== assetKey) {
          throw new CloudflareFault(
            400,
            CODE.scriptRejected,
            "assets.jwt is not a completed upload session for this script"
          );
        }
        paths = Object.keys(session.manifest).sort();
      }
      assets = { paths, config: isRecord(input.assets.config) ? { ...input.assets.config } : {} };
    }
    return {
      id: newId(),
      mainModule: input.mainModule,
      moduleNames: [...input.moduleNames],
      bindings,
      assets,
      annotations: stringRecord(input.annotations),
    };
  }

  function versionView(version: ScriptVersion): FakeScriptVersionView {
    return {
      id: version.id,
      mainModule: version.mainModule,
      moduleNames: version.moduleNames,
      bindings: version.bindings,
      vars: varsOf(version),
      assetPaths: version.assets?.paths ?? [],
      assetsConfig: version.assets?.config ?? null,
      annotations: version.annotations,
    };
  }

  async function startUploadSession(key: string, request: Request): Promise<Handled> {
    const body = await readJson(request);
    if (!isRecord(body.manifest)) {
      throw new CloudflareFault(400, CODE.invalid, "manifest must be an object");
    }
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const [path, entry] of Object.entries(body.manifest)) {
      const hash = isRecord(entry) ? entry.hash : undefined;
      const size = isRecord(entry) ? entry.size : undefined;
      if (
        !path.startsWith("/") ||
        typeof hash !== "string" ||
        !ASSET_HASH_PATTERN.test(hash) ||
        typeof size !== "number" ||
        !Number.isInteger(size) ||
        size < 0
      ) {
        throw new CloudflareFault(
          400,
          CODE.invalid,
          `manifest entry ${path} needs a 32 hex character hash and a size`
        );
      }
      manifest[path] = { hash, size };
    }
    const requested = new Set(Object.values(manifest).map((entry) => entry.hash));
    const pending = [...requested].filter((hash) => !assetStore.has(hash));
    const session: UploadSession = {
      jwt: `fake-upload-session-${newId(8)}`,
      key,
      manifest,
      requested,
      pending: new Set(pending),
      completionJwt: null,
    };
    if (pending.length === 0) {
      return { result: { jwt: completeUpload(session), buckets: [] } };
    }
    uploadSessions.set(session.jwt, session);
    const bucketsToUpload: string[][] = [];
    for (let index = 0; index < pending.length; index += assetsPerBucket) {
      bucketsToUpload.push(pending.slice(index, index + assetsPerBucket));
    }
    return { result: { jwt: session.jwt, buckets: bucketsToUpload } };
  }

  function completeUpload(session: UploadSession): string {
    if (!session.completionJwt) {
      session.completionJwt = `fake-upload-complete-${newId(8)}`;
      completedUploads.set(session.completionJwt, session);
    }
    return session.completionJwt;
  }

  // ---- D1 ---------------------------------------------------------------------------------------

  function createDatabase(name: string, jurisdiction: string | null): D1Database {
    if ([...databases.values()].some((db) => db.name === name)) {
      throw new CloudflareFault(400, CODE.d1Exists, `a database named ${name} already exists`);
    }
    const db: D1Database = {
      uuid: uuidFrom(newId()),
      name,
      jurisdiction,
      createdAt: isoNow(),
      state: { tables: new Map(), log: [] },
      history: [],
    };
    commitD1(db, db.state);
    databases.set(db.uuid, db);
    return db;
  }

  function commitD1(db: D1Database, state: D1State): void {
    db.state = state;
    const bookmark = `${db.history.length.toString(16).padStart(8, "0")}-00000000-${db.uuid}`;
    db.history.push({ bookmark, at: clockMs, state: cloneD1State(state) });
  }

  function currentBookmark(db: D1Database): string {
    return db.history[db.history.length - 1].bookmark;
  }

  function requireDatabase(id: string): D1Database {
    const db = databases.get(id);
    if (!db) throw new CloudflareFault(404, CODE.d1NotFound, `database ${id} not found`);
    return db;
  }

  function databaseView(db: D1Database): Record<string, unknown> {
    return {
      uuid: db.uuid,
      name: db.name,
      created_at: db.createdAt,
      version: "production",
      num_tables: db.state.tables.size,
      file_size: 4096 * (1 + db.state.tables.size),
      read_replication: { mode: "disabled" },
      ...(db.jurisdiction ? { jurisdiction: db.jurisdiction } : {}),
    };
  }

  function bookmarkAt(db: D1Database, query: URLSearchParams): string {
    const bookmark = query.get("bookmark");
    if (bookmark !== null) {
      if (!db.history.some((entry) => entry.bookmark === bookmark)) {
        throw new CloudflareFault(400, CODE.d1Sql, `bookmark ${bookmark} is not valid`);
      }
      return bookmark;
    }
    const timestamp = query.get("timestamp");
    if (timestamp === null) return currentBookmark(db);
    const at = /^\d+$/.test(timestamp) ? Number(timestamp) * 1000 : Date.parse(timestamp);
    const entry = [...db.history].reverse().find((candidate) => candidate.at <= at);
    if (Number.isNaN(at) || !entry) {
      throw new CloudflareFault(400, CODE.d1Sql, `no bookmark at or before ${timestamp}`);
    }
    return entry.bookmark;
  }

  // ---- KV and R2 --------------------------------------------------------------------------------

  function requireNamespaceId(id: string): { id: string; title: string } {
    const namespace = kvNamespaces.get(id);
    if (!namespace) throw new CloudflareFault(404, CODE.kvNotFound, `namespace ${id} not found`);
    return namespace;
  }

  function jurisdictionOf(request: Request): string {
    const jurisdiction = request.headers.get("cf-r2-jurisdiction") ?? "default";
    if (!R2_JURISDICTIONS.has(jurisdiction)) {
      throw new CloudflareFault(400, CODE.invalid, `unknown jurisdiction ${jurisdiction}`);
    }
    return jurisdiction;
  }

  function requireBucket(name: string, jurisdiction: string): R2Bucket {
    const bucket = buckets.get(`${jurisdiction}/${name}`);
    if (!bucket) {
      throw new CloudflareFault(404, CODE.r2NotFound, "The specified bucket does not exist.");
    }
    return bucket;
  }

  function bucketView(bucket: R2Bucket): Record<string, unknown> {
    return {
      name: bucket.name,
      creation_date: bucket.creationDate,
      location: "ENAM",
      storage_class: "Standard",
      ...(bucket.jurisdiction === "default" ? {} : { jurisdiction: bucket.jurisdiction }),
    };
  }

  function createBucket(name: string, jurisdiction: string): R2Bucket {
    if (!R2_BUCKET_NAME_PATTERN.test(name)) {
      throw new CloudflareFault(400, CODE.invalid, `${name} is not a valid bucket name`);
    }
    const key = `${jurisdiction}/${name}`;
    if (buckets.has(key)) {
      throw new CloudflareFault(
        409,
        CODE.r2Exists,
        "The bucket you tried to create already exists."
      );
    }
    const bucket: R2Bucket = {
      name,
      jurisdiction,
      creationDate: isoNow(),
      objects: 0,
      lifecycleRules: [],
    };
    buckets.set(key, bucket);
    return bucket;
  }

  // ---- Routes -----------------------------------------------------------------------------------

  const routes: Route[] = [
    route(
      "GET",
      "/access/apps/:id",
      ({ id }) => (id === options.floorAppId ? "access.get_floor" : "access.get"),
      ({ params }) => ({ result: accessAppView(requireAccessApp(params.id)) })
    ),

    route("GET", "/access/apps", "access.list", ({ query }) => {
      const domain = query.get("domain")?.toLowerCase();
      const exact = query.get("exact") === "true";
      const aud = query.get("aud");
      const matches = [...accessApps.values()].filter(
        (app) =>
          (domain === undefined || (exact ? app.domain === domain : app.domain.includes(domain))) &&
          (aud === null || app.aud === aud)
      );
      return { result: matches.map(accessAppView) };
    }),

    route("POST", "/access/apps", "access.create", async ({ request }) => {
      const parsed = parseAccessApp(await readJson(request));
      const app: AccessApp = {
        id: uuidFrom(newId()),
        aud: newId(64),
        createdAt: isoNow(),
        updatedAt: isoNow(),
        ...parsed,
      };
      accessApps.set(app.id, app);
      return { status: 201, result: accessAppView(app) };
    }),

    route("PUT", "/access/apps/:id", "access.update", async ({ request, params }) => {
      const app = requireAccessApp(params.id);
      const previousDomain = app.domain;
      Object.assign(app, parseAccessApp(await readJson(request)), { updatedAt: isoNow() });
      checkAccessChange("access.update", app.id, [previousDomain, app.domain]);
      return { result: accessAppView(app) };
    }),

    route("DELETE", "/access/apps/:id", "access.delete", ({ params }) => {
      const app = requireAccessApp(params.id);
      accessApps.delete(app.id);
      checkAccessChange("access.delete", app.id, [app.domain]);
      return { result: { id: app.id } };
    }),

    route("GET", "/workers/workers/:worker", "workers.get", ({ params }) => ({
      result: workerView(findWorker(params.worker)),
    })),

    route("POST", "/workers/workers", "workers.create", async ({ request }) => {
      const body = await readJson(request);
      if (typeof body.name !== "string" || !body.name) {
        throw new CloudflareFault(400, CODE.invalid, "a Worker needs a name");
      }
      if (workers.has(body.name)) {
        throw new CloudflareFault(409, CODE.exists, `a Worker named ${body.name} already exists`);
      }
      const worker: WorkerScript = {
        id: newId(),
        name: body.name,
        createdAt: isoNow(),
        subdomain:
          body.subdomain === undefined ? { ...newWorkerSubdomain } : parseSubdomain(body.subdomain),
        versions: new Map(),
        activeVersionId: null,
      };
      workers.set(worker.name, worker);
      return { result: workerView(worker) };
    }),

    route("GET", "/workers/scripts/:script/subdomain", "workers.subdomain.get", ({ params }) => ({
      result: { ...findWorker(params.script).subdomain },
    })),

    route(
      "POST",
      "/workers/scripts/:script/subdomain",
      "workers.subdomain.set",
      async ({ request, params }) => {
        const worker = findWorker(params.script);
        worker.subdomain = parseSubdomain(await readJson(request));
        checkIngress("workers.subdomain.set", hostnamesServing(worker.name), ["subdomain"]);
        return { result: { ...worker.subdomain } };
      }
    ),

    route(
      "POST",
      "/workers/scripts/:script/assets-upload-session",
      "assets.session",
      ({ request, params }) => startUploadSession(`worker:${params.script}`, request)
    ),

    route(
      "POST",
      "/workers/dispatch/namespaces/:namespace/scripts/:script/assets-upload-session",
      "assets.session",
      ({ request, params }) => {
        requireNamespace(params.namespace);
        return startUploadSession(`dispatch:${params.script}`, request);
      }
    ),

    route("POST", "/workers/assets/upload", "assets.upload", async ({ request, query }) => {
      if (query.get("base64") !== "true") {
        throw new CloudflareFault(400, CODE.invalid, "asset uploads must set base64=true");
      }
      const session = uploadSessions.get(bearerOf(request) ?? "");
      if (!session) {
        throw new CloudflareFault(401, CODE.auth, "the bearer must be an upload session JWT");
      }
      for (const [hash, value] of await readForm(request)) {
        if (!session.requested.has(hash)) {
          throw new CloudflareFault(400, CODE.invalid, `${hash} was not requested by this session`);
        }
        if (!isBase64(await entryText(value))) {
          throw new CloudflareFault(400, CODE.invalid, `${hash} is not base64 content`);
        }
        session.pending.delete(hash);
        assetStore.add(hash);
      }
      if (session.pending.size > 0) return { status: 202, result: {} };
      return { status: 201, result: { jwt: completeUpload(session) } };
    }),

    route(
      "POST",
      "/workers/workers/:worker/versions",
      "versions.create",
      async ({ request, params }) => {
        const worker = findWorker(params.worker);
        const body = await readJson(request);
        const modules = Array.isArray(body.modules) ? body.modules : [];
        const moduleNames = modules.map((module) =>
          isRecord(module) && typeof module.name === "string" ? module.name : ""
        );
        if (moduleNames.length === 0 || moduleNames.includes("")) {
          throw new CloudflareFault(400, CODE.scriptRejected, "modules must each have a name");
        }
        const version = buildVersion(
          {
            mainModule: body.main_module,
            moduleNames,
            bindings: body.bindings,
            assets: body.assets,
            annotations: body.annotations,
          },
          `worker:${worker.name}`
        );
        worker.versions.set(version.id, version);
        return {
          result: { id: version.id, number: worker.versions.size, created_on: isoNow() },
        };
      }
    ),

    route(
      "POST",
      "/workers/scripts/:script/deployments",
      "deployments.create",
      async ({ request, params }) => {
        const worker = findWorker(params.script);
        const body = await readJson(request);
        const entries = Array.isArray(body.versions) ? body.versions : [];
        const [entry] = entries;
        if (
          entries.length !== 1 ||
          !isRecord(entry) ||
          entry.percentage !== 100 ||
          typeof entry.version_id !== "string"
        ) {
          throw new CloudflareFault(
            400,
            CODE.invalid,
            "the fake models only single-version deployments at 100%"
          );
        }
        if (!worker.versions.has(entry.version_id)) {
          throw new CloudflareFault(400, CODE.invalid, `version ${entry.version_id} not found`);
        }
        worker.activeVersionId = entry.version_id;
        checkIngress("deployments.create", hostnamesServing(worker.name), ["aud"]);
        return {
          result: {
            id: newId(),
            strategy: "percentage",
            versions: [{ version_id: entry.version_id, percentage: 100 }],
            created_on: isoNow(),
          },
        };
      }
    ),

    route("DELETE", "/workers/scripts/:script", "scripts.delete", ({ params }) => {
      const worker = findWorker(params.script);
      workers.delete(worker.name);
      return { result: null };
    }),

    route(
      "GET",
      "/workers/dispatch/namespaces/:namespace/scripts/:script",
      "dispatch.get",
      ({ params }) => {
        requireNamespace(params.namespace);
        const script = namespaceScripts.get(params.script);
        if (!script) {
          throw new CloudflareFault(404, CODE.scriptNotFound, `script ${params.script} not found`);
        }
        return { result: { id: params.script, etag: script.version.id } };
      }
    ),

    route(
      "PUT",
      "/workers/dispatch/namespaces/:namespace/scripts/:script",
      "dispatch.put",
      async ({ request, params }) => {
        requireNamespace(params.namespace);
        const form = await readForm(request);
        const rawMetadata = form.get("metadata");
        let metadata: unknown = null;
        try {
          metadata = JSON.parse(await entryText(rawMetadata));
        } catch {
          metadata = null;
        }
        if (!isRecord(metadata)) {
          throw new CloudflareFault(400, CODE.invalid, "the metadata part must be a JSON object");
        }
        const moduleNames = [...new Set([...form.keys()].filter((key) => key !== "metadata"))];
        const version = buildVersion(
          {
            mainModule: metadata.main_module,
            moduleNames,
            bindings: metadata.bindings,
            assets: metadata.assets,
            annotations: metadata.annotations,
          },
          `dispatch:${params.script}`
        );
        const existing = namespaceScripts.get(params.script);
        const script: NamespaceScript = {
          createdAt: existing?.createdAt ?? isoNow(),
          modifiedAt: isoNow(),
          version,
        };
        namespaceScripts.set(params.script, script);
        if (options.dispatcherService) {
          checkIngress("dispatch.put", hostnamesServing(options.dispatcherService, params.script), [
            "aud",
          ]);
        }
        return {
          result: {
            id: params.script,
            etag: version.id,
            created_on: script.createdAt,
            modified_on: script.modifiedAt,
          },
        };
      }
    ),

    route(
      "DELETE",
      "/workers/dispatch/namespaces/:namespace/scripts/:script",
      "dispatch.delete",
      ({ params }) => {
        requireNamespace(params.namespace);
        if (!namespaceScripts.delete(params.script)) {
          throw new CloudflareFault(404, CODE.scriptNotFound, `script ${params.script} not found`);
        }
        return { result: null };
      }
    ),

    route("GET", "/workers/domains", "domains.list", ({ query }) => {
      const hostname = query.get("hostname")?.toLowerCase();
      const service = query.get("service");
      const zoneId = query.get("zone_id");
      const matches = [...domains.values()].filter(
        (domain) =>
          (hostname === undefined || domain.hostname === hostname) &&
          (service === null || domain.service === service) &&
          (zoneId === null || domain.zoneId === zoneId)
      );
      return { result: matches.map(domainView) };
    }),

    route("PUT", "/workers/domains", "domains.put", async ({ request }) => {
      const body = await readJson(request);
      const { hostname, service, zone_id: zoneId } = body;
      if (
        typeof hostname !== "string" ||
        typeof service !== "string" ||
        zoneId !== options.zoneId
      ) {
        throw new CloudflareFault(400, CODE.invalid, "hostname, service and this zone's id needed");
      }
      const host = hostname.toLowerCase();
      if (!host.endsWith(`.${appsDomain}`)) {
        throw new CloudflareFault(400, CODE.invalid, `${host} is not in zone ${appsDomain}`);
      }
      if (!workers.has(service) && !isDispatcher(service)) {
        throw new CloudflareFault(404, CODE.scriptNotFound, `Worker ${service} not found`);
      }
      if (foreignHostnames.has(host)) {
        if (body.override_existing_dns_record !== true) {
          throw new CloudflareFault(409, CODE.hostnameTaken, `${host} has existing DNS records`);
        }
        foreignHostnames.delete(host);
        recordViolation(`domains.put: ${host}: overrode a DNS record the platform does not own`);
      }
      const existing = domains.get(host);
      if (existing && existing.service !== service && body.override_existing_origin !== true) {
        throw new CloudflareFault(
          409,
          CODE.hostnameTaken,
          `${host} is attached to Worker ${existing.service}`
        );
      }
      const domain: CustomDomain = {
        id: existing?.id ?? newId(),
        hostname: host,
        service,
        zoneId,
        environment: typeof body.environment === "string" ? body.environment : "production",
      };
      domains.set(host, domain);
      checkIngress("domains.put", [host], ALL_FACETS);
      return { result: domainView(domain) };
    }),

    route("DELETE", "/workers/domains/:id", "domains.delete", ({ params }) => {
      const domain = [...domains.values()].find((candidate) => candidate.id === params.id);
      if (!domain) throw new CloudflareFault(404, CODE.invalid, `domain ${params.id} not found`);
      domains.delete(domain.hostname);
      return { result: null };
    }),

    route("GET", "/d1/database", "d1.list", ({ query }) => {
      const name = query.get("name")?.toLowerCase();
      const matches = [...databases.values()].filter(
        (db) => name === undefined || db.name.toLowerCase().includes(name)
      );
      return paginate(matches.map(databaseView), query, 1000);
    }),

    route("POST", "/d1/database", "d1.create", async ({ request }) => {
      const body = await readJson(request);
      if (typeof body.name !== "string" || !body.name) {
        throw new CloudflareFault(400, CODE.invalid, "a database needs a name");
      }
      const { jurisdiction } = body;
      if (
        jurisdiction !== undefined &&
        (typeof jurisdiction !== "string" || !D1_JURISDICTIONS.has(jurisdiction))
      ) {
        throw new CloudflareFault(
          400,
          CODE.invalid,
          `unknown jurisdiction ${String(jurisdiction)}`
        );
      }
      return { result: databaseView(createDatabase(body.name, jurisdiction ?? null)) };
    }),

    route("GET", "/d1/database/:id", "d1.get", ({ params }) => ({
      result: databaseView(requireDatabase(params.id)),
    })),

    route("DELETE", "/d1/database/:id", "d1.delete", ({ params }) => {
      databases.delete(requireDatabase(params.id).uuid);
      return { result: null };
    }),

    route("POST", "/d1/database/:id/query", "d1.query", async ({ request, params }) => {
      const db = requireDatabase(params.id);
      const body = await readJson(request);
      if (typeof body.sql !== "string") {
        throw new CloudflareFault(400, CODE.invalid, "sql must be a string");
      }
      const statements = splitSql(body.sql);
      if (statements.length === 0) {
        throw new CloudflareFault(400, CODE.d1Sql, "no SQL statements to execute");
      }
      const draft = cloneD1State(db.state);
      const results: unknown[] = [];
      let changed = false;
      for (const statement of statements) {
        const outcome = executeStatement(draft, statement);
        if ("error" in outcome) {
          throw new CloudflareFault(400, CODE.d1Sql, `${outcome.error}: SQLITE_ERROR`);
        }
        changed ||= outcome.changed;
        results.push({
          results: outcome.rows,
          success: true,
          meta: { changed_db: outcome.changed, changes: outcome.changed ? 1 : 0, duration: 0 },
        });
      }
      if (changed) commitD1(db, draft);
      return { result: results };
    }),

    route("GET", "/d1/database/:id/time_travel/bookmark", "d1.bookmark", ({ params, query }) => {
      const db = requireDatabase(params.id);
      return { result: { bookmark: bookmarkAt(db, query) } };
    }),

    route("POST", "/d1/database/:id/time_travel/restore", "d1.restore", ({ params, query }) => {
      const db = requireDatabase(params.id);
      const target = bookmarkAt(db, query);
      const previous = currentBookmark(db);
      const snapshot = db.history.find((entry) => entry.bookmark === target);
      if (snapshot) commitD1(db, cloneD1State(snapshot.state));
      return {
        result: { bookmark: target, previous_bookmark: previous, message: "Restored" },
      };
    }),

    route("GET", "/storage/kv/namespaces", "kv.list", ({ query }) =>
      paginate([...kvNamespaces.values()].map(kvView), query, kvPageSize)
    ),

    route("POST", "/storage/kv/namespaces", "kv.create", async ({ request }) => {
      const { title } = await readJson(request);
      if (typeof title !== "string" || !title) {
        throw new CloudflareFault(400, CODE.invalid, "a namespace needs a title");
      }
      if ([...kvNamespaces.values()].some((namespace) => namespace.title === title)) {
        throw new CloudflareFault(
          400,
          CODE.kvTitleTaken,
          "a namespace with this account ID and title already exists"
        );
      }
      const namespace = { id: newId(), title };
      kvNamespaces.set(namespace.id, namespace);
      return { result: kvView(namespace) };
    }),

    route("GET", "/storage/kv/namespaces/:id", "kv.get", ({ params }) => ({
      result: kvView(requireNamespaceId(params.id)),
    })),

    route("DELETE", "/storage/kv/namespaces/:id", "kv.delete", ({ params }) => {
      kvNamespaces.delete(requireNamespaceId(params.id).id);
      return { result: {} };
    }),

    route("GET", "/r2/buckets/:name", "r2.get", ({ request, params }) => ({
      result: bucketView(requireBucket(params.name, jurisdictionOf(request))),
    })),

    route("POST", "/r2/buckets", "r2.create", async ({ request }) => {
      const jurisdiction = jurisdictionOf(request);
      const { name } = await readJson(request);
      if (typeof name !== "string") {
        throw new CloudflareFault(400, CODE.invalid, "a bucket needs a name");
      }
      return { result: bucketView(createBucket(name, jurisdiction)) };
    }),

    route("DELETE", "/r2/buckets/:name", "r2.delete", ({ request, params }) => {
      const bucket = requireBucket(params.name, jurisdictionOf(request));
      if (bucket.objects > 0) {
        throw new CloudflareFault(
          409,
          CODE.r2NotEmpty,
          "The bucket you tried to delete is not empty."
        );
      }
      buckets.delete(`${bucket.jurisdiction}/${bucket.name}`);
      return { result: {} };
    }),

    route("GET", "/r2/buckets/:name/lifecycle", "r2.lifecycle.get", ({ request, params }) => ({
      result: { rules: requireBucket(params.name, jurisdictionOf(request)).lifecycleRules },
    })),

    route("PUT", "/r2/buckets/:name/lifecycle", "r2.lifecycle.put", async ({ request, params }) => {
      const bucket = requireBucket(params.name, jurisdictionOf(request));
      const { rules } = await readJson(request);
      if (!Array.isArray(rules)) {
        throw new CloudflareFault(400, CODE.invalid, "rules must be an array");
      }
      bucket.lifecycleRules = structuredClone(rules);
      return { result: {} };
    }),
  ];

  // ---- Dispatch ---------------------------------------------------------------------------------

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const fullPath = url.pathname.replace(/^\/client\/v4(?=\/)/, "");
    const accountMatch = /^\/accounts\/([^/]+)(\/.*)$/.exec(fullPath);
    const matched = accountMatch ? matchRoute(request.method, accountMatch[2]) : null;
    if (!accountMatch || !matched) {
      recordViolation(`unrouted request: ${request.method} ${fullPath}`);
      return errorResponse(404, [CODE.noRoute], `Could not route to ${fullPath}`);
    }
    if (accountMatch[1] !== options.accountId) {
      return errorResponse(403, [CODE.auth], "Authentication error");
    }
    const { route: hit, params } = matched;
    const step = hit.step(params);
    calls.push({ step, method: request.method, path: accountMatch[2] });

    const token = bearerOf(request);
    if (step !== "assets.upload" && (!token || (options.apiToken && token !== options.apiToken))) {
      return errorResponse(401, [CODE.auth], "Authentication error");
    }

    const hook = hooks.get(step)?.shift();
    if (hook) await hook();

    const injection = injections.find((candidate) => candidate.step === step);
    if (injection) {
      injection.remaining -= 1;
      if (injection.remaining <= 0) injections.splice(injections.indexOf(injection), 1);
    }
    if (injection && !injection.applyThenFail) return injectedFailure(injection);

    let response: Response;
    try {
      const handled = await hit.handle({ request, params, query: url.searchParams });
      response = jsonResponse(handled.status ?? 200, {
        success: true,
        errors: [],
        messages: [],
        result: handled.result,
        ...(handled.resultInfo ? { result_info: handled.resultInfo } : {}),
      });
    } catch (error) {
      if (!(error instanceof CloudflareFault)) throw error;
      response = errorResponse(error.status, [error.code], error.message);
    }
    return injection ? injectedFailure(injection) : response;
  }

  function matchRoute(method: string, path: string) {
    for (const candidate of routes) {
      if (candidate.method !== method) continue;
      const match = candidate.pattern.exec(path);
      if (!match) continue;
      const params = Object.fromEntries(
        candidate.paramNames.map((name, index) => [name, decodeURIComponent(match[index + 1])])
      );
      return { route: candidate, params };
    }
    return null;
  }

  return {
    fetch: (input, init) => handle(new Request(input, init)),
    calls,
    violations,
    inject(failure) {
      injections.push({ ...failure, remaining: failure.times ?? 1 });
    },
    onStep(step, hook) {
      hooks.set(step, [...(hooks.get(step) ?? []), hook]);
    },
    advanceTime(ms) {
      clockMs += ms;
    },

    accessAppsFor(hostname) {
      return perAppAccessApps(hostname.toLowerCase()).map((app) => ({
        id: app.id,
        aud: app.aud,
        policyIds: app.policies.map((policy) => policy.id),
      }));
    },
    domainFor(hostname) {
      const domain = domains.get(hostname.toLowerCase());
      return domain ? { id: domain.id, service: domain.service } : null;
    },
    script(name) {
      const worker = workers.get(name);
      if (!worker) return null;
      const active = worker.activeVersionId ? worker.versions.get(worker.activeVersionId) : null;
      return {
        id: worker.id,
        name: worker.name,
        subdomain: { ...worker.subdomain },
        activeVersion: active ? versionView(active) : null,
        versionCount: worker.versions.size,
      };
    },
    dispatchScript(name) {
      const script = namespaceScripts.get(name);
      return script ? versionView(script.version) : null;
    },
    d1(idOrName) {
      const db =
        databases.get(idOrName) ?? [...databases.values()].find((entry) => entry.name === idOrName);
      if (!db) return null;
      return {
        uuid: db.uuid,
        name: db.name,
        jurisdiction: db.jurisdiction,
        tables: [...db.state.tables.values()].map((table) => table.name).sort(),
        log: [...db.state.log],
      };
    },
    kvNamespaces() {
      return [...kvNamespaces.values()].map((namespace) => ({ ...namespace }));
    },
    r2Bucket(name, jurisdiction = "default") {
      const bucket = buckets.get(`${jurisdiction}/${name}`);
      return bucket
        ? {
            name: bucket.name,
            jurisdiction: bucket.jurisdiction,
            objects: bucket.objects,
            lifecycleRules: structuredClone(bucket.lifecycleRules),
          }
        : null;
    },

    deleteFloor() {
      accessApps.delete(options.floorAppId);
    },
    setAccessPolicies(hostname, policyIds) {
      for (const app of perAppAccessApps(hostname.toLowerCase())) {
        app.policies = policyIds.map((id, index) => ({ id, precedence: index + 1 }));
      }
    },
    enableSubdomain(script) {
      findWorker(script).subdomain = { enabled: true, previews_enabled: true };
    },
    seedD1(name, seedOptions) {
      return createDatabase(name, seedOptions?.jurisdiction ?? null).uuid;
    },
    seedKv(title) {
      const namespace = { id: newId(), title };
      kvNamespaces.set(namespace.id, namespace);
      return namespace.id;
    },
    seedR2(name, seedOptions) {
      createBucket(name, seedOptions?.jurisdiction ?? "default").objects =
        seedOptions?.objects ?? 0;
    },
    putR2Objects(name, count, jurisdiction = "default") {
      requireBucket(name, jurisdiction).objects += count;
    },
    runR2Lifecycle() {
      for (const bucket of buckets.values()) {
        if (bucket.lifecycleRules.some(expiresEverything)) bucket.objects = 0;
      }
    },
  };
}

// ---- Pure helpers -------------------------------------------------------------------------------

function route(
  method: string,
  path: string,
  step: FakeStep | Route["step"],
  handle: Route["handle"]
): Route {
  const paramNames: string[] = [];
  const source = path.replace(/:([a-z]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return {
    method,
    pattern: new RegExp(`^${source}$`),
    paramNames,
    step: typeof step === "function" ? step : () => step,
    handle,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(
  status: number,
  codes: readonly number[],
  message: string,
  headers?: Record<string, string>
): Response {
  return jsonResponse(
    status,
    {
      success: false,
      errors: codes.map((code) => ({ code, message })),
      messages: [],
      result: null,
    },
    headers
  );
}

function injectedFailure(failure: InjectedFailure): Response {
  if (failure.status === null) throw new TypeError("fetch failed (injected network error)");
  const codes = failure.codes ?? [failure.status === 429 ? CODE.throttled : CODE.internal];
  const headers: Record<string, string> =
    failure.retryAfterSeconds === undefined
      ? {}
      : { "retry-after": String(failure.retryAfterSeconds) };
  return errorResponse(failure.status, codes, `injected failure on ${failure.step}`, headers);
}

function bearerOf(request: Request): string | null {
  return /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

/** workers-types types FormData values as strings only; at runtime a file part is a Blob. */
async function entryText(value: unknown): Promise<string> {
  if (typeof value === "string") return value;
  return value instanceof Blob ? value.text() : "";
}

function isBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try {
    atob(value);
    return true;
  } catch {
    return false;
  }
}

function uuidFrom(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

function parsePolicies(raw: unknown): AccessPolicyRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new CloudflareFault(400, CODE.invalid, "policies must be an array");
  return raw.map((entry, index) => {
    if (typeof entry === "string") return { id: entry, precedence: index + 1 };
    if (isRecord(entry) && typeof entry.id === "string") {
      return {
        id: entry.id,
        precedence: typeof entry.precedence === "number" ? entry.precedence : index + 1,
      };
    }
    throw new CloudflareFault(400, CODE.invalid, "a policy is an id or { id, precedence }");
  });
}

function parseSubdomain(raw: unknown): SubdomainSetting {
  if (!isRecord(raw) || typeof raw.enabled !== "boolean") {
    throw new CloudflareFault(400, CODE.invalid, "subdomain needs a boolean enabled");
  }
  if (raw.previews_enabled !== undefined && typeof raw.previews_enabled !== "boolean") {
    throw new CloudflareFault(400, CODE.invalid, "previews_enabled must be a boolean");
  }
  // Cloudflare: when previews are not set explicitly they follow the workers.dev setting.
  return { enabled: raw.enabled, previews_enabled: raw.previews_enabled ?? raw.enabled };
}

function parseBindings(raw: unknown): FakeBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new CloudflareFault(400, CODE.scriptRejected, "bindings must be an array");
  }
  const names = new Set<string>();
  return raw.map((binding) => {
    if (
      !isRecord(binding) ||
      typeof binding.type !== "string" ||
      typeof binding.name !== "string"
    ) {
      throw new CloudflareFault(400, CODE.scriptRejected, "each binding needs a type and a name");
    }
    if (names.has(binding.name)) {
      throw new CloudflareFault(400, CODE.scriptRejected, `binding ${binding.name} is duplicated`);
    }
    names.add(binding.name);
    return { ...binding, type: binding.type, name: binding.name };
  });
}

function varsOf(version: ScriptVersion): Record<string, string> {
  return Object.fromEntries(
    version.bindings
      .filter((binding) => binding.type === "plain_text" && typeof binding.text === "string")
      .map((binding) => [binding.name, binding.text as string])
  );
}

function domainView(domain: CustomDomain): Record<string, unknown> {
  return {
    id: domain.id,
    hostname: domain.hostname,
    service: domain.service,
    zone_id: domain.zoneId,
    environment: domain.environment,
  };
}

function kvView(namespace: { id: string; title: string }): Record<string, unknown> {
  return { id: namespace.id, title: namespace.title, supports_url_encoding: true };
}

function expiresEverything(rule: unknown): boolean {
  if (!isRecord(rule) || rule.enabled !== true || !isRecord(rule.deleteObjectsTransition)) {
    return false;
  }
  const prefix = isRecord(rule.conditions) ? rule.conditions.prefix : undefined;
  return prefix === undefined || prefix === "";
}

function cloneD1State(state: D1State): D1State {
  return {
    tables: new Map([...state.tables].map(([key, table]) => [key, { ...table }])),
    log: [...state.log],
  };
}

/**
 * Splits a request body into statements on semicolons outside quotes and comments, the way D1
 * sees a multi-statement `/query` body.
 */
function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      current += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 1;
      current += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    if (char === "[") quote = "]";
    if (char === ";") {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const IDENT = String.raw`("[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const SQL_FORMS = {
  createTable: new RegExp(String.raw`^CREATE TABLE (IF NOT EXISTS )?${IDENT}`, "i"),
  createIndex: new RegExp(
    String.raw`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${IDENT} ON ${IDENT}`,
    "i"
  ),
  dropTable: new RegExp(String.raw`^DROP TABLE (IF EXISTS )?${IDENT}`, "i"),
  alterTable: new RegExp(String.raw`^ALTER TABLE ${IDENT}(?: RENAME TO ${IDENT})?`, "i"),
  writeRow: new RegExp(
    String.raw`^(?:INSERT (?:OR \w+ )?INTO|REPLACE INTO|UPDATE (?:OR \w+ )?|DELETE FROM) ?${IDENT}`,
    "i"
  ),
  schemaLookup: /^SELECT name FROM sqlite_(?:master|schema)\b/i,
  read: /^(?:SELECT|PRAGMA|EXPLAIN)\b/i,
};

function tableKey(identifier: string): string {
  return identifier.replace(/^["`[]|["`\]]$/g, "").toLowerCase();
}

/**
 * Applies one statement to `state`: enough of SQLite's table semantics for a later statement to
 * fail on an earlier one's effect (missing or duplicate tables). Rows are counted, not stored.
 */
function executeStatement(
  state: D1State,
  sql: string
): { rows: unknown[]; changed: boolean } | { error: string } {
  const has = (identifier: string) => state.tables.has(tableKey(identifier));
  const missing = (identifier: string) => ({ error: `no such table: ${tableKey(identifier)}` });
  const applied = (rows: unknown[] = []) => {
    state.log.push(sql);
    return { rows, changed: true };
  };
  let match: RegExpExecArray | null;
  if ((match = SQL_FORMS.createTable.exec(sql))) {
    const [, ifNotExists, name] = match;
    if (has(name)) {
      return ifNotExists
        ? { rows: [], changed: false }
        : { error: `table ${tableKey(name)} already exists` };
    }
    state.tables.set(tableKey(name), { name: tableKey(name), rows: 0 });
    return applied();
  }
  if ((match = SQL_FORMS.createIndex.exec(sql))) {
    return has(match[2]) ? applied() : missing(match[2]);
  }
  if ((match = SQL_FORMS.dropTable.exec(sql))) {
    const [, ifExists, name] = match;
    if (!has(name)) return ifExists ? { rows: [], changed: false } : missing(name);
    state.tables.delete(tableKey(name));
    return applied();
  }
  if ((match = SQL_FORMS.alterTable.exec(sql))) {
    const [, name, renameTo] = match;
    if (!has(name)) return missing(name);
    if (renameTo) {
      const table = state.tables.get(tableKey(name));
      state.tables.delete(tableKey(name));
      state.tables.set(tableKey(renameTo), { name: tableKey(renameTo), rows: table?.rows ?? 0 });
    }
    return applied();
  }
  if ((match = SQL_FORMS.writeRow.exec(sql))) {
    const table = state.tables.get(tableKey(match[1]));
    if (!table) return missing(match[1]);
    if (/^(?:INSERT|REPLACE)/i.test(sql)) table.rows += 1;
    return applied();
  }
  if (SQL_FORMS.schemaLookup.test(sql)) {
    const wanted = /\bname\s*=\s*'([^']*)'/i.exec(sql)?.[1]?.toLowerCase();
    const rows = [...state.tables.values()]
      .filter((table) => wanted === undefined || table.name === wanted)
      .map((table) => ({ name: table.name }));
    return { rows, changed: false };
  }
  if (SQL_FORMS.read.test(sql)) return { rows: [], changed: false };
  return applied();
}
