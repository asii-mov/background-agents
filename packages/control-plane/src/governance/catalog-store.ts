import { buildValidatedSkillRevision } from "../skills/content-addressing";
import { RESERVED_SKILL_NAMES } from "../db/skills";
import { MAX_D1_QUERY_PARAMETERS } from "../db/query-limits";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import type { ParsedGovernanceCatalog } from "./catalog-schema";
import type { ResolvedMcpServer } from "./npm-resolver";

export interface GovernanceSource {
  provider: string;
  owner: string;
  name: string;
  ref: string;
  path: string;
}

export interface GovernanceCatalogStatus {
  configured: boolean;
  source?: GovernanceSource;
  activeCommitSha?: string;
  lastAttemptedAt?: number;
  lastSucceededAt?: number;
  lastStatus: "idle" | "succeeded" | "failed";
  lastError?: string;
}

interface SkillCatalogRow {
  id: string;
  name: string;
  source_kind: "app" | "git";
  source_path: string | null;
  current_revision_id: string | null;
  revision_number: number | null;
  revision_sha256: string | null;
  enabled: number;
  required: number;
  deleted_at: number | null;
}

interface McpCatalogRow {
  id: string;
  revision: number;
  name: string;
  type: "local" | "remote";
  command: string | null;
  url: string | null;
  env: string;
  repo_scope: string | null;
  environment_scope: string | null;
  lifecycle: string;
  enabled: number;
  source_kind: "app" | "git";
  source_path: string | null;
  update_policy_json: string | null;
  resolved_version: string | null;
  resolved_integrity: string | null;
  artifact_key: string | null;
  artifact_sha256: string | null;
  artifact_executable: string | null;
}

interface GovernanceStateRow {
  source_provider: string | null;
  source_repo_owner: string | null;
  source_repo_name: string | null;
  source_ref: string | null;
  source_path: string | null;
  active_commit_sha: string | null;
  last_attempted_at: number | null;
  last_succeeded_at: number | null;
  last_status: "idle" | "succeeded" | "failed";
  last_error: string | null;
}

const utf8 = new TextEncoder();

async function stableId(prefix: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
  return `${prefix}_${hex.slice(0, 32)}`;
}

function normalizeScopes(scopes: string[] | null): string | null {
  if (!scopes?.length) return null;
  return JSON.stringify([...new Set(scopes.map((scope) => scope.toLowerCase()))].sort());
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sameRuntime(
  current: McpCatalogRow,
  next: {
    name: string;
    type: "local" | "remote";
    command: string | null;
    url: string | null;
    repoScope: string | null;
    environmentScope: string | null;
    lifecycle: string;
    enabled: number;
    resolvedVersion: string | null;
    resolvedIntegrity: string | null;
    artifactKey: string | null;
    artifactSha256: string | null;
    artifactExecutable: string | null;
  }
): boolean {
  return (
    current.name === next.name &&
    current.type === next.type &&
    current.command === next.command &&
    current.url === next.url &&
    current.repo_scope === next.repoScope &&
    current.environment_scope === next.environmentScope &&
    current.lifecycle === next.lifecycle &&
    current.enabled === next.enabled &&
    current.resolved_version === next.resolvedVersion &&
    current.resolved_integrity === next.resolvedIntegrity &&
    current.artifact_key === next.artifactKey &&
    current.artifact_sha256 === next.artifactSha256 &&
    current.artifact_executable === next.artifactExecutable
  );
}

/** Atomic last-good persistence for a fully fetched, parsed, and resolved catalog. */
export class GovernanceCatalogStore {
  constructor(private readonly db: SqlDatabase) {}

  async getStatus(configuredSource?: GovernanceSource): Promise<GovernanceCatalogStatus> {
    const row = await this.db
      .prepare("SELECT * FROM governance_catalog_state WHERE singleton = 1")
      .first<GovernanceStateRow>();
    if (!row) throw new Error("Governance catalog state is missing");
    const persistedSource =
      row.source_provider &&
      row.source_repo_owner &&
      row.source_repo_name &&
      row.source_ref &&
      row.source_path
        ? {
            provider: row.source_provider,
            owner: row.source_repo_owner,
            name: row.source_repo_name,
            ref: row.source_ref,
            path: row.source_path,
          }
        : undefined;
    return {
      configured: configuredSource !== undefined,
      ...((configuredSource ?? persistedSource)
        ? { source: configuredSource ?? persistedSource }
        : {}),
      ...(row.active_commit_sha ? { activeCommitSha: row.active_commit_sha } : {}),
      ...(row.last_attempted_at ? { lastAttemptedAt: row.last_attempted_at } : {}),
      ...(row.last_succeeded_at ? { lastSucceededAt: row.last_succeeded_at } : {}),
      lastStatus: row.last_status,
      ...(row.last_error ? { lastError: row.last_error } : {}),
    };
  }

  async recordFailure(source: GovernanceSource, error: unknown, now = Date.now()): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
    await this.db
      .prepare(
        `UPDATE governance_catalog_state
         SET source_provider = ?, source_repo_owner = ?, source_repo_name = ?, source_ref = ?,
             source_path = ?, last_attempted_at = ?, last_status = 'failed', last_error = ?
         WHERE singleton = 1`
      )
      .bind(source.provider, source.owner, source.name, source.ref, source.path, now, message)
      .run();
  }

  async apply(
    source: GovernanceSource,
    catalog: ParsedGovernanceCatalog,
    resolvedMcpServers: ResolvedMcpServer[],
    now = Date.now()
  ): Promise<void> {
    const desiredMcpPaths = catalog.mcpServers.map((server) => server.sourcePath).sort();
    const resolvedMcpPaths = resolvedMcpServers.map((server) => server.sourcePath).sort();
    if (JSON.stringify(desiredMcpPaths) !== JSON.stringify(resolvedMcpPaths)) {
      throw new Error("Resolved MCP set does not match the Git catalog");
    }
    for (const skill of catalog.skills) {
      if (RESERVED_SKILL_NAMES.has(skill.name)) {
        throw new Error(`${skill.sourcePath}: skill name is reserved by the sandbox runtime`);
      }
    }
    await this.validateEnvironmentAssignments(catalog);
    const [skillsResult, mcpResult] = await Promise.all([
      this.db
        .prepare(
          `SELECT s.id, s.name, s.source_kind, s.source_path, s.current_revision_id,
                  r.revision_number, r.revision_sha256, s.enabled, s.required, s.deleted_at
           FROM skills s LEFT JOIN skill_revisions r ON r.id = s.current_revision_id`
        )
        .all<SkillCatalogRow>(),
      this.db.prepare("SELECT * FROM mcp_servers").all<McpCatalogRow>(),
    ]);
    const allSkills = skillsResult.results ?? [];
    const allMcps = mcpResult.results ?? [];
    this.rejectNameCollisions(catalog, resolvedMcpServers, allSkills, allMcps);

    const statements: SqlStatement[] = [];
    const activeSkillIds = new Set<string>();
    for (const skill of catalog.skills) {
      const current =
        allSkills.find(
          (row) => row.source_kind === "git" && row.source_path === skill.sourcePath
        ) ?? allSkills.find((row) => row.name.toLowerCase() === skill.name.toLowerCase());
      const id = current?.id ?? (await stableId("git_skill", skill.sourcePath));
      activeSkillIds.add(id);
      const validated = await buildValidatedSkillRevision(skill.name, skill.content);
      if (!current) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO skills
               (id, name, current_revision_id, enabled, required, deleted_at, created_by,
                updated_by, created_at, updated_at, source_kind, source_path, source_commit_sha)
               VALUES (?, ?, NULL, ?, ?, NULL, 'git-governance', 'git-governance', ?, ?, 'git', ?, ?)`
            )
            .bind(
              id,
              skill.name,
              skill.enabled ? 1 : 0,
              skill.required ? 1 : 0,
              now,
              now,
              skill.sourcePath,
              catalog.commitSha
            )
        );
      }
      let revisionId = current?.current_revision_id ?? null;
      if (!current || current.revision_sha256 !== validated.revisionSha256) {
        revisionId = await stableId(
          "git_skillrev",
          `${id}\0${catalog.commitSha}\0${validated.revisionSha256}`
        );
        const existingRevision = await this.db
          .prepare("SELECT id FROM skill_revisions WHERE id = ? AND skill_id = ?")
          .bind(revisionId, id)
          .first<{ id: string }>();
        if (!existingRevision) {
          const latestRevision = await this.db
            .prepare(
              "SELECT COALESCE(MAX(revision_number), 0) AS revision_number FROM skill_revisions WHERE skill_id = ?"
            )
            .bind(id)
            .first<{ revision_number: number }>();
          const revisionNumber = (latestRevision?.revision_number ?? 0) + 1;
          statements.push(
            this.db
              .prepare(
                `INSERT INTO skill_revisions
                 (id, skill_id, revision_number, revision_sha256, description, body, license,
                  compatibility, metadata_json, total_bytes, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'git-governance', ?)`
              )
              .bind(
                revisionId,
                id,
                revisionNumber,
                validated.revisionSha256,
                skill.content.description,
                skill.content.body,
                skill.content.license ?? null,
                skill.content.compatibility ?? null,
                JSON.stringify(skill.content.metadata),
                validated.totalBytes,
                now
              ),
            ...validated.files.map((file) =>
              this.db
                .prepare(
                  `INSERT INTO skill_revision_files
                   (revision_id, path, content, content_sha256, size_bytes, executable)
                   VALUES (?, ?, ?, ?, ?, ?)`
                )
                .bind(
                  revisionId,
                  file.path,
                  file.content,
                  file.sha256,
                  file.sizeBytes,
                  file.executable ? 1 : 0
                )
            )
          );
        }
      }
      statements.push(
        this.db
          .prepare(
            `UPDATE skills SET name = ?, current_revision_id = ?, enabled = ?, required = ?,
                    deleted_at = NULL, updated_by = 'git-governance', updated_at = ?,
                    source_kind = 'git', source_path = ?, source_commit_sha = ?
             WHERE id = ?`
          )
          .bind(
            skill.name,
            revisionId,
            skill.enabled ? 1 : 0,
            skill.required ? 1 : 0,
            now,
            skill.sourcePath,
            catalog.commitSha,
            id
          ),
        this.db.prepare("DELETE FROM skill_assignments WHERE skill_id = ?").bind(id)
      );
      for (const assignment of skill.assignments) {
        const assignmentKey =
          assignment.type === "global"
            ? "global"
            : assignment.type === "environment"
              ? `environment:${assignment.environmentId}`
              : `repository:${assignment.repository.repoOwner.toLowerCase()}/${assignment.repository.repoName.toLowerCase()}`;
        statements.push(
          this.db
            .prepare(
              `INSERT INTO skill_assignments
               (id, skill_id, scope_type, repo_owner, repo_name, environment_id, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'git-governance', ?)`
            )
            .bind(
              await stableId("git_skillassign", `${id}\0${assignmentKey}`),
              id,
              assignment.type,
              assignment.type === "repository" ? assignment.repository.repoOwner : null,
              assignment.type === "repository" ? assignment.repository.repoName : null,
              assignment.type === "environment" ? assignment.environmentId : null,
              now
            )
        );
      }
    }
    for (const removed of allSkills.filter(
      (row) =>
        !activeSkillIds.has(row.id) && (row.source_kind === "app" || row.source_kind === "git")
    )) {
      if (removed.enabled === 0 && removed.deleted_at !== null) continue;
      statements.push(
        this.db
          .prepare(
            `UPDATE skills SET enabled = 0, deleted_at = COALESCE(deleted_at, ?),
                    updated_by = 'git-governance', updated_at = ?, source_commit_sha = ?
             WHERE id = ?`
          )
          .bind(now, now, catalog.commitSha, removed.id),
        this.db.prepare("DELETE FROM skill_assignments WHERE skill_id = ?").bind(removed.id)
      );
    }

    const activeMcpIds = new Set<string>();
    for (const server of resolvedMcpServers) {
      const current =
        allMcps.find((row) => row.source_kind === "git" && row.source_path === server.sourcePath) ??
        allMcps.find((row) => row.name.toLowerCase() === server.name.toLowerCase());
      const id = current?.id ?? (await stableId("git_mcp", server.sourcePath));
      activeMcpIds.add(id);
      const command = server.type === "local" ? JSON.stringify(server.command) : null;
      const url = server.type === "remote" ? (server.url ?? null) : null;
      const repoScope = normalizeScopes(server.repoScopes);
      const environmentScope = normalizeScopes(server.environmentScopes);
      const enabled = server.enabled ? 1 : 0;
      const updatePolicy = server.updatePolicy ? JSON.stringify(server.updatePolicy) : null;
      const resolvedVersion = stringOrNull(server.resolvedVersion);
      const resolvedIntegrity = stringOrNull(server.resolvedIntegrity);
      const artifactKey = stringOrNull(server.artifactKey);
      const artifactSha256 = stringOrNull(server.artifactSha256);
      const artifactExecutable = stringOrNull(server.executable);
      const nextRuntime = {
        name: server.name,
        type: server.type,
        command,
        url,
        repoScope,
        environmentScope,
        lifecycle: server.lifecycle,
        enabled,
        resolvedVersion,
        resolvedIntegrity,
        artifactKey,
        artifactSha256,
        artifactExecutable,
      };
      let revision = current?.revision ?? 1;
      if (current && current.type !== server.type) {
        const pinned = await this.db
          .prepare("SELECT 1 AS pinned FROM session_mcp_servers WHERE mcp_server_id = ? LIMIT 1")
          .bind(current.id)
          .first<{ pinned: number }>();
        if (pinned) {
          throw new Error(
            `${server.sourcePath}: MCP type cannot change while an existing session pins it; use a new catalog path`
          );
        }
      }
      if (!current) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO mcp_servers
               (id, revision, name, type, command, url, env, repo_scope, environment_scope,
                lifecycle, enabled, created_by, updated_by, created_at, updated_at, source_kind,
                source_path, source_commit_sha, update_policy_json, resolved_version,
                resolved_integrity, artifact_key, artifact_sha256, artifact_executable)
               VALUES (?, 1, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'git-governance', 'git-governance',
                       ?, ?, 'git', ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              id,
              server.name,
              server.type,
              command,
              url,
              repoScope,
              environmentScope,
              server.lifecycle,
              enabled,
              now,
              now,
              server.sourcePath,
              catalog.commitSha,
              updatePolicy,
              resolvedVersion,
              resolvedIntegrity,
              artifactKey,
              artifactSha256,
              artifactExecutable
            ),
          this.mcpRevisionInsert(id, revision)
        );
      } else if (!sameRuntime(current, nextRuntime)) {
        revision++;
        statements.push(
          this.db
            .prepare(
              `UPDATE mcp_servers SET revision = ?, name = ?, type = ?, command = ?, url = ?,
                      repo_scope = ?, environment_scope = ?, lifecycle = ?, enabled = ?,
                      updated_by = 'git-governance', updated_at = ?, source_commit_sha = ?,
                      source_kind = 'git', source_path = ?, update_policy_json = ?,
                      resolved_version = ?, resolved_integrity = ?, artifact_key = ?,
                      artifact_sha256 = ?, artifact_executable = ?
               WHERE id = ? AND revision = ?`
            )
            .bind(
              revision,
              server.name,
              server.type,
              command,
              url,
              repoScope,
              environmentScope,
              server.lifecycle,
              enabled,
              now,
              catalog.commitSha,
              server.sourcePath,
              updatePolicy,
              resolvedVersion,
              resolvedIntegrity,
              artifactKey,
              artifactSha256,
              artifactExecutable,
              id,
              current.revision
            ),
          this.mcpRevisionInsert(id, revision)
        );
      } else {
        statements.push(
          this.db
            .prepare(
              `UPDATE mcp_servers SET updated_by = 'git-governance', updated_at = ?,
                      source_kind = 'git', source_path = ?, source_commit_sha = ?,
                      update_policy_json = ? WHERE id = ?`
            )
            .bind(now, server.sourcePath, catalog.commitSha, updatePolicy, id)
        );
      }
    }
    for (const removed of allMcps.filter(
      (row) => !activeMcpIds.has(row.id) && (row.source_kind === "app" || row.source_kind === "git")
    )) {
      if (removed.enabled === 0 && removed.lifecycle === "deprecated") continue;
      const revision = removed.revision + 1;
      statements.push(
        this.db
          .prepare(
            `UPDATE mcp_servers SET revision = ?, enabled = 0, lifecycle = 'deprecated',
                    updated_by = 'git-governance', updated_at = ?, source_commit_sha = ?
             WHERE id = ? AND revision = ?`
          )
          .bind(revision, now, catalog.commitSha, removed.id, removed.revision),
        this.mcpRevisionInsert(removed.id, revision)
      );
    }

    statements.push(
      this.db.prepare(
        "UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1"
      ),
      this.db
        .prepare(
          `UPDATE governance_catalog_state
           SET source_provider = ?, source_repo_owner = ?, source_repo_name = ?, source_ref = ?,
               source_path = ?, active_commit_sha = ?, last_attempted_at = ?,
               last_succeeded_at = ?, last_status = 'succeeded', last_error = NULL
           WHERE singleton = 1`
        )
        .bind(
          source.provider,
          source.owner,
          source.name,
          source.ref,
          source.path,
          catalog.commitSha,
          now,
          now
        )
    );
    await this.db.batch(statements);
  }

  private mcpRevisionInsert(id: string, revision: number): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO mcp_catalog_revisions
         (mcp_server_id, revision, name, type, command, url, repo_scope,
          environment_scope, lifecycle, enabled, source_commit_sha,
          resolved_version, resolved_integrity, artifact_key, artifact_sha256,
          artifact_executable, created_at)
         SELECT id, revision, name, type, command, url, repo_scope,
                environment_scope, lifecycle, enabled, source_commit_sha,
                resolved_version, resolved_integrity, artifact_key, artifact_sha256,
                artifact_executable, updated_at
         FROM mcp_servers WHERE id = ? AND revision = ?`
      )
      .bind(id, revision);
  }

  private rejectNameCollisions(
    catalog: ParsedGovernanceCatalog,
    mcps: ResolvedMcpServer[],
    existingSkills: SkillCatalogRow[],
    existingMcps: McpCatalogRow[]
  ): void {
    for (const desired of catalog.skills) {
      const pathOwner = existingSkills.find(
        (row) => row.source_kind === "git" && row.source_path === desired.sourcePath
      );
      const sameName = existingSkills.filter(
        (row) => row.name.toLowerCase() === desired.name.toLowerCase()
      );
      const collision = pathOwner
        ? sameName.find((row) => row.id !== pathOwner.id)
        : sameName.length > 1
          ? sameName[1]
          : undefined;
      if (collision) throw new Error(`Skill name '${desired.name}' is already managed elsewhere`);
    }
    for (const desired of mcps) {
      const pathOwner = existingMcps.find(
        (row) => row.source_kind === "git" && row.source_path === desired.sourcePath
      );
      const sameName = existingMcps.filter(
        (row) => row.name.toLowerCase() === desired.name.toLowerCase()
      );
      const collision = pathOwner
        ? sameName.find((row) => row.id !== pathOwner.id)
        : sameName.length > 1
          ? sameName[1]
          : undefined;
      if (collision)
        throw new Error(`MCP server name '${desired.name}' is already managed elsewhere`);
    }
  }

  private async validateEnvironmentAssignments(catalog: ParsedGovernanceCatalog): Promise<void> {
    const ids = [
      ...new Set(
        catalog.skills.flatMap((skill) =>
          skill.assignments.flatMap((assignment) =>
            assignment.type === "environment" ? [assignment.environmentId] : []
          )
        )
      ),
    ];
    let found = 0;
    for (let start = 0; start < ids.length; start += MAX_D1_QUERY_PARAMETERS) {
      const chunk = ids.slice(start, start + MAX_D1_QUERY_PARAMETERS);
      const result = await this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM environments WHERE id IN (${chunk.map(() => "?").join(",")})`
        )
        .bind(...chunk)
        .first<{ count: number }>();
      found += result?.count ?? 0;
    }
    if (found !== ids.length) throw new Error("One or more assigned environments do not exist");
  }
}
