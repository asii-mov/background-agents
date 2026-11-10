/**
 * The only writer of app_data_profiles, app_data_resources, app_data_migrations,
 * app_data_secrets and app_data_operations. The operations table is the data audit log, so every
 * mutation here writes its ledger row in the same batch, guarded by the same predicate as the
 * change: a ledger row exists exactly when the change applied.
 *
 * Secrets reuse the scoped-secrets plumbing (validation, caps, REPO_SECRETS_ENCRYPTION_KEY), keyed
 * by (app, stage, key) so a preview can never read a production value.
 */

import type { AppResourceName } from "@open-inspect/shared/app-broker";
import type {
  AppDataInventoryRow,
  AppDataOperationView,
  AppStage,
  BindingName,
  DataClassification,
  DataOperationKind,
  DataStoreKind,
  MigrationStatus,
  ResourceStatus,
} from "@open-inspect/shared/types/app-data";
import {
  assertScopeKeyCapacity,
  decryptSecretRows,
  encryptSecretEntries,
  prepareSecretsForWrite,
} from "./scoped-secrets";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export interface AppDataProfile {
  appName: string;
  classification: DataClassification;
  classificationSource: "manifest" | "admin";
  declaredSecrets: readonly BindingName[];
  updatedBy: string;
  updatedAt: number;
}

export type RetireReason = "takedown" | "binding_removed";

export interface AppDataResource {
  id: string;
  appName: string;
  stage: AppStage;
  binding: BindingName;
  kind: DataStoreKind;
  providerName: AppResourceName;
  /** D1 uuid, KV namespace id or R2 bucket name; null while provisioning. */
  providerRef: string | null;
  status: ResourceStatus;
  sizeBytes: number | null;
  retiredAt: number | null;
  retireReason: RetireReason | null;
  purgeAfter: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AppDataMigration {
  resourceId: string;
  name: string;
  sha256: string;
  status: MigrationStatus;
  classification: "additive" | "destructive";
  statements: readonly string[];
  bookmarkBefore: string | null;
  approvedBy: string | null;
  approvedAt: number | null;
  appliedAt: number | null;
  error: string | null;
  updatedAt: number;
}

export type MigrationWrite = Omit<AppDataMigration, "resourceId" | "updatedAt">;

/** Who acted. Sessions deploy; users manage; the system purges. */
export type OperationActor =
  | { kind: "session"; sessionId: string; userId: string | null; requestId: string }
  | { kind: "user"; userId: string; requestId?: string }
  | { kind: "system"; job: string };

export interface OperationInput {
  kind: DataOperationKind;
  result: "applied" | "blocked" | "failed";
  stage: AppStage | null;
  resourceId?: string | null;
  binding?: BindingName | null;
  actor: OperationActor;
  /** Secret-free by construction of the callers: names, reasons, bookmarks. */
  detail: Record<string, unknown>;
}

/** A position in a newest-first listing: the last row's timestamp and id. */
export interface KeysetCursor {
  at: number;
  id: string;
}

export type InventoryStatusFilter = "live" | "retired" | "purged";

const INVENTORY_STATUSES: Record<InventoryStatusFilter, readonly ResourceStatus[]> = {
  live: ["provisioning", "ready"],
  retired: ["retired", "purging"],
  purged: ["purged"],
};

interface ProfileRow {
  app_name: string;
  classification: DataClassification;
  classification_source: "manifest" | "admin";
  declared_secrets_json: string;
  updated_by: string;
  updated_at: number;
}

interface ResourceRow {
  id: string;
  app_name: string;
  stage: AppStage;
  binding_name: string;
  kind: DataStoreKind;
  provider_name: string;
  provider_ref: string | null;
  status: ResourceStatus;
  size_bytes: number | null;
  retired_at: number | null;
  retire_reason: RetireReason | null;
  purge_after: number | null;
  created_at: number;
  updated_at: number;
}

interface MigrationRow {
  resource_id: string;
  name: string;
  sha256: string;
  status: MigrationStatus;
  classification: "additive" | "destructive";
  statements_json: string;
  bookmark_before: string | null;
  approved_by: string | null;
  approved_at: number | null;
  applied_at: number | null;
  error: string | null;
  updated_at: number;
}

interface OperationRow {
  id: string;
  kind: DataOperationKind;
  result: "applied" | "blocked" | "failed";
  stage: AppStage | null;
  binding_name: string | null;
  actor_kind: "session" | "user" | "system";
  actor_user_id: string | null;
  actor_session_id: string | null;
  actor_job: string | null;
  detail_json: string;
  occurred_at: number;
}

const RESOURCE_COLUMNS = `id, app_name, stage, binding_name, kind, provider_name, provider_ref, status,
  size_bytes, retired_at, retire_reason, purge_after, created_at, updated_at`;

function toResource(row: ResourceRow): AppDataResource {
  return {
    id: row.id,
    appName: row.app_name,
    stage: row.stage,
    binding: row.binding_name as BindingName,
    kind: row.kind,
    providerName: row.provider_name as AppResourceName,
    providerRef: row.provider_ref,
    status: row.status,
    sizeBytes: row.size_bytes,
    retiredAt: row.retired_at,
    retireReason: row.retire_reason,
    purgeAfter: row.purge_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMigration(row: MigrationRow): AppDataMigration {
  return {
    resourceId: row.resource_id,
    name: row.name,
    sha256: row.sha256,
    status: row.status,
    classification: row.classification,
    statements: JSON.parse(row.statements_json) as string[],
    bookmarkBefore: row.bookmark_before,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    appliedAt: row.applied_at,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

function toOperationView(row: OperationRow): AppDataOperationView {
  const actor: AppDataOperationView["actor"] =
    row.actor_kind === "session"
      ? { kind: "session", sessionId: row.actor_session_id!, userId: row.actor_user_id }
      : row.actor_kind === "user"
        ? { kind: "user", userId: row.actor_user_id! }
        : { kind: "system", job: row.actor_job! };
  return {
    id: row.id,
    kind: row.kind,
    result: row.result,
    stage: row.stage,
    binding: row.binding_name as BindingName | null,
    actor,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    occurredAt: row.occurred_at,
  };
}

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

export class AppDataStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  // ---- Ledger ---------------------------------------------------------------------------------

  private operationValues(appName: string, op: OperationInput, now: number): unknown[] {
    const { actor } = op;
    return [
      crypto.randomUUID(),
      appName,
      op.stage,
      op.resourceId ?? null,
      op.binding ?? null,
      op.kind,
      op.result,
      actor.kind,
      actor.kind === "system" ? null : actor.userId,
      actor.kind === "session" ? actor.sessionId : null,
      actor.kind === "system" ? actor.job : null,
      actor.kind === "system" ? null : (actor.requestId ?? null),
      JSON.stringify(op.detail),
      now,
    ];
  }

  private static readonly OPERATION_COLUMNS = `(id, app_name, stage, resource_id, binding_name, kind,
    result, actor_kind, actor_user_id, actor_session_id, actor_job, request_id, detail_json, occurred_at)`;

  private insertOperation(appName: string, op: OperationInput, now: number): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO app_data_operations ${AppDataStore.OPERATION_COLUMNS} VALUES (${placeholders(14)})`
      )
      .bind(...this.operationValues(appName, op, now));
  }

  /** The ledger row, written only when `guard` (an EXISTS subquery) holds in the same batch. */
  private insertOperationWhere(
    appName: string,
    op: OperationInput,
    now: number,
    guard: { sql: string; binds: readonly unknown[] }
  ): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO app_data_operations ${AppDataStore.OPERATION_COLUMNS}
         SELECT ${placeholders(14)} WHERE EXISTS (${guard.sql})`
      )
      .bind(...this.operationValues(appName, op, now), ...guard.binds);
  }

  async appendOperation(appName: string, op: OperationInput, now: number): Promise<void> {
    await this.insertOperation(appName, op, now).run();
  }

  /** Newest first, keyset-paginated on (occurred_at, id). */
  async listOperations(
    appName: string,
    cursor: KeysetCursor | null,
    limit: number
  ): Promise<{ operations: AppDataOperationView[]; nextCursor: KeysetCursor | null }> {
    const after = cursor ? "AND (occurred_at < ? OR (occurred_at = ? AND id < ?))" : "";
    const binds = cursor ? [cursor.at, cursor.at, cursor.id] : [];
    const rows = await this.db
      .prepare(
        `SELECT id, kind, result, stage, binding_name, actor_kind, actor_user_id, actor_session_id,
                actor_job, detail_json, occurred_at
         FROM app_data_operations WHERE app_name = ? ${after}
         ORDER BY occurred_at DESC, id DESC LIMIT ?`
      )
      .bind(appName, ...binds, limit + 1)
      .all<OperationRow>();
    const page = rows.results.slice(0, limit);
    const last = page.at(-1);
    return {
      operations: page.map(toOperationView),
      nextCursor:
        rows.results.length > limit && last ? { at: last.occurred_at, id: last.id } : null,
    };
  }

  // ---- Profile --------------------------------------------------------------------------------

  async getProfile(appName: string): Promise<AppDataProfile | null> {
    const row = await this.db
      .prepare(
        `SELECT app_name, classification, classification_source, declared_secrets_json, updated_by,
                updated_at
         FROM app_data_profiles WHERE app_name = ?`
      )
      .bind(appName)
      .first<ProfileRow>();
    return row
      ? {
          appName: row.app_name,
          classification: row.classification,
          classificationSource: row.classification_source,
          declaredSecrets: JSON.parse(row.declared_secrets_json) as BindingName[],
          updatedBy: row.updated_by,
          updatedAt: row.updated_at,
        }
      : null;
  }

  /** What the deployed manifest says. An administrator's classification is never overwritten. */
  async recordManifest(
    appName: string,
    manifest: { classification: DataClassification; declaredSecrets: readonly BindingName[] },
    by: string,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO app_data_profiles
           (app_name, classification, classification_source, declared_secrets_json, updated_by,
            created_at, updated_at)
         VALUES (?, ?, 'manifest', ?, ?, ?, ?)
         ON CONFLICT (app_name) DO UPDATE SET
           classification = CASE WHEN app_data_profiles.classification_source = 'admin'
             THEN app_data_profiles.classification ELSE excluded.classification END,
           declared_secrets_json = excluded.declared_secrets_json,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .bind(
        appName,
        manifest.classification,
        JSON.stringify([...manifest.declaredSecrets].sort()),
        by,
        now,
        now
      )
      .run();
  }

  /** An administrator's label: the manifest can no longer change it. */
  async classify(
    appName: string,
    classification: DataClassification,
    op: OperationInput & { actor: { kind: "user" } },
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO app_data_profiles
             (app_name, classification, classification_source, declared_secrets_json, updated_by,
              created_at, updated_at)
           VALUES (?, ?, 'admin', '[]', ?, ?, ?)
           ON CONFLICT (app_name) DO UPDATE SET
             classification = excluded.classification,
             classification_source = 'admin',
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        )
        .bind(appName, classification, op.actor.userId, now, now),
      this.insertOperation(appName, op, now),
    ]);
  }

  // ---- Resources ------------------------------------------------------------------------------

  async listResources(appName: string, stage?: AppStage): Promise<AppDataResource[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${RESOURCE_COLUMNS} FROM app_data_resources
         WHERE app_name = ? ${stage ? "AND stage = ?" : ""}
         ORDER BY stage, binding_name, created_at, id`
      )
      .bind(appName, ...(stage ? [stage] : []))
      .all<ResourceRow>();
    return rows.results.map(toResource);
  }

  /**
   * Claim the binding: the row is inserted unless a live one exists (the partial unique index
   * decides), then the live row is read back, so concurrent deploys converge on one row. Null when
   * the provider name is held by another row that is not purged.
   */
  async insertProvisioning(input: {
    appName: string;
    stage: AppStage;
    binding: BindingName;
    kind: DataStoreKind;
    providerName: AppResourceName;
    now: number;
  }): Promise<AppDataResource | null> {
    await this.db
      .prepare(
        `INSERT INTO app_data_resources
           (id, app_name, stage, binding_name, kind, provider_name, provider_ref, status,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'provisioning', ?, ?)
         ON CONFLICT DO NOTHING`
      )
      .bind(
        crypto.randomUUID(),
        input.appName,
        input.stage,
        input.binding,
        input.kind,
        input.providerName,
        input.now,
        input.now
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT ${RESOURCE_COLUMNS} FROM app_data_resources
         WHERE app_name = ? AND stage = ? AND binding_name = ? AND status IN ('provisioning', 'ready')`
      )
      .bind(input.appName, input.stage, input.binding)
      .first<ResourceRow>();
    return row && row.provider_name === input.providerName ? toResource(row) : null;
  }

  /** One guarded transition plus its ledger row, atomically. True when the transition applied. */
  private async transition(
    resource: AppDataResource,
    from: readonly ResourceStatus[],
    set: { sql: string; binds: readonly unknown[] },
    op: OperationInput | null,
    now: number
  ): Promise<boolean> {
    const guard = {
      sql: `SELECT 1 FROM app_data_resources WHERE id = ? AND status IN (${placeholders(from.length)})`,
      binds: [resource.id, ...from],
    };
    const update = this.db
      .prepare(
        `UPDATE app_data_resources SET ${set.sql}, updated_at = ?
         WHERE id = ? AND status IN (${placeholders(from.length)})`
      )
      .bind(...set.binds, now, resource.id, ...from);
    const statements = op
      ? [this.insertOperationWhere(resource.appName, op, now, guard), update]
      : [update];
    const results = await this.db.batch(statements);
    return (results.at(-1)?.meta.changes ?? 0) > 0;
  }

  markReady(
    resource: AppDataResource,
    providerRef: string,
    op: OperationInput | null,
    now: number
  ): Promise<boolean> {
    return this.transition(
      resource,
      ["provisioning"],
      { sql: "status = 'ready', provider_ref = ?", binds: [providerRef] },
      op,
      now
    );
  }

  retire(
    resource: AppDataResource,
    retirement: { reason: RetireReason; purgeAfter: number },
    op: OperationInput,
    now: number
  ): Promise<boolean> {
    return this.transition(
      resource,
      ["ready"],
      {
        sql: "status = 'retired', retired_at = ?, retire_reason = ?, purge_after = ?",
        binds: [now, retirement.reason, retirement.purgeAfter],
      },
      op,
      now
    );
  }

  /** retired -> ready. Never from purging: its data is already being deleted. */
  reinstate(resource: AppDataResource, op: OperationInput, now: number): Promise<boolean> {
    return this.transition(
      resource,
      ["retired"],
      {
        sql: "status = 'ready', retired_at = NULL, retire_reason = NULL, purge_after = NULL",
        binds: [],
      },
      op,
      now
    );
  }

  /** Retired rows past their window, and purges a previous sweep left unfinished. */
  async listPurgeDue(now: number, limit: number): Promise<AppDataResource[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${RESOURCE_COLUMNS} FROM app_data_resources
         WHERE status IN ('retired', 'purging') AND purge_after <= ?
         ORDER BY purge_after, id LIMIT ?`
      )
      .bind(now, limit)
      .all<ResourceRow>();
    return rows.results.map(toResource);
  }

  /** retired -> purging: from here a deploy can no longer reinstate the resource. */
  claimPurge(resource: AppDataResource, now: number): Promise<boolean> {
    return this.transition(
      resource,
      ["retired", "purging"],
      { sql: "status = 'purging'", binds: [] },
      null,
      now
    );
  }

  markPurged(resource: AppDataResource, op: OperationInput, now: number): Promise<boolean> {
    return this.transition(
      resource,
      ["purging"],
      { sql: "status = 'purged', purged_at = ?", binds: [now] },
      op,
      now
    );
  }

  // ---- Migrations -----------------------------------------------------------------------------

  async listMigrations(resourceIds: readonly string[]): Promise<AppDataMigration[]> {
    if (resourceIds.length === 0) return [];
    const rows = await this.db
      .prepare(
        `SELECT resource_id, name, sha256, status, classification, statements_json, bookmark_before,
                approved_by, approved_at, applied_at, error, updated_at
         FROM app_data_migrations WHERE resource_id IN (${placeholders(resourceIds.length)})
         ORDER BY resource_id, name`
      )
      .bind(...resourceIds)
      .all<MigrationRow>();
    return rows.results.map(toMigration);
  }

  /** Upsert by (resource, name). An applied row is immutable: the write leaves it untouched. */
  async writeMigration(
    resource: AppDataResource,
    migration: MigrationWrite,
    op: OperationInput | null,
    now: number
  ): Promise<void> {
    const upsert = this.db
      .prepare(
        `INSERT INTO app_data_migrations
           (resource_id, name, sha256, status, classification, statements_json, bookmark_before,
            approved_by, approved_at, applied_at, error, created_at, updated_at)
         VALUES (${placeholders(13)})
         ON CONFLICT (resource_id, name) DO UPDATE SET
           sha256 = excluded.sha256,
           status = excluded.status,
           classification = excluded.classification,
           statements_json = excluded.statements_json,
           bookmark_before = excluded.bookmark_before,
           approved_by = excluded.approved_by,
           approved_at = excluded.approved_at,
           applied_at = excluded.applied_at,
           error = excluded.error,
           updated_at = excluded.updated_at
         WHERE app_data_migrations.status <> 'applied'`
      )
      .bind(
        resource.id,
        migration.name,
        migration.sha256,
        migration.status,
        migration.classification,
        JSON.stringify(migration.statements),
        migration.bookmarkBefore,
        migration.approvedBy,
        migration.approvedAt,
        migration.appliedAt,
        migration.error,
        now,
        now
      );
    await this.db.batch(op ? [upsert, this.insertOperation(resource.appName, op, now)] : [upsert]);
  }

  /** blocked -> approved, only for the exact bytes the approver reviewed. */
  async approveMigration(
    resource: AppDataResource,
    approval: { name: string; sha256: string; by: string },
    op: OperationInput,
    now: number
  ): Promise<boolean> {
    const where = "resource_id = ? AND name = ? AND sha256 = ? AND status = 'blocked'";
    const binds = [resource.id, approval.name, approval.sha256];
    const results = await this.db.batch([
      this.insertOperationWhere(resource.appName, op, now, {
        sql: `SELECT 1 FROM app_data_migrations WHERE ${where}`,
        binds,
      }),
      this.db
        .prepare(
          `UPDATE app_data_migrations
           SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
           WHERE ${where}`
        )
        .bind(approval.by, now, now, ...binds),
    ]);
    return (results[1]?.meta.changes ?? 0) > 0;
  }

  // ---- Secrets --------------------------------------------------------------------------------

  /** Validates, caps and encrypts like every scoped secret; throws SecretsValidationError. */
  async setSecrets(
    appName: string,
    stage: AppStage,
    secrets: Record<string, string>,
    op: OperationInput,
    now: number
  ): Promise<string[]> {
    const normalized = prepareSecretsForWrite(secrets);
    const existing = new Set((await this.secretKeys(appName, stage)).map((entry) => entry.name));
    const keys = Object.keys(normalized).sort();
    assertScopeKeyCapacity("App", existing, keys);
    const { entries } = await encryptSecretEntries(normalized, existing, this.encryptionKey);
    await this.db.batch([
      ...entries.map((entry) =>
        this.db
          .prepare(
            `INSERT INTO app_data_secrets
               (app_name, stage, key, encrypted_value, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (app_name, stage, key) DO UPDATE SET
               encrypted_value = excluded.encrypted_value,
               updated_at = excluded.updated_at`
          )
          .bind(appName, stage, entry.key, entry.encryptedValue, now, now)
      ),
      this.insertOperation(appName, op, now),
    ]);
    return keys;
  }

  async secretKeys(
    appName: string,
    stage?: AppStage
  ): Promise<Array<{ name: BindingName; stage: AppStage; updatedAt: number }>> {
    const rows = await this.db
      .prepare(
        `SELECT key, stage, updated_at FROM app_data_secrets
         WHERE app_name = ? ${stage ? "AND stage = ?" : ""} ORDER BY stage, key`
      )
      .bind(appName, ...(stage ? [stage] : []))
      .all<{ key: string; stage: AppStage; updated_at: number }>();
    return rows.results.map((row) => ({
      name: row.key as BindingName,
      stage: row.stage,
      updatedAt: row.updated_at,
    }));
  }

  /** For the publish path only: callers wrap each value in SecretText at once. */
  async decryptedSecrets(
    appName: string,
    stage: AppStage,
    names: readonly BindingName[]
  ): Promise<Record<string, string>> {
    if (names.length === 0) return {};
    const rows = await this.db
      .prepare(
        `SELECT key, encrypted_value FROM app_data_secrets
         WHERE app_name = ? AND stage = ? AND key IN (${placeholders(names.length)})`
      )
      .bind(appName, stage, ...names)
      .all<{ key: string; encrypted_value: string }>();
    return decryptSecretRows(rows.results, this.encryptionKey);
  }

  async deleteSecret(
    appName: string,
    stage: AppStage,
    key: BindingName,
    op: OperationInput,
    now: number
  ): Promise<boolean> {
    const where = "app_name = ? AND stage = ? AND key = ?";
    const binds = [appName, stage, key];
    const results = await this.db.batch([
      this.insertOperationWhere(appName, op, now, {
        sql: `SELECT 1 FROM app_data_secrets WHERE ${where}`,
        binds,
      }),
      this.db.prepare(`DELETE FROM app_data_secrets WHERE ${where}`).bind(...binds),
    ]);
    return (results[1]?.meta.changes ?? 0) > 0;
  }

  /** D1 only: the size Cloudflare reported at the last describe. */
  async recordSize(resource: AppDataResource, sizeBytes: number, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE app_data_resources SET size_bytes = ?, updated_at = ? WHERE id = ?")
      .bind(sizeBytes, now, resource.id)
      .run();
  }
}

// ---- Inventory ------------------------------------------------------------------------------

/**
 * Every resource of every app, newest first, keyset-paginated on (created_at, id). A read for the
 * governance view, so it needs no secrets key.
 */
export async function listAppDataInventory(
  db: SqlDatabase,
  filter: { classification?: DataClassification; status?: InventoryStatusFilter },
  cursor: KeysetCursor | null,
  limit: number
): Promise<{ rows: AppDataInventoryRow[]; nextCursor: KeysetCursor | null }> {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (filter.classification) {
    conditions.push("COALESCE(p.classification, 'internal') = ?");
    binds.push(filter.classification);
  }
  if (filter.status) {
    const statuses = INVENTORY_STATUSES[filter.status];
    conditions.push(`r.status IN (${placeholders(statuses.length)})`);
    binds.push(...statuses);
  }
  if (cursor) {
    conditions.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
    binds.push(cursor.at, cursor.at, cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT r.id, r.app_name, a.owner_user_id, COALESCE(p.classification, 'internal') AS classification,
              r.stage, r.binding_name, r.kind, r.status, r.size_bytes, r.purge_after, r.created_at,
              (SELECT MAX(m.applied_at) FROM app_data_migrations m WHERE m.resource_id = r.id)
                AS last_migration_at
       FROM app_data_resources r
       JOIN apps a ON a.name = r.app_name
       LEFT JOIN app_data_profiles p ON p.app_name = r.app_name
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?`
    )
    .bind(...binds, limit + 1)
    .all<{
      id: string;
      app_name: string;
      owner_user_id: string;
      classification: DataClassification;
      stage: AppStage;
      binding_name: string;
      kind: DataStoreKind;
      status: ResourceStatus;
      size_bytes: number | null;
      purge_after: number | null;
      created_at: number;
      last_migration_at: number | null;
    }>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((row) => ({
      appName: row.app_name,
      ownerUserId: row.owner_user_id,
      classification: row.classification,
      stage: row.stage,
      binding: row.binding_name as BindingName,
      kind: row.kind,
      status: row.status,
      sizeBytes: row.size_bytes,
      purgeAfter: row.purge_after,
      lastMigrationAt: row.last_migration_at,
    })),
    nextCursor: rows.results.length > limit && last ? { at: last.created_at, id: last.id } : null,
  };
}
