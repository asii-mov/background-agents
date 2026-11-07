/**
 * Stack policy: the organization's graded technology choices (preferred / allowed / denied per
 * category), the signals the sandbox scanner matches, the compiled policy a session receives, the
 * raw facts sandboxes report, and the inventory read model.
 *
 * The sandbox runtime cannot import TypeScript, so `npm run generate:stack-contract -w
 * @open-inspect/shared` writes STACK_POLICY_CONTRACT (ecosystems, platform constants and golden
 * cases) into the runtime package; `stack-policy.test.ts` fails when that file is stale, and the
 * Python scanner asserts its registry against it.
 */

import { z } from "zod";
import { APP_DATA_MANIFEST_FILE, DATA_STORE_KINDS, type DataStoreKind } from "./app-data";
import { repositoryPairInputSchema, type RepositoryPair } from "./repositories";

// ---- Ecosystems and platform constants --------------------------------------------------------

/** Package ecosystems the sandbox scanner parses. */
export const STACK_ECOSYSTEMS = ["npm", "pypi"] as const;
export const stackEcosystemSchema = z.enum(STACK_ECOSYSTEMS);
export type StackEcosystem = z.infer<typeof stackEcosystemSchema>;

/**
 * Package-name normalization and grammar per ecosystem. Python re-implements `normalize`; the
 * golden cases guard drift. An npm `@scope/*` signal names every package in that scope.
 */
const PACKAGE_NAME_RULES = {
  npm: {
    normalize: (name: string) => name.trim().toLowerCase(),
    pattern:
      /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$|^@[a-z0-9~-][a-z0-9._~-]*\/\*$/,
  },
  pypi: {
    // PEP 503
    normalize: (name: string) =>
      name
        .trim()
        .replace(/[-_.]+/g, "-")
        .toLowerCase(),
    pattern: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  },
} as const satisfies Record<StackEcosystem, { normalize(name: string): string; pattern: RegExp }>;

export function normalizePackageName(ecosystem: StackEcosystem, name: string): string {
  return PACKAGE_NAME_RULES[ecosystem].normalize(name);
}

/**
 * Source files never counted for `source` signals, so config files such as svelte.config.js do
 * not make every TypeScript repo look mixed. A platform rule rather than a per-signal one, so
 * inventory can re-match stored counts at read time.
 */
export const SOURCE_COUNT_EXCLUDED_BASENAME_GLOBS = ["*.config.*", ".*"] as const;
export const SOURCE_COUNT_EXCLUDED_DIRECTORIES = [
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".svelte-kit",
] as const;

/**
 * Basenames the sandbox always reports as file facts, even when no current signal names them,
 * so a file signal added later re-matches stored inventory. The sandbox also reports any path
 * that matches a signal in its compiled policy.
 */
export const WELL_KNOWN_TOOLCHAIN_FILES = [
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  ".yarnrc.yml",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".nvmrc",
  ".node-version",
  "pyproject.toml",
  "uv.lock",
  "pylock.toml",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "environment.yml",
  "environment.yaml",
  "conda-lock.yml",
  "requirements*.txt",
] as const;

/**
 * A file fact is `derived` when one of the rule's siblings exists in the same directory: `uv
 * export` output beside `uv.lock` is not a second toolchain. Matching and status derivation skip
 * derived facts. Two JS lockfiles are a real mix, so only Python rules exist.
 */
export const DERIVED_FILE_RULES = [
  { file: "requirements*.txt", derivedWhenSibling: ["uv.lock", "pylock.toml"] },
  { file: "constraints*.txt", derivedWhenSibling: ["uv.lock", "pylock.toml"] },
] as const;

export const MAX_OBSERVED_FACTS = 5000;

export const DEPENDENCY_SCOPES = ["runtime", "dev", "peer", "optional", "transitive"] as const;

// ---- Signals ----------------------------------------------------------------------------------

/**
 * File signals are basename globs using only `*` and `?`, so Python `fnmatchcase` and this
 * matcher agree. Case-sensitive.
 */
export function fileGlobMatches(pattern: string, basename: string): boolean {
  const source = [...pattern]
    .map((char) =>
      char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\/-]/g, "\\$&")
    )
    .join("");
  return new RegExp(`^${source}$`, "s").test(basename);
}

/** Whether a normalized package signal (exact name or npm `@scope/*`) names a normalized package. */
export function packageSignalMatches(signalName: string, packageName: string): boolean {
  return signalName.endsWith("/*")
    ? packageName.startsWith(signalName.slice(0, -1))
    : signalName === packageName;
}

const stackSignalShapeSchema = z.discriminatedUnion("kind", [
  /** A declared dependency: an exact name, or npm `@scope/*`. */
  z.strictObject({
    kind: z.literal("package"),
    ecosystem: stackEcosystemSchema,
    name: z.string().trim().min(1).max(214),
  }),
  /** A tracked file by basename glob ("bun.lock", "requirements*.txt"). */
  z.strictObject({
    kind: z.literal("file"),
    pattern: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._*?-]+$/, "must be a basename glob using only * and ?")
      .refine((pattern) => !pattern.includes("**"), "must not contain **")
      .refine((pattern) => /[A-Za-z0-9]/.test(pattern), "must name at least one literal character"),
  }),
  /** Source files by extension (".ts"), counted after the platform exclusions. */
  z.strictObject({
    kind: z.literal("source"),
    extension: z.string().regex(/^\.[a-z0-9]{1,10}$/),
  }),
  /** A data store declared in openinspect.app.json `data[*].kind`. */
  z.strictObject({
    kind: z.literal("manifest"),
    value: z.enum(DATA_STORE_KINDS),
  }),
]);

/**
 * What the scanner can see. A signal identifies one component; the database enforces that with
 * PRIMARY KEY (kind, ecosystem, value). Package names are normalized here, at the boundary.
 * Precedence when several signals match one fact, identical in TypeScript and Python: an exact
 * value beats a glob; among globs, the lexicographically smallest signal key wins.
 */
export const stackSignalSchema = stackSignalShapeSchema.transform((signal, ctx) => {
  if (signal.kind !== "package") return signal;
  const rules = PACKAGE_NAME_RULES[signal.ecosystem];
  const name = rules.normalize(signal.name);
  if (!rules.pattern.test(name)) {
    ctx.addIssue({
      code: "custom",
      path: ["name"],
      message:
        signal.ecosystem === "npm"
          ? `${JSON.stringify(signal.name)} is not an npm package name or @scope/*`
          : `${JSON.stringify(signal.name)} is not a PyPI project name; wildcards are not supported`,
    });
    return z.NEVER;
  }
  return { ...signal, name };
});
export type StackSignal = z.output<typeof stackSignalSchema>;

export const STACK_SIGNAL_KINDS = stackSignalShapeSchema.options.map(
  (option) => option.shape.kind.value
);
export type StackSignalKind = StackSignal["kind"];

/** Canonical "package:npm:react" | "file:bun.lock" | "source:.ts" | "manifest:d1": the DB key and match tiebreaker. */
export function stackSignalKey(signal: StackSignal): string {
  switch (signal.kind) {
    case "package":
      return `package:${signal.ecosystem}:${signal.name}`;
    case "file":
      return `file:${signal.pattern}`;
    case "source":
      return `source:${signal.extension}`;
    case "manifest":
      return `manifest:${signal.value}`;
  }
}

/** Golden cases exported into the sandbox contract, asserted by both test suites. */
export const STACK_CONTRACT_GOLDEN = {
  normalization: [
    { ecosystem: "npm", input: "React", expected: "react" },
    { ecosystem: "npm", input: "@Acme/UI", expected: "@acme/ui" },
    { ecosystem: "pypi", input: "Typing_Extensions", expected: "typing-extensions" },
    { ecosystem: "pypi", input: "zope.interface", expected: "zope-interface" },
  ],
  packageSignal: [
    { signal: "react", name: "react", matches: true },
    { signal: "react", name: "react-dom", matches: false },
    { signal: "@acme/*", name: "@acme/ui", matches: true },
    { signal: "@acme/*", name: "@acme-labs/ui", matches: false },
  ],
  fileGlob: [
    { pattern: "requirements*.txt", basename: "requirements-dev.txt", matches: true },
    { pattern: "requirements*.txt", basename: "requirements.txt", matches: true },
    { pattern: "bun.lock", basename: "bun.lockb", matches: false },
    { pattern: "bun.lock?", basename: "bun.lockb", matches: true },
    { pattern: "Pipfile", basename: "pipfile", matches: false },
  ],
  sourceExclusion: [
    { path: "svelte.config.js", counted: false },
    { path: ".eslintrc.cjs", counted: false },
    { path: "src/routes/+page.js", counted: true },
    { path: "dist/app.js", counted: false },
    { path: "packages/web/node_modules/x/index.ts", counted: false },
  ],
  derived: [
    { path: "svc/requirements.txt", siblings: ["svc/uv.lock"], derived: true },
    { path: "svc/requirements-dev.txt", siblings: ["svc/pylock.toml"], derived: true },
    { path: "svc/requirements.txt", siblings: [], derived: false },
    { path: "svc/requirements.txt", siblings: ["uv.lock"], derived: false },
    { path: "web/package-lock.json", siblings: ["web/bun.lock"], derived: false },
  ],
} as const;

// ---- Categories and stances -------------------------------------------------------------------

/** Capability slot, e.g. "web-frontend", "js-toolchain". */
export const componentCategoryIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase slug");

/**
 * How denials in a category are enforced. Preferences never block, in any category: "advise"
 * prompts remediation without failing; "block" fails the turn after remediation attempts and
 * rejects the push.
 */
export const categoryEnforcementSchema = z.enum(["advise", "block"]);
export type CategoryEnforcement = z.infer<typeof categoryEnforcementSchema>;

/**
 * Graded stance. There is deliberately no "required": "only X" is preferred X plus denied
 * siblings. Uncategorised catalogue entries are "allowed" and contribute nothing to the policy.
 */
export const approvedComponentStanceSchema = z.enum(["preferred", "allowed", "denied"]);
export type Stance = z.infer<typeof approvedComponentStanceSchema>;

/** Who owns a catalogue row: the admin API ("app") or `.openinspect/catalog.yaml` ("git"). */
export const catalogSourceKindSchema = z.enum(["app", "git"]);
export type CatalogSourceKind = z.infer<typeof catalogSourceKindSchema>;

const categoryDefinitionFields = {
  name: z.string().trim().min(1).max(100),
  /** Written for the agent: what kind of work belongs to this slot. */
  description: z.string().trim().min(1).max(500),
  enforcement: categoryEnforcementSchema.default("advise"),
};

export const componentCategoryInputSchema = z.strictObject({
  id: componentCategoryIdSchema,
  ...categoryDefinitionFields,
});
export const updateComponentCategorySchema = z.strictObject({
  ...categoryDefinitionFields,
  revision: z.number().int().positive(),
});
export type ComponentCategoryInput = z.input<typeof componentCategoryInputSchema>;
export type UpdateComponentCategoryInput = z.input<typeof updateComponentCategorySchema>;

export interface ComponentCategory extends z.output<typeof componentCategoryInputSchema> {
  revision: number;
  sourceKind: CatalogSourceKind;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

// ---- Compiled policy: SESSION_CONFIG key `stack_policy` ---------------------------------------

export const STACK_POLICY_SCHEMA_VERSION = 1 as const;

/**
 * Derived only by `stackRuleVerdict` in the control plane. The sandbox never sees stance,
 * lifecycle or enforcement.
 *   prefer: the category's standard. Steers through instructions; tracked; never blocks.
 *   allow:  an acceptable alternative. Tracked as non-standard; never blocks.
 *   forbid: denied. A new use prompts remediation; it blocks iff `blocking`.
 */
export type StackRuleVerdict = "prefer" | "allow" | "forbid";

export interface CompiledStackRule {
  componentId: string;
  componentRevision: number;
  componentName: string;
  categoryId: string;
  categoryName: string;
  verdict: StackRuleVerdict;
  /** verdict === "forbid" && category.enforcement === "block". Never true otherwise. */
  blocking: boolean;
  signals: StackSignal[];
  /** Bounded excerpt of `usage`, shown in remediation for forbid. */
  guidance: string;
  /** Same semantics as SecurityPipelineConfig.repoScopes. */
  repoScopes: string[] | null;
}

export interface CompiledStackPolicy {
  schemaVersion: typeof STACK_POLICY_SCHEMA_VERSION;
  digest: string;
  /** Rendered, bounded markdown; always-on harness context, never a skill. */
  instructions: string;
  maxRemediationAttempts: number;
  /** Sorted by (categoryId, verdict, componentName) so digest and text are stable. */
  rules: CompiledStackRule[];
}

/** The `app-data-store` category's rules, consumed by the app-data policy check. */
export interface DataStorePolicy {
  stances: Readonly<Record<DataStoreKind, Stance>>;
  guidance: Readonly<Partial<Record<DataStoreKind, string>>>;
}

// ---- Observations: sandbox -> control plane (POST /sessions/:id/stack-observations) -----------

/** Raw facts, not verdicts: the control plane matches them at read time against current signals. */
export const stackFactSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("package"),
    ecosystem: stackEcosystemSchema,
    name: z.string().min(1).max(214),
    manifestPath: z.string().min(1).max(1024),
    scope: z.enum(DEPENDENCY_SCOPES),
    declaredRange: z.string().max(200).nullable(),
    resolvedVersion: z.string().max(200).nullable(),
  }),
  z.strictObject({
    kind: z.literal("file"),
    path: z.string().min(1).max(1024),
    derived: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal("source"),
    extension: z.string().regex(/^\.[a-z0-9]{1,10}$/),
    fileCount: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("manifest"),
    value: z.enum(DATA_STORE_KINDS),
    /** The openinspect.app.json that declared the store. */
    path: z.string().min(1).max(1024),
  }),
]);
export type StackFact = z.output<typeof stackFactSchema>;

export const stackObservationInputSchema = z.strictObject({
  repository: repositoryPairInputSchema,
  refName: z.string().trim().min(1).max(255),
  commitSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  kind: z.enum(["baseline", "push"]),
  /** False when a manifest was unreadable or MAX_OBSERVED_FACTS truncated the list. */
  complete: z.boolean(),
  policyDigest: z.string().nullable(),
  /**
   * All direct packages; transitive packages that matched a rule; file facts for
   * WELL_KNOWN_TOOLCHAIN_FILES plus any path matching a compiled file signal; one source fact per
   * counted extension; one manifest fact per declared data store.
   */
  facts: z.array(stackFactSchema).max(MAX_OBSERVED_FACTS),
});
export type StackObservationInput = z.output<typeof stackObservationInputSchema>;

// ---- Inventory read model (governance.read) ---------------------------------------------------

/**
 * Per category per snapshot, derived at read time:
 *   violating:   a denied component is detected
 *   standard:    only the preferred component is detected
 *   mixed:       the preferred component plus alternatives
 *   nonstandard: only alternatives are detected
 *   absent:      nothing in this category is detected
 */
export const CATEGORY_ADOPTION_STATUSES = [
  "violating",
  "standard",
  "mixed",
  "nonstandard",
  "absent",
] as const;
export type CategoryAdoptionStatus = (typeof CATEGORY_ADOPTION_STATUSES)[number];

export interface StackObservationSummary {
  refName: string;
  commitSha: string;
  observedAt: number;
  complete: boolean;
  categories: Array<{
    categoryId: string;
    status: CategoryAdoptionStatus;
    components: Array<{
      componentId: string;
      name: string;
      verdict: StackRuleVerdict;
      /** Manifest or file paths, or "<n> .ts files" for source signals. */
      evidence: string[];
    }>;
  }>;
  /** Direct packages matching no component: the raw sprawl signal. */
  uncataloguedDirectCount: number;
}

export interface RepositoryStackInventory {
  repository: RepositoryPair;
  /** Latest baseline observation: the base branch at session start, the repository's real state. */
  current: StackObservationSummary | null;
  /** Push observations on other refs: agent branches in flight. */
  pending: StackObservationSummary[];
}

/** Workspace roll-up for "is the standard winning?". */
export interface CategoryAdoptionRollup {
  categoryId: string;
  counts: Record<CategoryAdoptionStatus, number>;
}

// ---- CI export (GET /stack-policy/export?repo=) -----------------------------------------------

export const STACK_POLICY_EXPORT_SCHEMA_VERSION = 1 as const;

/** What the CI CLI checks a push against. `policy` is null when no category applies. */
export interface StackPolicyExport {
  schemaVersion: typeof STACK_POLICY_EXPORT_SCHEMA_VERSION;
  repository: RepositoryPair | null;
  exportedAt: number;
  policy: CompiledStackPolicy | null;
}

// ---- Generated sandbox contract ---------------------------------------------------------------

export const STACK_POLICY_CONTRACT = {
  schemaVersion: STACK_POLICY_SCHEMA_VERSION,
  exportSchemaVersion: STACK_POLICY_EXPORT_SCHEMA_VERSION,
  ecosystems: STACK_ECOSYSTEMS,
  signalKinds: STACK_SIGNAL_KINDS,
  dependencyScopes: DEPENDENCY_SCOPES,
  dataStoreKinds: DATA_STORE_KINDS,
  appManifestFile: APP_DATA_MANIFEST_FILE,
  sourceCountExcludedBasenameGlobs: SOURCE_COUNT_EXCLUDED_BASENAME_GLOBS,
  sourceCountExcludedDirectories: SOURCE_COUNT_EXCLUDED_DIRECTORIES,
  wellKnownToolchainFiles: WELL_KNOWN_TOOLCHAIN_FILES,
  derivedFileRules: DERIVED_FILE_RULES,
  maxObservedFacts: MAX_OBSERVED_FACTS,
  golden: STACK_CONTRACT_GOLDEN,
} as const;

/** Repo-relative output path for {@link formatStackPolicyContractFile}. */
export const STACK_POLICY_CONTRACT_FILE =
  "packages/sandbox-runtime/src/sandbox_runtime/stack_policy_contract.json";

export function formatStackPolicyContractFile(): string {
  const header =
    "Generated from packages/shared/src/types/stack-policy.ts by `npm run generate:stack-contract -w @open-inspect/shared`. Do not edit.";
  return `${JSON.stringify({ $comment: header, ...STACK_POLICY_CONTRACT }, null, 2)}\n`;
}
