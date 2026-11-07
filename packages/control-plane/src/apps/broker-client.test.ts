import { brokerDeployRequestSchema } from "@open-inspect/shared/app-broker";
import type { AppName } from "@open-inspect/shared/apps";
import {
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  sha256Hex,
  verifyServiceSignature,
} from "@open-inspect/shared/service-auth";
import {
  SecretText,
  type AppDataBinding,
  type BindingName,
} from "@open-inspect/shared/types/app-data";
import { describe, expect, it } from "vitest";
import { createBrokerClient } from "./broker-client";
import type { AppBundle, AssetPath } from "./bundle";
import { AppHostError } from "./host";

const CONFIG = {
  brokerOrigin: "https://deployer.apps.example.test",
  brokerSecret: "placeholder-broker-secret",
  accessClientId: "placeholder-client-id",
  accessClientSecret: "placeholder-client-secret",
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

type Reply = Response | Error;

function broker(replies: Reply[]) {
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const client = createBrokerClient({
    config: CONFIG,
    fetch: {
      async fetch(input, init) {
        const body = init?.body;
        sent.push({
          url: String(input),
          headers: init?.headers as Record<string, string>,
          body: typeof body === "string" ? new TextEncoder().encode(body) : (body as Uint8Array),
        });
        const reply = replies.shift();
        if (!reply) throw new Error("no reply scripted");
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, sent, sleeps };
}

const ok = (body: unknown) => Response.json(body);
const brokerError = (status: number, error: string, message = "x", retryAfterSeconds?: number) =>
  Response.json(
    { error, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
    { status }
  );

const RECEIPT = {
  url: "https://notes.apps.example.test",
  backend: "workers",
  cfVersionId: "cf-version-1",
  accessAud: "aud-notes",
  firstDeploy: true,
};

const bundle: AppBundle = {
  assets: [
    { path: "/app.js" as AssetPath, bytes: new TextEncoder().encode("go()") },
    { path: "/index.html" as AssetPath, bytes: new TextEncoder().encode("<h1>notes</h1>") },
  ],
  worker: new TextEncoder().encode("export default {}"),
  notFoundHandling: "single-page-application",
  bytes: 35,
  sha256: "a".repeat(64),
};

const bindings: AppDataBinding[] = [
  { kind: "d1", name: "DB" as BindingName, databaseId: "db-1" },
  { kind: "secret", name: "STRIPE_KEY" as BindingName, value: new SecretText("placeholder-value") },
];

async function verifies(request: Sent): Promise<boolean> {
  const result = await verifyServiceSignature({
    signatureHeader: request.headers[SERVICE_SIGNATURE_HEADER],
    service: "control-plane",
    secret: CONFIG.brokerSecret,
    method: "POST",
    url: request.url,
    bodySha256Hex: await sha256Hex(request.body),
    actor: "",
  });
  return result.ok;
}

const deploy = (
  client: ReturnType<typeof broker>["client"],
  signal = new AbortController().signal
) =>
  client.deploy(
    { name: "notes" as AppName, deploymentId: "deployment-1", bundle, bindings },
    signal
  );

describe("broker client", () => {
  it("sends a signed multipart deploy the broker's schema accepts, behind the Access token", async () => {
    const { client, sent } = broker([ok(RECEIPT)]);

    expect(await deploy(client)).toEqual(RECEIPT);

    const [request] = sent;
    expect(request.url).toBe("https://deployer.apps.example.test/deploy");
    expect(request.headers).toMatchObject({
      [SERVICE_HEADER]: "control-plane",
      "CF-Access-Client-Id": "placeholder-client-id",
      "CF-Access-Client-Secret": "placeholder-client-secret",
    });
    expect(await verifies(request)).toBe(true);
    const form = await new Response(request.body, {
      headers: { "content-type": request.headers["Content-Type"] },
    }).formData();
    const parsed = brokerDeployRequestSchema.parse(JSON.parse(form.get("request") as string));
    expect(parsed).toEqual({
      name: "notes",
      deploymentId: "deployment-1",
      assets: [
        { path: "/app.js", part: "a0" },
        { path: "/index.html", part: "a1" },
      ],
      worker: { part: "worker" },
      notFoundHandling: "single-page-application",
      bindings: [
        { type: "d1", name: "DB", databaseId: "db-1" },
        { type: "secret_text", name: "STRIPE_KEY", value: "placeholder-value" },
      ],
    });
    expect(await (form.get("a1") as unknown as Blob).text()).toBe("<h1>notes</h1>");
    expect(await (form.get("worker") as unknown as Blob).text()).toBe("export default {}");
  });

  it("signs every attempt afresh when it retries a transient failure", async () => {
    const { client, sent, sleeps } = broker([
      brokerError(502, "upstream_unavailable"),
      ok(RECEIPT),
    ]);

    await deploy(client);

    expect(sent).toHaveLength(2);
    expect(sent[0].headers[SERVICE_SIGNATURE_HEADER]).not.toBe(
      sent[1].headers[SERVICE_SIGNATURE_HEADER]
    );
    expect(await verifies(sent[1])).toBe(true);
    expect(sleeps).toEqual([1_000]);
  });

  it("gives up after the attempt budget", async () => {
    const { client, sent } = broker([
      brokerError(502, "upstream_unavailable"),
      new TypeError("fetch failed"),
      brokerError(502, "upstream_unavailable"),
    ]);

    await expect(deploy(client)).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(sent).toHaveLength(3);
  });

  it.each([
    [
      "the broker refuses the signature",
      () => brokerError(401, "invalid_request", "Unauthorized"),
      "unauthorized",
    ],
    [
      "Access redirects to sign-in",
      () => new Response(null, { status: 302, headers: { location: "https://sso.example.test" } }),
      "unauthorized",
    ],
    [
      "Access forbids the token",
      () => new Response("<html>denied</html>", { status: 403 }),
      "unauthorized",
    ],
    [
      "the body is over the cap",
      () => brokerError(413, "invalid_request", "Request body too large"),
      "too_large",
    ],
    ["the broker refuses a resource", () => brokerError(403, "refused"), "refused"],
    [
      "the hostname belongs to something else",
      () => brokerError(409, "hostname_conflict"),
      "hostname_conflict",
    ],
  ])("does not retry when %s", async (_case, reply, code) => {
    const { client, sent } = broker([reply(), ok(RECEIPT)]);

    await expect(deploy(client)).rejects.toMatchObject({ code });
    expect(sent).toHaveLength(1);
  });

  it("relays the broker's message for a rejected script", async () => {
    const { client } = broker([brokerError(422, "script_rejected", "Uncaught SyntaxError")]);

    await expect(deploy(client)).rejects.toMatchObject({
      code: "script_rejected",
      message: "Uncaught SyntaxError",
    });
  });

  it("hands back a long rate limit instead of waiting it out", async () => {
    const { client, sent, sleeps } = broker([brokerError(429, "rate_limited", "slow down", 60)]);

    await expect(deploy(client)).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 60,
    });
    expect(sent).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("waits out a short rate limit and tries again", async () => {
    const { client, sleeps } = broker([
      brokerError(429, "rate_limited", "slow down", 2),
      ok(RECEIPT),
    ]);

    await deploy(client);

    expect(sleeps).toEqual([2_000]);
  });

  it("reports the caller's deadline instead of a network failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = broker([new DOMException("aborted", "AbortError")]);

    await expect(deploy(client, controller.signal)).rejects.toMatchObject({ code: "deadline" });
  });

  it("parses a takedown answer", async () => {
    const { client, sent } = broker([ok({ cleanupComplete: false, failedStep: "detach" })]);

    expect(await client.takedown("notes" as AppName, new AbortController().signal)).toEqual({
      cleanupComplete: false,
      failedStep: "detach",
    });
    expect(JSON.parse(new TextDecoder().decode(sent[0].body))).toEqual({ name: "notes" });
    expect(await verifies(sent[0])).toBe(true);
  });

  describe("data ops", () => {
    it("sends one op per request and parses its answer", async () => {
      const { client, sent } = broker([ok({ databaseId: "db-1", created: true })]);

      expect(await client.ensureD1("app-notes-db" as never)).toEqual({
        databaseId: "db-1",
        created: true,
      });
      expect(sent[0].url).toBe("https://deployer.apps.example.test/data");
      expect(JSON.parse(new TextDecoder().decode(sent[0].body))).toEqual({
        op: "d1.ensure",
        name: "app-notes-db",
      });
    });

    it("retries an ensure whose answer was lost", async () => {
      const { client, sent } = broker([
        new TypeError("fetch failed"),
        ok({ namespaceId: "kv-1", created: false }),
      ]);

      expect(await client.ensureKv("app-notes-cache" as never)).toEqual({
        namespaceId: "kv-1",
        created: false,
      });
      expect(sent).toHaveLength(2);
    });

    it("never sends a migration twice when its answer was lost", async () => {
      const { client, sent } = broker([new TypeError("fetch failed"), ok({ ok: true })]);

      await expect(client.executeD1("db-1", "CREATE TABLE t (id TEXT);")).rejects.toBeInstanceOf(
        AppHostError
      );
      expect(sent).toHaveLength(1);
    });

    it("relays D1's error for a failed statement", async () => {
      const { client } = broker([brokerError(422, "sql_error", "no such table: notes")]);

      await expect(client.executeD1("db-1", "DROP TABLE notes;")).rejects.toMatchObject({
        code: "sql_error",
        message: "no such table: notes",
      });
    });
  });
});
