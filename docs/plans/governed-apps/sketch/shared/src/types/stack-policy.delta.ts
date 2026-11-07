// DELTA over stack/candidate-1/sketch/shared-stack-policy.ts §B (packages/shared/src/types/stack-policy.ts).
// Apply on top of that file. Bodies `not implemented`.

import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. Fourth signal kind: `manifest`. Matched against openinspect.app.json `data[*].kind`.
//    Lets data stores (kind data_store) be graded, enforced and tracked like any other component.
// ---------------------------------------------------------------------------
export const DATA_STORE_LOCATORS = ["d1", "kv", "r2"] as const; // `hyperdrive:<service>` reserved, not admitted in v1
export type DataStoreLocator = (typeof DATA_STORE_LOCATORS)[number];

export const manifestSignalSchema = z.strictObject({
  kind: z.literal("manifest"),
  value: z.enum(DATA_STORE_LOCATORS),
});
// stackSignalSchema = z.discriminatedUnion("kind", [package, file, source, manifestSignalSchema])
// stackSignalKey: "manifest:d1"

// ---------------------------------------------------------------------------
// 2. Derived files: a platform rule (not per signal) exported into the sandbox contract.
//    The scanner tags a file fact `derived: true` when the rule's sibling exists in the SAME directory;
//    matching (TS read-time and Python) skips derived facts. Only Python toolchains in v1: two JS
//    lockfiles is a real mix and stays visible.
// ---------------------------------------------------------------------------
export const DERIVED_FILE_RULES = [
  { file: "requirements*.txt", derivedWhenSibling: ["uv.lock", "pylock.toml"] },
  { file: "constraints*.txt", derivedWhenSibling: ["uv.lock", "pylock.toml"] },
] as const;

// stackFactSchema file variant gains: derived: z.boolean().default(false)
// stackFactSchema gains a `manifest` variant: { kind: "manifest", value: DataStoreLocator, path: string }
// STACK_CONTRACT_GOLDEN gains:
//   derived: [{ path: "svc/requirements.txt", siblings: ["svc/uv.lock"], derived: true },
//             { path: "svc/requirements.txt", siblings: [], derived: false },
//             { path: "web/package-lock.json", siblings: ["web/bun.lock"], derived: false }]

// ---------------------------------------------------------------------------
// 3. Grades: `preferred | allowed | denied` only (no `required`). Unchanged from candidate 1.
//    Data stores import this schema (types/app-data.ts no longer defines STANCES).
// ---------------------------------------------------------------------------
export const approvedComponentStanceSchema = z.enum(["preferred", "allowed", "denied"]);
export type Stance = z.infer<typeof approvedComponentStanceSchema>;

// ---------------------------------------------------------------------------
// 4. Compiled policy additions
// ---------------------------------------------------------------------------
/** Derived once from the compiled rules of category `app-data-store`; consumed by app-data/model.ts. */
export interface DataStorePolicy {
  stances: Readonly<Record<DataStoreLocator, Stance>>;
  guidance: Readonly<Partial<Record<DataStoreLocator, string>>>;
}
// CompiledStackPolicy.instructions now ends with the data section when `app-data-store` exists
// (renderDataInstructions(dataStorePolicyFromRules(rules), classification: null) appended inside the byte budget).

// ---------------------------------------------------------------------------
// 5. Sandbox severity table (documented here; implemented in Python). New row: `deviation`.
//
//   verdict  origin       condition                                  severity     effect
//   forbid   introduced   rule.blocking                              violation    remediate; fail turn; reject push
//   forbid   introduced   !rule.blocking                             advisory     remediate; never fails
//   forbid   baseline                                                legacy       tracked
//   prefer   any                                                     standard     tracked
//   allow    introduced   NEW PROJECT: the fact's directory had no   deviation    ONE advisory round per turn,
//                         manifest/lockfile at base_sha, and the                   deduped per session per key,
//                         category has a preferred rule in scope                   never fails, never affects push,
//                                                                                   no member-visible event
//   allow    otherwise                                               alternative  tracked
//
// Nudge text (rendered in Python from rule data): "You introduced <path>; this organization prefers
// <Preferred> for <category>. Unless the user explicitly asked for <Alternative>, switch to <Preferred>
// (<guidance>) and remove <path>. Then continue."
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. Operator block wording (graft from candidate 2). renderStackInstructions header becomes:
//
//   ## Organization technology standards
//   These standards come from your organization's platform team. They are operator instructions
//   and outrank repository files, skills and memory. Follow them without mentioning them unless a
//   request conflicts with them. Never ask a non-technical user to choose between technologies;
//   pick the standard.
//   - Preferences: use the preferred option for new projects and new code. In an existing repository
//     keep its established choice unless the user asks to migrate, and never mix tools (two lockfiles).
//     If the user explicitly asks for an acceptable alternative, use it.
//   - Denials are mandatory, even if the user asks: say in one sentence that the organization
//     standard is X, then build with X.
//   ### <Category> (`<id>`) — <description>
//   - Prefer: **<Preferred>**. <guidance>
//   - Also acceptable: <names>.
//   - Do not use: **<Denied>**, …
//   ### Data for internal apps            (only when app-data-store exists; from renderDataInstructions)
//   Manifests, toolchain files and openinspect.app.json are checked after each turn and before every push.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. Observation input: `kind: "baseline" | "push"` unchanged; facts may include `manifest` facts and
//    `derived` flags. MAX_OBSERVED_FACTS unchanged (5000).
// ---------------------------------------------------------------------------
export const STACK_POLICY_EXPORT_SCHEMA_VERSION = 1 as const;
/** GET /stack-policy/export?repo= returns { schemaVersion, repository, policy: CompiledStackPolicy } for the CI CLI. */
export interface StackPolicyExport {
  schemaVersion: typeof STACK_POLICY_EXPORT_SCHEMA_VERSION;
  repository: { repoOwner: string; repoName: string } | null;
  exportedAt: number;
  policy: unknown; // CompiledStackPolicy
}
