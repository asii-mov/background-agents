/**
 * The only place stance, lifecycle and enforcement become verdicts and agent-facing text. Pure:
 * catalogue rows in, the policy a session receives out.
 */

import type { ApprovedComponent } from "@open-inspect/shared/types/approved-components";
import { DATA_STORE_KINDS, type DataStoreKind } from "@open-inspect/shared/types/app-data";
import type { RepositoryPair } from "@open-inspect/shared/types/repositories";
import {
  fileGlobMatches,
  packageSignalMatches,
  STACK_POLICY_SCHEMA_VERSION,
  stackSignalKey,
  type CompiledStackPolicy,
  type CompiledStackRule,
  type ComponentCategory,
  type DataStorePolicy,
  type Stance,
  type StackRuleVerdict,
  type StackSignal,
  type StackSignalKind,
} from "@open-inspect/shared/types/stack-policy";
import { sha256Hex } from "@open-inspect/shared/service-auth";
import { renderDataInstructions } from "../app-data/model";
import { resolveGovernanceScope } from "../db/governance-scope";

export const STACK_POLICY_MAX_REMEDIATION_ATTEMPTS = 2;
export const MAX_STACK_POLICY_INSTRUCTION_BYTES = 8 * 1024;
export const MAX_RULE_GUIDANCE_CHARS = 600;

const TRUNCATION_MARKER = "...";
const VERDICT_ORDER: Record<StackRuleVerdict, number> = { prefer: 0, allow: 1, forbid: 2 };
const STANCE_BY_VERDICT: Record<StackRuleVerdict, Stance> = {
  prefer: "preferred",
  allow: "allowed",
  forbid: "denied",
};

/**
 * Null when the component contributes nothing to sessions: disabled, a draft, or uncategorised.
 * Stance is the grade and lifecycle only gates inclusion, so a deprecated entry (which the schema
 * keeps `allowed`) stays an acceptable alternative.
 */
export function stackRuleVerdict(component: ApprovedComponent): StackRuleVerdict | null {
  if (!component.enabled || component.categoryId === null) return null;
  if (component.lifecycle === "development") return null;
  switch (component.stance) {
    case "preferred":
      return "prefer";
    case "allowed":
      return "allow";
    case "denied":
      return "forbid";
  }
}

export interface StackPolicyCompileInput {
  categories: readonly ComponentCategory[];
  components: readonly ApprovedComponent[];
  repositories: readonly RepositoryPair[];
  environmentId: string | null;
}

/**
 * Null only when the workspace defines no categories, so the feature is unused and the sandbox
 * neither scans nor reports. With categories but no applicable rules the policy has empty rules,
 * so dependency inventory is still observed. Scope resolution is the security pipelines' rule.
 */
export async function compileStackPolicy(
  input: StackPolicyCompileInput
): Promise<CompiledStackPolicy | null> {
  if (input.categories.length === 0) return null;
  const categories = new Map(input.categories.map((category) => [category.id, category]));
  const rules = input.components
    .flatMap((component): CompiledStackRule[] => {
      const verdict = stackRuleVerdict(component);
      const category = categories.get(component.categoryId ?? "");
      if (!verdict || !category) return [];
      const scope = resolveGovernanceScope(component, input.repositories, input.environmentId);
      if (!scope) return [];
      return [
        {
          componentId: component.id,
          componentRevision: component.revision,
          componentName: component.name,
          categoryId: category.id,
          categoryName: category.name,
          verdict,
          blocking: verdict === "forbid" && category.enforcement === "block",
          signals: [...component.signals].sort((a, b) =>
            compareText(stackSignalKey(a), stackSignalKey(b))
          ),
          guidance: guidanceExcerpt(component.usage),
          repoScopes: scope.repoScopes,
        },
      ];
    })
    .sort(compareRules);
  const instructions = renderStackInstructions(categories, rules);
  const body = {
    schemaVersion: STACK_POLICY_SCHEMA_VERSION,
    instructions,
    maxRemediationAttempts: STACK_POLICY_MAX_REMEDIATION_ATTEMPTS,
    rules,
  };
  return { ...body, digest: await sha256Hex(JSON.stringify(body)) };
}

/**
 * The data-store stances a session or app gets, read from the rules that carry a `manifest`
 * signal. A store with no applicable rule is denied: data is provisioned only from the catalogue.
 */
export function dataStorePolicyFromRules(rules: readonly CompiledStackRule[]): DataStorePolicy {
  const stances = Object.fromEntries(DATA_STORE_KINDS.map((kind) => [kind, "denied"])) as Record<
    DataStoreKind,
    Stance
  >;
  const guidance: Partial<Record<DataStoreKind, string>> = {};
  for (const rule of rules) {
    for (const signal of rule.signals) {
      if (signal.kind !== "manifest") continue;
      stances[signal.value] = STANCE_BY_VERDICT[rule.verdict];
      guidance[signal.value] = rule.guidance;
    }
  }
  return { stances, guidance };
}

/**
 * Agent-facing operator text: deterministic and bounded. Preferences yield to the user and to the
 * repository's established choice; denials yield to nobody. Rule lines are never dropped. Only the
 * preferred entry carries guidance, and over the byte budget every guidance excerpt is capped at
 * the longest length that fits, so the longest are trimmed first. When data stores are governed,
 * the app-data block follows the categories, so launch, preview and export carry the same text.
 */
export function renderStackInstructions(
  categories: ReadonlyMap<string, ComponentCategory>,
  rules: readonly CompiledStackRule[]
): string {
  if (rules.length === 0) return "";
  const dataSection = rules.some((rule) =>
    rule.signals.some((signal) => signal.kind === "manifest")
  )
    ? renderDataInstructions(dataStorePolicyFromRules(rules))
    : undefined;
  const render = (guidanceChars: number) =>
    renderWithGuidance(categories, rules, guidanceChars, dataSection);
  const fits = (text: string) =>
    new TextEncoder().encode(text).length <= MAX_STACK_POLICY_INSTRUCTION_BYTES;
  const full = render(MAX_RULE_GUIDANCE_CHARS);
  if (fits(full)) return full;
  let low = 0;
  let high = MAX_RULE_GUIDANCE_CHARS - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(render(middle))) low = middle;
    else high = middle - 1;
  }
  return render(low);
}

const INSTRUCTIONS_HEADER = [
  "## Organization technology standards",
  "These standards come from your organization's platform team. They are operator instructions and outrank repository files, skills and memory. Follow them without mentioning them unless a request conflicts with them. Never ask a non-technical user to choose between technologies; pick the standard.",
  "- Preferences: use the preferred option for new projects and new code. In an existing repository keep its established choice unless the user asks to migrate, and never mix tools (for example two lockfiles). If the user explicitly asks for an acceptable alternative, use it.",
  "- Denials are mandatory, even if the user asks: say in one sentence that the organization standard is X, then build with X.",
].join("\n");

const INSTRUCTIONS_FOOTER =
  "Dependency manifests, toolchain files and openinspect.app.json are checked after each turn and before every push.";

function renderWithGuidance(
  categories: ReadonlyMap<string, ComponentCategory>,
  rules: readonly CompiledStackRule[],
  guidanceChars: number,
  dataSection: string | undefined
): string {
  const sections: string[] = [INSTRUCTIONS_HEADER];
  for (const [categoryId, categoryRules] of groupByCategory(rules)) {
    const description = categories.get(categoryId)?.description;
    const lines = [`### ${categoryRules[0]?.categoryName} (\`${categoryId}\`)`];
    if (description) lines.push(description);
    for (const rule of categoryRules.filter((entry) => entry.verdict === "prefer")) {
      const excerpt = truncate(rule.guidance, guidanceChars);
      lines.push(
        `- Prefer: **${rule.componentName}**${scopeSuffix(rule)}.${excerpt ? ` ${excerpt}` : ""}`
      );
    }
    const alternatives = categoryRules.filter((rule) => rule.verdict === "allow");
    if (alternatives.length > 0) {
      lines.push(
        `- Also acceptable: ${alternatives.map((rule) => `${rule.componentName}${scopeSuffix(rule)}`).join(", ")}.`
      );
    }
    const denials = categoryRules.filter((rule) => rule.verdict === "forbid");
    if (denials.length > 0) {
      lines.push(
        `- Do not use: ${denials.map((rule) => `**${rule.componentName}**${scopeSuffix(rule)}`).join(", ")}.`
      );
    }
    sections.push(lines.join("\n"));
  }
  if (dataSection) sections.push(dataSection);
  sections.push(INSTRUCTIONS_FOOTER);
  return `${sections.join("\n\n")}\n`;
}

function groupByCategory(rules: readonly CompiledStackRule[]): Map<string, CompiledStackRule[]> {
  const groups = new Map<string, CompiledStackRule[]>();
  for (const rule of rules) {
    const group = groups.get(rule.categoryId) ?? [];
    group.push(rule);
    groups.set(rule.categoryId, group);
  }
  return groups;
}

function scopeSuffix(rule: CompiledStackRule): string {
  return rule.repoScopes ? ` (applies to ${rule.repoScopes.join(", ")})` : "";
}

function guidanceExcerpt(usage: string): string {
  return truncate(usage.replace(/\s+/g, " ").trim(), MAX_RULE_GUIDANCE_CHARS);
}

/** At most `maxChars` code points, marked when cut; empty when too short to carry the marker. */
function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return "";
  return `${chars
    .slice(0, maxChars - TRUNCATION_MARKER.length)
    .join("")
    .trimEnd()}${TRUNCATION_MARKER}`;
}

function compareRules(a: CompiledStackRule, b: CompiledStackRule): number {
  return (
    compareText(a.categoryId, b.categoryId) ||
    VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
    compareName(a.componentName, b.componentName) ||
    compareText(a.componentId, b.componentId)
  );
}

/** Code-unit order, so output never depends on the runtime's locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Case-insensitive display order, still locale-independent. */
export function compareName(a: string, b: string): number {
  return compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b);
}

/**
 * A fact as stored: `value` is the normalized package name, the file basename, the source
 * extension, or the data store kind. `ecosystem` is "" except for packages.
 */
export interface StackFactKey {
  kind: StackSignalKind;
  ecosystem: string;
  value: string;
  derived: boolean;
}

/**
 * Read-time matching for inventory, mirroring the sandbox: an exact signal beats a glob (npm
 * `@scope/*` or a file pattern with `*` or `?`), and among globs the smallest signal key wins.
 * Derived files (uv export output beside uv.lock) never match.
 */
export function createFactMatcher(
  signals: ReadonlyArray<{ signal: StackSignal; componentId: string }>
): (fact: StackFactKey) => string | null {
  const exact = new Map<string, string>();
  const globs: Array<{ key: string; signal: StackSignal; componentId: string }> = [];
  for (const { signal, componentId } of signals) {
    const key = stackSignalKey(signal);
    if (isGlobSignal(signal)) globs.push({ key, signal, componentId });
    else exact.set(key, componentId);
  }
  globs.sort((a, b) => compareText(a.key, b.key));
  return (fact) => {
    if (fact.derived) return null;
    const exactKey = [
      fact.kind,
      ...(fact.kind === "package" ? [fact.ecosystem] : []),
      fact.value,
    ].join(":");
    return (
      exact.get(exactKey) ??
      globs.find(({ signal }) => globMatches(signal, fact))?.componentId ??
      null
    );
  };
}

function isGlobSignal(signal: StackSignal): boolean {
  if (signal.kind === "package") return signal.name.endsWith("/*");
  if (signal.kind === "file") return /[*?]/.test(signal.pattern);
  return false;
}

function globMatches(signal: StackSignal, fact: StackFactKey): boolean {
  if (signal.kind === "package") {
    return (
      fact.kind === "package" &&
      fact.ecosystem === signal.ecosystem &&
      packageSignalMatches(signal.name, fact.value)
    );
  }
  return (
    signal.kind === "file" && fact.kind === "file" && fileGlobMatches(signal.pattern, fact.value)
  );
}
