/**
 * The only writer of `apps` and `app_deployments`. D1 holds ownership, status and the audit
 * ledger; the apps account holds the resources, found by name. Concurrent actors stay safe
 * without a lock:
 *
 * - Claim-first ownership. The row is inserted before any broker call, ON CONFLICT DO NOTHING,
 *   then read back, so two people racing for a new name end with exactly one owner.
 * - One deploy at a time. A deployment row is opened only when the app has no pending one, and
 *   a pending row older than any attempt can live is closed as abandoned by the next deploy.
 * - Mark-then-sweep against attach-then-confirm. Takedown marks the app before it detaches;
 *   a deploy commits only while the app is not taken down, and sweeps itself when it is.
 */

import {
  APP_DEPLOY_DEADLINE_MS,
  type AppDeployFailureReason,
  type AppDeploymentView,
  type AppHoldKind,
  type AppName,
  type AppStatus,
  type HostingBackendKind,
} from "@open-inspect/shared/apps";
import type { SqlDatabase } from "../db/sql-database";
import type { DeployReceipt } from "./host";

/**
 * A pending deployment older than this cannot still be running: the control plane and the broker
 * each abandon an attempt at APP_DEPLOY_DEADLINE_MS, and the broker's clock starts after the row
 * is written.
 */
export const ABANDONED_DEPLOYMENT_AGE_MS = 2 * APP_DEPLOY_DEADLINE_MS;

export interface AppHold {
  kind: AppHoldKind;
  at: number;
  byUserId: string;
  reason: string;
  /** When cleanup in the apps account finished; null while a re-run of takedown is needed. */
  sweptAt: number | null;
}

export interface AppRecord {
  name: AppName;
  ownerUserId: string;
  ownerTeamId: string | null;
  ownerDisplayName: string | null;
  status: AppStatus;
  backend: HostingBackendKind | null;
  version: number;
  hasWorker: boolean;
  assetCount: number;
  bundleBytes: number;
  cfVersionId: string | null;
  lastSessionId: string | null;
  lastRepo: { owner: string; name: string } | null;
  lastErrorReason: AppDeployFailureReason | null;
  lastDeployedAt: number | null;
  hold: AppHold | null;
  createdAt: number;
  updatedAt: number;
}

export type ClaimResult =
  { kind: "owned"; record: AppRecord } | { kind: "taken" } | { kind: "held"; record: AppRecord };

export interface DeploymentFacts {
  name: AppName;
  bundleSha256: string;
  hasWorker: boolean;
  assetCount: number;
  bundleBytes: number;
  sessionId: string;
  userId: string;
  repo: { owner: string; name: string } | null;
}

interface AppRow {
  name: string;
  owner_user_id: string;
  owner_team_id: string | null;
  owner_display_name: string | null;
  status: AppStatus;
  backend: HostingBackendKind | null;
  version: number;
  has_worker: number;
  asset_count: number;
  bundle_bytes: number;
  cf_version_id: string | null;
  last_session_id: string | null;
  last_repo_owner: string | null;
  last_repo_name: string | null;
  last_error_reason: string | null;
  last_deployed_at: number | null;
  hold_kind: AppHoldKind | null;
  hold_at: number | null;
  hold_by: string | null;
  hold_reason: string | null;
  sweep_completed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface DeploymentRow {
  id: string;
  version: number;
  status: AppDeploymentView["status"];
  bundle_sha256: string;
  has_worker: number;
  session_id: string | null;
  user_id: string;
  failure_reason: string | null;
  created_at: number;
}

const SELECT_APP = `SELECT a.*, u.display_name AS owner_display_name
  FROM apps a LEFT JOIN users u ON u.id = a.owner_user_id`;

function toRecord(row: AppRow): AppRecord {
  return {
    name: row.name as AppName,
    ownerUserId: row.owner_user_id,
    ownerTeamId: row.owner_team_id,
    ownerDisplayName: row.owner_display_name,
    status: row.status,
    backend: row.backend,
    version: row.version,
    hasWorker: row.has_worker === 1,
    assetCount: row.asset_count,
    bundleBytes: row.bundle_bytes,
    cfVersionId: row.cf_version_id,
    lastSessionId: row.last_session_id,
    lastRepo:
      row.last_repo_owner !== null && row.last_repo_name !== null
        ? { owner: row.last_repo_owner, name: row.last_repo_name }
        : null,
    lastErrorReason: row.last_error_reason as AppDeployFailureReason | null,
    lastDeployedAt: row.last_deployed_at,
    hold:
      row.hold_kind !== null
        ? {
            kind: row.hold_kind,
            at: row.hold_at!,
            byUserId: row.hold_by!,
            reason: row.hold_reason!,
            sweptAt: row.sweep_completed_at,
          }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDeploymentView(row: DeploymentRow): AppDeploymentView {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    bundleSha256: row.bundle_sha256,
    hasWorker: row.has_worker === 1,
    requestedBy: { userId: row.user_id, sessionId: row.session_id },
    failureReason: row.failure_reason as AppDeployFailureReason | null,
    createdAt: row.created_at,
  };
}

export class AppStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(name: AppName): Promise<AppRecord | null> {
    const row = await this.db.prepare(`${SELECT_APP} WHERE a.name = ?`).bind(name).first<AppRow>();
    return row ? toRecord(row) : null;
  }

  /** The `AppOwnerLookup` route admission uses for `{ kind: "app" }` requirements. */
  async findOwner(name: AppName): Promise<{ userId: string; teamId: string | null } | null> {
    const row = await this.db
      .prepare("SELECT owner_user_id, owner_team_id FROM apps WHERE name = ?")
      .bind(name)
      .first<{ owner_user_id: string; owner_team_id: string | null }>();
    return row ? { userId: row.owner_user_id, teamId: row.owner_team_id } : null;
  }

  async list(): Promise<AppRecord[]> {
    const rows = await this.db.prepare(`${SELECT_APP} ORDER BY a.name`).all<AppRow>();
    return rows.results.map(toRecord);
  }

  async listDeployments(name: AppName, limit: number): Promise<AppDeploymentView[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, version, status, bundle_sha256, has_worker, session_id, user_id, failure_reason, created_at
           FROM app_deployments WHERE app_name = ? ORDER BY version DESC LIMIT ?`
      )
      .bind(name, limit)
      .all<DeploymentRow>();
    return rows.results.map(toDeploymentView);
  }

  /**
   * Insert-or-read the name for a deployer. The deployer owns it when they are the owner or a
   * member of the owner team. Their own unpublish is reopened; an administrator's hold is not.
   */
  async claim(input: {
    name: AppName;
    ownerUserId: string;
    ownerTeamId: string | null;
    actorTeamIds: ReadonlySet<string>;
    now: number;
  }): Promise<ClaimResult> {
    await this.db
      .prepare(
        `INSERT INTO apps (name, owner_user_id, owner_team_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT (name) DO NOTHING`
      )
      .bind(input.name, input.ownerUserId, input.ownerTeamId, input.now, input.now)
      .run();
    let record = await this.get(input.name);
    if (!record) throw new Error(`App ${input.name} vanished after its claim`);
    const owns =
      record.ownerUserId === input.ownerUserId ||
      (record.ownerTeamId !== null && input.actorTeamIds.has(record.ownerTeamId));
    if (!owns) return { kind: "taken" };
    if (record.hold?.kind === "owner_unpublished") {
      await this.db
        .prepare(
          `UPDATE apps SET status = 'pending', hold_kind = NULL, hold_at = NULL, hold_by = NULL,
             hold_reason = NULL, sweep_completed_at = NULL, updated_at = ?
           WHERE name = ? AND hold_kind = 'owner_unpublished'`
        )
        .bind(input.now, input.name)
        .run();
      record = (await this.get(input.name))!;
    }
    return record.hold ? { kind: "held", record } : { kind: "owned", record };
  }

  /** Open the app's next deployment, or report that another deploy of it is still running. */
  async beginDeployment(
    facts: DeploymentFacts,
    now: number
  ): Promise<{ kind: "started"; id: string; version: number } | { kind: "busy" }> {
    const id = crypto.randomUUID();
    const [, inserted] = await this.db.batch<{ version: number }>([
      this.db
        .prepare(
          `UPDATE app_deployments SET status = 'failed', failure_reason = 'deadline_exceeded', finished_at = ?
           WHERE app_name = ? AND status = 'pending' AND created_at <= ?`
        )
        .bind(now, facts.name, now - ABANDONED_DEPLOYMENT_AGE_MS),
      this.db
        .prepare(
          `INSERT INTO app_deployments
             (id, app_name, version, status, bundle_sha256, has_worker, asset_count, bundle_bytes,
              session_id, user_id, repo_owner, repo_name, created_at)
           SELECT ?, ?, n.version, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM (SELECT COALESCE(MAX(version), 0) + 1 AS version
                     FROM app_deployments WHERE app_name = ?) AS n
            WHERE NOT EXISTS (SELECT 1 FROM app_deployments WHERE app_name = ? AND status = 'pending')
           RETURNING version`
        )
        .bind(
          id,
          facts.name,
          facts.bundleSha256,
          facts.hasWorker ? 1 : 0,
          facts.assetCount,
          facts.bundleBytes,
          facts.sessionId,
          facts.userId,
          facts.repo?.owner ?? null,
          facts.repo?.name ?? null,
          now,
          facts.name,
          facts.name
        ),
    ]);
    const version = inserted?.results[0]?.version;
    return version === undefined ? { kind: "busy" } : { kind: "started", id, version };
  }

  /**
   * Make the deployment live and supersede the previous live one, in one batch. Applies only while
   * the deployment is still pending and the app is not taken down; false means it did not apply.
   */
  async commitLive(input: {
    facts: DeploymentFacts;
    deploymentId: string;
    version: number;
    receipt: DeployReceipt;
    dataDigest: string | null;
    now: number;
  }): Promise<boolean> {
    const { facts, receipt, now } = input;
    const liveAtThisVersion =
      "EXISTS (SELECT 1 FROM apps WHERE name = ? AND status = 'live' AND version = ?)";
    const [app] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE apps SET status = 'live', backend = ?, access_aud = ?, version = ?, has_worker = ?,
             asset_count = ?, bundle_bytes = ?, cf_version_id = ?, last_session_id = ?,
             last_repo_owner = ?, last_repo_name = ?, last_error_reason = NULL,
             last_deployed_at = ?, updated_at = ?
           WHERE name = ? AND status <> 'taken_down'
             AND EXISTS (SELECT 1 FROM app_deployments WHERE id = ? AND status = 'pending')`
        )
        .bind(
          receipt.backend,
          receipt.accessAud,
          input.version,
          facts.hasWorker ? 1 : 0,
          facts.assetCount,
          facts.bundleBytes,
          receipt.cfVersionId,
          facts.sessionId,
          facts.repo?.owner ?? null,
          facts.repo?.name ?? null,
          now,
          now,
          facts.name,
          input.deploymentId
        ),
      this.db
        .prepare(
          `UPDATE app_deployments SET status = 'superseded'
           WHERE app_name = ? AND status = 'live' AND ${liveAtThisVersion}`
        )
        .bind(facts.name, facts.name, input.version),
      this.db
        .prepare(
          `UPDATE app_deployments SET status = 'live', cf_version_id = ?, data_digest = ?, finished_at = ?
           WHERE id = ? AND status = 'pending' AND ${liveAtThisVersion}`
        )
        .bind(
          receipt.cfVersionId,
          input.dataDigest,
          now,
          input.deploymentId,
          facts.name,
          input.version
        ),
    ]);
    return app.meta.changes === 1;
  }

  /** Close a pending deployment as failed. A never-live app becomes failed; a live one keeps serving. */
  async failDeployment(input: {
    name: AppName;
    deploymentId: string;
    reason: AppDeployFailureReason;
    now: number;
  }): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE app_deployments SET status = 'failed', failure_reason = ?, finished_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .bind(input.reason, input.now, input.deploymentId),
      this.db
        .prepare(
          `UPDATE apps SET status = CASE status WHEN 'pending' THEN 'failed' ELSE status END,
             last_error_reason = ?, updated_at = ?
           WHERE name = ? AND status <> 'taken_down'`
        )
        .bind(input.reason, input.now, input.name),
    ]);
  }

  /** A deployment the broker published after a takedown marked the app: recorded, never live. */
  async closeDeploymentAsTakenDown(deploymentId: string, cfVersionId: string, now: number) {
    await this.db
      .prepare(
        `UPDATE app_deployments SET status = 'taken_down', cf_version_id = ?, finished_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .bind(cfVersionId, now, deploymentId)
      .run();
  }

  /**
   * Mark the app taken down and its cleanup outstanding. Repeating it re-opens the sweep. An
   * administrator's hold is never replaced by an owner's.
   */
  async markTakenDown(input: {
    name: AppName;
    kind: AppHoldKind;
    actorUserId: string;
    reason: string;
    now: number;
  }): Promise<AppRecord | null> {
    const keep = "hold_kind = 'admin_takedown'";
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE apps SET status = 'taken_down',
             hold_kind = CASE WHEN ${keep} THEN hold_kind ELSE ? END,
             hold_at = CASE WHEN ${keep} THEN hold_at ELSE ? END,
             hold_by = CASE WHEN ${keep} THEN hold_by ELSE ? END,
             hold_reason = CASE WHEN ${keep} THEN hold_reason ELSE ? END,
             sweep_completed_at = NULL, updated_at = ?
           WHERE name = ?`
        )
        .bind(input.kind, input.now, input.actorUserId, input.reason, input.now, input.name),
      this.db
        .prepare(
          "UPDATE app_deployments SET status = 'taken_down' WHERE app_name = ? AND status = 'live'"
        )
        .bind(input.name),
    ]);
    return this.get(input.name);
  }

  /** Re-open cleanup on an app that is already taken down, without touching its hold. */
  async reopenSweep(name: AppName, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE apps SET sweep_completed_at = NULL, updated_at = ? WHERE name = ? AND status = 'taken_down'`
      )
      .bind(now, name)
      .run();
  }

  async markSwept(name: AppName, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE apps SET sweep_completed_at = ?, updated_at = ? WHERE name = ? AND status = 'taken_down'`
      )
      .bind(now, now, name)
      .run();
  }

  /** Clear a fully swept hold. The app waits, not live, for its next deploy. */
  async releaseHold(name: AppName, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE apps SET status = 'pending', hold_kind = NULL, hold_at = NULL, hold_by = NULL,
           hold_reason = NULL, sweep_completed_at = NULL, updated_at = ?
         WHERE name = ? AND status = 'taken_down' AND sweep_completed_at IS NOT NULL`
      )
      .bind(now, name)
      .run();
    return result.meta.changes === 1;
  }
}
