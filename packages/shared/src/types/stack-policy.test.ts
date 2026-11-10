import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DERIVED_FILE_RULES,
  STACK_CONTRACT_GOLDEN,
  STACK_POLICY_CONTRACT_FILE,
  fileGlobMatches,
  formatStackPolicyContractFile,
  normalizePackageName,
  packageSignalMatches,
  stackObservationInputSchema,
  stackSignalKey,
  stackSignalSchema,
} from "./stack-policy";

const root = new URL("../../../../", import.meta.url);

function signal(input: unknown) {
  return stackSignalSchema.safeParse(input);
}

describe("stack signal grammar", () => {
  it.each([
    { kind: "package", ecosystem: "npm", name: "react" },
    { kind: "package", ecosystem: "npm", name: "@sveltejs/kit" },
    { kind: "package", ecosystem: "npm", name: "@acme/*" },
    { kind: "package", ecosystem: "pypi", name: "typing_extensions" },
    { kind: "file", pattern: "requirements*.txt" },
    { kind: "file", pattern: "bun.lock?" },
    { kind: "source", extension: ".svelte" },
    { kind: "manifest", value: "d1" },
    { kind: "manifest", value: "kv" },
    { kind: "manifest", value: "r2" },
  ])("accepts $kind $name$pattern$extension$value", (input) => {
    expect(signal(input).success).toBe(true);
  });

  it.each([
    { kind: "package", ecosystem: "npm", name: "react*" },
    { kind: "package", ecosystem: "npm", name: "*" },
    { kind: "package", ecosystem: "npm", name: "@acme/ui*" },
    { kind: "package", ecosystem: "npm", name: "_private" },
    { kind: "package", ecosystem: "pypi", name: "django*" },
    { kind: "package", ecosystem: "pypi", name: "a b" },
    { kind: "package", ecosystem: "cargo", name: "serde" },
    { kind: "file", pattern: "[ab].lock" },
    { kind: "file", pattern: "web/package.json" },
    { kind: "file", pattern: "**.lock" },
    { kind: "file", pattern: "*" },
    { kind: "source", extension: "ts" },
    { kind: "manifest", value: "postgres" },
    { kind: "manifest", value: "hyperdrive:billing" },
  ])("rejects $kind $name$pattern$extension$value", (input) => {
    expect(signal(input).success).toBe(false);
  });

  it("normalizes package names at the boundary", () => {
    expect(signal({ kind: "package", ecosystem: "npm", name: " React " }).data).toEqual({
      kind: "package",
      ecosystem: "npm",
      name: "react",
    });
    expect(signal({ kind: "package", ecosystem: "pypi", name: "Typing_Extensions" }).data).toEqual({
      kind: "package",
      ecosystem: "pypi",
      name: "typing-extensions",
    });
  });

  it("keys each signal canonically, whatever the input spelling", () => {
    const key = (input: unknown) => stackSignalKey(stackSignalSchema.parse(input));
    expect(key({ kind: "package", ecosystem: "npm", name: "React" })).toBe("package:npm:react");
    expect(key({ kind: "package", ecosystem: "npm", name: "react" })).toBe("package:npm:react");
    expect(key({ kind: "package", ecosystem: "pypi", name: "Zope.Interface" })).toBe(
      "package:pypi:zope-interface"
    );
    expect(key({ kind: "file", pattern: "bun.lock" })).toBe("file:bun.lock");
    expect(key({ kind: "source", extension: ".ts" })).toBe("source:.ts");
    expect(key({ kind: "manifest", value: "d1" })).toBe("manifest:d1");
  });
});

describe("golden cases shared with the sandbox scanner", () => {
  it.each(STACK_CONTRACT_GOLDEN.normalization)(
    "normalizes $ecosystem $input",
    ({ ecosystem, input, expected }) => {
      expect(normalizePackageName(ecosystem, input)).toBe(expected);
    }
  );

  it.each(STACK_CONTRACT_GOLDEN.fileGlob)(
    "matches $pattern against $basename",
    ({ pattern, basename, matches }) => {
      expect(fileGlobMatches(pattern, basename)).toBe(matches);
    }
  );

  it.each(STACK_CONTRACT_GOLDEN.packageSignal)(
    "matches package signal $signal against $name",
    ({ signal: signalName, name, matches }) => {
      expect(packageSignalMatches(signalName, name)).toBe(matches);
    }
  );
});

describe("stack observations", () => {
  it("accepts every fact kind, defaulting file facts to not derived", () => {
    const parsed = stackObservationInputSchema.parse({
      repository: { repoOwner: "Acme/Platform", repoName: "Portal" },
      refName: "main",
      commitSha: "a".repeat(40),
      kind: "baseline",
      complete: true,
      policyDigest: null,
      facts: [
        {
          kind: "package",
          ecosystem: "npm",
          name: "svelte",
          manifestPath: "package.json",
          scope: "runtime",
          declaredRange: "^5.0.0",
          resolvedVersion: null,
        },
        { kind: "file", path: "bun.lock" },
        { kind: "file", path: "svc/requirements.txt", derived: true },
        { kind: "source", extension: ".ts", fileCount: 12 },
        { kind: "manifest", value: "d1", path: "openinspect.app.json" },
      ],
    });
    expect(parsed.repository).toEqual({ repoOwner: "acme/platform", repoName: "portal" });
    expect(parsed.facts[1]).toEqual({ kind: "file", path: "bun.lock", derived: false });
    expect(parsed.facts[2]).toEqual({ kind: "file", path: "svc/requirements.txt", derived: true });
  });

  it("rejects a manifest fact for an unadmitted store", () => {
    expect(
      stackObservationInputSchema.safeParse({
        repository: { repoOwner: "acme", repoName: "portal" },
        refName: "main",
        commitSha: "b".repeat(40),
        kind: "push",
        complete: true,
        policyDigest: "digest",
        facts: [{ kind: "manifest", value: "postgres", path: "openinspect.app.json" }],
      }).success
    ).toBe(false);
  });
});

describe("generated stack policy contract", () => {
  it("keeps the sandbox contract in sync (run `npm run generate:stack-contract -w @open-inspect/shared`)", () => {
    const expected = formatStackPolicyContractFile();
    const file = new URL(STACK_POLICY_CONTRACT_FILE, root);
    if (process.env.UPDATE_STACK_CONTRACT === "1") writeFileSync(file, expected);
    expect(readFileSync(file, "utf8")).toBe(expected);
  });

  it("carries the platform rules the scanner applies", () => {
    const contract = JSON.parse(
      readFileSync(new URL(STACK_POLICY_CONTRACT_FILE, root), "utf8")
    ) as Record<string, unknown>;
    expect(contract.derivedFileRules).toEqual(DERIVED_FILE_RULES);
    expect(contract.signalKinds).toEqual(["package", "file", "source", "manifest"]);
    expect(contract.dataStoreKinds).toEqual(["d1", "kv", "r2"]);
    expect(contract.appManifestFile).toBe("openinspect.app.json");
    expect(contract.golden).toEqual(STACK_CONTRACT_GOLDEN);
  });
});
