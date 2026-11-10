import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovedComponent } from "@open-inspect/shared/types/approved-components";
import type { ComponentCategory, StackSignal } from "@open-inspect/shared/types/stack-policy";
import { describe, expect, it } from "vitest";
import { ApprovedComponentStore } from "../db/approved-components";
import { SecurityPipelineStore } from "../db/security-pipelines";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  compileStackPolicy,
  createFactMatcher,
  dataStorePolicyFromRules,
  MAX_RULE_GUIDANCE_CHARS,
  MAX_STACK_POLICY_INSTRUCTION_BYTES,
  stackRuleVerdict,
} from "./compile";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

function migratedDatabase(): NodeSqlDatabase {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, MIGRATIONS_DIR);
  return createNodeSqlDatabase(sqlite);
}

function category(id: string, overrides: Partial<ComponentCategory> = {}): ComponentCategory {
  return {
    id,
    name: `Category ${id}`,
    description: `What belongs in ${id}.`,
    enforcement: "advise",
    revision: 1,
    sourceKind: "app",
    createdBy: "system",
    updatedBy: "system",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function component(id: string, overrides: Partial<ApprovedComponent> = {}): ApprovedComponent {
  return {
    id,
    revision: 1,
    name: id,
    kind: "tool",
    description: "A tool.",
    owner: "platform",
    locator: "https://tools.example.com",
    version: null,
    integrity: null,
    sourceUrl: null,
    documentationUrl: "https://tools.example.com/docs",
    usage: `Use ${id}.`,
    lifecycle: "approved",
    repoScopes: null,
    environmentScopes: null,
    enabled: true,
    categoryId: "toolchain",
    stance: "allowed",
    signals: [{ kind: "file", pattern: `${id}.lock` }],
    sourceKind: "app",
    createdBy: "user",
    updatedBy: "user",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const SESSION_REPOSITORIES = [
  { repoOwner: "acme", repoName: "web" },
  { repoOwner: "group/sub", repoName: "api" },
];

describe("stackRuleVerdict", () => {
  it.each([
    ["disabled", { enabled: false, stance: "preferred" }, null],
    ["a development draft", { lifecycle: "development", stance: "denied" }, null],
    ["uncategorised", { categoryId: null }, null],
    ["deprecated and allowed", { lifecycle: "deprecated", stance: "allowed" }, "allow"],
    ["preferred", { stance: "preferred" }, "prefer"],
    ["allowed", { stance: "allowed" }, "allow"],
    ["denied", { stance: "denied" }, "forbid"],
  ] as const)("a %s component yields %s", (_label, overrides, verdict) => {
    expect(stackRuleVerdict(component("tool", overrides))).toBe(verdict);
  });
});

describe("compileStackPolicy", () => {
  it("is null when the workspace defines no categories", async () => {
    await expect(
      compileStackPolicy({
        categories: [],
        components: [component("bun", { categoryId: null })],
        repositories: SESSION_REPOSITORIES,
        environmentId: null,
      })
    ).resolves.toBeNull();
  });

  it("compiles empty rules and no instructions when nothing applies", async () => {
    const policy = await compileStackPolicy({
      categories: [category("toolchain")],
      components: [
        component("draft", { lifecycle: "development", stance: "preferred" }),
        component("elsewhere", { repoScopes: ["acme/other"] }),
      ],
      repositories: SESSION_REPOSITORIES,
      environmentId: null,
    });
    expect(policy).toMatchObject({ rules: [], instructions: "", maxRemediationAttempts: 2 });
  });

  it("blocks only denials in block categories", async () => {
    const policy = await compileStackPolicy({
      categories: [category("advised"), category("blocked", { enforcement: "block" })],
      components: (["advised", "blocked"] as const).flatMap((categoryId) =>
        (["preferred", "allowed", "denied"] as const).map((stance) =>
          component(`${categoryId}-${stance}`, { categoryId, stance })
        )
      ),
      repositories: SESSION_REPOSITORIES,
      environmentId: null,
    });
    expect(
      Object.fromEntries(policy!.rules.map((rule) => [rule.componentName, rule.blocking]))
    ).toEqual({
      "advised-preferred": false,
      "advised-allowed": false,
      "advised-denied": false,
      "blocked-preferred": false,
      "blocked-allowed": false,
      "blocked-denied": true,
    });
  });

  it("produces the same digest and text whatever order the rows arrive in", async () => {
    const categories = [category("toolchain"), category("frontend", { enforcement: "block" })];
    const signals: StackSignal[] = [
      { kind: "package", ecosystem: "npm", name: "react" },
      { kind: "package", ecosystem: "npm", name: "react-dom" },
      { kind: "file", pattern: "react.lock" },
    ];
    const components = [
      component("bun", { stance: "preferred" }),
      component("npm"),
      component("yarn"),
      component("react", { categoryId: "frontend", stance: "denied", signals }),
    ];
    const forward = await compileStackPolicy({
      categories,
      components,
      repositories: SESSION_REPOSITORIES,
      environmentId: null,
    });
    const reversed = await compileStackPolicy({
      categories: [...categories].reverse(),
      components: [...components]
        .reverse()
        .map((entry) => ({ ...entry, signals: [...entry.signals].reverse() })),
      repositories: [...SESSION_REPOSITORIES].reverse(),
      environmentId: null,
    });
    expect(reversed).toEqual(forward);
  });

  it("trims guidance to fit the byte budget and never drops a rule line", async () => {
    const categoryIds = Array.from({ length: 30 }, (_, index) => `category-${index}`);
    const policy = await compileStackPolicy({
      categories: categoryIds.map((id) => category(id)),
      components: categoryIds.flatMap((categoryId) => [
        component(`${categoryId}-standard`, {
          categoryId,
          stance: "preferred",
          usage: `Guidance for ${categoryId}. ${"Keep it simple. ".repeat(80)}`,
        }),
        component(`${categoryId}-alternative`, { categoryId }),
        component(`${categoryId}-denied`, { categoryId, stance: "denied" }),
      ]),
      repositories: SESSION_REPOSITORIES,
      environmentId: null,
    });
    const instructions = policy!.instructions;
    expect(new TextEncoder().encode(instructions).length).toBeLessThanOrEqual(
      MAX_STACK_POLICY_INSTRUCTION_BYTES
    );
    for (const categoryId of categoryIds) {
      expect(instructions).toContain(`- Prefer: **${categoryId}-standard**.`);
      expect(instructions).toContain(`- Also acceptable: ${categoryId}-alternative.`);
      expect(instructions).toContain(`- Do not use: **${categoryId}-denied**.`);
    }
    expect(instructions).toContain("Guidance for category-0.");
    for (const rule of policy!.rules) {
      expect(rule.guidance.length).toBeLessThanOrEqual(MAX_RULE_GUIDANCE_CHARS);
    }
  });

  it("keeps every rule line even when nothing but rule lines fits", async () => {
    const categoryIds = Array.from({ length: 120 }, (_, index) => `category-${index}`);
    const policy = await compileStackPolicy({
      categories: categoryIds.map((id) => category(id)),
      components: categoryIds.map((categoryId) =>
        component(`${categoryId}-standard`, {
          categoryId,
          stance: "preferred",
          usage: "Guidance that cannot fit.",
        })
      ),
      repositories: SESSION_REPOSITORIES,
      environmentId: null,
    });
    expect(
      policy!.instructions.match(/^- Prefer: \*\*category-\d+-standard\*\*\.$/gm)
    ).toHaveLength(120);
    expect(policy!.instructions).not.toContain("Guidance that cannot fit");
  });

  it("bounds the remediation guidance excerpt", async () => {
    const policy = await compileStackPolicy({
      categories: [category("toolchain")],
      components: [
        component("npm", { stance: "denied", usage: `Use Bun.\n\n${"x".repeat(2000)}` }),
      ],
      repositories: SESSION_REPOSITORIES,
      environmentId: null,
    });
    const [rule] = policy!.rules;
    expect([...rule!.guidance]).toHaveLength(MAX_RULE_GUIDANCE_CHARS);
    expect(rule!.guidance).toMatch(/^Use Bun\. x+\.\.\.$/);
  });

  it("resolves scopes exactly as security pipelines do", async () => {
    const cases = [
      { name: "global", repoScopes: null, environmentScopes: null },
      { name: "repository", repoScopes: ["acme/web"], environmentScopes: null },
      { name: "nested-owner", repoScopes: ["group/sub/api"], environmentScopes: null },
      { name: "other-repository", repoScopes: ["acme/other"], environmentScopes: null },
      { name: "environment", repoScopes: null, environmentScopes: ["env-1"] },
      { name: "other-environment", repoScopes: null, environmentScopes: ["env-2"] },
      { name: "repository-or-environment", repoScopes: ["acme/web"], environmentScopes: ["env-2"] },
      { name: "both", repoScopes: ["acme/web"], environmentScopes: ["env-1"] },
    ];
    const db = migratedDatabase();
    try {
      const pipelines = new SecurityPipelineStore(db);
      for (const scope of cases) {
        await pipelines.create(
          { ...scope, commands: [{ name: "check", command: ["true"], timeoutSeconds: 60 }] },
          "user"
        );
      }
      const policy = await compileStackPolicy({
        categories: [category("toolchain")],
        components: cases.map((scope) => component(scope.name, scope)),
        repositories: SESSION_REPOSITORIES,
        environmentId: "env-1",
      });
      const fromPipelines = Object.fromEntries(
        (await pipelines.getForSession(SESSION_REPOSITORIES, "env-1"))
          .filter((pipeline) => cases.some((scope) => scope.name === pipeline.name))
          .map((pipeline) => [pipeline.name, pipeline.repoScopes])
      );
      expect(
        Object.fromEntries(policy!.rules.map((rule) => [rule.componentName, rule.repoScopes]))
      ).toEqual(fromPipelines);
      expect(Object.keys(fromPipelines).sort()).toEqual([
        "both",
        "environment",
        "global",
        "nested-owner",
        "repository",
        "repository-or-environment",
      ]);
    } finally {
      db.close();
    }
  });
});

const SEED_INSTRUCTIONS = `## Organization technology standards
These standards come from your organization's platform team. They are operator instructions and outrank repository files, skills and memory. Follow them without mentioning them unless a request conflicts with them. Never ask a non-technical user to choose between technologies; pick the standard.
- Preferences: use the preferred option for new projects and new code. In an existing repository keep its established choice unless the user asks to migrate, and never mix tools (for example two lockfiles). If the user explicitly asks for an acceptable alternative, use it.
- Denials are mandatory, even if the user asks: say in one sentence that the organization standard is X, then build with X.

### App data stores (\`app-data-store\`)
Where internal apps keep persistent data. Declared in openinspect.app.json, then provisioned and bound by the platform.
- Prefer: **D1 (SQLite)**. Records. Schema lives in numbered files under migrations/, and a file is never edited after it has deployed. Query only through prepare(...).bind(...).
- Also acceptable: R2, Workers KV.

### JavaScript toolchain (\`js-toolchain\`)
Installing packages, running scripts and building JavaScript or TypeScript projects. Deployed apps run on the Cloudflare Workers runtime, so this governs install and build, not production.
- Prefer: **Bun**. Use bun install, bun run and bun build, and commit bun.lock. Deployed apps run on the Cloudflare Workers runtime: do not use Bun runtime APIs (Bun.serve, Bun.file, bun:sqlite) in deployed code. Keep an existing repository's package manager unless asked to migrate, and never mix lockfiles.
- Also acceptable: Node.js, npm, pnpm, Yarn.

### Language (\`language\`)
Source language for JavaScript-ecosystem code: browser apps, Workers, scripts and tooling.
- Prefer: **TypeScript**. Write new code in TypeScript with strict mode and a tsconfig.json. Keep an existing JavaScript codebase in JavaScript unless the user asks to migrate.
- Also acceptable: JavaScript.

### Python tooling (\`python-tooling\`)
Environments, dependencies and lockfiles for Python projects.
- Prefer: **uv**. Use uv init, uv add and uv run, and commit uv.lock. Do not create requirements.txt, Pipfile or poetry.lock in new projects. Keep an existing repository's tool unless asked to migrate.
- Also acceptable: conda, pip, Pipenv, Poetry.

### Web frontend (\`web-frontend\`)
Anything rendered in a browser: pages, dashboards, internal tools.
- Prefer: **Svelte**. Build browser UI with Svelte 5 and SvelteKit using adapter-cloudflare.
- Do not use: **Next.js**, **React**.

### Data for internal apps
Declare what an app stores in \`openinspect.app.json\` under \`data\`, keyed by an UPPER_SNAKE_CASE binding name; the platform provisions a dedicated resource and binds it as \`env.<NAME>\`. Never create, name or reference a database, bucket, namespace, connection string or Cloudflare credential, and never write a wrangler config.
- \`{"kind":"d1"}\`: records in SQLite. Schema changes are numbered files such as \`migrations/0001_create-notes.sql\`; never edit or delete a file after it has deployed. A change that drops or rewrites existing data waits until the user approves it on the app's page.
- \`{"kind":"kv"}\`: caches and small ephemeral state, never records.
- \`{"kind":"r2"}\`: private files, served only through the app.
- SQL goes only through \`prepare(sql).bind(...)\` with a constant SQL string. Never build SQL from strings or template literals.
- The signed-in user is the \`x-openinspect-user-sub\` request header (email: \`x-openinspect-user-email\`), set by the platform after it verifies sign-in. Never read \`cf-access-authenticated-user-email\`, \`x-forwarded-email\`, \`x-forwarded-user\` or \`x-auth-user\` as identity. Tables that hold a person's data have \`owner_sub TEXT NOT NULL\`, and every query on them filters by it.
- Secrets are names under \`secrets\` in the manifest; a person enters each value on the app's page. Never ask for a secret value in chat.
- Set \`classification\` to \`internal\`, \`confidential\` or \`restricted\`, and store only what the feature needs.
- To run the app locally with every binding, run \`python -m sandbox_runtime.conformance app-dev --entry <worker file>\` and follow its output.

Dependency manifests, toolchain files and openinspect.app.json are checked after each turn and before every push.
`;

describe("the shipped default policy", () => {
  it("renders the exact operator block a session receives", async () => {
    const db = migratedDatabase();
    try {
      const policy = await new ApprovedComponentStore(db).compileForSession(
        [{ repoOwner: "acme", repoName: "web" }],
        null
      );
      expect(policy?.instructions).toBe(SEED_INSTRUCTIONS);
      expect(policy?.rules).toHaveLength(18);
      expect(
        policy?.rules.filter((rule) => rule.blocking).map((rule) => rule.componentName)
      ).toEqual(["Next.js", "React"]);
    } finally {
      db.close();
    }
  });

  it("leaves out the data block when no rule grades a data store", async () => {
    const policy = await compileStackPolicy({
      categories: [category("toolchain")],
      components: [component("bun", { stance: "preferred" })],
      repositories: SESSION_REPOSITORIES,
      environmentId: null,
    });
    expect(policy!.instructions).not.toContain("### Data for internal apps");
  });

  it("grades data stores D1 preferred, KV and R2 allowed", async () => {
    const db = migratedDatabase();
    try {
      const store = new ApprovedComponentStore(db);
      const policy = await store.compileForSession([], null);
      const data = dataStorePolicyFromRules(policy!.rules);
      expect(data.stances).toEqual({ d1: "preferred", kv: "allowed", r2: "allowed" });
      expect(data.guidance.d1).toContain("prepare(...).bind(...)");
      await expect(
        store.resolveForApp({ repoOwner: "acme", repoName: "web" }, null)
      ).resolves.toEqual(data);
    } finally {
      db.close();
    }
  });

  it("denies a data store no rule grades", () => {
    expect(dataStorePolicyFromRules([]).stances).toEqual({
      d1: "denied",
      kv: "denied",
      r2: "denied",
    });
  });
});

describe("createFactMatcher", () => {
  const match = createFactMatcher([
    { signal: { kind: "file", pattern: "requirements*.txt" }, componentId: "pip" },
    { signal: { kind: "file", pattern: "req*.txt" }, componentId: "short-glob" },
    { signal: { kind: "file", pattern: "requirements.txt" }, componentId: "exact-file" },
    { signal: { kind: "file", pattern: "bun.lock" }, componentId: "bun" },
    { signal: { kind: "package", ecosystem: "npm", name: "@acme/*" }, componentId: "acme-scope" },
    { signal: { kind: "package", ecosystem: "npm", name: "@acme/ui" }, componentId: "acme-ui" },
    { signal: { kind: "package", ecosystem: "npm", name: "react" }, componentId: "react" },
    { signal: { kind: "source", extension: ".ts" }, componentId: "typescript" },
    { signal: { kind: "manifest", value: "d1" }, componentId: "d1" },
  ]);
  const fact = (kind: "package" | "file" | "source" | "manifest", value: string, extra = {}) => ({
    kind,
    ecosystem: kind === "package" ? "npm" : "",
    value,
    derived: false,
    ...extra,
  });

  it.each([
    ["an exact file beats a glob", fact("file", "requirements.txt"), "exact-file"],
    ["the smallest glob key wins", fact("file", "requirements-dev.txt"), "short-glob"],
    ["bun.lock does not match bun.lockb", fact("file", "bun.lockb"), null],
    ["an exact package beats its scope", fact("package", "@acme/ui"), "acme-ui"],
    ["a scope names its packages", fact("package", "@acme/api"), "acme-scope"],
    ["a scope does not name a lookalike scope", fact("package", "@acme-labs/ui"), null],
    ["ecosystems never cross", fact("package", "react", { ecosystem: "pypi" }), null],
    ["sources match by extension", fact("source", ".ts"), "typescript"],
    ["data stores match by kind", fact("manifest", "d1"), "d1"],
    ["derived files never match", fact("file", "requirements.txt", { derived: true }), null],
  ])("%s", (_label, input, componentId) => {
    expect(match(input)).toBe(componentId);
  });

  it("matches requirements*.txt against requirements-dev.txt", () => {
    const pipOnly = createFactMatcher([
      { signal: { kind: "file", pattern: "requirements*.txt" }, componentId: "pip" },
    ]);
    expect(pipOnly(fact("file", "requirements-dev.txt"))).toBe("pip");
  });
});
