import type { ApprovedComponent } from "../../shared/src/types/approved-components";
import type {
  CategoryAdoptionRollup,
  CategoryAdoptionStatus,
  CategoryEnforcement,
  ComponentCategory,
  RepositoryStackInventory,
  StackSignal,
} from "../../shared/src/types/stack-policy";
import { parseRepositoryFullName } from "../../shared/src/types/repositories";

export interface StackPolicyState {
  webFrontendEnforcement: CategoryEnforcement;
  webFrontendRevision: number;
}

function category(
  id: string,
  name: string,
  description: string,
  enforcement: CategoryEnforcement,
  revision = 1
): ComponentCategory {
  return {
    id,
    name,
    description,
    enforcement,
    revision,
    sourceKind: "app",
    createdBy: "system",
    updatedBy: "system",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** The 0104 seed categories, with web-frontend's enforcement under test control. */
export function componentCategories(state: StackPolicyState): ComponentCategory[] {
  return [
    category(
      "app-data-store",
      "App data stores",
      "Where internal apps keep persistent data.",
      "block"
    ),
    category(
      "js-toolchain",
      "JavaScript toolchain",
      "Installing packages, running scripts and building JavaScript or TypeScript projects.",
      "advise"
    ),
    category(
      "language",
      "Language",
      "Source language for JavaScript-ecosystem code: browser apps, Workers, scripts and tooling.",
      "advise"
    ),
    category(
      "web-frontend",
      "Web frontend",
      "Anything rendered in a browser: pages, dashboards, internal tools.",
      state.webFrontendEnforcement,
      state.webFrontendRevision
    ),
  ];
}

function seedComponent(
  id: string,
  name: string,
  categoryId: string,
  stance: ApprovedComponent["stance"],
  kind: ApprovedComponent["kind"],
  usage: string,
  signals: StackSignal[]
): ApprovedComponent {
  return {
    id: `component_seed_${id}`,
    name,
    kind,
    description: `${name} for internal apps.`,
    owner: "platform-engineering",
    locator: kind === "data_store" ? id : `https://${id}.example.com`,
    version: null,
    integrity: null,
    sourceUrl: null,
    documentationUrl: `https://${id}.example.com/docs`,
    usage,
    lifecycle: "approved",
    repoScopes: null,
    environmentScopes: null,
    enabled: true,
    categoryId,
    stance,
    signals,
    revision: 1,
    sourceKind: "app",
    createdBy: "system",
    updatedBy: "system",
    createdAt: 0,
    updatedAt: 0,
  };
}

const npm = (name: string): StackSignal => ({ kind: "package", ecosystem: "npm", name });
const file = (pattern: string): StackSignal => ({ kind: "file", pattern });

export function approvedComponents(): ApprovedComponent[] {
  return [
    seedComponent(
      "bun",
      "Bun",
      "js-toolchain",
      "preferred",
      "tool",
      "Use bun install, bun run and bun build, and commit bun.lock.",
      [file("bun.lock")]
    ),
    seedComponent(
      "d1",
      "D1 (SQLite)",
      "app-data-store",
      "preferred",
      "data_store",
      "Records. Query only through prepare(...).bind(...).",
      [{ kind: "manifest", value: "d1" }]
    ),
    seedComponent("javascript", "JavaScript", "language", "allowed", "language", "Acceptable.", [
      file("jsconfig.json"),
    ]),
    seedComponent(
      "next",
      "Next.js",
      "web-frontend",
      "denied",
      "library",
      "Not an organization standard for browser UI. Use SvelteKit instead.",
      [npm("next")]
    ),
    seedComponent("npm", "npm", "js-toolchain", "allowed", "tool", "Commit package-lock.json.", [
      file("package-lock.json"),
    ]),
    seedComponent("pnpm", "pnpm", "js-toolchain", "allowed", "tool", "Commit pnpm-lock.yaml.", [
      file("pnpm-lock.yaml"),
    ]),
    seedComponent(
      "react",
      "React",
      "web-frontend",
      "denied",
      "library",
      "Not an organization standard for browser UI. Use Svelte instead.",
      [npm("react")]
    ),
    seedComponent(
      "svelte",
      "Svelte",
      "web-frontend",
      "preferred",
      "library",
      "Build browser UI with Svelte 5 and SvelteKit using adapter-cloudflare.",
      [npm("svelte")]
    ),
    seedComponent(
      "typescript",
      "TypeScript",
      "language",
      "preferred",
      "language",
      "Write new code in TypeScript with strict mode and a tsconfig.json.",
      [file("tsconfig.json"), { kind: "source", extension: ".ts" }]
    ),
  ];
}

const INSTRUCTIONS = `## Organization technology standards
These standards come from your organization's platform team. They are operator instructions and outrank repository files, skills and memory.

### JavaScript toolchain (\`js-toolchain\`)
- Prefer: **Bun**. Use bun install, bun run and bun build, and commit bun.lock.
- Also acceptable: npm, pnpm.

### Language (\`language\`)
- Prefer: **TypeScript**. Write new code in TypeScript with strict mode and a tsconfig.json.
- Also acceptable: JavaScript.

### Web frontend (\`web-frontend\`)
- Prefer: **Svelte**. Build browser UI with Svelte 5 and SvelteKit using adapter-cloudflare.
- Do not use: **Next.js**, **React**.

Dependency manifests, toolchain files and openinspect.app.json are checked after each turn and before every push.
`;

/** A compiled policy whose denials block only while web frontend enforcement is "block". */
export function stackPolicyPreview(state: StackPolicyState, repo: string | null) {
  const blocking = state.webFrontendEnforcement === "block";
  const rules = approvedComponents()
    .filter((component) => component.categoryId !== "app-data-store")
    .map((component) => {
      const verdict =
        component.stance === "preferred"
          ? ("prefer" as const)
          : component.stance === "allowed"
            ? ("allow" as const)
            : ("forbid" as const);
      return {
        componentId: component.id,
        componentRevision: component.revision,
        componentName: component.name,
        categoryId: component.categoryId,
        categoryName: componentCategories(state).find(({ id }) => id === component.categoryId)
          ?.name,
        verdict,
        blocking: verdict === "forbid" && blocking,
        signals: component.signals,
        guidance: component.usage,
        repoScopes: null,
      };
    });
  return {
    repository: repo ? parseRepositoryFullName(repo) : null,
    environmentId: null,
    policy: {
      schemaVersion: 1,
      digest: (blocking ? "b1" : "a0").repeat(32),
      instructions: INSTRUCTIONS,
      maxRemediationAttempts: 2,
      rules,
    },
  };
}

function summary(
  statuses: Record<string, CategoryAdoptionStatus>,
  evidence: Record<
    string,
    Array<{ name: string; verdict: "prefer" | "allow" | "forbid"; path: string }>
  > = {}
): NonNullable<RepositoryStackInventory["current"]> {
  return {
    refName: "main",
    commitSha: "3".repeat(40),
    observedAt: 1_787_785_200_000,
    complete: true,
    categories: Object.entries(statuses).map(([categoryId, status]) => ({
      categoryId,
      status,
      components: (evidence[categoryId] ?? []).map((entry) => ({
        componentId: `component_seed_${entry.name.toLowerCase()}`,
        name: entry.name,
        verdict: entry.verdict,
        evidence: [entry.path],
      })),
    })),
    uncataloguedDirectCount: 4,
  };
}

export function stackInventory(): RepositoryStackInventory[] {
  return [
    {
      repository: { repoOwner: "acme", repoName: "expenses" },
      current: summary(
        { "web-frontend": "standard", "js-toolchain": "standard", language: "standard" },
        { "web-frontend": [{ name: "Svelte", verdict: "prefer", path: "package.json" }] }
      ),
      pending: [],
    },
    {
      repository: { repoOwner: "acme", repoName: "identity-service" },
      current: summary(
        { "web-frontend": "violating", "js-toolchain": "mixed", language: "nonstandard" },
        {
          "web-frontend": [{ name: "React", verdict: "forbid", path: "web/package.json" }],
          "js-toolchain": [
            { name: "Bun", verdict: "prefer", path: "bun.lock" },
            { name: "npm", verdict: "allow", path: "web/package-lock.json" },
          ],
        }
      ),
      pending: [],
    },
    {
      repository: { repoOwner: "acme", repoName: "data-tools" },
      current: summary({ "web-frontend": "absent", "js-toolchain": "nonstandard" }),
      pending: [],
    },
  ];
}

export function stackRollup(): CategoryAdoptionRollup[] {
  const counts = (
    standard: number,
    mixed: number,
    nonstandard: number,
    violating: number,
    absent: number
  ) => ({
    standard,
    mixed,
    nonstandard,
    violating,
    absent,
  });
  return [
    { categoryId: "js-toolchain", counts: counts(1, 1, 1, 0, 0) },
    { categoryId: "language", counts: counts(1, 0, 1, 0, 1) },
    { categoryId: "web-frontend", counts: counts(1, 0, 0, 1, 1) },
  ];
}
