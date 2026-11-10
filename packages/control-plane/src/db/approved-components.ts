import type {
  ApprovedComponent,
  ApprovedComponentConsumer,
  ApprovedComponentDefinition,
  ComponentConsumer,
  CreateApprovedComponentInput,
} from "@open-inspect/shared/types/approved-components";
import { createApprovedComponentSchema } from "@open-inspect/shared/types/approved-components";
import type { DataStoreKind } from "@open-inspect/shared/types/app-data";
import type { RepositoryPair } from "@open-inspect/shared/types/repositories";
import {
  componentCategoryInputSchema,
  stackSignalKey,
  updateComponentCategorySchema,
  type CatalogSourceKind,
  type CompiledStackPolicy,
  type ComponentCategory,
  type ComponentCategoryInput,
  type DataStorePolicy,
  type StackSignal,
  type StackSignalKind,
  type UpdateComponentCategoryInput,
} from "@open-inspect/shared/types/stack-policy";
import { generateId } from "../auth/crypto";
import { compareText, compileStackPolicy, dataStorePolicyFromRules } from "../stack-policy/compile";
import { isUniqueConstraintError } from "./errors";
import {
  findSessionRepository,
  loadSessionGovernanceScope,
  resolveGovernanceScope,
} from "./governance-scope";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { StackInventoryStore } from "./stack-inventory";

interface ApprovedComponentRow {
  id: string;
  revision: number;
  name: string;
  kind: ApprovedComponent["kind"];
  description: string;
  owner: string;
  locator: string;
  version: string | null;
  integrity: string | null;
  source_url: string | null;
  documentation_url: string | null;
  usage: string;
  lifecycle: ApprovedComponent["lifecycle"];
  repo_scope: string | null;
  environment_scope: string | null;
  enabled: number;
  category_id: string | null;
  stance: ApprovedComponent["stance"];
  source_kind: CatalogSourceKind;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

interface SignalRow {
  kind: StackSignalKind;
  ecosystem: string;
  value: string;
  component_id: string;
}

interface CategoryRow {
  id: string;
  revision: number;
  name: string;
  description: string;
  enforcement: ComponentCategory["enforcement"];
  source_kind: CatalogSourceKind;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

interface ConsumerRow {
  component_id: string;
  component_revision: number;
  component_version: string | null;
  repo_owner: string;
  repo_name: string;
  session_id: string;
  first_seen_at: number;
  last_seen_at: number;
}

function parseScopes(raw: string | null): string[] | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid approved component scope");
  }
  return parsed;
}

/** The stored `(kind, ecosystem, value)` key of a signal: one row, one owning component. */
function signalColumns(signal: StackSignal): {
  kind: StackSignalKind;
  ecosystem: string;
  value: string;
} {
  switch (signal.kind) {
    case "package":
      return { kind: "package", ecosystem: signal.ecosystem, value: signal.name };
    case "file":
      return { kind: "file", ecosystem: "", value: signal.pattern };
    case "source":
      return { kind: "source", ecosystem: "", value: signal.extension };
    case "manifest":
      return { kind: "manifest", ecosystem: "", value: signal.value };
  }
}

function toSignal(row: SignalRow): StackSignal {
  switch (row.kind) {
    case "package":
      return { kind: "package", ecosystem: row.ecosystem as "npm" | "pypi", name: row.value };
    case "file":
      return { kind: "file", pattern: row.value };
    case "source":
      return { kind: "source", extension: row.value };
    case "manifest":
      return { kind: "manifest", value: row.value as DataStoreKind };
  }
}

function toComponent(row: ApprovedComponentRow, signals: readonly SignalRow[]): ApprovedComponent {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    kind: row.kind,
    description: row.description,
    owner: row.owner,
    locator: row.locator,
    version: row.version,
    integrity: row.integrity,
    sourceUrl: row.source_url,
    documentationUrl: row.documentation_url,
    usage: row.usage,
    lifecycle: row.lifecycle,
    repoScopes: parseScopes(row.repo_scope),
    environmentScopes: parseScopes(row.environment_scope),
    enabled: row.enabled === 1,
    categoryId: row.category_id,
    stance: row.stance,
    signals: signals
      .map(toSignal)
      .sort((a, b) => compareText(stackSignalKey(a), stackSignalKey(b))),
    sourceKind: row.source_kind,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCategory(row: CategoryRow): ComponentCategory {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    description: row.description,
    enforcement: row.enforcement,
    sourceKind: row.source_kind,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toConsumer(row: ConsumerRow): ApprovedComponentConsumer {
  return {
    componentId: row.component_id,
    componentRevision: row.component_revision,
    componentVersion: row.component_version,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    sessionId: row.session_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function scopesJson(scopes: string[] | null, lowerCase: boolean): string | null {
  if (!scopes?.length) return null;
  return JSON.stringify(scopes.map((scope) => (lowerCase ? scope.toLowerCase() : scope)));
}

function holdsPreference(definition: ApprovedComponentDefinition): boolean {
  return (
    definition.stance === "preferred" && definition.enabled && definition.lifecycle === "approved"
  );
}

/** Stale revision, a lost race, a category still in use, or adoption of a detected component. */
export class ApprovedComponentConflictError extends Error {}
export class ApprovedComponentValidationError extends Error {}
/** An API write to a row that a Git governance catalogue owns. */
export class GitManagedCatalogueError extends Error {
  constructor(what: string) {
    super(`${what} is managed by the Git governance catalogue; change it there`);
  }
}

const MAX_SESSION_COMPONENT_RESULTS = 100;
const COMPONENT_COLUMNS = `id, revision, name, kind, description, owner, locator, version, integrity,
  source_url, documentation_url, usage, lifecycle, repo_scope, environment_scope, enabled,
  category_id, stance, source_kind, created_by, updated_by, created_at, updated_at`;

/** The catalogue: categories, components and their detection signals, with one owner. */
export class ApprovedComponentStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<ApprovedComponent[]> {
    const [components, signals] = await Promise.all([
      this.db
        .prepare(`SELECT ${COMPONENT_COLUMNS} FROM approved_components ORDER BY name`)
        .all<ApprovedComponentRow>(),
      this.db
        .prepare("SELECT kind, ecosystem, value, component_id FROM approved_component_signals")
        .all<SignalRow>(),
    ]);
    const signalsByComponent = new Map<string, SignalRow[]>();
    for (const row of signals.results ?? []) {
      const owned = signalsByComponent.get(row.component_id) ?? [];
      owned.push(row);
      signalsByComponent.set(row.component_id, owned);
    }
    return (components.results ?? []).map((row) =>
      toComponent(row, signalsByComponent.get(row.id) ?? [])
    );
  }

  async get(id: string): Promise<ApprovedComponent | null> {
    const [row, signals] = await Promise.all([
      this.db
        .prepare(`SELECT ${COMPONENT_COLUMNS} FROM approved_components WHERE id = ?`)
        .bind(id)
        .first<ApprovedComponentRow>(),
      this.db
        .prepare(
          "SELECT kind, ecosystem, value, component_id FROM approved_component_signals WHERE component_id = ?"
        )
        .bind(id)
        .all<SignalRow>(),
    ]);
    return row ? toComponent(row, signals.results ?? []) : null;
  }

  async create(
    input: CreateApprovedComponentInput,
    actorUserId: string
  ): Promise<ApprovedComponent> {
    const definition = createApprovedComponentSchema.parse(input);
    await this.assertAppOwnsCatalogue();
    const id = `component_${generateId()}`;
    const now = Date.now();
    await this.assertNoConflict(definition, null, false);
    await this.write(definition, null, false, [
      this.db
        .prepare(
          `INSERT INTO approved_components
           (id, revision, name, kind, description, owner, locator, version, integrity, source_url,
            documentation_url, usage, lifecycle, repo_scope, environment_scope, enabled,
            category_id, stance, source_kind, created_by, updated_by, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app', ?, ?, ?, ?)`
        )
        .bind(id, ...this.definitionValues(definition), actorUserId, actorUserId, now, now),
      ...this.signalInserts(id, definition.signals, null),
    ]);
    const created = await this.get(id);
    if (!created) {
      throw new Error(`Approved component ${id} is missing after creation`);
    }
    return created;
  }

  /**
   * One atomic batch. Moving a category's standard is one request: with `demoteCurrentPreferred`
   * the current preferred component becomes allowed before this one is promoted. Every statement
   * is guarded by the expected revision, so a lost race changes nothing.
   */
  async update(
    id: string,
    definition: ApprovedComponentDefinition,
    expectedRevision: number,
    actorUserId: string,
    options: { demoteCurrentPreferred?: boolean } = {}
  ): Promise<ApprovedComponent | null> {
    const current = await this.get(id);
    if (!current) return null;
    if (current.sourceKind === "git") throw new GitManagedCatalogueError(current.name);
    if (current.revision !== expectedRevision) {
      throw new ApprovedComponentConflictError("Approved component changed; reload and try again");
    }
    const validated = createApprovedComponentSchema.parse(definition);
    const demote = options.demoteCurrentPreferred === true && holdsPreference(validated);
    await this.assertNoConflict(validated, id, demote);
    const now = Date.now();
    const atExpectedRevision =
      "EXISTS (SELECT 1 FROM approved_components WHERE id = ? AND revision = ?)";
    const results = await this.write(validated, id, demote, [
      ...(demote
        ? [
            this.db
              .prepare(
                `UPDATE approved_components SET stance = 'allowed', revision = revision + 1,
                   updated_by = ?, updated_at = ?
                 WHERE category_id = ? AND id <> ? AND stance = 'preferred' AND enabled = 1
                   AND lifecycle = 'approved' AND source_kind = 'app' AND ${atExpectedRevision}`
              )
              .bind(actorUserId, now, validated.categoryId, id, id, expectedRevision),
          ]
        : []),
      this.db
        .prepare(
          `DELETE FROM approved_component_signals WHERE component_id = ? AND ${atExpectedRevision}`
        )
        .bind(id, id, expectedRevision),
      ...this.signalInserts(id, validated.signals, expectedRevision),
      this.db
        .prepare(
          `UPDATE approved_components SET
             name = ?, kind = ?, description = ?, owner = ?, locator = ?, version = ?,
             integrity = ?, source_url = ?, documentation_url = ?, usage = ?, lifecycle = ?,
             repo_scope = ?, environment_scope = ?, enabled = ?, category_id = ?, stance = ?,
             updated_by = ?, updated_at = ?, revision = revision + 1
           WHERE id = ? AND revision = ? AND source_kind = 'app'
           RETURNING id`
        )
        .bind(...this.definitionValues(validated), actorUserId, now, id, expectedRevision),
    ]);
    if (!results.at(-1)?.results[0]) {
      throw new ApprovedComponentConflictError("Approved component changed; reload and try again");
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const current = await this.get(id);
    if (!current) return false;
    if (current.sourceKind === "git") throw new GitManagedCatalogueError(current.name);
    if (current.lifecycle !== "development") {
      throw new ApprovedComponentValidationError(
        "Approved or deprecated components must be retained for consumer discovery"
      );
    }
    const [, deleted] = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM approved_component_signals WHERE component_id = ? AND EXISTS (
             SELECT 1 FROM approved_components
             WHERE id = ? AND lifecycle = 'development' AND source_kind = 'app')`
        )
        .bind(id, id),
      this.db
        .prepare(
          "DELETE FROM approved_components WHERE id = ? AND lifecycle = 'development' AND source_kind = 'app'"
        )
        .bind(id),
    ]);
    return (deleted?.meta.changes ?? 0) > 0;
  }

  /**
   * The reconciler keeps a Git row exactly while catalog.yaml declares a non-empty catalogue, and
   * disables every app component it finds then; an app row created meanwhile would not survive.
   */
  private async assertAppOwnsCatalogue(): Promise<void> {
    const row = await this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM component_categories WHERE source_kind = 'git')
             OR EXISTS (SELECT 1 FROM approved_components WHERE source_kind = 'git') AS managed`
      )
      .first<{ managed: number }>();
    if (row?.managed) throw new GitManagedCatalogueError("The component catalogue");
  }

  async listCategories(): Promise<ComponentCategory[]> {
    const result = await this.db
      .prepare("SELECT * FROM component_categories ORDER BY id")
      .all<CategoryRow>();
    return (result.results ?? []).map(toCategory);
  }

  async getCategory(id: string): Promise<ComponentCategory | null> {
    const row = await this.db
      .prepare("SELECT * FROM component_categories WHERE id = ?")
      .bind(id)
      .first<CategoryRow>();
    return row ? toCategory(row) : null;
  }

  async createCategory(
    input: ComponentCategoryInput,
    actorUserId: string
  ): Promise<ComponentCategory> {
    const category = componentCategoryInputSchema.parse(input);
    await this.assertAppOwnsCatalogue();
    const now = Date.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO component_categories
           (id, revision, name, description, enforcement, source_kind, created_by, updated_by,
            created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, 'app', ?, ?, ?, ?)`
        )
        .bind(
          category.id,
          category.name,
          category.description,
          category.enforcement,
          actorUserId,
          actorUserId,
          now,
          now
        )
        .run();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ApprovedComponentValidationError(
          "A component category with this id or name already exists"
        );
      }
      throw error;
    }
    const created = await this.getCategory(category.id);
    if (!created) throw new Error(`Component category ${category.id} is missing after creation`);
    return created;
  }

  async updateCategory(
    id: string,
    input: UpdateComponentCategoryInput,
    actorUserId: string
  ): Promise<ComponentCategory | null> {
    const { revision, ...category } = updateComponentCategorySchema.parse(input);
    const current = await this.getCategory(id);
    if (!current) return null;
    if (current.sourceKind === "git") throw new GitManagedCatalogueError(current.name);
    try {
      const row = await this.db
        .prepare(
          `UPDATE component_categories SET
             name = ?, description = ?, enforcement = ?, updated_by = ?, updated_at = ?,
             revision = revision + 1
           WHERE id = ? AND revision = ? AND source_kind = 'app'
           RETURNING *`
        )
        .bind(
          category.name,
          category.description,
          category.enforcement,
          actorUserId,
          Date.now(),
          id,
          revision
        )
        .first<CategoryRow>();
      if (!row) {
        throw new ApprovedComponentConflictError(
          "Component category changed; reload and try again"
        );
      }
      return toCategory(row);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ApprovedComponentValidationError(
          "A component category with this name already exists"
        );
      }
      throw error;
    }
  }

  async deleteCategory(id: string): Promise<boolean> {
    const current = await this.getCategory(id);
    if (!current) return false;
    if (current.sourceKind === "git") throw new GitManagedCatalogueError(current.name);
    const users = await this.db
      .prepare("SELECT COUNT(*) AS n FROM approved_components WHERE category_id = ?")
      .bind(id)
      .first<{ n: number }>();
    if ((users?.n ?? 0) > 0) {
      throw new ApprovedComponentConflictError(
        `Category ${id} is used by ${users?.n} component${users?.n === 1 ? "" : "s"}`
      );
    }
    const result = await this.db
      .prepare("DELETE FROM component_categories WHERE id = ? AND source_kind = 'app'")
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** The stack policy a session on these repositories receives, compiled at launch and restore. */
  async compileForSession(
    repositories: readonly RepositoryPair[],
    environmentId: string | null
  ): Promise<CompiledStackPolicy | null> {
    const [categories, components] = await Promise.all([this.listCategories(), this.list()]);
    return compileStackPolicy({
      categories,
      components,
      repositories,
      environmentId,
    });
  }

  /** The data-store slice of the policy an app's repository and environment receive. */
  async resolveForApp(
    repository: RepositoryPair | null,
    environmentId: string | null
  ): Promise<DataStorePolicy> {
    const policy = await this.compileForSession(repository ? [repository] : [], environmentId);
    return dataStorePolicyFromRules(policy?.rules ?? []);
  }

  async listForSession(sessionId: string, query = ""): Promise<ApprovedComponent[]> {
    const scope = await loadSessionGovernanceScope(this.db, sessionId);
    if (!scope) return [];
    const normalizedQuery = query.trim().toLowerCase();
    return (await this.list())
      .filter((component) => {
        if (!component.enabled || component.lifecycle !== "approved") return false;
        if (!resolveGovernanceScope(component, scope.repositories, scope.environmentId)) {
          return false;
        }
        if (!normalizedQuery) return true;
        return [
          component.name,
          component.kind,
          component.description,
          component.owner,
          component.locator,
          component.usage,
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .slice(0, MAX_SESSION_COMPONENT_RESULTS);
  }

  /**
   * Self-reported adoption, for components the scanner cannot see (services, templates,
   * snippets). Adoption of a component with signals is detected from the repository instead.
   */
  async recordConsumption(
    sessionId: string,
    componentId: string,
    repository: RepositoryPair
  ): Promise<ApprovedComponentConsumer | null> {
    const [scope, applicable] = await Promise.all([
      loadSessionGovernanceScope(this.db, sessionId),
      this.listForSession(sessionId),
    ]);
    if (!scope) return null;
    const member = findSessionRepository(scope, repository);
    if (!member)
      throw new ApprovedComponentValidationError("Repository is not part of the session");
    const component = applicable.find((entry) => entry.id === componentId);
    if (!component) {
      throw new ApprovedComponentValidationError(
        "Component is not approved and applicable to this session"
      );
    }
    if (component.signals.length > 0) {
      throw new ApprovedComponentConflictError(
        "Adoption of this component is detected automatically from dependency manifests"
      );
    }
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO approved_component_consumers
         (component_id, component_revision, component_version, repo_owner, repo_name, session_id,
          first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(component_id, repo_owner, repo_name) DO UPDATE SET
           component_revision = excluded.component_revision,
           component_version = excluded.component_version,
           session_id = excluded.session_id,
           last_seen_at = excluded.last_seen_at`
      )
      .bind(
        component.id,
        component.revision,
        component.version,
        member.repoOwner,
        member.repoName,
        sessionId,
        now,
        now
      )
      .run();
    return this.getConsumer(component.id, member.repoOwner, member.repoName);
  }

  /** Declared consumers (the adopt tool) merged with repositories where the component is detected. */
  async listConsumers(componentId: string): Promise<ComponentConsumer[]> {
    const [declared, detected] = await Promise.all([
      this.db
        .prepare(
          "SELECT * FROM approved_component_consumers WHERE component_id = ? ORDER BY repo_owner, repo_name"
        )
        .bind(componentId)
        .all<ConsumerRow>(),
      new StackInventoryStore(this.db, this).listDetectedConsumers(componentId),
    ]);
    return [
      ...(declared.results ?? []).map((row): ComponentConsumer => ({
        evidence: "declared",
        ...toConsumer(row),
      })),
      ...detected,
    ];
  }

  private async getConsumer(
    componentId: string,
    repoOwner: string,
    repoName: string
  ): Promise<ApprovedComponentConsumer | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM approved_component_consumers
         WHERE component_id = ? AND repo_owner = ? AND repo_name = ?`
      )
      .bind(componentId, repoOwner, repoName)
      .first<ConsumerRow>();
    return row ? toConsumer(row) : null;
  }

  private definitionValues(definition: ApprovedComponentDefinition): unknown[] {
    return [
      definition.name,
      definition.kind,
      definition.description,
      definition.owner,
      definition.locator,
      definition.version,
      definition.integrity,
      definition.sourceUrl,
      definition.documentationUrl,
      definition.usage,
      definition.lifecycle,
      scopesJson(definition.repoScopes, true),
      scopesJson(definition.environmentScopes, false),
      definition.enabled ? 1 : 0,
      definition.categoryId,
      definition.stance,
    ];
  }

  /**
   * Signal inserts for one component. With `expectedRevision` each statement applies only while
   * the component is still at that revision, so a lost race inserts nothing.
   */
  private signalInserts(
    componentId: string,
    signals: readonly StackSignal[],
    expectedRevision: number | null
  ): SqlStatement[] {
    const guardParameters = expectedRevision === null ? 0 : 2;
    const rowsPerStatement = Math.floor((MAX_D1_QUERY_PARAMETERS - guardParameters - 1) / 3);
    const statements: SqlStatement[] = [];
    for (let start = 0; start < signals.length; start += rowsPerStatement) {
      const chunk = signals.slice(start, start + rowsPerStatement).map(signalColumns);
      const values = chunk.map(() => "(?, ?, ?)").join(", ");
      const guard =
        expectedRevision === null
          ? ""
          : "WHERE EXISTS (SELECT 1 FROM approved_components WHERE id = ? AND revision = ?)";
      statements.push(
        this.db
          .prepare(
            `INSERT INTO approved_component_signals (kind, ecosystem, value, component_id)
             SELECT column1, column2, column3, ? FROM (VALUES ${values}) ${guard}`
          )
          .bind(
            componentId,
            ...chunk.flatMap((signal) => [signal.kind, signal.ecosystem, signal.value]),
            ...(expectedRevision === null ? [] : [componentId, expectedRevision])
          )
      );
    }
    return statements;
  }

  /** Runs a component write, translating constraint failures into the conflict that caused them. */
  private async write(
    definition: ApprovedComponentDefinition,
    id: string | null,
    demote: boolean,
    statements: SqlStatement[]
  ) {
    try {
      return await this.db.batch<{ id: string }>(statements);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      await this.assertNoConflict(definition, id, demote);
      throw new ApprovedComponentConflictError(
        "Approved component conflicts with a concurrent change; reload and try again"
      );
    }
  }

  /** The 400 a write would hit: unknown category, taken name or signal, or a second standard. */
  private async assertNoConflict(
    definition: ApprovedComponentDefinition,
    id: string | null,
    demote: boolean
  ): Promise<void> {
    if (definition.categoryId !== null && !(await this.getCategory(definition.categoryId))) {
      throw new ApprovedComponentValidationError(`Unknown category ${definition.categoryId}`);
    }
    const others = (await this.list()).filter((component) => component.id !== id);
    if (
      others.some((component) => component.name.toLowerCase() === definition.name.toLowerCase())
    ) {
      throw new ApprovedComponentValidationError(
        "An approved component with this name already exists"
      );
    }
    for (const signal of definition.signals) {
      const key = stackSignalKey(signal);
      const owner = others.find((component) =>
        component.signals.some((owned) => stackSignalKey(owned) === key)
      );
      if (owner) {
        throw new ApprovedComponentValidationError(
          `Signal ${key} already identifies ${owner.name}`
        );
      }
    }
    if (!holdsPreference(definition)) return;
    const standard = others.find(
      (component) =>
        component.categoryId === definition.categoryId &&
        component.stance === "preferred" &&
        component.enabled &&
        component.lifecycle === "approved"
    );
    if (!standard) return;
    if (!demote) {
      throw new ApprovedComponentValidationError(
        `${definition.categoryId} already prefers ${standard.name}; demote it to make this the standard`
      );
    }
    if (standard.sourceKind === "git") throw new GitManagedCatalogueError(standard.name);
  }
}
