import type {
  ApprovedComponent,
  ApprovedComponentConsumer,
  ApprovedComponentDefinition,
  CreateApprovedComponentInput,
} from "@open-inspect/shared/types/approved-components";
import { createApprovedComponentSchema } from "@open-inspect/shared/types/approved-components";
import { generateId } from "../auth/crypto";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

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

interface SessionScopeRow {
  repo_owner: string | null;
  repo_name: string | null;
  environment_id: string | null;
}

function parseScopes(raw: string | null): string[] | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid approved component scope");
  }
  return parsed;
}

function toComponent(row: ApprovedComponentRow): ApprovedComponent {
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
    // Until the stack-policy columns exist, every row is a plain API-owned catalogue entry.
    categoryId: null,
    stance: "allowed",
    signals: [],
    sourceKind: "app",
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

export class ApprovedComponentConflictError extends Error {}
export class ApprovedComponentValidationError extends Error {}
const MAX_SESSION_COMPONENT_RESULTS = 100;

export class ApprovedComponentStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<ApprovedComponent[]> {
    const result = await this.db
      .prepare("SELECT * FROM approved_components ORDER BY name")
      .all<ApprovedComponentRow>();
    return (result.results ?? []).map(toComponent);
  }

  async get(id: string): Promise<ApprovedComponent | null> {
    const row = await this.db
      .prepare("SELECT * FROM approved_components WHERE id = ?")
      .bind(id)
      .first<ApprovedComponentRow>();
    return row ? toComponent(row) : null;
  }

  async create(
    input: CreateApprovedComponentInput,
    actorUserId: string
  ): Promise<ApprovedComponent> {
    const definition = createApprovedComponentSchema.parse(input);
    const id = `component_${generateId()}`;
    const now = Date.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO approved_components
           (id, revision, name, kind, description, owner, locator, version, integrity, source_url,
            documentation_url, usage, lifecycle, repo_scope, environment_scope, enabled,
            created_by, updated_by, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
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
          actorUserId,
          actorUserId,
          now,
          now
        )
        .run();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ApprovedComponentValidationError(
          "An approved component with this name already exists"
        );
      }
      throw error;
    }
    const created = await this.get(id);
    if (!created) {
      throw new Error(`Approved component ${id} is missing after creation`);
    }
    return created;
  }

  async update(
    id: string,
    definition: ApprovedComponentDefinition,
    expectedRevision: number,
    actorUserId: string
  ): Promise<ApprovedComponent | null> {
    const current = await this.get(id);
    if (!current) return null;
    if (current.revision !== expectedRevision) {
      throw new ApprovedComponentConflictError("Approved component changed; reload and try again");
    }
    const validated = createApprovedComponentSchema.parse(definition);
    const now = Date.now();
    try {
      const row = await this.db
        .prepare(
          `UPDATE approved_components SET
             name = ?, kind = ?, description = ?, owner = ?, locator = ?, version = ?,
             integrity = ?, source_url = ?, documentation_url = ?, usage = ?, lifecycle = ?,
             repo_scope = ?, environment_scope = ?, enabled = ?, updated_by = ?, updated_at = ?,
             revision = revision + 1
           WHERE id = ? AND revision = ? RETURNING *`
        )
        .bind(
          validated.name,
          validated.kind,
          validated.description,
          validated.owner,
          validated.locator,
          validated.version,
          validated.integrity,
          validated.sourceUrl,
          validated.documentationUrl,
          validated.usage,
          validated.lifecycle,
          scopesJson(validated.repoScopes, true),
          scopesJson(validated.environmentScopes, false),
          validated.enabled ? 1 : 0,
          actorUserId,
          now,
          id,
          expectedRevision
        )
        .first<ApprovedComponentRow>();
      if (!row) {
        throw new ApprovedComponentConflictError(
          "Approved component changed; reload and try again"
        );
      }
      return toComponent(row);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ApprovedComponentValidationError(
          "An approved component with this name already exists"
        );
      }
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const current = await this.get(id);
    if (!current) return false;
    if (current.lifecycle !== "development") {
      throw new ApprovedComponentValidationError(
        "Approved or deprecated components must be retained for consumer discovery"
      );
    }
    const result = await this.db
      .prepare("DELETE FROM approved_components WHERE id = ? AND lifecycle = 'development'")
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async listForSession(sessionId: string, query = ""): Promise<ApprovedComponent[]> {
    const scope = await this.sessionScope(sessionId);
    if (!scope) return [];
    const repositoryNames = new Set(
      scope.repositories.map(({ repoOwner, repoName }) => `${repoOwner}/${repoName}`.toLowerCase())
    );
    const normalizedQuery = query.trim().toLowerCase();
    return (await this.list())
      .filter((component) => {
        if (!component.enabled || component.lifecycle !== "approved") return false;
        const global = !component.repoScopes && !component.environmentScopes;
        const scoped =
          (component.repoScopes?.some((entry) => repositoryNames.has(entry.toLowerCase())) ??
            false) ||
          (scope.environmentId !== null &&
            component.environmentScopes?.includes(scope.environmentId) === true);
        if (!global && !scoped) return false;
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

  async recordConsumption(
    sessionId: string,
    componentId: string,
    repository: { repoOwner: string; repoName: string }
  ): Promise<ApprovedComponentConsumer | null> {
    const [scope, applicable] = await Promise.all([
      this.sessionScope(sessionId),
      this.listForSession(sessionId),
    ]);
    if (!scope) return null;
    const member = scope.repositories.find(
      (entry) =>
        entry.repoOwner.toLowerCase() === repository.repoOwner.toLowerCase() &&
        entry.repoName.toLowerCase() === repository.repoName.toLowerCase()
    );
    if (!member)
      throw new ApprovedComponentValidationError("Repository is not part of the session");
    const component = applicable.find((entry) => entry.id === componentId);
    if (!component) {
      throw new ApprovedComponentValidationError(
        "Component is not approved and applicable to this session"
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

  async listConsumers(componentId: string): Promise<ApprovedComponentConsumer[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM approved_component_consumers WHERE component_id = ? ORDER BY repo_owner, repo_name"
      )
      .bind(componentId)
      .all<ConsumerRow>();
    return (result.results ?? []).map(toConsumer);
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

  private async sessionScope(sessionId: string): Promise<{
    repositories: Array<{ repoOwner: string; repoName: string }>;
    environmentId: string | null;
  } | null> {
    const session = await this.db
      .prepare("SELECT repo_owner, repo_name, environment_id FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<SessionScopeRow>();
    if (!session) return null;
    const members = await this.db
      .prepare(
        `SELECT repo_owner, repo_name FROM session_repositories
         WHERE session_id = ? ORDER BY position`
      )
      .bind(sessionId)
      .all<{ repo_owner: string; repo_name: string }>();
    const repositories = (members.results ?? []).map((entry) => ({
      repoOwner: entry.repo_owner,
      repoName: entry.repo_name,
    }));
    if (repositories.length === 0 && session.repo_owner && session.repo_name) {
      repositories.push({ repoOwner: session.repo_owner, repoName: session.repo_name });
    }
    return { repositories, environmentId: session.environment_id };
  }
}
