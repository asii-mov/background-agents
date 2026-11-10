import {
  type CreateMcpServerRequest,
  type McpServerLifecycle,
  mcpServerCommandSchema,
  mcpServerCredentialMapSchema,
  mcpServerTypeSchema,
  type McpServerConfig,
  type McpServerMetadata,
  type ValidatedCreateMcpServerInput,
  type ValidatedUpdateMcpServerInput,
} from "@open-inspect/shared/types/integrations";
import {
  DEFAULT_MCP_SERVER_ENABLED,
  DEFAULT_MCP_SERVER_LIFECYCLE,
} from "@open-inspect/shared/types/integrations";
import { encryptToken, decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

const log = createLogger("db:mcp-servers");

export class McpServerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerValidationError";
  }
}

export class McpServerConflictError extends Error {}

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

interface McpServerRow {
  id: string;
  revision: number;
  name: string;
  type: string;
  command: string | null;
  url: string | null;
  env: string;
  repo_scope: string | null;
  environment_scope: string | null;
  lifecycle: McpServerLifecycle;
  source_kind: "app" | "git";
  source_path: string | null;
  source_commit_sha: string | null;
  update_policy_json: string | null;
  resolved_version: string | null;
  resolved_integrity: string | null;
  artifact_key: string | null;
  artifact_sha256: string | null;
  artifact_executable: string | null;
  created_by: string;
  updated_by: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function parseScopes(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [raw];
  } catch {
    return [raw];
  }
}

function safeJsonParseCommand(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [raw];
  }
  return mcpServerCommandSchema.parse(parsed);
}

function safeJsonParseEnv(raw: string, serverId: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = mcpServerCredentialMapSchema.safeParse(parsed);
  if (result.success) return result.data;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const credentials: Record<string, string> = {};
  const rejectedKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") credentials[key] = value;
    else rejectedKeys.push(key);
  }
  if (rejectedKeys.length > 0) {
    log.warn("MCP server env entries rejected", {
      event: "mcp_server.env_entries_rejected",
      server_id: serverId,
      rejected_keys: rejectedKeys,
    });
  }
  return credentials;
}

function safeJsonParseUpdatePolicy(raw: string | null) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { automatic?: unknown; channel?: unknown; range?: unknown };
    if (parsed.automatic !== true || typeof parsed.channel !== "string") return undefined;
    return {
      automatic: true as const,
      channel: parsed.channel,
      ...(typeof parsed.range === "string" ? { range: parsed.range } : {}),
    };
  } catch {
    return undefined;
  }
}

function rowToConfig(row: McpServerRow, payload: Record<string, string>): McpServerConfig {
  const type = mcpServerTypeSchema.parse(row.type);
  const envOrHeaders: Pick<McpServerConfig, "env" | "headers"> =
    type === "remote" ? { headers: payload } : { env: payload };
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    type,
    command: type === "local" ? safeJsonParseCommand(row.command) : undefined,
    url: type === "remote" ? (row.url ?? undefined) : undefined,
    ...envOrHeaders,
    repoScopes: parseScopes(row.repo_scope),
    environmentScopes: parseScopes(row.environment_scope),
    ...(row.resolved_version ? { resolvedVersion: row.resolved_version } : {}),
    ...(row.resolved_integrity ? { resolvedIntegrity: row.resolved_integrity } : {}),
    ...(row.artifact_sha256 ? { artifactSha256: row.artifact_sha256 } : {}),
    ...(row.artifact_executable ? { artifactExecutable: row.artifact_executable } : {}),
    ...(row.source_commit_sha ? { sourceCommitSha: row.source_commit_sha } : {}),
    enabled: row.enabled === 1,
  };
}

function rowToMetadata(row: McpServerRow): McpServerMetadata {
  const type = mcpServerTypeSchema.parse(row.type);
  const hasCredentials = row.env !== "" && row.env !== "{}" && row.env !== "null";
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    type,
    command: type === "local" ? safeJsonParseCommand(row.command) : undefined,
    url: type === "remote" ? (row.url ?? undefined) : undefined,
    hasEnv: type === "local" && hasCredentials,
    hasHeaders: type === "remote" && hasCredentials,
    repoScopes: parseScopes(row.repo_scope),
    environmentScopes: parseScopes(row.environment_scope),
    lifecycle: row.lifecycle ?? "approved",
    createdBy: row.created_by ?? "system",
    updatedBy: row.updated_by ?? "system",
    sourceKind: row.source_kind ?? "app",
    ...(row.source_path ? { sourcePath: row.source_path } : {}),
    ...(row.source_commit_sha ? { sourceCommitSha: row.source_commit_sha } : {}),
    ...(safeJsonParseUpdatePolicy(row.update_policy_json)
      ? { updatePolicy: safeJsonParseUpdatePolicy(row.update_policy_json) }
      : {}),
    ...(row.resolved_version ? { resolvedVersion: row.resolved_version } : {}),
    ...(row.resolved_integrity ? { resolvedIntegrity: row.resolved_integrity } : {}),

    enabled: row.enabled === 1,
  };
}

const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function validateApprovedMcpServer(config: {
  type: "local" | "remote";
  command?: string[];
  url?: string;
  lifecycle: McpServerLifecycle;
  artifactKey?: string;
  artifactSha256?: string;
  artifactExecutable?: string;
}): void {
  if (config.lifecycle !== "approved") return;
  if (config.type === "remote") {
    if (!config.url || new URL(config.url).protocol !== "https:") {
      throw new McpServerValidationError("Approved remote MCP servers require an HTTPS URL");
    }
    return;
  }
  if (
    !config.artifactSha256 ||
    !ARTIFACT_SHA256_PATTERN.test(config.artifactSha256) ||
    config.artifactKey !== `mcp-artifacts/${config.artifactSha256}.tar.gz` ||
    !config.artifactExecutable ||
    config.artifactExecutable.includes("/") ||
    config.artifactExecutable.includes("\\")
  ) {
    throw new McpServerValidationError(
      "Approved local MCP servers must be Git-governed and launched from a verified artifact"
    );
  }
}

export class McpServerStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  /** Empty dicts are stored as plaintext "{}" so rowToMetadata() can detect "no credentials". */
  private async encryptEnv(env: Record<string, string>): Promise<string> {
    const plain = JSON.stringify(env);
    if (Object.keys(env).length === 0) return plain;
    return encryptToken(plain, this.encryptionKey);
  }

  private async decryptEnv(raw: string, rowId: string): Promise<Record<string, string>> {
    // The write side stores an empty credential map as plaintext "{}" (see
    // encryptEnv) — recognize the full credential-free sentinel set that
    // rowToMetadata classifies ("", "{}", "null") before attempting a decrypt
    // that is guaranteed to fail into the error path.
    if (!raw || raw === "{}" || raw === "null") return {};
    try {
      const plain = await decryptToken(raw, this.encryptionKey);
      return safeJsonParseEnv(plain, rowId);
    } catch {
      // Decryption failed — try plaintext fallback (pre-encryption row)
      const plaintext = safeJsonParseEnv(raw, rowId);
      if (Object.keys(plaintext).length > 0) {
        log.warn("MCP server env decryption failed — treating as pre-encryption plaintext row", {
          event: "mcp_server.env_decrypt_fallback",
        });
        return plaintext;
      }
      log.error("MCP server env decryption failed and raw value is not plaintext JSON", {
        event: "mcp_server.env_decrypt_error",
      });
      return {};
    }
  }

  private async decryptRow(row: McpServerRow): Promise<McpServerConfig> {
    const env = await this.decryptEnv(row.env, row.id);
    return rowToConfig(row, env);
  }

  async list(repoScope?: string, environmentScope?: string): Promise<McpServerMetadata[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM mcp_servers ORDER BY name")
      .all<McpServerRow>();
    const metadata = results.map(rowToMetadata);
    if (repoScope === undefined && environmentScope === undefined) return metadata;
    const normalizedRepo = repoScope?.toLowerCase();
    return metadata.filter((server) => {
      if (!server.repoScopes && !server.environmentScopes) return true;
      return (
        (normalizedRepo !== undefined &&
          (server.repoScopes?.some((scope) => scope.toLowerCase() === normalizedRepo) ?? false)) ||
        (environmentScope !== undefined && server.environmentScopes?.includes(environmentScope))
      );
    });
  }

  async get(id: string): Promise<McpServerMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    return row ? rowToMetadata(row) : null;
  }

  async create(
    config: ValidatedCreateMcpServerInput | CreateMcpServerRequest,
    actorUserId = "system"
  ): Promise<McpServerMetadata> {
    const id = generateId();
    const now = Date.now();

    if (config.type === "local" && (!config.command || config.command.length === 0)) {
      throw new McpServerValidationError("Local MCP servers require a command");
    }
    if (config.type === "remote" && !config.url) {
      throw new McpServerValidationError("remote MCP servers require a URL");
    }
    const lifecycle = config.lifecycle ?? DEFAULT_MCP_SERVER_LIFECYCLE;
    validateApprovedMcpServer({ ...config, lifecycle });

    const encryptedEnv = await this.encryptEnv(
      config.type === "remote" ? (config.headers ?? {}) : (config.env ?? {})
    );

    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO mcp_servers
           (id, name, type, command, url, env, repo_scope, environment_scope, lifecycle,
            enabled, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            config.name,
            config.type,
            config.type === "local" ? JSON.stringify(config.command) : null,
            config.type === "remote" ? config.url : null,
            encryptedEnv,
            config.repoScopes?.length
              ? JSON.stringify(config.repoScopes.map((r) => r.toLowerCase()))
              : null,
            config.environmentScopes?.length ? JSON.stringify(config.environmentScopes) : null,
            lifecycle,
            (config.enabled ?? DEFAULT_MCP_SERVER_ENABLED) ? 1 : 0,
            actorUserId,
            actorUserId,
            now,
            now
          ),
        this.revisionSnapshotInsert(id, 1),
      ]);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new McpServerValidationError(`An MCP server named '${config.name}' already exists`);
      }
      throw err;
    }

    const created = await this.get(id);
    if (!created) {
      throw new Error(`MCP server '${id}' not found after insert — this should not happen`);
    }
    return created;
  }

  async update(
    id: string,
    patch: ValidatedUpdateMcpServerInput,
    expectedRevision: number,
    actorUserId = "system"
  ): Promise<McpServerMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    if (!row) return null;
    if (row.revision !== expectedRevision) {
      throw new McpServerConflictError("MCP server changed; reload and try again");
    }

    const mergedType = patch.type ?? mcpServerTypeSchema.parse(row.type);
    if (mergedType === "local" && (patch.url !== undefined || patch.headers !== undefined)) {
      throw new McpServerValidationError("Local MCP servers do not support url or headers");
    }
    if (mergedType === "remote" && (patch.command !== undefined || patch.env !== undefined)) {
      throw new McpServerValidationError("Remote MCP servers do not support command or env");
    }

    const credentialsChanged =
      patch.env !== undefined || patch.headers !== undefined || patch.type !== undefined;

    let encryptedEnv: string;
    if (credentialsChanged) {
      const existing = await this.decryptRow(row);
      const mergedType = patch.type ?? existing.type;
      const mergedEnv = patch.env !== undefined ? patch.env : existing.env;
      const mergedHeaders = patch.headers !== undefined ? patch.headers : existing.headers;
      encryptedEnv = await this.encryptEnv(
        mergedType === "remote" ? (mergedHeaders ?? {}) : (mergedEnv ?? {})
      );
    } else {
      encryptedEnv = row.env;
    }

    const mergedCommand =
      patch.command !== undefined ? patch.command : safeJsonParseCommand(row.command);
    const mergedUrl = patch.url !== undefined ? patch.url : (row.url ?? undefined);

    if (mergedType === "local" && (!mergedCommand || mergedCommand.length === 0)) {
      throw new McpServerValidationError("Local MCP servers require a command");
    }
    if (mergedType === "remote" && !mergedUrl) {
      throw new McpServerValidationError("remote MCP servers require a URL");
    }
    const mergedLifecycle = patch.lifecycle ?? row.lifecycle ?? "approved";
    validateApprovedMcpServer({
      type: mergedType,
      command: mergedCommand,
      url: mergedUrl,
      lifecycle: mergedLifecycle,
      artifactKey: row.artifact_key ?? undefined,
      artifactSha256: row.artifact_sha256 ?? undefined,
      artifactExecutable: row.artifact_executable ?? undefined,
    });
    if (patch.type !== undefined && patch.type !== row.type) {
      const pinned = await this.db
        .prepare("SELECT 1 AS pinned FROM session_mcp_servers WHERE mcp_server_id = ? LIMIT 1")
        .bind(id)
        .first<{ pinned: number }>();
      if (pinned) {
        throw new McpServerConflictError(
          "MCP server type cannot change while an existing session pins it; create a new server"
        );
      }
    }

    const now = Date.now();

    try {
      const nextRevision = expectedRevision + 1;
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE mcp_servers SET name = ?, type = ?, command = ?, url = ?, env = ?, repo_scope = ?,
         environment_scope = ?, lifecycle = ?, enabled = ?, updated_by = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ?`
          )
          .bind(
            patch.name ?? row.name,
            mergedType,
            mergedType === "local" && mergedCommand ? JSON.stringify(mergedCommand) : null,
            mergedType === "remote" ? (mergedUrl ?? null) : null,
            encryptedEnv,
            patch.repoScopes !== undefined
              ? patch.repoScopes?.length
                ? JSON.stringify(patch.repoScopes.map((r) => r.toLowerCase()))
                : null
              : row.repo_scope,
            patch.environmentScopes !== undefined
              ? patch.environmentScopes?.length
                ? JSON.stringify(patch.environmentScopes)
                : null
              : row.environment_scope,
            mergedLifecycle,
            patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
            actorUserId,
            now,
            id,
            expectedRevision
          ),
        this.revisionSnapshotInsert(id, nextRevision),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        throw new McpServerConflictError("MCP server changed; reload and try again");
      }
      return this.get(id);
    } catch (err) {
      const latest = await this.db
        .prepare("SELECT revision FROM mcp_servers WHERE id = ?")
        .bind(id)
        .first<{ revision: number }>();
      if (latest && latest.revision !== expectedRevision) {
        throw new McpServerConflictError("MCP server changed; reload and try again");
      }
      if (isUniqueConstraintError(err)) {
        throw new McpServerValidationError(
          `An MCP server named '${patch.name ?? row.name}' already exists`
        );
      }
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    const pinned = await this.db
      .prepare("SELECT 1 AS pinned FROM session_mcp_servers WHERE mcp_server_id = ? LIMIT 1")
      .bind(id)
      .first<{ pinned: number }>();
    if (pinned) {
      throw new McpServerConflictError(
        "MCP server is pinned by an existing session; disable it instead"
      );
    }
    const result = await this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").bind(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Rotate credentials without changing the immutable runtime revision. */
  async updateCredentials(
    id: string,
    credentials: { env?: Record<string, string>; headers?: Record<string, string> },
    expectedRevision: number,
    actorUserId = "system"
  ): Promise<McpServerMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    if (!row) return null;
    if (row.revision !== expectedRevision) {
      throw new McpServerConflictError("MCP server changed; reload and try again");
    }
    if (row.type === "local" && credentials.env === undefined) {
      throw new McpServerValidationError("Local MCP servers require env credentials");
    }
    if (row.type === "remote" && credentials.headers === undefined) {
      throw new McpServerValidationError("Remote MCP servers require header credentials");
    }
    const encrypted = await this.encryptEnv(
      row.type === "local" ? (credentials.env ?? {}) : (credentials.headers ?? {})
    );
    const result = await this.db
      .prepare(
        `UPDATE mcp_servers SET env = ?, updated_by = ?, updated_at = ?
         WHERE id = ? AND revision = ?`
      )
      .bind(encrypted, actorUserId, Date.now(), id, expectedRevision)
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      throw new McpServerConflictError("MCP server changed; reload and try again");
    }
    return this.get(id);
  }

  /**
   * Servers applicable to a session's member repositories: unscoped servers
   * always apply; scoped servers apply when ANY member matches a scope.
   * Pass an empty list for repo-less sessions (unscoped servers only).
   */
  async getDecryptedForSession(
    sessionId: string,
    repositories: Array<{ repoOwner: string; repoName: string }>,
    environmentId?: string | null
  ): Promise<McpServerConfig[]> {
    return this.getDecryptedApplicableServers(sessionId, repositories, environmentId ?? null);
  }

  async getDecryptedForTarget(
    repositories: Array<{ repoOwner: string; repoName: string }>,
    environmentId?: string | null
  ): Promise<McpServerConfig[]> {
    return this.getDecryptedApplicableServers(null, repositories, environmentId ?? null);
  }

  private async getDecryptedApplicableServers(
    sessionId: string | null,
    repositories: Array<{ repoOwner: string; repoName: string }>,
    environmentId: string | null
  ): Promise<McpServerConfig[]> {
    if (sessionId) {
      const existingManifest = await this.db
        .prepare("SELECT 1 AS manifest FROM session_mcp_manifests WHERE session_id = ?")
        .bind(sessionId)
        .first<{ manifest: number }>();
      if (existingManifest) return this.getPinnedForSession(sessionId);
    }

    const repoFullNames = new Set(
      repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`.toLowerCase())
    );
    const { results } = await this.db
      .prepare(
        "SELECT * FROM mcp_servers WHERE enabled = 1 AND lifecycle = 'approved' ORDER BY name"
      )
      .all<McpServerRow>();

    const filtered = results.filter((row) => {
      const repoScopes = parseScopes(row.repo_scope);
      const environmentScopes = parseScopes(row.environment_scope);
      if (!repoScopes && !environmentScopes) return true;
      return (
        (repoScopes?.some((scope) => repoFullNames.has(scope.toLowerCase())) ?? false) ||
        (environmentId !== null && environmentScopes?.includes(environmentId))
      );
    });

    for (const row of filtered) {
      validateApprovedMcpServer({
        type: row.type as "local" | "remote",
        command: safeJsonParseCommand(row.command),
        url: row.url ?? undefined,
        lifecycle: row.lifecycle,
        artifactKey: row.artifact_key ?? undefined,
        artifactSha256: row.artifact_sha256 ?? undefined,
        artifactExecutable: row.artifact_executable ?? undefined,
      });
    }

    if (!sessionId) return Promise.all(filtered.map((r) => this.decryptRow(r)));

    const catalogState = await this.db
      .prepare("SELECT active_commit_sha FROM governance_catalog_state WHERE singleton = 1")
      .first<{ active_commit_sha: string | null }>();
    const now = Date.now();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO session_mcp_manifests
           (session_id, catalog_commit_sha, resolved_at) VALUES (?, ?, ?)`
        )
        .bind(sessionId, catalogState?.active_commit_sha ?? null, now),
      ...filtered.map((row, position) =>
        this.db
          .prepare(
            `INSERT INTO session_mcp_servers
             (session_id, position, mcp_server_id, mcp_revision, name,
              resolved_version, resolved_integrity)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            sessionId,
            position,
            row.id,
            row.revision,
            row.name,
            row.resolved_version,
            row.resolved_integrity
          )
      ),
    ]);

    return Promise.all(filtered.map((r) => this.decryptRow(r)));
  }

  private async getPinnedForSession(sessionId: string): Promise<McpServerConfig[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.*, current.env
         FROM session_mcp_servers pinned
         JOIN mcp_catalog_revisions r
           ON r.mcp_server_id = pinned.mcp_server_id AND r.revision = pinned.mcp_revision
         JOIN mcp_servers current ON current.id = pinned.mcp_server_id
         WHERE pinned.session_id = ?
         ORDER BY pinned.position`
      )
      .bind(sessionId)
      .all<McpServerRow>();
    return Promise.all(results.map((row) => this.decryptRow(row)));
  }

  async getPinnedArtifact(
    sessionId: string,
    serverId: string,
    revision: number
  ): Promise<{ key: string; sha256: string } | null> {
    const row = await this.db
      .prepare(
        `SELECT runtime.artifact_key, runtime.artifact_sha256
         FROM session_mcp_servers pinned
         JOIN mcp_catalog_revisions runtime
           ON runtime.mcp_server_id = pinned.mcp_server_id
          AND runtime.revision = pinned.mcp_revision
         WHERE pinned.session_id = ? AND pinned.mcp_server_id = ?
           AND pinned.mcp_revision = ? AND runtime.type = 'local'`
      )
      .bind(sessionId, serverId, revision)
      .first<{ artifact_key: string | null; artifact_sha256: string | null }>();
    return row?.artifact_key && row.artifact_sha256
      ? { key: row.artifact_key, sha256: row.artifact_sha256 }
      : null;
  }

  private revisionSnapshotInsert(id: string, revision: number) {
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
}
