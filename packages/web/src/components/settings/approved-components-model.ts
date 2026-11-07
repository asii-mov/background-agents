import type {
  ApprovedComponent,
  UpdateApprovedComponentInput,
} from "@open-inspect/shared/types/approved-components";
import {
  STACK_ECOSYSTEMS,
  stackSignalKey,
  type CategoryAdoptionStatus,
  type ComponentCategory,
  type Stance,
  type StackSignal,
} from "@open-inspect/shared/types/stack-policy";

interface Presentation {
  label: string;
  /** Dot or bar fill. Text stays in the ink tokens. */
  fill: string;
  description: string;
}

export const STANCE_PRESENTATION = {
  preferred: {
    label: "Standard",
    fill: "bg-success",
    description: "Agents use it for new projects and new code.",
  },
  allowed: {
    label: "Also acceptable",
    fill: "bg-info",
    description: "Agents keep it where a repository already uses it or a user asks for it.",
  },
  denied: {
    label: "Not allowed",
    fill: "bg-destructive",
    description: "Agents replace it with the standard, even when a user asks for it.",
  },
} as const satisfies Record<Stance, Presentation>;

export const STANCE_ORDER = ["preferred", "allowed", "denied"] as const satisfies readonly Stance[];

export const ADOPTION_STATUS_PRESENTATION = {
  standard: {
    label: "Standard",
    fill: "bg-success",
    description: "Only the standard is in use.",
  },
  mixed: {
    label: "Mixed",
    fill: "bg-info",
    description: "The standard and an alternative are both in use.",
  },
  nonstandard: {
    label: "Non-standard",
    fill: "bg-warning",
    description: "Only alternatives are in use.",
  },
  violating: {
    label: "Violating",
    fill: "bg-destructive",
    description: "A technology that is not allowed is in use.",
  },
  absent: {
    label: "Not used",
    fill: "bg-secondary-foreground",
    description: "Nothing in this category was detected.",
  },
} as const satisfies Record<CategoryAdoptionStatus, Presentation>;

/** Display order: the healthy state first, the state that needs action last before "not used". */
export const ADOPTION_STATUS_ORDER = [
  "standard",
  "mixed",
  "nonstandard",
  "violating",
  "absent",
] as const satisfies readonly CategoryAdoptionStatus[];

/** Mirrors the compiler: disabled, draft and uncategorised components never reach a session. */
export function isInEffect(component: ApprovedComponent): boolean {
  return (
    component.enabled && component.categoryId !== null && component.lifecycle !== "development"
  );
}

export interface StackLane {
  category: ComponentCategory;
  components: Record<Stance, ApprovedComponent[]>;
  /** The enabled, approved standard a promotion would demote, if any. */
  standard: ApprovedComponent | null;
}

/** One lane per category, components grouped by stance, in the catalogue's name order. */
export function buildStackLanes(
  categories: readonly ComponentCategory[],
  components: readonly ApprovedComponent[]
): StackLane[] {
  return categories.map((category) => {
    const members = components.filter((component) => component.categoryId === category.id);
    const byStance = (stance: Stance) => members.filter((component) => component.stance === stance);
    return {
      category,
      components: {
        preferred: byStance("preferred"),
        allowed: byStance("allowed"),
        denied: byStance("denied"),
      },
      standard:
        members.find(
          (component) =>
            component.stance === "preferred" &&
            component.enabled &&
            component.lifecycle === "approved"
        ) ?? null,
    };
  });
}

/** One signal per line in its canonical key form, the same text the catalogue stores. */
export function formatSignalLines(signals: readonly StackSignal[]): string {
  return signals.map(stackSignalKey).join("\n");
}

/**
 * Parses `package:<ecosystem>:<name>`, `file:<glob>`, `source:<.ext>` and `manifest:<kind>` lines
 * into signal shapes. The shared component schema validates names, globs and kinds.
 */
export function parseSignalLines(
  text: string
): { ok: true; signals: unknown[] } | { ok: false; message: string } {
  const signals: unknown[] = [];
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const separator = line.indexOf(":");
    const kind = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);
    if (kind === "package") {
      const ecosystemEnd = value.indexOf(":");
      const ecosystem = value.slice(0, ecosystemEnd);
      if (ecosystemEnd === -1 || !(STACK_ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
        return {
          ok: false,
          message: `Line ${index + 1}: write package:${STACK_ECOSYSTEMS.join("|")}:<name>`,
        };
      }
      signals.push({ kind, ecosystem, name: value.slice(ecosystemEnd + 1) });
    } else if (kind === "file") {
      signals.push({ kind, pattern: value });
    } else if (kind === "source") {
      signals.push({ kind, extension: value });
    } else if (kind === "manifest") {
      signals.push({ kind, value });
    } else {
      return {
        ok: false,
        message: `Line ${index + 1}: start with package:, file:, source: or manifest:`,
      };
    }
  }
  return { ok: true, signals };
}

/** The full update body for `component` with `changes` applied; PUT replaces the whole row. */
function componentUpdate(
  component: ApprovedComponent,
  changes: Partial<UpdateApprovedComponentInput> = {}
): UpdateApprovedComponentInput {
  return {
    name: component.name,
    kind: component.kind,
    description: component.description,
    owner: component.owner,
    locator: component.locator,
    version: component.version,
    integrity: component.integrity,
    sourceUrl: component.sourceUrl,
    documentationUrl: component.documentationUrl,
    usage: component.usage,
    lifecycle: component.lifecycle,
    repoScopes: component.repoScopes,
    environmentScopes: component.environmentScopes,
    enabled: component.enabled,
    categoryId: component.categoryId,
    stance: component.stance,
    signals: component.signals,
    revision: component.revision,
    ...changes,
  };
}

/** Makes `component` its lane's standard in one request, demoting the current one. */
export function standardPromotion(
  component: ApprovedComponent,
  lane: StackLane
): UpdateApprovedComponentInput {
  return componentUpdate(component, {
    stance: "preferred",
    demoteCurrentPreferred: lane.standard !== null && lane.standard.id !== component.id,
  });
}
