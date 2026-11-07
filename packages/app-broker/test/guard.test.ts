import {
  ACCESS_IDENTITY_HEADERS,
  FORBIDDEN_IDENTITY_HEADERS,
} from "@open-inspect/shared/types/app-data";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleGuard } from "../build.mjs";
import { APP_SCRIPT_COMPATIBILITY_DATE } from "../src/backends";

const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "aud-inventory";
const HOST = "inventory.apps.example.test";
const KID = "key-1";
const STATIC_BODY = "static asset body";

const STATIC_APP = "export default null;\n";
const ECHO_APP = `export default {
  async fetch(request) {
    return Response.json({ headers: Object.fromEntries(request.headers) });
  },
};
`;
/** An app that tries to switch off signature checks before the guard runs. */
const PATCHING_APP = `
const accept = async () => true;
crypto.subtle.verify = accept;
SubtleCrypto.prototype.verify = accept;
const realImport = SubtleCrypto.prototype.importKey;
SubtleCrypto.prototype.importKey = function (...args) { return realImport.apply(this, args); };
JSON.parse = ((parse) => (text, ...rest) => {
  const value = parse(text, ...rest);
  if (value && typeof value === "object" && "aud" in value) value.aud = ${JSON.stringify(AUD)};
  return value;
})(JSON.parse);
export default {
  async fetch() {
    return new Response(String(await crypto.subtle.verify("x", null, null, null)));
  },
};
`;

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;
let otherKeys: KeyPair;
let jwks: unknown;

async function token(
  claims: Record<string, unknown> = {},
  keyPair: KeyPair = keys
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: TEAM,
    aud: [AUD],
    sub: "user-1234",
    email: "visitor@example.test",
    type: "app",
    iat: now,
    exp: now + 600,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .sign(keyPair.privateKey);
}

function unsignedToken(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: "none", kid: KID })}.${encode({
    iss: TEAM,
    aud: AUD,
    sub: "user-1234",
    email: "visitor@example.test",
    type: "app",
    exp: now + 600,
  })}.`;
}

interface GuardWorker {
  fetch(path: string, init?: RequestInit & { host?: string }): Promise<Response>;
  assetCalls(): number;
  dispose(): Promise<void>;
}

async function startGuard(
  userModule: string,
  bindings: Record<string, string> = {
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    APP_HOSTNAME: HOST,
    OI_APP_NAME: "inventory",
  }
): Promise<GuardWorker> {
  const guard = await bundleGuard();
  let assetCalls = 0;
  const miniflare = new Miniflare({
    modules: [
      ...guard.modules.map((module) => ({
        type: "ESModule" as const,
        path: module.name,
        contents: module.source,
      })),
      { type: "ESModule" as const, path: guard.userModuleName, contents: userModule },
    ],
    compatibilityDate: APP_SCRIPT_COMPATIBILITY_DATE,
    bindings,
    serviceBindings: {
      ASSETS: async () => {
        assetCalls += 1;
        return new Response(STATIC_BODY);
      },
    },
    outboundService: async (request: { url: string }) => {
      if (request.url === `${TEAM}/cdn-cgi/access/certs`) return Response.json(jwks);
      return new Response("unexpected outbound request", { status: 599 });
    },
  });
  await miniflare.ready;
  return {
    fetch: async (path, init = {}) => {
      const response = await miniflare.dispatchFetch(`https://${init.host ?? HOST}${path}`, {
        method: init.method,
        headers: init.headers as Record<string, string>,
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    },
    assetCalls: () => assetCalls,
    dispose: () => miniflare.dispose(),
  };
}

const withToken = (value: string) => ({ headers: { "cf-access-jwt-assertion": value } });

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  otherKeys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256" }] };
});

describe("the platform guard in front of a static app", () => {
  let guard: GuardWorker;
  beforeAll(async () => {
    guard = await startGuard(STATIC_APP);
  });
  afterAll(() => guard.dispose());

  it.each([
    ["no token", async () => ({})],
    [
      "an expired token",
      async () => withToken(await token({ exp: Math.floor(Date.now() / 1000) - 60 })),
    ],
    ["another app's AUD", async () => withToken(await token({ aud: "aud-payroll" }))],
    [
      "another team's issuer",
      async () => withToken(await token({ iss: "https://other.cloudflareaccess.com" })),
    ],
    ["an unsigned alg:none token", async () => withToken(unsignedToken())],
    ["a token signed by another key", async () => withToken(await token({}, otherKeys))],
    ["a service token without a user", async () => withToken(await token({ email: "" }))],
  ])("refuses %s and serves no asset", async (_case, init) => {
    const before = guard.assetCalls();

    const response = await guard.fetch("/", await init());

    expect(response.status).toBe(403);
    expect(guard.assetCalls()).toBe(before);
  });

  it("serves assets only after verifying the visitor's token", async () => {
    const before = guard.assetCalls();

    const response = await guard.fetch("/", withToken(await token()));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(STATIC_BODY);
    expect(guard.assetCalls()).toBe(before + 1);
  });

  it("accepts the token from the CF_Authorization cookie", async () => {
    const response = await guard.fetch("/", {
      headers: { cookie: `theme=dark; CF_Authorization=${await token()}` },
    });

    expect(response.status).toBe(200);
  });

  it("answers 404 on any hostname but the app's own, even with a valid token", async () => {
    const before = guard.assetCalls();

    const response = await guard.fetch("/", {
      ...withToken(await token()),
      host: "app-inventory.example-account.workers.dev",
    });

    expect(response.status).toBe(404);
    expect(guard.assetCalls()).toBe(before);
  });
});

describe("the platform guard in front of a Worker app", () => {
  let guard: GuardWorker;
  beforeAll(async () => {
    guard = await startGuard(ECHO_APP);
  });
  afterAll(() => guard.dispose());

  it("passes the verified identity and strips identity headers the visitor sent", async () => {
    const forged = Object.fromEntries([
      ...FORBIDDEN_IDENTITY_HEADERS.map((name) => [name, "attacker@example.test"]),
      [ACCESS_IDENTITY_HEADERS.sub, "attacker"],
      [ACCESS_IDENTITY_HEADERS.email, "attacker@example.test"],
    ]);

    const response = await guard.fetch("/api/notes", {
      headers: { ...forged, "cf-access-jwt-assertion": await token() },
    });

    expect(response.status).toBe(200);
    const { headers } = (await response.json()) as { headers: Record<string, string> };
    expect(headers[ACCESS_IDENTITY_HEADERS.sub]).toBe("user-1234");
    expect(headers[ACCESS_IDENTITY_HEADERS.email]).toBe("visitor@example.test");
    for (const name of FORBIDDEN_IDENTITY_HEADERS) expect(headers).not.toHaveProperty(name);
  });
});

describe("the platform guard in front of an app that patches crypto.subtle", () => {
  let guard: GuardWorker;
  beforeAll(async () => {
    guard = await startGuard(PATCHING_APP);
  });
  afterAll(() => guard.dispose());

  it("still refuses forged and foreign tokens", async () => {
    for (const forged of [
      await token({}, otherKeys),
      await token({ aud: "aud-payroll" }),
      unsignedToken(),
    ]) {
      expect((await guard.fetch("/", withToken(forged))).status).toBe(403);
    }
  });

  it("lets a valid visitor through to the app, whose patch is in effect", async () => {
    const response = await guard.fetch("/", withToken(await token()));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("true");
  });
});

describe("the platform guard without its bindings", () => {
  it("fails closed", async () => {
    const guard = await startGuard(STATIC_APP, { APP_HOSTNAME: HOST });
    try {
      const response = await guard.fetch("/", withToken(await token()));

      expect(response.status).toBe(503);
      expect(guard.assetCalls()).toBe(0);
    } finally {
      await guard.dispose();
    }
  });
});
