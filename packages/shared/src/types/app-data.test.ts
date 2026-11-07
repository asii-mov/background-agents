import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  APP_DATA_CONTRACT_FILE,
  APP_DATA_LIMITS,
  EXTERNAL_DATA_STORE_REJECTION,
  SecretText,
  appDataManifestSchema,
  formatAppDataContractFile,
  parseBindingName,
  setAppSecretsRequestSchema,
} from "./app-data";

const root = new URL("../../../../", import.meta.url);

const manifest = {
  schemaVersion: 1,
  name: "notes",
  data: { DB: { kind: "d1" }, CACHE: { kind: "kv" }, FILES: { kind: "r2" } },
  secrets: ["STRIPE_KEY"],
};

function issues(input: unknown): string[] {
  const parsed = appDataManifestSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("openinspect.app.json", () => {
  it("parses a manifest with platform defaults", () => {
    expect(appDataManifestSchema.parse(manifest)).toEqual({
      schemaVersion: 1,
      name: "notes",
      classification: "internal",
      data: {
        DB: { kind: "d1", migrations: "migrations" },
        CACHE: { kind: "kv" },
        FILES: { kind: "r2" },
      },
      secrets: ["STRIPE_KEY"],
    });
  });

  it.each([
    "ASSETS",
    "APP_HOSTNAME",
    "CF_ACCESS_AUD",
    "OI_APP_NAME",
    "CF_ANYTHING",
    "OPENINSPECT_X",
    "CLOUDFLARE_X",
    "db",
    "1DB",
  ])("rejects %s as a data binding or a secret name", (name) => {
    expect(issues({ ...manifest, data: { [name]: { kind: "kv" } } })).not.toEqual([]);
    expect(issues({ ...manifest, secrets: [name] })).not.toEqual([]);
    expect(parseBindingName(name)).toBeNull();
  });

  it("rejects a name that is both a binding and a secret", () => {
    expect(issues({ ...manifest, secrets: ["DB"] })).toEqual([
      "DB is both a data binding and a secret",
    ]);
  });

  it.each([
    "DATABASE_URL",
    "PG_DATABASE_URL",
    "DB_URL",
    "CONNECTION_STRING",
    "CLOUDFLARE_API_TOKEN",
    "API_TOKEN_CLOUDFLARE",
  ])("denies credential-shaped secret %s", (name) => {
    expect(issues({ ...manifest, secrets: [name] })).not.toEqual([]);
  });

  it("rejects duplicate secrets", () => {
    expect(issues({ ...manifest, secrets: ["STRIPE_KEY", "STRIPE_KEY"] })).toEqual([
      "Secret STRIPE_KEY is declared twice",
    ]);
  });

  it("enforces the binding and secret limits", () => {
    const data = Object.fromEntries(
      Array.from({ length: APP_DATA_LIMITS.maxBindings + 1 }, (_, index) => [
        `KV_${index}`,
        { kind: "kv" },
      ])
    );
    expect(issues({ ...manifest, data })).not.toEqual([]);
    const secrets = Array.from(
      { length: APP_DATA_LIMITS.maxSecrets + 1 },
      (_, index) => `KEY_${index}`
    );
    expect(issues({ ...manifest, secrets })).not.toEqual([]);
  });

  it("refuses external databases with the v1 message", () => {
    expect(
      issues({ ...manifest, data: { BILLING: { kind: "external", service: "billing" } } })
    ).toContain(EXTERNAL_DATA_STORE_REJECTION);
  });

  it.each(["/etc", "../shared", "db/../../x", "a//b"])(
    "keeps the migrations directory inside the project: %s",
    (migrations) => {
      expect(issues({ ...manifest, data: { DB: { kind: "d1", migrations } } })).not.toEqual([]);
    }
  );

  it("rejects unknown keys and resource ids", () => {
    expect(issues({ ...manifest, data: { DB: { kind: "d1", databaseId: "uuid" } } })).not.toEqual(
      []
    );
    expect(issues({ ...manifest, token: "x" })).not.toEqual([]);
  });
});

describe("SecretText", () => {
  it("never serializes or prints its value", () => {
    const secret = new SecretText("s3cr3t-placeholder");
    expect(JSON.stringify({ binding: { value: secret } })).toBe(
      '{"binding":{"value":"[redacted]"}}'
    );
    expect(String(secret)).toBe("[redacted]");
    expect(`${secret}`).toBe("[redacted]");
    expect(inspect({ secret })).not.toContain("s3cr3t");
    expect(secret.reveal()).toBe("s3cr3t-placeholder");
  });
});

describe("setAppSecretsRequestSchema", () => {
  it("bounds secret values in bytes and requires at least one", () => {
    const max = APP_DATA_LIMITS.maxSecretValueBytes;
    const parse = (secrets: Record<string, string>) =>
      setAppSecretsRequestSchema.safeParse({ stage: "production", secrets }).success;
    expect(parse({ STRIPE_KEY: "x".repeat(max) })).toBe(true);
    expect(parse({ STRIPE_KEY: "é".repeat(max / 2 + 1) })).toBe(false);
    expect(parse({})).toBe(false);
    expect(parse({ ASSETS: "x" })).toBe(false);
  });
});

describe("generated app data contract", () => {
  it("keeps the conformance contract in sync (run `npm run generate:app-data-contract -w @open-inspect/shared`)", () => {
    const expected = formatAppDataContractFile();
    const file = new URL(APP_DATA_CONTRACT_FILE, root);
    if (process.env.UPDATE_APP_DATA_CONTRACT === "1") {
      mkdirSync(new URL(".", file), { recursive: true });
      writeFileSync(file, expected);
    }
    expect(readFileSync(file, "utf8")).toBe(expected);
  });
});
