import {
  securityPipelineCommandSchema,
  type CreateSecurityPipelineInput,
  type SecurityPipelineConfig,
  type SecurityPipelineMetadata,
  type ValidatedCreateSecurityPipelineInput,
  type ValidatedUpdateSecurityPipelineInput,
} from "@open-inspect/shared/types/security-pipelines";
import { generateId } from "../auth/crypto";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

interface SecurityPipelineRow {
  id: string;
  revision: number;
  name: string;
  commands_json: string;
  repo_scope: string | null;
  environment_scope: string | null;
  enabled: number;
  blocking: number;
  max_remediation_attempts: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

function parseScopes(raw: string | null): string[] | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("Invalid persisted security pipeline scope");
  }
  return parsed;
}

function toMetadata(row: SecurityPipelineRow): SecurityPipelineMetadata {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    commands: securityPipelineCommandSchema.array().parse(JSON.parse(row.commands_json)),
    repoScopes: parseScopes(row.repo_scope),
    environmentScopes: parseScopes(row.environment_scope),
    enabled: row.enabled === 1,
    blocking: row.blocking === 1,
    maxRemediationAttempts: row.max_remediation_attempts,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SecurityPipelineConflictError extends Error {}
export class SecurityPipelineValidationError extends Error {}

export class SecurityPipelineStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<SecurityPipelineMetadata[]> {
    const result = await this.db
      .prepare("SELECT * FROM security_pipelines ORDER BY name")
      .all<SecurityPipelineRow>();
    return (result.results ?? []).map(toMetadata);
  }

  async get(id: string): Promise<SecurityPipelineMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM security_pipelines WHERE id = ?")
      .bind(id)
      .first<SecurityPipelineRow>();
    return row ? toMetadata(row) : null;
  }

  async create(
    input: ValidatedCreateSecurityPipelineInput | CreateSecurityPipelineInput,
    actorUserId: string
  ): Promise<SecurityPipelineMetadata> {
    const id = `pipeline_${generateId()}`;
    const now = Date.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO security_pipelines
           (id, revision, name, commands_json, repo_scope, environment_scope, enabled, blocking,
            max_remediation_attempts, created_by, updated_by, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.name,
          JSON.stringify(input.commands),
          input.repoScopes?.length
            ? JSON.stringify(input.repoScopes.map((scope) => scope.toLowerCase()))
            : null,
          input.environmentScopes?.length ? JSON.stringify(input.environmentScopes) : null,
          (input.enabled ?? true) ? 1 : 0,
          (input.blocking ?? true) ? 1 : 0,
          input.maxRemediationAttempts ?? 2,
          actorUserId,
          actorUserId,
          now,
          now
        )
        .run();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new SecurityPipelineValidationError(
          "A security pipeline with this name already exists"
        );
      }
      throw error;
    }
    const created = await this.get(id);
    if (!created) {
      throw new Error(`Security pipeline ${id} is missing after creation`);
    }
    return created;
  }

  async update(
    id: string,
    patch: ValidatedUpdateSecurityPipelineInput,
    expectedRevision: number,
    actorUserId: string
  ): Promise<SecurityPipelineMetadata | null> {
    const current = await this.get(id);
    if (!current) return null;
    if (expectedRevision !== current.revision) {
      throw new SecurityPipelineConflictError("Security pipeline changed; reload and try again");
    }
    const now = Date.now();
    try {
      const updated = await this.db
        .prepare(
          `UPDATE security_pipelines SET
             name = ?, commands_json = ?, repo_scope = ?, environment_scope = ?, enabled = ?,
             blocking = ?, max_remediation_attempts = ?, updated_by = ?, updated_at = ?,
             revision = revision + 1
           WHERE id = ? AND revision = ?
           RETURNING *`
        )
        .bind(
          patch.name ?? current.name,
          JSON.stringify(patch.commands ?? current.commands),
          patch.repoScopes === undefined
            ? current.repoScopes
              ? JSON.stringify(current.repoScopes)
              : null
            : patch.repoScopes?.length
              ? JSON.stringify(patch.repoScopes.map((scope) => scope.toLowerCase()))
              : null,
          patch.environmentScopes === undefined
            ? current.environmentScopes
              ? JSON.stringify(current.environmentScopes)
              : null
            : patch.environmentScopes?.length
              ? JSON.stringify(patch.environmentScopes)
              : null,
          (patch.enabled ?? current.enabled) ? 1 : 0,
          (patch.blocking ?? current.blocking) ? 1 : 0,
          patch.maxRemediationAttempts ?? current.maxRemediationAttempts,
          actorUserId,
          now,
          id,
          expectedRevision
        )
        .first<SecurityPipelineRow>();
      if (!updated) {
        throw new SecurityPipelineConflictError("Security pipeline changed; reload and try again");
      }
      return toMetadata(updated);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new SecurityPipelineValidationError(
          "A security pipeline with this name already exists"
        );
      }
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM security_pipelines WHERE id = ?")
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async getForSession(
    repositories: Array<{ repoOwner: string; repoName: string }>,
    environmentId: string | null
  ): Promise<SecurityPipelineConfig[]> {
    const repositoryNames = new Set(
      repositories.map(({ repoOwner, repoName }) => `${repoOwner}/${repoName}`.toLowerCase())
    );
    return (await this.list())
      .map((pipeline): SecurityPipelineConfig | null => {
        if (!pipeline.enabled) return null;
        const environmentMatches =
          environmentId !== null && pipeline.environmentScopes?.includes(environmentId) === true;
        const matchingRepoScopes =
          pipeline.repoScopes?.filter((scope) => repositoryNames.has(scope.toLowerCase())) ?? [];
        const global = !pipeline.repoScopes && !pipeline.environmentScopes;
        if (!global && !environmentMatches && matchingRepoScopes.length === 0) return null;

        return {
          id: pipeline.id,
          name: pipeline.name,
          commands: pipeline.commands,
          blocking: pipeline.blocking,
          maxRemediationAttempts: pipeline.maxRemediationAttempts,
          // A global or environment match applies to every repository in the
          // environment. A repo-only match remains narrowed at runtime so a
          // multi-repo sandbox executes the command from the right checkout.
          repoScopes: global || environmentMatches ? null : matchingRepoScopes,
        };
      })
      .filter((pipeline): pipeline is SecurityPipelineConfig => pipeline !== null);
  }
}
