import { SELF, env } from "cloudflare:test";
import type {
  ApprovedComponent,
  CreateApprovedComponentInput,
} from "@open-inspect/shared/types/approved-components";
import type { BuiltInRoleKey } from "@open-inspect/shared/rbac";
import {
  MAX_OBSERVED_FACTS,
  type CategoryAdoptionRollup,
  type ComponentCategory,
  type RepositoryStackInventory,
  type StackFact,
  type StackPolicyExport,
} from "@open-inspect/shared/types/stack-policy";
import { beforeEach, describe, expect, it } from "vitest";
import { ApprovedComponentStore } from "../../src/db/approved-components";
import { parseGovernanceCatalog } from "../../src/governance/catalog-schema";
import { GovernanceCatalogStore } from "../../src/governance/catalog-store";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSession,
  seedSandboxAuth,
  serviceFetch,
  serviceRequestHeaders,
  type ServiceRequestInit,
} from "./helpers";

const BASE = "https://test.local";

/** The shipped default policy, re-applied after cleanup empties the catalogue. */
async function reseedDefaultPolicy(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0104"));
  const seed = (migration?.queries ?? []).filter((query) =>
    /INSERT INTO (component_categories|approved_components|approved_component_signals) \(/.test(
      query
    )
  );
  expect(seed).toHaveLength(3);
  await env.DB.batch(seed.map((query) => env.DB.prepare(query)));
}

type Actor = "member" | "catalogue-editor" | "administrator";
const ACTORS: Record<Actor, { userId: string; role: BuiltInRoleKey }> = {
  member: { userId: "a".repeat(32), role: "member" },
  "catalogue-editor": { userId: "b".repeat(32), role: "member" },
  administrator: { userId: "c".repeat(32), role: "administrator" },
};

async function seedActors(): Promise<void> {
  for (const actor of Object.values(ACTORS)) {
    await serviceRequestHeaders(`${BASE}/`, { as: actor });
  }
  await env.DB.prepare(
    "UPDATE user_role_assignments SET role_id = 'role_fork_catalog_editor' WHERE user_id = ?"
  )
    .bind(ACTORS["catalogue-editor"].userId)
    .run();
}

function fetchAs(
  actor: Actor,
  path: string,
  init: Omit<ServiceRequestInit, "as"> = {}
): Promise<Response> {
  return serviceFetch(`${BASE}${path}`, { ...init, as: ACTORS[actor] });
}

function sendAs(actor: Actor, method: string, path: string, body: unknown): Promise<Response> {
  return fetchAs(actor, path, { method, body: JSON.stringify(body) });
}

const READS: ReadonlyArray<[method: string, path: string, body?: unknown]> = [
  ["GET", "/approved-components"],
  ["GET", "/approved-components/component_seed_bun/consumers"],
  ["GET", "/component-categories"],
  ["GET", "/security-pipelines"],
  ["GET", "/repository-risk"],
  ["POST", "/risk/assess", { repoOwner: "acme", repoName: "web-app", paths: ["README.md"] }],
  ["GET", "/governance/catalog"],
  ["GET", "/stack-policy/preview?repo=acme/web-app"],
  ["GET", "/stack-policy/export?repo=acme/web-app"],
  ["GET", "/stack-inventory"],
  ["GET", "/stack-inventory/rollup"],
  ["GET", "/stack-inventory/repositories/acme/web-app"],
];

const WRITES: ReadonlyArray<[method: string, path: string]> = [
  ["POST", "/approved-components"],
  ["PUT", "/approved-components/component_seed_bun"],
  ["DELETE", "/approved-components/component_seed_bun"],
  ["POST", "/component-categories"],
  ["PUT", "/component-categories/web-frontend"],
  ["DELETE", "/component-categories/web-frontend"],
  ["POST", "/security-pipelines"],
  ["PUT", "/security-pipelines/pipeline-1"],
  ["DELETE", "/security-pipelines/pipeline-1"],
  ["PUT", "/repository-risk"],
  ["POST", "/governance/catalog/sync"],
];

const SANDBOX_TOKEN = "governance-sandbox-token";
const BASE_SHA = "a".repeat(40);

const npm = (name: string, manifestPath = "package.json"): StackFact => ({
  kind: "package",
  ecosystem: "npm",
  name,
  manifestPath,
  scope: "runtime",
  declaredRange: "^1.0.0",
  resolvedVersion: null,
});

function observation(repoOwner: string, repoName: string, facts: StackFact[]) {
  return {
    repository: { repoOwner, repoName },
    refName: "main",
    commitSha: BASE_SHA,
    kind: "baseline",
    complete: true,
    policyDigest: null,
    facts,
  };
}

async function sandboxSession(
  name: string,
  token: string,
  repository = { repoOwner: "acme", repoName: "web-app" }
): Promise<string> {
  const sessionName = `${name}-${crypto.randomUUID()}`;
  const { stub } = await initNamedSession(sessionName, repository);
  await seedSandboxAuth(stub, { authToken: token, sandboxId: `${sessionName}-sandbox` });
  return sessionName;
}

function postObservation(sessionName: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/sessions/${sessionName}/stack-observations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("governance route policy", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await reseedDefaultPolicy();
    await seedActors();
  });

  it("refuses a member every governance read and write", async () => {
    for (const [method, path, body] of [...READS, ...WRITES]) {
      const response = await fetchAs("member", path, {
        method,
        ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("lets a catalogue editor and an administrator read every governance view", async () => {
    const sessionName = await sandboxSession("governance-reads", SANDBOX_TOKEN);
    expect(
      (await postObservation(sessionName, SANDBOX_TOKEN, observation("acme", "web-app", []))).status
    ).toBe(204);
    for (const actor of ["catalogue-editor", "administrator"] as const) {
      for (const [method, path, body] of READS) {
        const response = await fetchAs(actor, path, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(response.status, `${actor} ${method} ${path}`).toBe(200);
      }
    }
  });

  it("lets a catalogue editor change categories, components, pipelines and risk", async () => {
    const category = await sendAs("catalogue-editor", "POST", "/component-categories", {
      id: "mobile",
      name: "Mobile",
      description: "Native mobile apps.",
    });
    expect(category.status).toBe(201);
    const blocked = await sendAs("catalogue-editor", "PUT", "/component-categories/mobile", {
      name: "Mobile",
      description: "Native mobile apps.",
      enforcement: "block",
      revision: 1,
    });
    expect(blocked.status).toBe(200);
    await expect(blocked.json()).resolves.toMatchObject({ enforcement: "block", revision: 2 });

    const definition: CreateApprovedComponentInput = {
      name: "Expo",
      kind: "tool",
      description: "Native app toolchain.",
      owner: "mobile-platform",
      locator: "https://expo.dev",
      usage: "Use for new mobile apps.",
      categoryId: "mobile",
      signals: [{ kind: "package", ecosystem: "npm", name: "expo" }],
    };
    const created = await sendAs("catalogue-editor", "POST", "/approved-components", definition);
    expect(created.status).toBe(201);
    const component = await created.json<ApprovedComponent>();
    const updated = await sendAs(
      "catalogue-editor",
      "PUT",
      `/approved-components/${component.id}`,
      { ...definition, usage: "Use for every mobile app.", revision: component.revision }
    );
    expect(updated.status).toBe(200);
    expect(
      (
        await fetchAs("catalogue-editor", `/approved-components/${component.id}`, {
          method: "DELETE",
        })
      ).status
    ).toBe(200);
    expect(
      (await fetchAs("catalogue-editor", "/component-categories/mobile", { method: "DELETE" }))
        .status
    ).toBe(200);

    const pipeline = {
      name: "AppSec baseline",
      commands: [{ name: "secret scan", command: ["gitleaks", "detect"], timeoutSeconds: 120 }],
      repoScopes: null,
      environmentScopes: null,
      enabled: true,
      blocking: true,
      maxRemediationAttempts: 2,
    };
    const createdPipeline = await sendAs(
      "catalogue-editor",
      "POST",
      "/security-pipelines",
      pipeline
    );
    expect(createdPipeline.status).toBe(201);
    const { id: pipelineId, revision } = await createdPipeline.json<{
      id: string;
      revision: number;
    }>();
    expect(
      (
        await sendAs("catalogue-editor", "PUT", `/security-pipelines/${pipelineId}`, {
          ...pipeline,
          blocking: false,
          revision,
        })
      ).status
    ).toBe(200);
    expect(
      (await fetchAs("catalogue-editor", `/security-pipelines/${pipelineId}`, { method: "DELETE" }))
        .status
    ).toBe(200);
    expect(
      (
        await sendAs("catalogue-editor", "PUT", "/repository-risk", {
          repoOwner: "acme",
          repoName: "web-app",
          criticality: "high",
          rationale: null,
        })
      ).status
    ).toBe(200);

    const sync = await fetchAs("catalogue-editor", "/governance/catalog/sync", {
      method: "POST",
      body: "{}",
    });
    expect(sync.status).toBe(409);
    await expect(sync.json()).resolves.toEqual({
      error: expect.stringContaining("not configured"),
    });
  });

  it("answers catalogue conflicts and invalid category input", async () => {
    const inUse = await fetchAs("administrator", "/component-categories/web-frontend", {
      method: "DELETE",
    });
    expect(inUse.status).toBe(409);
    await expect(inUse.json()).resolves.toEqual({
      error: "Category web-frontend is used by 3 components",
    });
    const stale = await sendAs("administrator", "PUT", "/component-categories/web-frontend", {
      name: "Web frontend",
      description: "Browser UI.",
      enforcement: "advise",
      revision: 99,
    });
    expect(stale.status).toBe(409);
    const invalid = await sendAs("administrator", "POST", "/component-categories", {
      id: "Not A Slug",
      name: "Invalid",
      description: "Invalid id.",
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "id: must be a lowercase slug" });
    const missing = await sendAs("administrator", "PUT", "/component-categories/absent", {
      name: "Absent",
      description: "Absent.",
      revision: 1,
    });
    expect(missing.status).toBe(404);
  });
});

describe("sandbox stack observations", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await reseedDefaultPolicy();
  });

  it("records an observation of a session repository and shows it in the inventory", async () => {
    const sessionName = await sandboxSession("observe", SANDBOX_TOKEN);
    const response = await postObservation(
      sessionName,
      SANDBOX_TOKEN,
      observation("Acme", "Web-App", [{ kind: "file", path: "bun.lock", derived: false }])
    );
    expect(response.status).toBe(204);

    const inventory = await serviceFetch(`${BASE}/stack-inventory/repositories/acme/web-app`);
    expect(inventory.status).toBe(200);
    const body = await inventory.json<RepositoryStackInventory>();
    expect(body.repository).toEqual({ repoOwner: "acme", repoName: "web-app" });
    expect(body.current?.categories).toContainEqual({
      categoryId: "js-toolchain",
      status: "standard",
      components: [
        {
          componentId: "component_seed_bun",
          name: "Bun",
          verdict: "prefer",
          evidence: ["bun.lock"],
        },
      ],
    });
    const rollup = await serviceFetch(`${BASE}/stack-inventory/rollup`);
    await expect(rollup.json<CategoryAdoptionRollup[]>()).resolves.toContainEqual({
      categoryId: "js-toolchain",
      counts: { violating: 0, standard: 1, mixed: 0, nonstandard: 0, absent: 0 },
    });
    const all = await serviceFetch(`${BASE}/stack-inventory`);
    await expect(all.json<RepositoryStackInventory[]>()).resolves.toHaveLength(1);
  });

  it("refuses a repository the session does not include", async () => {
    const sessionName = await sandboxSession("observe-foreign", SANDBOX_TOKEN);
    const response = await postObservation(
      sessionName,
      SANDBOX_TOKEN,
      observation("acme", "backend", [npm("react")])
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Repository is not part of the session",
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM repository_stack_observations").first()
    ).toEqual({ n: 0 });
  });

  it("refuses another session's sandbox token", async () => {
    const target = await sandboxSession("observe-target", SANDBOX_TOKEN);
    await sandboxSession("observe-other", "other-sandbox-token");
    const response = await postObservation(
      target,
      "other-sandbox-token",
      observation("acme", "web-app", [npm("svelte")])
    );
    expect(response.status).toBe(401);
  });

  it("rejects a body that is not an observation", async () => {
    const sessionName = await sandboxSession("observe-invalid", SANDBOX_TOKEN);
    const response = await postObservation(sessionName, SANDBOX_TOKEN, {
      ...observation("acme", "web-app", []),
      commitSha: "main",
    });
    expect(response.status).toBe(400);
  });

  it("records an observation at the fact cap in one request", async () => {
    const sessionName = await sandboxSession("observe-cap", SANDBOX_TOKEN);
    const facts = Array.from({ length: MAX_OBSERVED_FACTS }, (_, index) =>
      npm(`package-${index}`, `packages/app-${index % 50}/package.json`)
    );
    const response = await postObservation(
      sessionName,
      SANDBOX_TOKEN,
      observation("acme", "web-app", facts)
    );
    expect(response.status).toBe(204);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM repository_stack_facts").first()
    ).toEqual({ n: MAX_OBSERVED_FACTS });

    const over = await postObservation(
      sessionName,
      SANDBOX_TOKEN,
      observation("acme", "web-app", [...facts, npm("one-too-many")])
    );
    expect(over.status).toBe(400);
  });

  it("round-trips a nested repository owner through the inventory path", async () => {
    const sessionName = await sandboxSession("observe-nested", SANDBOX_TOKEN, {
      repoOwner: "group/sub",
      repoName: "api",
    });
    expect(
      (
        await postObservation(
          sessionName,
          SANDBOX_TOKEN,
          observation("group/sub", "api", [{ kind: "file", path: "uv.lock", derived: false }])
        )
      ).status
    ).toBe(204);
    const response = await serviceFetch(`${BASE}/stack-inventory/repositories/group%2Fsub/api`);
    expect(response.status).toBe(200);
    await expect(response.json<RepositoryStackInventory>()).resolves.toMatchObject({
      repository: { repoOwner: "group/sub", repoName: "api" },
    });
    expect(
      (await serviceFetch(`${BASE}/stack-inventory/repositories/group%2Fsub/unknown`)).status
    ).toBe(404);
  });
});

describe("stack policy preview and export", () => {
  const scoped: CreateApprovedComponentInput = {
    name: "Acme UI kit",
    kind: "library",
    description: "Component library for the portal.",
    owner: "design-systems",
    locator: "@acme/ui",
    documentationUrl: "https://docs.example.com/ui",
    usage: "Use for portal screens.",
    lifecycle: "approved",
    categoryId: "web-frontend",
    stance: "allowed",
    signals: [{ kind: "package", ecosystem: "npm", name: "@acme/ui" }],
  };

  beforeEach(async () => {
    await cleanD1Tables();
    await reseedDefaultPolicy();
    const store = new ApprovedComponentStore(env.DB);
    await store.create({ ...scoped, repoScopes: ["group/sub/portal"] }, "seed");
    await store.create(
      {
        ...scoped,
        name: "Staging kit",
        environmentScopes: ["env-staging"],
        signals: [{ kind: "package", ecosystem: "npm", name: "@acme/staging-kit" }],
      },
      "seed"
    );
  });

  it("previews the exact policy a session on the repository and environment receives", async () => {
    const store = new ApprovedComponentStore(env.DB);
    const expected = await store.compileForSession(
      [{ repoOwner: "group/sub", repoName: "portal" }],
      "env-staging"
    );
    expect(expected?.instructions).toContain("Acme UI kit");
    expect(expected?.instructions).toContain("Staging kit");

    const response = await serviceFetch(
      `${BASE}/stack-policy/preview?repo=Group/Sub/Portal&environmentId=env-staging`
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ policy: typeof expected }>();
    expect(body.policy?.instructions).toBe(expected?.instructions);
    expect(body).toEqual({
      repository: { repoOwner: "group/sub", repoName: "portal" },
      environmentId: "env-staging",
      policy: expected,
    });

    const unscoped = await serviceFetch(`${BASE}/stack-policy/preview`);
    const unscopedBody = await unscoped.json<{ policy: typeof expected }>();
    expect(unscopedBody.policy?.instructions).not.toContain("Acme UI kit");
    expect(unscopedBody.policy).toEqual(await store.compileForSession([], null));
  });

  it("exports the compiled policy with its digest for CI", async () => {
    const response = await serviceFetch(`${BASE}/stack-policy/export?repo=group/sub/portal`);
    expect(response.status).toBe(200);
    const body = await response.json<StackPolicyExport>();
    const expected = await new ApprovedComponentStore(env.DB).compileForSession(
      [{ repoOwner: "group/sub", repoName: "portal" }],
      null
    );
    expect(body).toEqual({
      schemaVersion: 1,
      repository: { repoOwner: "group/sub", repoName: "portal" },
      exportedAt: expect.any(Number),
      policy: expected,
    });
    expect(body.policy?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.policy?.instructions).not.toContain("Staging kit");
  });

  it("rejects a repository that is not owner/name", async () => {
    expect((await serviceFetch(`${BASE}/stack-policy/preview?repo=portal`)).status).toBe(400);
    expect((await serviceFetch(`${BASE}/stack-policy/export?repo=acme/`)).status).toBe(400);
  });
});

describe("Git technology catalogue", () => {
  const source = {
    provider: "github",
    owner: "security",
    name: "agent-catalog",
    ref: "main",
    path: ".openinspect",
  };
  const categories = `categories:
  - id: js-toolchain
    name: JavaScript toolchain
    description: Installing packages and running scripts. Deployed apps run on Workers.
`;
  const componentList = `components:
  - path: components/bun.yaml
  - path: components/deno.yaml
`;
  const bun = `schemaVersion: 1
name: Bun
kind: tool
categoryId: js-toolchain
stance: preferred
owner: platform-engineering
locator: https://bun.sh
documentationUrl: https://bun.sh/docs
description: Package manager, script runner and bundler.
usage: Use bun install and commit bun.lock.
lifecycle: approved
signals:
  - { kind: file, pattern: bun.lock }
  - { kind: file, pattern: bun.lockb }
`;
  const deno = `schemaVersion: 1
name: Deno
kind: tool
categoryId: js-toolchain
stance: allowed
owner: platform-engineering
locator: https://deno.com
documentationUrl: https://docs.deno.com
description: JavaScript runtime and toolchain.
usage: Acceptable for scripts.
lifecycle: approved
repoScopes: [Acme/Tools]
signals:
  - { kind: file, pattern: deno.lock }
`;

  function parsed(
    commitSha: string,
    manifestTail = categories + componentList,
    files: Record<string, string> = {}
  ) {
    return parseGovernanceCatalog(
      {
        commitSha,
        files: Object.entries({
          "catalog.yaml": `schemaVersion: 1\n${manifestTail}`,
          "components/bun.yaml": bun,
          "components/deno.yaml": deno,
          ...files,
        }).map(([path, content]) => ({ path: `.openinspect/${path}`, content })),
      },
      ".openinspect"
    );
  }

  const catalogue = () => new ApprovedComponentStore(env.DB);
  const governance = () => new GovernanceCatalogStore(env.DB);

  async function signalOwners(): Promise<Record<string, string>> {
    const rows = await env.DB.prepare(
      "SELECT value, component_id FROM approved_component_signals ORDER BY value"
    ).all<{ value: string; component_id: string }>();
    return Object.fromEntries((rows.results ?? []).map((row) => [row.value, row.component_id]));
  }

  beforeEach(async () => {
    await cleanD1Tables();
    await reseedDefaultPolicy();
  });

  it("takes ownership: declared rows are Git's, every other component is disabled", async () => {
    const catalog = parsed("commit-a");
    await governance().apply(source, catalog, []);

    const components = await catalogue().list();
    const bunRow = components.find((component) => component.name === "Bun");
    const denoRow = components.find((component) => component.name === "Deno");
    expect(bunRow).toMatchObject({ id: "component_seed_bun", sourceKind: "git", enabled: true });
    expect(denoRow).toMatchObject({ sourceKind: "git", enabled: true });
    expect(
      components
        .filter((component) => component.enabled)
        .map((component) => component.name)
        .sort()
    ).toEqual(["Bun", "Deno"]);
    expect(components.filter((component) => component.sourceKind === "app")).toHaveLength(17);
    expect(await signalOwners()).toEqual({
      "bun.lock": "component_seed_bun",
      "bun.lockb": "component_seed_bun",
      "deno.lock": denoRow?.id,
    });

    const {
      id: _id,
      revision: _revision,
      sourceKind: _sourceKind,
      createdBy: _createdBy,
      updatedBy: _updatedBy,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...denoDefinition
    } = denoRow!;
    expect(denoDefinition).toEqual({
      ...catalog.stack?.components[1].definition,
      repoScopes: ["acme/tools"],
    });

    const categories = await (
      await serviceFetch(`${BASE}/component-categories`)
    ).json<ComponentCategory[]>();
    expect(categories.find((category) => category.id === "js-toolchain")).toMatchObject({
      sourceKind: "git",
      description: "Installing packages and running scripts. Deployed apps run on Workers.",
    });

    const policy = await catalogue().compileForSession(
      [{ repoOwner: "acme", repoName: "tools" }],
      null
    );
    expect(policy?.rules.map((rule) => rule.componentName)).toEqual(["Bun", "Deno"]);

    const refused = await serviceFetch(`${BASE}/approved-components/component_seed_bun`, {
      method: "PUT",
      body: JSON.stringify({
        ...catalog.stack?.components[0].definition,
        revision: bunRow?.revision,
      }),
    });
    expect(refused.status).toBe(409);
    const refusedCategory = await serviceFetch(`${BASE}/component-categories/js-toolchain`, {
      method: "PUT",
      body: JSON.stringify({
        name: "JavaScript toolchain",
        description: "Changed through the API.",
        revision: 2,
      }),
    });
    expect(refusedCategory.status).toBe(409);
  });

  it("writes nothing new when the same catalogue applies again", async () => {
    await governance().apply(source, parsed("commit-a"), []);
    const before = await catalogue().list();
    const categoriesBefore = await catalogue().listCategories();

    await governance().apply(source, parsed("commit-b"), []);
    expect(await catalogue().list()).toEqual(before);
    expect(await catalogue().listCategories()).toEqual(categoriesBefore);

    await governance().apply(
      source,
      parsed("commit-c", undefined, {
        "components/deno.yaml": deno.replace("Acceptable for scripts.", "Scripts only."),
      }),
      []
    );
    const after = await catalogue().list();
    const revision = (rows: ApprovedComponent[], name: string) =>
      rows.find((row) => row.name === name)?.revision;
    expect(revision(after, "Deno")).toBe((revision(before, "Deno") ?? 0) + 1);
    expect(revision(after, "Bun")).toBe(revision(before, "Bun"));
  });

  it("leaves app rows untouched when catalog.yaml declares neither key", async () => {
    const before = await catalogue().list();
    await governance().apply(source, parsed("commit-a", ""), []);
    expect(await catalogue().list()).toEqual(before);
    expect(await signalOwners()).toMatchObject({ "bun.lock": "component_seed_bun" });
  });

  it("hands Git rows back to the app when both keys are removed", async () => {
    await governance().apply(source, parsed("commit-a"), []);
    await governance().apply(source, parsed("commit-b", ""), []);

    const bunRow = await catalogue().get("component_seed_bun");
    expect(bunRow).toMatchObject({ sourceKind: "app", enabled: true });
    expect(await catalogue().getCategory("js-toolchain")).toMatchObject({ sourceKind: "app" });
    const edited = await serviceFetch(`${BASE}/approved-components/component_seed_bun`, {
      method: "PUT",
      body: JSON.stringify({
        ...parsed("commit-b").stack?.components[0].definition,
        usage: "Edited in the app again.",
        revision: bunRow?.revision,
      }),
    });
    expect(edited.status).toBe(200);
  });

  it("keeps the last good catalogue when a new one is rejected", async () => {
    await governance().apply(source, parsed("good-commit"), []);
    const lastGood = await catalogue().list();

    const collision = parsed("collision-commit", undefined, {
      "components/deno.yaml": deno.replace("name: Deno", "name: npm"),
    });
    await expect(governance().apply(source, collision, [])).rejects.toThrow(
      "components/deno.yaml: component name 'npm' is already in use"
    );
    expect(() =>
      parsed("unknown-category", undefined, {
        "components/deno.yaml": deno.replace("categoryId: js-toolchain", "categoryId: mobile"),
      })
    ).toThrow("components/deno.yaml: unknown category mobile");
    expect(() =>
      parsed("duplicate-signal", undefined, {
        "components/deno.yaml": deno.replace("deno.lock", "bun.lock"),
      })
    ).toThrow("components/deno.yaml: signal file:bun.lock already identifies Bun");
    await governance().recordFailure(source, new Error("rejected"));

    expect(await catalogue().list()).toEqual(lastGood);
    await expect(governance().getStatus(source)).resolves.toMatchObject({
      activeCommitSha: "good-commit",
      lastStatus: "failed",
    });
  });
});
