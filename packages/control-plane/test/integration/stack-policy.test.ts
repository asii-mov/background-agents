import { SELF, env } from "cloudflare:test";
import {
  createApprovedComponentSchema,
  type ApprovedComponent,
  type CreateApprovedComponentInput,
} from "@open-inspect/shared/types/approved-components";
import type { RepositoryPair } from "@open-inspect/shared/types/repositories";
import {
  MAX_OBSERVED_FACTS,
  type StackFact,
  type StackObservationInput,
} from "@open-inspect/shared/types/stack-policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovedComponentConflictError,
  ApprovedComponentStore,
} from "../../src/db/approved-components";
import {
  STACK_OBSERVATION_RETENTION_MS,
  StackInventoryStore,
  StackObservationRejectedError,
} from "../../src/db/stack-inventory";
import type { SqlDatabase } from "../../src/db/sql-database";
import { GovernanceCatalogStore } from "../../src/governance/catalog-store";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth, serviceFetch } from "./helpers";

function migration(prefix: string) {
  const entry = env.TEST_MIGRATIONS.find((candidate) => candidate.name.startsWith(prefix));
  if (!entry) throw new Error(`Migration ${prefix} not found in TEST_MIGRATIONS`);
  return entry;
}

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  )
    .bind(name)
    .first();
  return row !== null;
}

/** The shipped default policy, re-applied after cleanup empties the catalogue. */
async function reseedDefaultPolicy(): Promise<void> {
  const seed = migration("0104").queries.filter((query) =>
    /INSERT INTO (component_categories|approved_components|approved_component_signals) \(/.test(
      query
    )
  );
  expect(seed).toHaveLength(3);
  await env.DB.batch(seed.map((query) => env.DB.prepare(query)));
}

async function createSession(id: string, repositories: RepositoryPair[]): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sessions (id, repo_owner, repo_name, status, created_at, updated_at) VALUES (?, ?, ?, 'created', ?, ?)"
    ).bind(id, repositories[0]?.repoOwner, repositories[0]?.repoName, now, now),
    ...repositories.map((repository, position) =>
      env.DB.prepare(
        "INSERT INTO session_repositories (session_id, position, repo_owner, repo_name, repo_id, base_branch) VALUES (?, ?, ?, ?, NULL, 'main')"
      ).bind(id, position, repository.repoOwner, repository.repoName)
    ),
  ]);
}

const catalogue = () => new ApprovedComponentStore(env.DB);
const inventory = () => new StackInventoryStore(env.DB, catalogue());

const BASE_SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const SESSION_ID = "stack-session";

const repo = (repoOwner: string, repoName: string): RepositoryPair => ({ repoOwner, repoName });
const file = (path: string, derived = false): StackFact => ({ kind: "file", path, derived });
const npm = (
  name: string,
  scope: "runtime" | "dev" | "transitive" = "runtime",
  manifestPath = "package.json"
): StackFact => ({
  kind: "package",
  ecosystem: "npm",
  name,
  manifestPath,
  scope,
  declaredRange: "^1.0.0",
  resolvedVersion: null,
});
const source = (extension: string, fileCount: number): StackFact => ({
  kind: "source",
  extension,
  fileCount,
});

function observation(
  repository: RepositoryPair,
  facts: StackFact[],
  overrides: Partial<StackObservationInput> = {}
): StackObservationInput {
  return {
    repository,
    refName: "main",
    commitSha: BASE_SHA,
    kind: "baseline",
    complete: true,
    policyDigest: null,
    facts,
    ...overrides,
  };
}

function definitionOf(component: ApprovedComponent): CreateApprovedComponentInput {
  const {
    id: _id,
    revision: _revision,
    sourceKind: _sourceKind,
    createdBy: _createdBy,
    updatedBy: _updatedBy,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...definition
  } = component;
  return definition;
}

const denoInput: CreateApprovedComponentInput = {
  name: "Deno",
  kind: "tool",
  description: "JavaScript runtime and toolchain.",
  owner: "platform-engineering",
  locator: "https://deno.com",
  documentationUrl: "https://docs.deno.com",
  usage: "Use deno task and commit deno.lock.",
  lifecycle: "approved",
  categoryId: "js-toolchain",
  stance: "allowed",
  signals: [{ kind: "file", pattern: "deno.lock" }],
};

async function putComponent(id: string, body: Record<string, unknown>): Promise<Response> {
  return serviceFetch(`https://test.local/approved-components/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

describe("migration 0104", () => {
  beforeEach(cleanD1Tables);
  afterEach(async () => {
    if (!(await tableExists("component_categories"))) {
      await env.DB.batch(migration("0104").queries.map((query) => env.DB.prepare(query)));
    }
    await cleanD1Tables();
  });

  it("rebuilds the catalogue over live consumers, keeping every id and grading old rows allowed", async () => {
    await env.DB.exec(`
      DROP TABLE repository_stack_facts;
      DROP TABLE repository_stack_observations;
      DROP TABLE approved_component_signals;
      DROP TABLE approved_component_consumers;
      DROP TABLE approved_components;
      DROP TABLE component_categories;
    `);
    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE permission_id IN ('governance.read', 'governance.manage')"
    ).run();
    await env.DB.batch(migration("0075").queries.map((query) => env.DB.prepare(query)));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO approved_components
          (id, revision, name, kind, description, owner, locator, version, documentation_url, usage,
           lifecycle, created_by, updated_by, created_at, updated_at)
         VALUES
          ('component_auth', 3, 'Acme auth', 'library', 'Auth.', 'Security', '@acme/auth', '1.2.3',
           'https://docs.example.com/auth', 'Use it.', 'approved', 'user-1', 'user-1', 10, 20),
          ('component_template', 1, 'Service template', 'template', 'Template.', 'Platform',
           'https://templates.example.com/service', NULL, NULL, 'Start here.', 'deprecated',
           'user-1', 'user-1', 10, 20)`
      ),
      env.DB.prepare(
        `INSERT INTO approved_component_consumers
          (component_id, component_revision, component_version, repo_owner, repo_name, session_id,
           first_seen_at, last_seen_at)
         VALUES
          ('component_auth', 2, '1.2.0', 'acme', 'web-app', 'session-1', 100, 200),
          ('component_auth', 3, '1.2.3', 'group/sub', 'api', 'session-2', 110, 210),
          ('component_template', 1, NULL, 'acme', 'web-app', 'session-1', 120, 220)`
      ),
    ]);
    const consumersBefore = await env.DB.prepare(
      "SELECT * FROM approved_component_consumers ORDER BY component_id, repo_owner"
    ).all();

    await env.DB.batch(migration("0104").queries.map((query) => env.DB.prepare(query)));

    expect(
      await env.DB.prepare(
        "SELECT * FROM approved_component_consumers ORDER BY component_id, repo_owner"
      ).all()
    ).toMatchObject({ results: consumersBefore.results });
    const store = catalogue();
    expect(await store.get("component_auth")).toMatchObject({
      revision: 3,
      kind: "library",
      categoryId: null,
      stance: "allowed",
      signals: [],
      sourceKind: "app",
    });
    expect(await store.get("component_template")).toMatchObject({
      lifecycle: "deprecated",
      categoryId: null,
      stance: "allowed",
    });
    expect((await store.listCategories()).map((category) => category.id)).toEqual([
      "app-data-store",
      "js-toolchain",
      "language",
      "python-tooling",
      "web-frontend",
    ]);
    const components = await store.list();
    expect(components).toHaveLength(20);
    expect(components.flatMap((component) => component.signals)).toHaveLength(39);
    const policy = await store.compileForSession([repo("acme", "web-app")], null);
    expect(policy?.rules.map((rule) => rule.componentId).sort()).toEqual(
      components
        .filter((component) => component.id.startsWith("component_seed_"))
        .map((component) => component.id)
        .sort()
    );
    expect(
      await env.DB.prepare(
        "SELECT permission_id FROM role_permissions WHERE role_id = 'role_fork_catalog_editor' AND permission_id LIKE 'governance.%' ORDER BY permission_id"
      ).all()
    ).toMatchObject({
      results: [{ permission_id: "governance.manage" }, { permission_id: "governance.read" }],
    });
  });
});

describe("catalogue grades", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await reseedDefaultPolicy();
  });

  it("rejects a denial without a category, a deprecated standard and a second standard", async () => {
    const insert = (
      id: string,
      stance: string,
      categoryId: string | null,
      lifecycle: string,
      enabled = 1
    ) =>
      env.DB.prepare(
        `INSERT INTO approved_components
          (id, name, kind, description, owner, locator, usage, lifecycle, enabled, category_id,
           stance, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, 'tool', 'A tool.', 'platform', 'https://tools.example.com', 'Use it.', ?, ?, ?,
           ?, 'user-1', 'user-1', 1, 1)`
      )
        .bind(id, id, lifecycle, enabled, categoryId, stance)
        .run();

    await expect(insert("ungraded-denial", "denied", null, "approved")).rejects.toThrow(/CHECK/);
    await expect(
      insert("deprecated-standard", "preferred", "js-toolchain", "deprecated")
    ).rejects.toThrow(/CHECK/);
    await expect(
      insert("second-standard", "preferred", "js-toolchain", "approved")
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      insert("disabled-standard", "preferred", "js-toolchain", "approved", 0)
    ).resolves.toBeDefined();
    await expect(
      insert("draft-standard", "preferred", "js-toolchain", "development")
    ).resolves.toBeDefined();
  });

  it("moves a category's standard in one request", async () => {
    const created = await serviceFetch("https://test.local/approved-components", {
      method: "POST",
      body: JSON.stringify(denoInput),
    });
    expect(created.status).toBe(201);
    const deno = await created.json<ApprovedComponent>();

    const refused = await putComponent(deno.id, { ...denoInput, stance: "preferred", revision: 1 });
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toEqual({
      error: "js-toolchain already prefers Bun; demote it to make this the standard",
    });

    const promoted = await putComponent(deno.id, {
      ...denoInput,
      stance: "preferred",
      revision: 1,
      demoteCurrentPreferred: true,
    });
    expect(promoted.status).toBe(200);
    await expect(promoted.json()).resolves.toMatchObject({ stance: "preferred", revision: 2 });
    expect(await catalogue().get("component_seed_bun")).toMatchObject({
      stance: "allowed",
      revision: 2,
    });
    const policy = await catalogue().compileForSession([], null);
    expect(
      policy?.rules
        .filter((rule) => rule.categoryId === "js-toolchain" && rule.verdict === "prefer")
        .map((rule) => rule.componentName)
    ).toEqual(["Deno"]);
  });

  it("keeps each signal with one component and names its owner", async () => {
    const response = await serviceFetch("https://test.local/approved-components", {
      method: "POST",
      body: JSON.stringify({
        ...denoInput,
        signals: [
          { kind: "file", pattern: "deno.lock" },
          { kind: "file", pattern: "bun.lock" },
        ],
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Signal file:bun.lock already identifies Bun",
    });
    expect((await catalogue().list()).some((component) => component.name === "Deno")).toBe(false);
  });

  it("replaces a component's signals with its update", async () => {
    const created = await catalogue().create(denoInput, "user-1");
    const updated = await putComponent(created.id, {
      ...denoInput,
      signals: [{ kind: "file", pattern: "deno.json" }],
      revision: 1,
    });
    expect(updated.status).toBe(200);
    expect((await catalogue().get(created.id))?.signals).toEqual([
      { kind: "file", pattern: "deno.json" },
    ]);
    const stale = await putComponent(created.id, { ...denoInput, revision: 1 });
    expect(stale.status).toBe(409);
    expect((await catalogue().get(created.id))?.signals).toEqual([
      { kind: "file", pattern: "deno.json" },
    ]);
  });

  it("changes nothing when a concurrent edit lands between read and write", async () => {
    const created = await catalogue().create(denoInput, "user-1");
    const racing: SqlDatabase = {
      prepare: (query) => env.DB.prepare(query),
      batch: async (statements) => {
        await env.DB.prepare(
          "UPDATE approved_components SET revision = revision + 1, usage = 'Concurrent edit.' WHERE id = ?"
        )
          .bind(created.id)
          .run();
        return env.DB.batch(statements as D1PreparedStatement[]);
      },
    };

    await expect(
      new ApprovedComponentStore(racing).update(
        created.id,
        createApprovedComponentSchema.parse({
          ...denoInput,
          stance: "preferred",
          signals: [{ kind: "file", pattern: "deno.json" }],
        }),
        1,
        "user-2",
        { demoteCurrentPreferred: true }
      )
    ).rejects.toThrow(ApprovedComponentConflictError);
    expect(await catalogue().get(created.id)).toMatchObject({
      revision: 2,
      usage: "Concurrent edit.",
      stance: "allowed",
      signals: [{ kind: "file", pattern: "deno.lock" }],
    });
    expect(await catalogue().get("component_seed_bun")).toMatchObject({
      stance: "preferred",
      revision: 1,
    });
  });

  it("refuses API writes to rows the Git catalogue owns", async () => {
    await env.DB.prepare(
      "UPDATE approved_components SET source_kind = 'git', lifecycle = 'development', stance = 'allowed' WHERE id = 'component_seed_react'"
    ).run();
    const react = await catalogue().get("component_seed_react");

    const update = await putComponent("component_seed_react", {
      ...definitionOf(react!),
      usage: "Changed through the API.",
      revision: react!.revision,
    });
    expect(update.status).toBe(409);
    const removal = await serviceFetch(
      "https://test.local/approved-components/component_seed_react",
      {
        method: "DELETE",
      }
    );
    expect(removal.status).toBe(409);
    expect(await catalogue().get("component_seed_react")).toEqual(react);
  });

  it("refuses API creation while the Git catalogue owns categories and components", async () => {
    const governance = new GovernanceCatalogStore(env.DB);
    const gitSource = {
      provider: "github",
      owner: "security",
      name: "agent-catalog",
      ref: "main",
      path: ".openinspect",
    };
    const createComponent = () =>
      serviceFetch("https://test.local/approved-components", {
        method: "POST",
        body: JSON.stringify(denoInput),
      });
    const createCategory = (id: string) =>
      serviceFetch("https://test.local/component-categories", {
        method: "POST",
        body: JSON.stringify({ id, name: id, description: "Native mobile apps." }),
      });

    await governance.apply(
      gitSource,
      {
        commitSha: BASE_SHA,
        skills: [],
        mcpServers: [],
        stack: {
          categories: [
            {
              id: "mobile",
              name: "Mobile",
              description: "Native mobile apps.",
              enforcement: "advise",
            },
          ],
          components: [],
        },
      },
      []
    );
    const component = await createComponent();
    expect(component.status).toBe(409);
    await expect(component.json()).resolves.toEqual({
      error: "The component catalogue is managed by the Git governance catalogue; change it there",
    });
    expect((await createCategory("tablet")).status).toBe(409);
    expect((await catalogue().list()).some((row) => row.name === "Deno")).toBe(false);
    expect(await catalogue().getCategory("tablet")).toBeNull();

    await governance.apply(gitSource, { commitSha: NEXT_SHA, skills: [], mcpServers: [] }, []);
    expect((await createComponent()).status).toBe(201);
    expect((await createCategory("tablet")).status).toBe(201);
  });

  it("refuses to delete a category components still use", async () => {
    const store = catalogue();
    await expect(store.deleteCategory("web-frontend")).rejects.toThrow(
      ApprovedComponentConflictError
    );
    await expect(store.deleteCategory("web-frontend")).rejects.toThrow(
      "Category web-frontend is used by 3 components"
    );
    await store.createCategory(
      { id: "mobile", name: "Mobile", description: "Native mobile apps." },
      "user-1"
    );
    await expect(store.deleteCategory("mobile")).resolves.toBe(true);
  });

  it("refuses self-reported adoption of a component the scanner detects", async () => {
    const sessionName = `stack-adopt-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuth(stub, { authToken: "stack-token", sandboxId: "stack-sandbox" });

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/approved-components/component_seed_bun/adopt`,
      {
        method: "POST",
        headers: { Authorization: "Bearer stack-token", "Content-Type": "application/json" },
        body: JSON.stringify({ repoOwner: "acme", repoName: "web-app" }),
      }
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Adoption of this component is detected automatically from dependency manifests",
    });
  });
});

describe("stack inventory", () => {
  const repositories = [
    repo("acme", "web"),
    repo("acme", "mixed"),
    repo("acme", "yarn"),
    repo("acme", "react"),
    repo("acme", "py"),
    repo("group/sub", "api"),
  ];

  beforeEach(async () => {
    await cleanD1Tables();
    await reseedDefaultPolicy();
    await createSession(SESSION_ID, repositories);
  });

  async function factRows() {
    return (
      await env.DB.prepare(
        "SELECT * FROM repository_stack_facts ORDER BY repo_owner, repo_name, ref_name, kind, value, location"
      ).all()
    ).results;
  }

  it("records the same observation twice to the same rows", async () => {
    const input = observation(repo("Acme", "Web"), [
      file("bun.lock"),
      npm("Svelte"),
      npm("svelte", "dev"),
      source(".ts", 12),
    ]);
    await inventory().recordObservation(SESSION_ID, input);
    const first = await factRows();
    await inventory().recordObservation(SESSION_ID, input);

    expect(await factRows()).toEqual(first);
    expect(first).toEqual([
      expect.objectContaining({
        repo_owner: "acme",
        repo_name: "web",
        kind: "file",
        value: "bun.lock",
      }),
      expect.objectContaining({ kind: "package", value: "svelte", dependency_scope: "runtime" }),
      expect.objectContaining({ kind: "source", value: ".ts", file_count: 12 }),
    ]);
  });

  it("records an observation at the fact cap in one write", async () => {
    const facts = Array.from({ length: MAX_OBSERVED_FACTS }, (_, index) =>
      npm(`package-${index}`, "runtime", `packages/app-${index % 50}/package.json`)
    );
    await inventory().recordObservation(SESSION_ID, observation(repo("acme", "web"), facts));

    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM repository_stack_facts").first()
    ).toEqual({ n: MAX_OBSERVED_FACTS });
  });

  it("replaces a ref's snapshot with the newer observation", async () => {
    await inventory().recordObservation(
      SESSION_ID,
      observation(repo("acme", "web"), [file("bun.lock")])
    );
    await inventory().recordObservation(
      SESSION_ID,
      observation(repo("acme", "web"), [file("yarn.lock")], { commitSha: NEXT_SHA })
    );

    const current = (await inventory().getRepository(repo("acme", "web")))?.current;
    expect(current?.commitSha).toBe(NEXT_SHA);
    expect(current?.categories.find((entry) => entry.categoryId === "js-toolchain")).toEqual({
      categoryId: "js-toolchain",
      status: "nonstandard",
      components: [
        {
          componentId: "component_seed_yarn",
          name: "Yarn",
          verdict: "allow",
          evidence: ["yarn.lock"],
        },
      ],
    });
  });

  it("rejects a repository the session does not include", async () => {
    await expect(
      inventory().recordObservation(
        SESSION_ID,
        observation(repo("acme", "other"), [file("bun.lock")])
      )
    ).rejects.toThrow(StackObservationRejectedError);
    await expect(
      inventory().recordObservation("missing-session", observation(repo("acme", "web"), []))
    ).rejects.toThrow(StackObservationRejectedError);
    expect(await inventory().listRepositories()).toEqual([]);
  });

  it("round-trips a nested repository owner", async () => {
    await inventory().recordObservation(
      SESSION_ID,
      observation(repo("group/sub", "api"), [file("services/api/bun.lock")])
    );

    const [listed] = await inventory().listRepositories();
    expect(listed?.repository).toEqual(repo("group/sub", "api"));
    expect(await inventory().getRepository(repo("Group/Sub", "API"))).toEqual(listed);
    expect(
      listed?.current?.categories.find((entry) => entry.categoryId === "js-toolchain")?.components
    ).toEqual([expect.objectContaining({ name: "Bun", evidence: ["services/api/bun.lock"] })]);
  });

  it("derives each category's status from what is detected", async () => {
    const observations: Array<[RepositoryPair, StackFact[]]> = [
      [
        repo("acme", "web"),
        [
          file("bun.lock"),
          source(".ts", 412),
          source(".js", 3),
          { kind: "manifest", value: "d1", path: "openinspect.app.json" },
        ],
      ],
      [repo("acme", "mixed"), [file("bun.lock"), file("package-lock.json")]],
      [repo("acme", "yarn"), [file("yarn.lock")]],
      [repo("acme", "react"), [npm("react"), npm("lodash"), npm("scheduler", "transitive")]],
      [repo("acme", "py"), [file("svc/uv.lock"), file("svc/requirements.txt", true)]],
    ];
    for (const [repository, facts] of observations) {
      await inventory().recordObservation(SESSION_ID, observation(repository, facts));
    }

    const statuses = Object.fromEntries(
      (await inventory().listRepositories()).map((entry) => [
        entry.repository.repoName,
        Object.fromEntries(
          entry.current!.categories.map((category) => [category.categoryId, category.status])
        ),
      ])
    );
    expect(statuses).toEqual({
      mixed: {
        "app-data-store": "absent",
        "js-toolchain": "mixed",
        language: "absent",
        "python-tooling": "absent",
        "web-frontend": "absent",
      },
      py: {
        "app-data-store": "absent",
        "js-toolchain": "absent",
        language: "absent",
        "python-tooling": "standard",
        "web-frontend": "absent",
      },
      react: {
        "app-data-store": "absent",
        "js-toolchain": "absent",
        language: "absent",
        "python-tooling": "absent",
        "web-frontend": "violating",
      },
      web: {
        "app-data-store": "standard",
        "js-toolchain": "standard",
        language: "mixed",
        "python-tooling": "absent",
        "web-frontend": "absent",
      },
      yarn: {
        "app-data-store": "absent",
        "js-toolchain": "nonstandard",
        language: "absent",
        "python-tooling": "absent",
        "web-frontend": "absent",
      },
    });
    const web = await inventory().getRepository(repo("acme", "web"));
    expect(
      web?.current?.categories.find((entry) => entry.categoryId === "language")?.components
    ).toEqual([
      {
        componentId: "component_seed_typescript",
        name: "TypeScript",
        verdict: "prefer",
        evidence: ["412 .ts files"],
      },
      {
        componentId: "component_seed_javascript",
        name: "JavaScript",
        verdict: "allow",
        evidence: ["3 .js files"],
      },
    ]);
    const react = await inventory().getRepository(repo("acme", "react"));
    expect(react?.current?.uncataloguedDirectCount).toBe(1);

    const rollup = Object.fromEntries(
      (await inventory().rollup()).map((entry) => [entry.categoryId, entry.counts])
    );
    expect(rollup["js-toolchain"]).toEqual({
      violating: 0,
      standard: 1,
      mixed: 1,
      nonstandard: 1,
      absent: 2,
    });
    expect(rollup["web-frontend"]).toEqual({
      violating: 1,
      standard: 0,
      mixed: 0,
      nonstandard: 0,
      absent: 4,
    });
    expect(rollup["python-tooling"]).toEqual({
      violating: 0,
      standard: 1,
      mixed: 0,
      nonstandard: 0,
      absent: 4,
    });
  });

  it("reclassifies stored facts when a signal is added later", async () => {
    await inventory().recordObservation(SESSION_ID, observation(repo("acme", "web"), [npm("vue")]));
    const frontend = async () =>
      (await inventory().getRepository(repo("acme", "web")))?.current?.categories.find(
        (entry) => entry.categoryId === "web-frontend"
      );
    expect(await frontend()).toMatchObject({ status: "absent" });

    await catalogue().create(
      {
        name: "Vue",
        kind: "library",
        description: "Component framework.",
        owner: "platform-engineering",
        locator: "https://vuejs.org",
        documentationUrl: "https://vuejs.org",
        usage: "Acceptable in existing code.",
        lifecycle: "approved",
        categoryId: "web-frontend",
        stance: "allowed",
        signals: [{ kind: "package", ecosystem: "npm", name: "vue" }],
      },
      "user-1"
    );

    expect(await frontend()).toMatchObject({
      status: "nonstandard",
      components: [{ name: "Vue", verdict: "allow", evidence: ["package.json"] }],
    });
  });

  it("keeps push observations pending until they age out", async () => {
    await inventory().recordObservation(
      SESSION_ID,
      observation(repo("acme", "web"), [file("bun.lock")])
    );
    await inventory().recordObservation(
      SESSION_ID,
      observation(repo("acme", "web"), [file("bun.lock"), npm("react")], {
        refName: "open-inspect/feature",
        commitSha: NEXT_SHA,
        kind: "push",
      })
    );

    const entry = await inventory().getRepository(repo("acme", "web"));
    expect(entry?.current?.refName).toBe("main");
    expect(entry?.pending.map((summary) => summary.refName)).toEqual(["open-inspect/feature"]);

    expect(await inventory().prune(Date.now())).toBe(0);
    expect(await inventory().prune(Date.now() + STACK_OBSERVATION_RETENTION_MS + 1)).toBe(1);
    const pruned = await inventory().getRepository(repo("acme", "web"));
    expect(pruned?.pending).toEqual([]);
    expect(pruned?.current?.refName).toBe("main");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM repository_stack_facts WHERE ref_name <> 'main'"
      ).first()
    ).toEqual({ n: 0 });
  });

  it("lists declared and detected consumers together", async () => {
    await inventory().recordObservation(
      SESSION_ID,
      observation(repo("acme", "web"), [file("apps/site/bun.lock"), file("bun.lock")])
    );
    await inventory().recordObservation(
      SESSION_ID,
      observation(repo("acme", "yarn"), [file("yarn.lock")])
    );

    const detected = await serviceFetch(
      "https://test.local/approved-components/component_seed_bun/consumers"
    );
    expect(detected.status).toBe(200);
    await expect(detected.json()).resolves.toEqual([
      {
        evidence: "detected",
        componentId: "component_seed_bun",
        repoOwner: "acme",
        repoName: "web",
        refName: "main",
        commitSha: BASE_SHA,
        evidencePaths: ["apps/site/bun.lock", "bun.lock"],
        observedAt: expect.any(Number),
      },
    ]);

    const service = await catalogue().create(
      {
        name: "Acme login service",
        kind: "service",
        description: "Hosted login.",
        owner: "security",
        locator: "https://login.example.com",
        documentationUrl: "https://docs.example.com/login",
        usage: "Redirect to it.",
        lifecycle: "approved",
      },
      "user-1"
    );
    await catalogue().recordConsumption(SESSION_ID, service.id, repo("acme", "web"));
    expect(await catalogue().listConsumers(service.id)).toEqual([
      expect.objectContaining({ evidence: "declared", componentId: service.id, repoName: "web" }),
    ]);
  });
});
