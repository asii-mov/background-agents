import type {
  ApprovedComponent,
  ComponentConsumer,
} from "@open-inspect/shared/types/approved-components";
import type { RepositoryPair } from "@open-inspect/shared/types/repositories";
import {
  CATEGORY_ADOPTION_STATUSES,
  normalizePackageName,
  type CategoryAdoptionRollup,
  type CategoryAdoptionStatus,
  type ComponentCategory,
  type RepositoryStackInventory,
  type StackFact,
  type StackObservationInput,
  type StackObservationSummary,
  type StackRuleVerdict,
  type StackSignalKind,
} from "@open-inspect/shared/types/stack-policy";
import {
  compareName,
  compareText,
  createFactMatcher,
  stackRuleVerdict,
} from "../stack-policy/compile";
import { bulkInsertStatements } from "./bulk-insert";
import {
  findSessionRepository,
  loadSessionGovernanceScope,
  resolveGovernanceScope,
} from "./governance-scope";
import type { SqlDatabase } from "./sql-database";

/** Push observations (agent branches in flight) older than this are pruned; baselines are kept. */
export const STACK_OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The reporting session does not include the observed repository. */
export class StackObservationRejectedError extends Error {}

/** The catalogue reads inventory is classified against (ApprovedComponentStore). */
export interface StackCatalogue {
  list(): Promise<ApprovedComponent[]>;
  listCategories(): Promise<ComponentCategory[]>;
}

interface ObservationRow {
  repo_owner: string;
  repo_name: string;
  ref_name: string;
  commit_sha: string;
  observation_kind: "baseline" | "push";
  complete: number;
  observed_at: number;
}

type FactRow = {
  repo_owner: string;
  repo_name: string;
  ref_name: string;
  kind: StackSignalKind;
  ecosystem: string;
  value: string;
  location: string;
  dependency_scope: string | null;
  declared_range: string | null;
  resolved_version: string | null;
  file_count: number | null;
  derived: number;
};

const VERDICT_ORDER: Record<StackRuleVerdict, number> = { prefer: 0, allow: 1, forbid: 2 };

function snapshotKey(row: { repo_owner: string; repo_name: string; ref_name: string }): string {
  return JSON.stringify([row.repo_owner, row.repo_name, row.ref_name]);
}

function toFactRow(
  snapshot: Pick<FactRow, "repo_owner" | "repo_name" | "ref_name">,
  fact: StackFact
): FactRow {
  const base = {
    ...snapshot,
    ecosystem: "",
    dependency_scope: null,
    declared_range: null,
    resolved_version: null,
    file_count: null,
    derived: 0,
  };
  switch (fact.kind) {
    case "package":
      return {
        ...base,
        kind: "package",
        ecosystem: fact.ecosystem,
        value: normalizePackageName(fact.ecosystem, fact.name),
        location: fact.manifestPath,
        dependency_scope: fact.scope,
        declared_range: fact.declaredRange,
        resolved_version: fact.resolvedVersion,
      };
    case "file":
      return {
        ...base,
        kind: "file",
        value: fact.path.slice(fact.path.lastIndexOf("/") + 1),
        location: fact.path,
        derived: fact.derived ? 1 : 0,
      };
    case "source":
      return {
        ...base,
        kind: "source",
        value: fact.extension,
        location: "",
        file_count: fact.fileCount,
      };
    case "manifest":
      return { ...base, kind: "manifest", value: fact.value, location: fact.path };
  }
}

function evidenceOf(fact: FactRow): string {
  return fact.kind === "source" ? `${fact.file_count} ${fact.value} files` : fact.location;
}

function categoryStatus(verdicts: ReadonlySet<StackRuleVerdict>): CategoryAdoptionStatus {
  if (verdicts.has("forbid")) return "violating";
  if (verdicts.has("prefer")) return verdicts.has("allow") ? "mixed" : "standard";
  return verdicts.has("allow") ? "nonstandard" : "absent";
}

/**
 * Sole writer of repository_stack_observations and repository_stack_facts. Facts are raw and are
 * matched to components at read time against the current catalogue, so a signal added today
 * reclassifies every repository already observed. Statuses are derived, never stored.
 */
export class StackInventoryStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly catalogue: StackCatalogue
  ) {}

  /**
   * Replaces one (repository, ref) snapshot atomically. The same input twice leaves the same rows;
   * of two writers for one ref the last ingested wins. Repository identity is stored lowercased.
   */
  async recordObservation(sessionId: string, input: StackObservationInput): Promise<void> {
    const scope = await loadSessionGovernanceScope(this.db, sessionId);
    if (!scope || !findSessionRepository(scope, input.repository)) {
      throw new StackObservationRejectedError("Repository is not part of the session");
    }
    const snapshot = {
      repo_owner: input.repository.repoOwner.toLowerCase(),
      repo_name: input.repository.repoName.toLowerCase(),
      ref_name: input.refName,
    };
    const facts = new Map<string, FactRow>();
    for (const fact of input.facts) {
      const row = toFactRow(snapshot, fact);
      const key = JSON.stringify([row.kind, row.ecosystem, row.value, row.location]);
      if (!facts.has(key)) facts.set(key, row);
    }
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO repository_stack_observations
           (repo_owner, repo_name, ref_name, commit_sha, observation_kind, complete, policy_digest,
            session_id, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo_owner, repo_name, ref_name) DO UPDATE SET
             commit_sha = excluded.commit_sha,
             observation_kind = excluded.observation_kind,
             complete = excluded.complete,
             policy_digest = excluded.policy_digest,
             session_id = excluded.session_id,
             observed_at = excluded.observed_at`
        )
        .bind(
          snapshot.repo_owner,
          snapshot.repo_name,
          snapshot.ref_name,
          input.commitSha,
          input.kind,
          input.complete ? 1 : 0,
          input.policyDigest,
          sessionId,
          Date.now()
        ),
      this.db
        .prepare(
          "DELETE FROM repository_stack_facts WHERE repo_owner = ? AND repo_name = ? AND ref_name = ?"
        )
        .bind(snapshot.repo_owner, snapshot.repo_name, snapshot.ref_name),
      ...bulkInsertStatements(this.db, "repository_stack_facts", [...facts.values()]),
    ]);
  }

  async listRepositories(): Promise<RepositoryStackInventory[]> {
    return (await this.snapshot(null)).inventories;
  }

  async getRepository(repository: RepositoryPair): Promise<RepositoryStackInventory | null> {
    return (await this.snapshot(repository)).inventories[0] ?? null;
  }

  /** Per-category status counts across each repository's current baseline. */
  async rollup(): Promise<CategoryAdoptionRollup[]> {
    const { categories, inventories } = await this.snapshot(null);
    return categories.map((category) => {
      const counts = Object.fromEntries(
        CATEGORY_ADOPTION_STATUSES.map((status) => [status, 0])
      ) as Record<CategoryAdoptionStatus, number>;
      for (const { current } of inventories) {
        const entry = current?.categories.find((summary) => summary.categoryId === category.id);
        if (entry) counts[entry.status] += 1;
      }
      return { categoryId: category.id, counts };
    });
  }

  /** Every observed ref where the component is detected, whatever its stance. */
  async listDetectedConsumers(componentId: string): Promise<ComponentConsumer[]> {
    const components = await this.catalogue.list();
    const kinds = [
      ...new Set(
        components.find((component) => component.id === componentId)?.signals.map((s) => s.kind)
      ),
    ];
    if (kinds.length === 0) return [];
    const match = createFactMatcher(
      components.flatMap((component) =>
        component.signals.map((signal) => ({ signal, componentId: component.id }))
      )
    );
    const [observations, facts] = await Promise.all([
      this.db
        .prepare(
          "SELECT * FROM repository_stack_observations ORDER BY repo_owner, repo_name, ref_name"
        )
        .all<ObservationRow>(),
      this.db
        .prepare(
          `SELECT * FROM repository_stack_facts WHERE kind IN (${kinds.map(() => "?").join(", ")})`
        )
        .bind(...kinds)
        .all<FactRow>(),
    ]);
    const evidence = new Map<string, Set<string>>();
    for (const fact of facts.results ?? []) {
      if (match({ ...fact, derived: fact.derived === 1 }) !== componentId) continue;
      const key = snapshotKey(fact);
      evidence.set(key, (evidence.get(key) ?? new Set()).add(evidenceOf(fact)));
    }
    return (observations.results ?? []).flatMap((observation): ComponentConsumer[] => {
      const paths = evidence.get(snapshotKey(observation));
      if (!paths) return [];
      return [
        {
          evidence: "detected",
          componentId,
          repoOwner: observation.repo_owner,
          repoName: observation.repo_name,
          refName: observation.ref_name,
          commitSha: observation.commit_sha,
          evidencePaths: [...paths].sort(compareText),
          observedAt: observation.observed_at,
        },
      ];
    });
  }

  /** Drops push observations older than the retention window. Returns how many were dropped. */
  async prune(now: number): Promise<number> {
    const cutoff = now - STACK_OBSERVATION_RETENTION_MS;
    const [, observations] = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM repository_stack_facts
           WHERE (repo_owner, repo_name, ref_name) IN (
             SELECT repo_owner, repo_name, ref_name FROM repository_stack_observations
             WHERE observation_kind = 'push' AND observed_at < ?)`
        )
        .bind(cutoff),
      this.db
        .prepare(
          "DELETE FROM repository_stack_observations WHERE observation_kind = 'push' AND observed_at < ?"
        )
        .bind(cutoff),
    ]);
    return observations?.meta.changes ?? 0;
  }

  private async snapshot(repository: RepositoryPair | null): Promise<{
    categories: ComponentCategory[];
    inventories: RepositoryStackInventory[];
  }> {
    const filter = repository ? " WHERE repo_owner = ? AND repo_name = ?" : "";
    const identity = repository
      ? [repository.repoOwner.toLowerCase(), repository.repoName.toLowerCase()]
      : [];
    const [categories, components, observations, facts] = await Promise.all([
      this.catalogue.listCategories(),
      this.catalogue.list(),
      this.db
        .prepare(
          `SELECT * FROM repository_stack_observations${filter}
           ORDER BY repo_owner, repo_name, observed_at DESC, ref_name`
        )
        .bind(...identity)
        .all<ObservationRow>(),
      this.db
        .prepare(`SELECT * FROM repository_stack_facts${filter}`)
        .bind(...identity)
        .all<FactRow>(),
    ]);
    const factsBySnapshot = new Map<string, FactRow[]>();
    for (const fact of facts.results ?? []) {
      const key = snapshotKey(fact);
      const snapshotFacts = factsBySnapshot.get(key) ?? [];
      snapshotFacts.push(fact);
      factsBySnapshot.set(key, snapshotFacts);
    }
    const summarize = this.summarizer(categories, components);
    const inventories = new Map<string, RepositoryStackInventory>();
    for (const observation of observations.results ?? []) {
      const repositoryKey = JSON.stringify([observation.repo_owner, observation.repo_name]);
      const inventory = inventories.get(repositoryKey) ?? {
        repository: { repoOwner: observation.repo_owner, repoName: observation.repo_name },
        current: null,
        pending: [],
      };
      inventories.set(repositoryKey, inventory);
      const summary = summarize(observation, factsBySnapshot.get(snapshotKey(observation)) ?? []);
      if (observation.observation_kind === "push") inventory.pending.push(summary);
      else inventory.current ??= summary;
    }
    return { categories, inventories: [...inventories.values()] };
  }

  /**
   * A snapshot's status per category, as a session on that repository with no environment would
   * be governed: disabled, draft and uncategorised components and out-of-scope rules count for
   * nothing. Direct packages no signal identifies are the uncatalogued sprawl count.
   */
  private summarizer(
    categories: readonly ComponentCategory[],
    components: readonly ApprovedComponent[]
  ): (observation: ObservationRow, facts: readonly FactRow[]) => StackObservationSummary {
    const match = createFactMatcher(
      components.flatMap((component) =>
        component.signals.map((signal) => ({ signal, componentId: component.id }))
      )
    );
    const componentsById = new Map(components.map((component) => [component.id, component]));
    return (observation, facts) => {
      const repository = { repoOwner: observation.repo_owner, repoName: observation.repo_name };
      const detected = new Map<string, Set<string>>();
      const uncatalogued = new Set<string>();
      for (const fact of facts) {
        const componentId = match({ ...fact, derived: fact.derived === 1 });
        if (componentId === null) {
          if (fact.kind === "package" && fact.dependency_scope !== "transitive") {
            uncatalogued.add(`${fact.ecosystem}:${fact.value}`);
          }
          continue;
        }
        detected.set(componentId, (detected.get(componentId) ?? new Set()).add(evidenceOf(fact)));
      }
      const governed = [...detected].flatMap(([componentId, evidence]) => {
        const component = componentsById.get(componentId);
        const verdict = component ? stackRuleVerdict(component) : null;
        if (!component || !verdict) return [];
        if (!resolveGovernanceScope(component, [repository], null)) return [];
        return [{ component, verdict, evidence: [...evidence].sort(compareText) }];
      });
      return {
        refName: observation.ref_name,
        commitSha: observation.commit_sha,
        observedAt: observation.observed_at,
        complete: observation.complete === 1,
        categories: categories.map((category) => {
          const members = governed
            .filter(({ component }) => component.categoryId === category.id)
            .sort(
              (a, b) =>
                VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
                compareName(a.component.name, b.component.name)
            );
          return {
            categoryId: category.id,
            status: categoryStatus(new Set(members.map(({ verdict }) => verdict))),
            components: members.map(({ component, verdict, evidence }) => ({
              componentId: component.id,
              name: component.name,
              verdict,
              evidence,
            })),
          };
        }),
        uncataloguedDirectCount: uncatalogued.size,
      };
    };
  }
}
