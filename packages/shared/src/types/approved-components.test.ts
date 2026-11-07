import { describe, expect, it } from "vitest";
import {
  createApprovedComponentSchema,
  updateApprovedComponentSchema,
} from "./approved-components";

const approvedLibrary = {
  name: "Acme authentication",
  kind: "library",
  description: "Reviewed authentication primitive",
  owner: "Product Security",
  locator: "@acme/auth",
  version: "1.2.3",
  sourceUrl: "https://github.example.com/platform/auth",
  usage: "Install and use createAuthenticatedApp().",
  lifecycle: "approved",
  enabled: true,
} as const;

describe("createApprovedComponentSchema", () => {
  it("accepts a provenance-bearing exact library version", () => {
    expect(createApprovedComponentSchema.parse(approvedLibrary)).toMatchObject({
      version: "1.2.3",
      repoScopes: null,
      environmentScopes: null,
    });
  });

  it("rejects floating library versions and missing provenance", () => {
    expect(
      createApprovedComponentSchema.safeParse({
        ...approvedLibrary,
        version: "^1.2.3",
        sourceUrl: null,
      }).success
    ).toBe(false);
  });

  it("requires immutable integrity for approved templates and snippets", () => {
    for (const kind of ["template", "snippet"] as const) {
      const invalid = createApprovedComponentSchema.safeParse({
        ...approvedLibrary,
        kind,
        locator: "https://templates.example.com/service",
        version: null,
        integrity: null,
      });
      expect(invalid.success).toBe(false);

      expect(
        createApprovedComponentSchema.safeParse({
          ...approvedLibrary,
          kind,
          locator: "https://templates.example.com/service",
          version: null,
          integrity: `sha256:${"a".repeat(64)}`,
        }).success
      ).toBe(true);
    }
  });
});

const svelte = {
  name: "Svelte",
  kind: "library",
  description: "Component framework for browser UI",
  owner: "Platform Engineering",
  locator: "svelte",
  documentationUrl: "https://svelte.dev/docs",
  usage: "Use Svelte for new browser UI.",
  lifecycle: "approved",
  categoryId: "web-frontend",
  stance: "preferred",
  signals: [{ kind: "package", ecosystem: "npm", name: "svelte" }],
} as const;

const d1 = {
  name: "D1 (SQLite)",
  kind: "data_store",
  description: "Relational records for internal apps",
  owner: "Platform Engineering",
  locator: "d1",
  documentationUrl: "https://developers.cloudflare.com/d1",
  usage: "Records. Schema lives in numbered files under migrations/.",
  lifecycle: "approved",
  categoryId: "app-data-store",
  stance: "preferred",
  signals: [{ kind: "manifest", value: "d1" }],
} as const;

function accepts(input: Record<string, unknown>): boolean {
  return createApprovedComponentSchema.safeParse(input).success;
}

describe("graded stances", () => {
  it("leaves plain catalogue entries uncategorised and allowed", () => {
    expect(createApprovedComponentSchema.parse(approvedLibrary)).toMatchObject({
      categoryId: null,
      stance: "allowed",
      signals: [],
    });
  });

  it.each([
    { case: "preferred with category and signal", input: svelte, valid: true },
    {
      case: "denied with category and signal",
      input: { ...svelte, stance: "denied" },
      valid: true,
    },
    { case: "preferred without category", input: { ...svelte, categoryId: null }, valid: false },
    {
      case: "denied without category",
      input: { ...svelte, stance: "denied", categoryId: null },
      valid: false,
    },
    { case: "categorised without signals", input: { ...svelte, signals: [] }, valid: false },
    {
      case: "allowed categorised without signals",
      input: { ...svelte, stance: "allowed", signals: [] },
      valid: false,
    },
    {
      case: "deprecated preferred",
      input: { ...svelte, lifecycle: "deprecated" },
      valid: false,
    },
    {
      case: "deprecated denied",
      input: { ...svelte, stance: "denied", lifecycle: "deprecated" },
      valid: false,
    },
    {
      case: "deprecated allowed",
      input: { ...svelte, stance: "allowed", lifecycle: "deprecated" },
      valid: true,
    },
    {
      case: "a draft preferred",
      input: { ...svelte, lifecycle: "development" },
      valid: true,
    },
    {
      case: "duplicate signals after normalization",
      input: {
        ...svelte,
        signals: [
          { kind: "package", ecosystem: "npm", name: "Svelte" },
          { kind: "package", ecosystem: "npm", name: "svelte" },
        ],
      },
      valid: false,
    },
  ])("$case -> valid=$valid", ({ input, valid }) => {
    expect(accepts(input)).toBe(valid);
  });

  it("requires an exact version only of approved uncategorised libraries", () => {
    expect(accepts({ ...svelte, version: null })).toBe(true);
    expect(accepts({ ...approvedLibrary, version: null })).toBe(false);
  });

  it("holds denied entries to replacement guidance, not artifact provenance", () => {
    const deniedService = {
      ...svelte,
      kind: "service",
      locator: "http://legacy.example.com",
      stance: "denied",
    };
    expect(accepts(deniedService)).toBe(true);
    expect(accepts({ ...deniedService, stance: "allowed" })).toBe(false);
  });

  it("accepts languages and tools with documentation alone", () => {
    for (const kind of ["language", "tool"] as const) {
      expect(
        accepts({
          ...svelte,
          kind,
          name: kind === "tool" ? "Bun" : "TypeScript",
          locator: "https://example.com",
          signals: [{ kind: "file", pattern: kind === "tool" ? "bun.lock" : "tsconfig.json" }],
        })
      ).toBe(true);
    }
  });
});

describe("data store components", () => {
  it("accepts a categorised store detected by its own manifest signal", () => {
    expect(createApprovedComponentSchema.parse(d1)).toMatchObject({
      kind: "data_store",
      locator: "d1",
      version: null,
      integrity: null,
    });
  });

  it.each([
    { case: "no signal", input: { ...d1, signals: [] } },
    {
      case: "a package signal",
      input: { ...d1, signals: [{ kind: "package", ecosystem: "npm", name: "d1" }] },
    },
    {
      case: "another store's signal",
      input: { ...d1, signals: [{ kind: "manifest", value: "kv" }] },
    },
    {
      case: "two signals",
      input: {
        ...d1,
        signals: [
          { kind: "manifest", value: "d1" },
          { kind: "file", pattern: "d1.sql" },
        ],
      },
    },
    { case: "a version", input: { ...d1, version: "1.0.0" } },
    { case: "an integrity digest", input: { ...d1, integrity: `sha256:${"a".repeat(64)}` } },
    { case: "an unknown locator", input: { ...d1, locator: "postgres" } },
    { case: "no category", input: { ...d1, stance: "allowed", categoryId: null } },
  ])("rejects $case", ({ input }) => {
    expect(accepts(input)).toBe(false);
  });

  it("keeps manifest signals for data stores", () => {
    expect(accepts({ ...svelte, signals: [{ kind: "manifest", value: "d1" }] })).toBe(false);
  });
});

describe("updateApprovedComponentSchema", () => {
  it("moves a category's standard in one request only when asked", () => {
    expect(updateApprovedComponentSchema.parse({ ...svelte, revision: 3 })).toMatchObject({
      demoteCurrentPreferred: false,
    });
    expect(
      updateApprovedComponentSchema.parse({ ...svelte, revision: 3, demoteCurrentPreferred: true })
    ).toMatchObject({ demoteCurrentPreferred: true });
  });
});
