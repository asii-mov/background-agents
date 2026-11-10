import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_DEPLOY_CONTRACT,
  APP_DEPLOY_CONTRACT_FILES,
  APP_DEPLOY_DEADLINE_MS,
  APP_DEPLOY_FAILURE_REASONS,
  APP_DEPLOY_FAILURE_STATUS,
  APP_DEPLOY_REASON_GUIDANCE,
  appDeployManifestSchema,
  formatAppDeployContractFiles,
  parseAppName,
} from "./apps";

const root = new URL("../../../", import.meta.url);

describe("parseAppName", () => {
  it.each(["notes", "a", "7", "team-tracker", "q3-okrs", "a".repeat(40)])("accepts %s", (raw) => {
    expect(parseAppName(raw)).toEqual({ ok: true, name: raw });
  });

  it.each([
    "",
    "Notes",
    "NOTES",
    " notes",
    "notes.",
    "a_b",
    "a.b",
    "-notes",
    "notes-",
    "ab--cd",
    "xn--nxasmq6b",
    "a".repeat(41),
    "café",
  ])("rejects %j without repairing it", (raw) => {
    expect(parseAppName(raw)).toMatchObject({ ok: false, reason: "invalid_name" });
  });

  it.each(["deployer", "dispatcher", "admin", "www", "sso", "api"])("reserves %s", (raw) => {
    expect(parseAppName(raw)).toMatchObject({ ok: false, reason: "reserved_name" });
  });
});

describe("deploy outcomes", () => {
  it("gives every failure reason a status and agent guidance", () => {
    expect(Object.keys(APP_DEPLOY_FAILURE_STATUS).sort()).toEqual(
      [...APP_DEPLOY_FAILURE_REASONS].sort()
    );
    expect(Object.keys(APP_DEPLOY_REASON_GUIDANCE).sort()).toEqual(
      [...APP_DEPLOY_FAILURE_REASONS].sort()
    );
    for (const reason of APP_DEPLOY_FAILURE_REASONS) {
      expect(APP_DEPLOY_REASON_GUIDANCE[reason].length).toBeGreaterThan(0);
    }
  });

  it("falls back, per status, to a reason the control plane answers with that status", () => {
    for (const [status, reason] of Object.entries(APP_DEPLOY_CONTRACT.statusFallback)) {
      expect(APP_DEPLOY_FAILURE_STATUS[reason]).toBe(Number(status));
    }
  });

  it("lets the control plane's deadline answer before the tool gives up", () => {
    expect(APP_DEPLOY_CONTRACT.tool.timeoutSeconds * 1000).toBeGreaterThan(APP_DEPLOY_DEADLINE_MS);
  });
});

describe("appDeployManifestSchema", () => {
  const manifest = {
    name: "notes",
    assets: [{ path: "/index.html", part: "a0" }],
    worker: null,
    app: { part: "app" },
    migrations: [{ binding: "DB", name: "0001_create-notes.sql", part: "m0" }],
  };

  it("accepts assets, the app manifest and migrations", () => {
    expect(appDeployManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("names migrations by the migration file pattern and bindings by the binding grammar", () => {
    const migration = manifest.migrations[0];
    for (const migrations of [
      [{ ...migration, name: "create-notes.sql" }],
      [{ ...migration, name: "0001_Create.sql" }],
      [{ ...migration, binding: "ASSETS" }],
      [{ ...migration, part: "a0" }],
    ]) {
      expect(appDeployManifestSchema.safeParse({ ...manifest, migrations }).success).toBe(false);
    }
  });
});

describe("generated deploy-app contract", () => {
  it.each(Object.entries(APP_DEPLOY_CONTRACT_FILES))(
    "keeps the generated %s artifact in sync (run `npm run generate:app-deploy-contract -w @open-inspect/shared`)",
    (kind, path) => {
      const expected =
        formatAppDeployContractFiles()[kind as keyof typeof APP_DEPLOY_CONTRACT_FILES];
      const file = new URL(path, root);
      if (process.env.UPDATE_APP_DEPLOY_CONTRACT === "1") writeFileSync(file, expected);
      expect(readFileSync(file, "utf8")).toBe(expected);
    }
  );
});
