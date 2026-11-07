import { describe, expect, it } from "vitest";
import {
  APP_BROKER_HOST_LABEL,
  APP_BROKER_SERVICE,
  brokerDataRequestSchema,
  brokerDataResponseSchema,
  brokerDeployRequestSchema,
  brokerDeployResponseSchema,
  brokerErrorSchema,
  brokerTakedownRequestSchema,
  brokerTakedownResponseSchema,
  type BrokerDataOp,
} from "./app-broker";
import { parseAppName } from "./apps";
import {
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  buildServiceAuthHeaders,
  isServiceName,
  sha256Hex,
  verifyServiceSignature,
} from "./service-auth";
import { APP_PLATFORM_BINDINGS } from "./types/app-data";

const deployRequest = {
  name: "notes",
  deploymentId: "deployment-1",
  assets: [{ path: "/index.html", part: "a0" }],
  worker: { part: "worker" },
  notFoundHandling: "single-page-application",
  bindings: [
    { type: "d1", name: "DB", databaseId: "00000000-0000-0000-0000-000000000000" },
    { type: "kv_namespace", name: "CACHE", namespaceId: "namespace-1" },
    { type: "r2_bucket", name: "FILES", bucketName: "app-notes-files" },
    { type: "secret_text", name: "STRIPE_KEY", value: "placeholder-value" },
  ],
};

function roundTrips(schema: { parse(input: unknown): unknown }, input: unknown): void {
  const parsed = schema.parse(input);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  expect(parsed).toEqual(input);
}

describe("broker protocol", () => {
  it("round-trips deploy and takedown messages", () => {
    roundTrips(brokerDeployRequestSchema, deployRequest);
    roundTrips(brokerDeployResponseSchema, {
      url: "https://notes.apps.example.com",
      backend: "workers",
      cfVersionId: "version-1",
      accessAud: "aud-1",
      firstDeploy: true,
    });
    roundTrips(brokerTakedownRequestSchema, { name: "notes" });
    roundTrips(brokerTakedownResponseSchema, {
      cleanupComplete: false,
      failedStep: "revoke_access",
    });
    roundTrips(brokerErrorSchema, {
      error: "rate_limited",
      message: "slow down",
      retryAfterSeconds: 3,
    });
  });

  it("round-trips every data op and its response", () => {
    const exchanges: { [Op in BrokerDataOp]: [Record<string, unknown>, Record<string, unknown>] } =
      {
        "d1.ensure": [{ name: "app-notes-db" }, { databaseId: "db-1", created: true }],
        "d1.execute": [{ databaseId: "db-1", sql: "CREATE TABLE notes (id TEXT);" }, { ok: true }],
        "d1.bookmark": [{ databaseId: "db-1" }, { bookmark: "bookmark-1" }],
        "d1.restore": [
          { databaseId: "db-1", target: { timestamp: 1_700_000_000_000 } },
          { bookmark: "bookmark-2", previousBookmark: "bookmark-1" },
        ],
        "d1.describe": [
          { databaseId: "db-1" },
          { name: "app-notes-db", fileSize: 4096, numTables: 2 },
        ],
        "d1.delete": [{ databaseId: "db-1" }, { ok: true }],
        "kv.ensure": [{ name: "app-notes-cache" }, { namespaceId: "ns-1", created: false }],
        "kv.delete": [{ namespaceId: "ns-1" }, { ok: true }],
        "r2.ensure": [
          { name: "app-notes-files" },
          { bucketName: "app-notes-files", created: true },
        ],
        "r2.purge": [{ bucketName: "app-notes-files" }, { status: "emptying" }],
      };
    for (const [op, [request, response]] of Object.entries(exchanges) as [
      BrokerDataOp,
      [Record<string, unknown>, Record<string, unknown>],
    ][]) {
      roundTrips(brokerDataRequestSchema, { op, ...request });
      roundTrips(brokerDataResponseSchema[op], response);
    }
  });

  it.each(Object.values(APP_PLATFORM_BINDINGS))(
    "rejects a binding named like platform var %s",
    (name) => {
      const bindings = [{ type: "kv_namespace", name, namespaceId: "namespace-1" }];
      expect(brokerDeployRequestSchema.safeParse({ ...deployRequest, bindings }).success).toBe(
        false
      );
    }
  );

  it("rejects duplicate binding names", () => {
    const bindings = [deployRequest.bindings[0], { ...deployRequest.bindings[1], name: "DB" }];
    expect(brokerDeployRequestSchema.safeParse({ ...deployRequest, bindings }).success).toBe(false);
  });

  it.each(["Notes", "deployer", "xn--abc", "a/b"])("never carries app name %s", (name) => {
    expect(brokerDeployRequestSchema.safeParse({ ...deployRequest, name }).success).toBe(false);
    expect(brokerTakedownRequestSchema.safeParse({ name }).success).toBe(false);
  });

  it.each(["notes-files", "app-", "APP-notes", "app-notes-"])(
    "refuses data resource names without the app- grammar: %s",
    (name) => {
      expect(brokerDataRequestSchema.safeParse({ op: "r2.ensure", name }).success).toBe(false);
      expect(brokerDataRequestSchema.safeParse({ op: "r2.purge", bucketName: name }).success).toBe(
        false
      );
    }
  );

  it("reserves the broker's own hostname label", () => {
    expect(parseAppName(APP_BROKER_HOST_LABEL)).toMatchObject({
      ok: false,
      reason: "reserved_name",
    });
  });
});

describe("broker authentication", () => {
  it("signs as a service the control plane itself never admits", async () => {
    expect(isServiceName(APP_BROKER_SERVICE)).toBe(false);
    const url = "https://deployer.apps.example.com/data";
    const body = JSON.stringify({ op: "d1.bookmark", databaseId: "db-1" });
    const secret = "test-broker-secret";
    const headers = await buildServiceAuthHeaders({
      service: APP_BROKER_SERVICE,
      secret,
      method: "POST",
      url,
      body,
    });
    expect(headers[SERVICE_HEADER]).toBe("control-plane");
    const verify = (verifySecret: string) =>
      sha256Hex(body).then((bodySha256Hex) =>
        verifyServiceSignature({
          signatureHeader: headers[SERVICE_SIGNATURE_HEADER],
          service: APP_BROKER_SERVICE,
          secret: verifySecret,
          method: "POST",
          url,
          bodySha256Hex,
          actor: "",
        })
      );
    await expect(verify(secret)).resolves.toMatchObject({ ok: true });
    await expect(verify("another-secret")).resolves.toEqual({ ok: false, reason: "mismatch" });
  });
});
