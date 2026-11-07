import type { BrokerBinding } from "@open-inspect/shared/app-broker";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { afterEach, expect } from "vitest";
import { createBrokerApp, type BrokerEnv } from "../src/index";
import type { GuardBundle } from "../src/publish";
import {
  FAKE_CLOUDFLARE_API_BASE_URL,
  createFakeCloudflare,
  type FakeCloudflare,
  type FakeCloudflareOptions,
} from "./fake-cloudflare";

export type Backend = "workers" | "dispatch-namespace";
export const BACKENDS: readonly Backend[] = ["workers", "dispatch-namespace"];

export const FAKE_OPTIONS: FakeCloudflareOptions = {
  accountId: "acct-test",
  zoneId: "zone-test",
  appsDomain: "apps.example.test",
  policyId: "policy-visitors",
  floorAppId: "floor-app",
  scriptPrefix: "app-",
  dispatchNamespace: "apps-namespace",
  dispatcherService: "apps-dispatcher",
  apiToken: "placeholder-apps-api-token",
};
export const SERVICE_SECRET = "placeholder-control-plane-secret";
export const BROKER_ORIGIN = "https://deployer.apps.example.test";
export const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";

/** Stand-ins for the built guard; the fake never runs module code. */
export const TEST_GUARD: GuardBundle = {
  modules: [
    { name: "guard.mjs", source: "export { default } from './guard-core.mjs';\n" },
    { name: "guard-core.mjs", source: "export default {};\n" },
  ],
  userModuleName: "app.mjs",
};

export function brokerEnv(backend: Backend, overrides: Partial<BrokerEnv> = {}): BrokerEnv {
  return {
    APPS_ACCOUNT_ID: FAKE_OPTIONS.accountId,
    APPS_ZONE_ID: FAKE_OPTIONS.zoneId,
    APPS_DOMAIN: FAKE_OPTIONS.appsDomain,
    APPS_SCRIPT_PREFIX: FAKE_OPTIONS.scriptPrefix,
    APPS_HOSTING_BACKEND: backend,
    ...(backend === "dispatch-namespace"
      ? {
          APPS_DISPATCH_NAMESPACE: FAKE_OPTIONS.dispatchNamespace,
          APPS_DISPATCHER_SERVICE: FAKE_OPTIONS.dispatcherService,
        }
      : {}),
    APPS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    APPS_ACCESS_POLICY_ID: FAKE_OPTIONS.policyId,
    APPS_ACCESS_FLOOR_APP_ID: FAKE_OPTIONS.floorAppId,
    APP_DATA_JURISDICTION: "",
    APPS_API_TOKEN: FAKE_OPTIONS.apiToken,
    SERVICE_AUTH_SECRET_CONTROL_PLANE: SERVICE_SECRET,
    ...overrides,
  };
}

export interface DeployInput {
  name: string;
  assets?: Readonly<Record<string, string>>;
  worker?: string;
  bindings?: readonly BrokerBinding[] | readonly Record<string, unknown>[];
  deploymentId?: string;
  /** Extra request fields, to prove the broker refuses them. */
  extra?: Readonly<Record<string, unknown>>;
}

export function deployForm(input: DeployInput): FormData {
  const assets = Object.entries(input.assets ?? { "/index.html": "<h1>inventory</h1>" });
  const request = {
    name: input.name,
    deploymentId: input.deploymentId ?? "deployment-1",
    assets: assets.map(([path], index) => ({ path, part: `a${index}` })),
    worker: input.worker === undefined ? null : { part: "worker" },
    notFoundHandling: "single-page-application",
    bindings: input.bindings ?? [],
    ...input.extra,
  };
  const form = new FormData();
  form.append("request", JSON.stringify(request));
  assets.forEach(([path, text], index) => {
    form.append(`a${index}`, new File([text], path.slice(1)));
  });
  if (input.worker !== undefined) {
    form.append(
      "worker",
      new File([input.worker], "worker.mjs", { type: "application/javascript+module" })
    );
  }
  return form;
}

export interface SignOptions {
  service?: string;
  secret?: string;
  method?: string;
  /** Sign as if the clock read this many ms earlier. */
  signedAgoMs?: number;
}

/** A request signed the way the control plane signs it. */
export async function signedRequest(
  path: string,
  body: { json?: unknown; form?: FormData; bytes?: Uint8Array; contentType?: string } = {},
  options: SignOptions = {}
): Promise<Request> {
  const url = `${BROKER_ORIGIN}${path}`;
  const method = options.method ?? ((body.json ?? body.form ?? body.bytes) ? "POST" : "GET");
  let bytes: Uint8Array | undefined = body.bytes;
  let contentType = body.contentType;
  if (body.json !== undefined) {
    bytes = new TextEncoder().encode(JSON.stringify(body.json));
    contentType = "application/json";
  } else if (body.form) {
    const encoded = new Request(url, { method: "POST", body: body.form });
    bytes = new Uint8Array(await encoded.arrayBuffer());
    contentType = encoded.headers.get("content-type") ?? undefined;
  }
  const realNow = Date.now;
  if (options.signedAgoMs) Date.now = () => realNow() - (options.signedAgoMs ?? 0);
  let headers: Record<string, string>;
  try {
    headers = await buildServiceAuthHeaders({
      service: (options.service ?? "control-plane") as "control-plane",
      secret: options.secret ?? SERVICE_SECRET,
      method,
      url,
      body: bytes ?? "",
    });
  } finally {
    Date.now = realNow;
  }
  return new Request(url, {
    method,
    headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) },
    body: bytes,
  });
}

export interface Harness {
  fake: FakeCloudflare;
  env: BrokerEnv;
  backend: Backend;
  /** Every wait the broker asked for, in ms. */
  sleeps: number[];
  call(request: Request): Promise<Response>;
  deploy(input: DeployInput): Promise<Response>;
  takedown(name: string): Promise<Response>;
  data(op: Record<string, unknown>): Promise<Response>;
}

const fakesInThisTest: FakeCloudflare[] = [];

/** A fake whose ingress invariant is checked after the test, whatever the test asserts. */
export function trackedFake(options: Partial<FakeCloudflareOptions> = {}): FakeCloudflare {
  const fake = createFakeCloudflare({ ...FAKE_OPTIONS, ...options });
  fakesInThisTest.push(fake);
  return fake;
}

afterEach(() => {
  const violations = fakesInThisTest.splice(0).flatMap((fake) => fake.violations);
  expect(violations, "the broker kept the ingress invariant").toEqual([]);
});

export function createHarness(
  options: {
    backend?: Backend;
    fake?: Partial<FakeCloudflareOptions>;
    env?: Partial<BrokerEnv>;
  } = {}
): Harness {
  const backend = options.backend ?? "workers";
  const fake = trackedFake(options.fake);
  const sleeps: number[] = [];
  const app = createBrokerApp({
    guard: TEST_GUARD,
    fetch: (request) => fake.fetch(request),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    apiBaseUrl: FAKE_CLOUDFLARE_API_BASE_URL,
  });
  const env = brokerEnv(backend, options.env);
  const call = async (request: Request) => app.fetch(request, env);
  return {
    fake,
    env,
    backend,
    sleeps,
    call,
    deploy: async (input) => call(await signedRequest("/deploy", { form: deployForm(input) })),
    takedown: async (name) => call(await signedRequest("/takedown", { json: { name } })),
    data: async (op) => call(await signedRequest("/data", { json: op })),
  };
}

export const hostnameOf = (name: string) => `${name}.${FAKE_OPTIONS.appsDomain}`;
export const scriptOf = (name: string) => `${FAKE_OPTIONS.scriptPrefix}${name}`;

/** The deployed version behind an app, on either backend. */
export function activeVersion(harness: Harness, name: string) {
  return harness.backend === "workers"
    ? (harness.fake.script(scriptOf(name))?.activeVersion ?? null)
    : harness.fake.dispatchScript(scriptOf(name));
}

/** The app resolves only behind its own Access app, its script carries that AUD, and nothing else is public. */
export function expectServing(harness: Harness, name: string): void {
  const { fake } = harness;
  const access = fake.accessAppsFor(hostnameOf(name));
  expect(access).toHaveLength(1);
  expect(access[0].policyIds).toEqual([FAKE_OPTIONS.policyId]);
  expect(fake.domainFor(hostnameOf(name))?.service).toBe(
    harness.backend === "workers" ? scriptOf(name) : FAKE_OPTIONS.dispatcherService
  );
  const version = activeVersion(harness, name);
  expect(version?.vars.CF_ACCESS_AUD).toBe(access[0].aud);
  expect(version?.mainModule).toBe("guard.mjs");
  if (harness.backend === "workers") {
    expect(fake.script(scriptOf(name))?.subdomain).toEqual({
      enabled: false,
      previews_enabled: false,
    });
  }
  expect(fake.violations).toEqual([]);
}

/** Nothing about the app is reachable or left behind, and the floor is untouched. */
export function expectGone(harness: Harness, name: string): void {
  const { fake } = harness;
  expect(fake.domainFor(hostnameOf(name))).toBeNull();
  expect(fake.script(scriptOf(name))).toBeNull();
  expect(fake.dispatchScript(scriptOf(name))).toBeNull();
  expect(fake.accessAppsFor(hostnameOf(name))).toEqual([]);
  expect(fake.violations).toEqual([]);
}
