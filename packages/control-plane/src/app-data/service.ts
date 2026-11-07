/**
 * The one public surface of app data. The deploy pipeline calls `prepare` and `retire`; routes
 * call one method per human action; the hourly sweep calls `purgeDue`.
 *
 * `prepare` is a converge step, not a workflow: it reads the rows that exist, compares them with
 * the declaration, and applies only the difference. Every check that needs no side effect (policy,
 * binding kinds, secrets) runs before any resource is touched. Running it twice yields the same
 * bindings and no new operations. A crash at any point leaves rows the next run recognizes:
 * provisioning rows adopt their resource by name, and a migration is marked `applying` before it
 * is sent, while D1 records the same file in its own ledger in the same batch.
 */

import type { AppName } from "@open-inspect/shared/apps";
import {
  D1_POINT_IN_TIME_RECOVERY_DAYS,
  SecretText,
  type AppDataBinding,
  type AppDataBindings,
  type AppDataBlockReason,
  type AppDataInventoryRow,
  type AppDataManifest,
  type AppDataMigrationView,
  type AppDataOperationView,
  type AppDataSummary,
  type AppStage,
  type BindingName,
  type D1RestoreTarget,
  type DataAdvisory,
  type DataClassification,
  type DataStoreKind,
  type MigrationFile,
} from "@open-inspect/shared/types/app-data";
import type { AppDataSeam, DataActor } from "../apps";
import { AppHostError, type DataHost } from "../apps/host";
import {
  listAppDataInventory,
  type AppDataMigration,
  type AppDataResource,
  type AppDataStore,
  type InventoryStatusFilter,
  type KeysetCursor,
  type MigrationWrite,
  type OperationActor,
  type OperationInput,
} from "../db/app-data";
import { SecretsValidationError } from "../db/secrets-validation";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import {
  APP_DATA_RETENTION_MS,
  D1_POINT_IN_TIME_RECOVERY_MS,
  appDataDigest,
  classifyMigration,
  describeDenial,
  evaluateDataPolicy,
  isAlreadyAppliedError,
  migrationBatchSql,
  mintResourceName,
  planMigrations,
  restoreRequiresScope,
  type AppDataConfig,
  type DataPolicyLookup,
} from "./model";

const log = createLogger("app-data");

/** D1 messages relayed to the agent are cut to this length. */
const RELAYED_SQL_ERROR_MAX_LENGTH = 2_000;

export interface PrepareInput {
  app: {
    name: AppName;
    ownerUserId: string;
    repository: { repoOwner: string; repoName: string } | null;
    environmentId: string | null;
  };
  stage: AppStage;
  /** Null when the bundle carried no openinspect.app.json: the app declares no data. */
  manifest: AppDataManifest | null;
  /** Per d1 binding, its migration files. */
  migrations: ReadonlyMap<BindingName, readonly MigrationFile[]>;
  actor: { kind: "session"; sessionId: string; userId: string; requestId: string };
}

export type PrepareResult =
  | { kind: "ready"; bindings: AppDataBindings; advisories: readonly DataAdvisory[] }
  | {
      kind: "blocked";
      reason: AppDataBlockReason;
      /** Agent-safe: names, statements the agent wrote, D1's message. Never a secret value. */
      message: string;
      detail?: Record<string, unknown>;
      advisories: readonly DataAdvisory[];
    };

/** A human acting through a route; admission has already decided they may manage the app. */
export interface UserActor {
  userId: string;
  scope: "own" | "any";
  requestId: string;
}

/** Why a human action did not apply. Routes map each code to one HTTP status. */
export type AppDataRefusalCode =
  | "not_found"
  | "requires_manage_any"
  | "not_blocked"
  | "sha_mismatch"
  | "undeclared_secret"
  | "invalid_secret"
  | "confirm_mismatch"
  | "outside_recovery_window"
  | "data_unavailable";

export type ActionResult<T> =
  { ok: true; value: T } | { ok: false; code: AppDataRefusalCode; message: string };

/** A refusal raised inside `prepare`; `prepare` turns it into its blocked result. */
class Blocked extends Error {
  constructor(
    readonly reason: AppDataBlockReason,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
  }
}

const isLive = (resource: AppDataResource) =>
  resource.status === "provisioning" || resource.status === "ready";

function refuse(code: AppDataRefusalCode, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

function operationActor(actor: DataActor | UserActor): OperationActor {
  if ("scope" in actor) return { kind: "user", userId: actor.userId, requestId: actor.requestId };
  return actor;
}

export class AppDataService implements AppDataSeam {
  constructor(
    private readonly deps: {
      db: SqlDatabase;
      store: AppDataStore;
      host: DataHost;
      policy: DataPolicyLookup;
      config: AppDataConfig;
      now: () => number;
    }
  ) {}

  // ---- Deploy pipeline ------------------------------------------------------------------------

  /** Converge (app, stage) to the declaration and return exactly the bindings to publish. */
  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const advisories: DataAdvisory[] = [];
    try {
      const bindings = await this.converge(input, advisories);
      return { kind: "ready", bindings, advisories };
    } catch (error) {
      if (error instanceof Blocked) {
        return {
          kind: "blocked",
          reason: error.reason,
          message: error.message,
          ...(error.detail ? { detail: error.detail } : {}),
          advisories,
        };
      }
      if (!(error instanceof AppHostError)) throw error;
      (error.code === "refused" ? log.error : log.warn)("App data provisioning did not complete", {
        event: "app_data.prepare_unavailable",
        app: input.app.name,
        code: error.code,
        request_id: input.actor.requestId,
      });
      return {
        kind: "blocked",
        reason: "data_unavailable",
        message: "The platform could not reach the app's data stores.",
        advisories,
      };
    }
  }

  private async converge(
    input: PrepareInput,
    advisories: DataAdvisory[]
  ): Promise<AppDataBindings> {
    const { store } = this.deps;
    const { app, stage } = input;
    const actor: OperationActor = input.actor;
    const now = this.deps.now();
    const manifest = input.manifest;
    const declarations = Object.entries(manifest?.data ?? {})
      .map(([name, declaration]) => ({ binding: name as BindingName, declaration }))
      .sort((a, b) => (a.binding < b.binding ? -1 : 1));
    const declaredSecrets = [...(manifest?.secrets ?? [])].sort();

    const profile = await store.getProfile(app.name);
    if (manifest) {
      const changed =
        !profile ||
        profile.declaredSecrets.join(",") !== declaredSecrets.join(",") ||
        (profile.classificationSource === "manifest" &&
          profile.classification !== manifest.classification);
      if (changed) {
        await store.recordManifest(
          app.name,
          { classification: manifest.classification, declaredSecrets },
          input.actor.userId,
          now
        );
      }
    }
    const classification: DataClassification =
      profile?.classificationSource === "admin"
        ? profile.classification
        : (manifest?.classification ?? profile?.classification ?? "internal");
    if (
      manifest &&
      profile?.classificationSource === "admin" &&
      classification !== manifest.classification
    ) {
      advisories.push({
        code: "classification_overridden_by_admin",
        message: `An administrator set this app's classification to ${classification}; the manifest's ${manifest.classification} is ignored.`,
      });
    }

    if (manifest && declarations.length > 0) {
      const policy = await this.deps.policy.resolveForApp(app.repository, app.environmentId);
      const evaluation = evaluateDataPolicy(manifest, policy, classification, this.deps.config);
      advisories.push(...evaluation.advisories);
      if (evaluation.denials.length > 0) {
        await store.appendOperation(
          app.name,
          {
            kind: "policy_block",
            result: "blocked",
            stage,
            actor,
            detail: { denials: evaluation.denials },
          },
          now
        );
        throw new Blocked("data_policy_denied", evaluation.denials.map(describeDenial).join(" "), {
          denials: evaluation.denials,
        });
      }
    }

    const resources = await store.listResources(app.name, stage);
    const live = new Map(resources.filter(isLive).map((resource) => [resource.binding, resource]));
    const dormant = new Map<BindingName, AppDataResource>();
    for (const resource of resources) {
      if (resource.status === "retired" || resource.status === "purging") {
        const newer = dormant.get(resource.binding);
        if (!newer || (newer.retiredAt ?? 0) < (resource.retiredAt ?? 0)) {
          dormant.set(resource.binding, resource);
        }
      }
    }
    for (const { binding, declaration } of declarations) {
      const current = live.get(binding) ?? dormant.get(binding);
      if (current && current.kind !== declaration.kind) {
        throw new Blocked(
          "binding_kind_changed",
          `${binding} holds ${current.kind} data and cannot become ${declaration.kind}.`,
          { binding, previousKind: current.kind }
        );
      }
      if (!live.has(binding) && current?.status === "purging") {
        throw new Blocked(
          "data_unavailable",
          `${binding}'s earlier ${current.kind} data is being deleted after its retention window. Deploy again later, or use a new binding name.`,
          { binding }
        );
      }
    }

    const storedSecrets = new Set(
      (await store.secretKeys(app.name, stage)).map((secret) => secret.name)
    );
    const missing = declaredSecrets.filter((name) => !storedSecrets.has(name));
    if (missing.length > 0) {
      throw new Blocked(
        "secret_missing",
        `Set ${missing.join(", ")} for ${app.name} on the app's page, then deploy again.`,
        { secrets: missing }
      );
    }

    const ready = new Map<BindingName, AppDataResource>();
    for (const { binding, declaration } of declarations) {
      ready.set(
        binding,
        await this.ensureResource(
          { appName: app.name, stage, binding, kind: declaration.kind },
          live.get(binding) ?? null,
          dormant.get(binding) ?? null,
          actor,
          now
        )
      );
    }
    for (const resource of live.values()) {
      if (!ready.has(resource.binding)) {
        await this.retireResource(resource, "binding_removed", actor, now);
      }
    }

    const databases = [...ready.values()].filter((resource) => resource.kind === "d1");
    const records = await store.listMigrations(databases.map((resource) => resource.id));
    for (const database of databases) {
      await this.migrate(
        database,
        input.migrations.get(database.binding) ?? [],
        records.filter((record) => record.resourceId === database.id),
        actor
      );
    }

    const secretValues = await store.decryptedSecrets(app.name, stage, declaredSecrets);
    const bindings: AppDataBinding[] = [
      ...[...ready.values()].map((resource) => toBinding(resource)),
      ...declaredSecrets.map((name): AppDataBinding => ({
        kind: "secret",
        name,
        value: new SecretText(secretValues[name]!),
      })),
    ].sort((a, b) => (a.name < b.name ? -1 : 1));
    const applied = (await store.listMigrations(databases.map((resource) => resource.id)))
      .filter((record) => record.status === "applied")
      .map((record) => {
        const binding = databases.find((resource) => resource.id === record.resourceId)?.binding;
        return `${binding}/${record.name}:${record.sha256}`;
      });
    return {
      appName: app.name,
      stage,
      classification,
      bindings,
      dataDigest: await appDataDigest(bindings, applied),
    };
  }

  /** Ready by the end: kept, reinstated within its retention, resumed, or created by name. */
  private async ensureResource(
    target: { appName: string; stage: AppStage; binding: BindingName; kind: DataStoreKind },
    live: AppDataResource | null,
    dormant: AppDataResource | null,
    actor: OperationActor,
    now: number
  ): Promise<AppDataResource> {
    const { store } = this.deps;
    if (live?.status === "ready") return live;
    if (!live && dormant?.status === "retired") {
      const reinstated = await store.reinstate(
        dormant,
        {
          kind: "reinstate",
          result: "applied",
          stage: target.stage,
          resourceId: dormant.id,
          binding: target.binding,
          actor,
          detail: { providerName: dormant.providerName, retiredAt: dormant.retiredAt },
        },
        now
      );
      if (!reinstated) {
        throw new Blocked(
          "data_unavailable",
          `${target.binding}'s earlier data is being deleted. Deploy again later, or use a new binding name.`,
          { binding: target.binding }
        );
      }
      return { ...dormant, status: "ready", retiredAt: null, retireReason: null, purgeAfter: null };
    }
    const row =
      live ??
      (await store.insertProvisioning({
        ...target,
        providerName: await mintResourceName(
          target.appName as AppName,
          target.stage,
          target.binding
        ),
        now,
      }));
    if (!row) {
      log.error("App data resource name is held by another row", {
        event: "app_data.name_conflict",
        app: target.appName,
        binding: target.binding,
      });
      throw new Blocked(
        "data_unavailable",
        `${target.binding} could not be provisioned. Use a different binding name.`,
        { binding: target.binding }
      );
    }
    return this.finishProvisioning(row, actor, now);
  }

  /** Create or adopt the resource by its name, then record it ready. */
  private async finishProvisioning(
    row: AppDataResource,
    actor: OperationActor,
    now: number
  ): Promise<AppDataResource> {
    const { host, store } = this.deps;
    const { ref, created } = await ensureRemote(host, row);
    await store.markReady(
      row,
      ref,
      {
        kind: "provision",
        result: "applied",
        stage: row.stage,
        resourceId: row.id,
        binding: row.binding,
        actor,
        detail: { kind: row.kind, providerName: row.providerName, created },
      },
      now
    );
    return { ...row, status: "ready", providerRef: ref };
  }

  private async retireResource(
    resource: AppDataResource,
    reason: "takedown" | "binding_removed",
    actor: OperationActor,
    now: number
  ): Promise<void> {
    const ready =
      resource.status === "provisioning"
        ? await this.finishProvisioning(resource, actor, now)
        : resource;
    const purgeAfter = now + APP_DATA_RETENTION_MS[resource.stage];
    await this.deps.store.retire(
      ready,
      { reason, purgeAfter },
      {
        kind: "retire",
        result: "applied",
        stage: resource.stage,
        resourceId: resource.id,
        binding: resource.binding,
        actor,
        detail: { reason, purgeAfter },
      },
      now
    );
  }

  /**
   * Apply each pending file in order. A bookmark is taken before every file. In production a file
   * that drops or rewrites data waits for approval of its exact bytes, unless the database had no
   * tables when this deploy began (nothing to lose).
   */
  private async migrate(
    database: AppDataResource,
    files: readonly MigrationFile[],
    records: readonly AppDataMigration[],
    actor: OperationActor
  ): Promise<void> {
    const { host, store } = this.deps;
    const binding = database.binding;
    const databaseId = database.providerRef!;
    const plan = planMigrations(files, records);
    if (!plan.ok) {
      throw new Blocked(plan.problem, problemMessage(plan.problem, binding, plan.name), {
        binding,
        migration: plan.name,
      });
    }
    const recorded = new Map(records.map((record) => [record.name, record]));
    const pending = plan.pending.map((file) => {
      const record = recorded.get(file.name);
      const admitted =
        record?.sha256 === file.sha256 &&
        (record.status === "approved" || record.status === "applying");
      return { file, verdict: classifyMigration(file), record: admitted ? record : null };
    });
    const guarded =
      database.stage === "production" &&
      pending.some(({ verdict, record }) => verdict.class === "destructive" && !record) &&
      !(await this.isEmpty(database));

    for (const { file, verdict, record } of pending) {
      const now = this.deps.now();
      const op = (result: OperationInput["result"], detail: Record<string, unknown>) => ({
        kind: "migrate" as const,
        result,
        stage: database.stage,
        resourceId: database.id,
        binding,
        actor,
        detail: { migration: file.name, sha256: file.sha256, ...detail },
      });
      if (verdict.class === "forbidden") {
        await store.appendOperation(
          database.appName,
          op("blocked", { reason: "forbidden_statement" }),
          now
        );
        throw new Blocked(
          "migration_forbidden_statement",
          `${file.name} for ${binding} contains a statement migrations may not run.`,
          { binding, migration: file.name, statements: verdict.statements }
        );
      }
      const statements = verdict.class === "destructive" ? verdict.statements : [];
      const base: Omit<MigrationWrite, "status" | "appliedAt" | "bookmarkBefore"> = {
        name: file.name,
        sha256: file.sha256,
        classification: verdict.class,
        statements,
        approvedBy: record?.approvedBy ?? null,
        approvedAt: record?.approvedAt ?? null,
        error: null,
      };
      if (verdict.class === "destructive" && guarded && !record) {
        const bookmark = await host.bookmarkD1(databaseId);
        await store.writeMigration(
          database,
          { ...base, status: "blocked", bookmarkBefore: bookmark, appliedAt: null },
          op("blocked", { reason: "requires_approval", bookmark }),
          now
        );
        throw new Blocked(
          "destructive_migration_requires_approval",
          `${file.name} for ${binding} would drop or rewrite existing data and needs approval on the app's page.`,
          { binding, migration: file.name, sha256: file.sha256, statements }
        );
      }

      const bookmark =
        record?.status === "applying" && record.bookmarkBefore
          ? record.bookmarkBefore
          : await host.bookmarkD1(databaseId);
      await store.writeMigration(
        database,
        { ...base, status: "applying", bookmarkBefore: bookmark, appliedAt: null },
        null,
        now
      );
      try {
        await host.executeD1(databaseId, migrationBatchSql(file));
      } catch (error) {
        if (!(error instanceof AppHostError && error.code === "sql_error")) throw error;
        // The ledger row collided: these exact bytes applied before a response was lost.
        if (!isAlreadyAppliedError(error.message)) {
          const message = error.message.slice(0, RELAYED_SQL_ERROR_MAX_LENGTH);
          await store.writeMigration(
            database,
            {
              ...base,
              status: "failed",
              bookmarkBefore: bookmark,
              appliedAt: null,
              error: message,
            },
            op("failed", { bookmarkBefore: bookmark }),
            now
          );
          throw new Blocked("migration_failed", `${file.name} for ${binding}: ${message}`, {
            binding,
            migration: file.name,
          });
        }
      }
      await store.writeMigration(
        database,
        { ...base, status: "applied", bookmarkBefore: bookmark, appliedAt: now },
        op("applied", { bookmarkBefore: bookmark, classification: verdict.class }),
        now
      );
    }
  }

  /** True when the database holds no tables, so no existing data can be lost. */
  private async isEmpty(database: AppDataResource): Promise<boolean> {
    const described = await this.deps.host.describeD1(database.providerRef!);
    await this.deps.store.recordSize(database, described.fileSize, this.deps.now());
    return described.numTables === 0;
  }

  /** Takedown: every live resource of the stage is retired, intact and unbound, for its window. */
  async retire(
    appName: AppName,
    stage: AppStage,
    actor: DataActor,
    reason: "takedown"
  ): Promise<void> {
    const now = this.deps.now();
    for (const resource of await this.deps.store.listResources(appName, stage)) {
      if (isLive(resource)) {
        await this.retireResource(resource, reason, operationActor(actor), now);
      }
    }
  }

  // ---- Human actions --------------------------------------------------------------------------

  async summary(appName: AppName): Promise<AppDataSummary> {
    const { store } = this.deps;
    const [profile, resources, secrets] = await Promise.all([
      store.getProfile(appName),
      store.listResources(appName),
      store.secretKeys(appName),
    ]);
    const current = resources.filter((resource) => resource.status !== "purged");
    const migrations = await store.listMigrations(
      current.filter((resource) => resource.kind === "d1").map((resource) => resource.id)
    );
    const bindingOf = new Map(current.map((resource) => [resource.id, resource.binding]));
    const views: AppDataMigrationView[] = migrations.map((migration) => ({
      binding: bindingOf.get(migration.resourceId)!,
      name: migration.name,
      sha256: migration.sha256,
      status: migration.status,
      classification: migration.classification,
      statements: migration.statements,
      appliedAt: migration.appliedAt,
      approvedBy: migration.approvedBy,
      error: migration.error,
    }));
    return {
      appName,
      classification: profile?.classification ?? "internal",
      classificationSource: profile?.classificationSource ?? "manifest",
      resources: current.map((resource) => ({
        id: resource.id,
        stage: resource.stage,
        binding: resource.binding,
        kind: resource.kind,
        status: resource.status,
        providerName: resource.providerName,
        sizeBytes: resource.sizeBytes,
        retiredAt: resource.retiredAt,
        purgeAfter: resource.purgeAfter,
        createdAt: resource.createdAt,
      })),
      migrations: views,
      secrets,
      declaredSecrets: profile?.declaredSecrets ?? [],
      pendingApprovals: views.filter((view) => view.status === "blocked").length,
      pointInTimeRecoveryDays: D1_POINT_IN_TIME_RECOVERY_DAYS,
    };
  }

  listOperations(
    appName: AppName,
    cursor: KeysetCursor | null,
    limit: number
  ): Promise<{ operations: AppDataOperationView[]; nextCursor: KeysetCursor | null }> {
    return this.deps.store.listOperations(appName, cursor, limit);
  }

  inventory(
    filter: { classification?: DataClassification; status?: InventoryStatusFilter },
    cursor: KeysetCursor | null,
    limit: number
  ): Promise<{ rows: AppDataInventoryRow[]; nextCursor: KeysetCursor | null }> {
    return listAppDataInventory(this.deps.db, filter, cursor, limit);
  }

  private async liveResource(
    appName: AppName,
    stage: AppStage,
    binding: BindingName
  ): Promise<AppDataResource | null> {
    const resources = await this.deps.store.listResources(appName, stage);
    return resources.find((resource) => resource.binding === binding && isLive(resource)) ?? null;
  }

  /** The approver approves exact bytes; a file edited after review is blocked again. */
  async approveMigration(input: {
    appName: AppName;
    stage: AppStage;
    binding: BindingName;
    name: string;
    sha256: string;
    actor: UserActor;
  }): Promise<ActionResult<{ status: "approved" }>> {
    const { store } = this.deps;
    const database = await this.liveResource(input.appName, input.stage, input.binding);
    if (database?.kind !== "d1") return refuse("not_found", `${input.binding} is not a database.`);
    const approved = await store.approveMigration(
      database,
      { name: input.name, sha256: input.sha256, by: input.actor.userId },
      {
        kind: "approve_migration",
        result: "applied",
        stage: input.stage,
        resourceId: database.id,
        binding: input.binding,
        actor: operationActor(input.actor),
        detail: { migration: input.name, sha256: input.sha256 },
      },
      this.deps.now()
    );
    if (approved) return { ok: true, value: { status: "approved" } };
    const record = (await store.listMigrations([database.id])).find(
      (migration) => migration.name === input.name
    );
    if (!record) return refuse("not_found", `${input.name} has not been deployed.`);
    if (record.status !== "blocked") {
      return refuse("not_blocked", `${input.name} is not waiting for approval.`);
    }
    return refuse(
      "sha_mismatch",
      `${input.name} changed after it was reviewed. Review the current version.`
    );
  }

  /** Write-only: the response carries names, never values. */
  async setSecrets(input: {
    appName: AppName;
    stage: AppStage;
    secrets: Readonly<Record<string, string>>;
    actor: UserActor;
  }): Promise<ActionResult<{ keys: string[] }>> {
    const { store } = this.deps;
    const declared = new Set((await store.getProfile(input.appName))?.declaredSecrets ?? []);
    const undeclared = Object.keys(input.secrets).filter(
      (name) => !declared.has(name as BindingName)
    );
    if (undeclared.length > 0) {
      return refuse(
        "undeclared_secret",
        `The app does not declare ${undeclared.sort().join(", ")}. Only declared secrets can be set.`
      );
    }
    try {
      const keys = await store.setSecrets(
        input.appName,
        input.stage,
        { ...input.secrets },
        {
          kind: "secret_set",
          result: "applied",
          stage: input.stage,
          actor: operationActor(input.actor),
          detail: { keys: Object.keys(input.secrets).sort() },
        },
        this.deps.now()
      );
      return { ok: true, value: { keys } };
    } catch (error) {
      if (error instanceof SecretsValidationError) return refuse("invalid_secret", error.message);
      throw error;
    }
  }

  async deleteSecret(input: {
    appName: AppName;
    stage: AppStage;
    key: BindingName;
    actor: UserActor;
  }): Promise<ActionResult<{ deleted: true }>> {
    const deleted = await this.deps.store.deleteSecret(
      input.appName,
      input.stage,
      input.key,
      {
        kind: "secret_delete",
        result: "applied",
        stage: input.stage,
        actor: operationActor(input.actor),
        detail: { key: input.key },
      },
      this.deps.now()
    );
    return deleted
      ? { ok: true, value: { deleted: true } }
      : refuse("not_found", `${input.key} is not set for ${input.stage}.`);
  }

  /**
   * D1 Time Travel. The app keeps running; the previous bookmark is recorded so the restore itself
   * can be undone. A timestamp is Unix milliseconds inside the recovery window.
   */
  async restoreToPointInTime(input: {
    appName: AppName;
    stage: AppStage;
    binding: BindingName;
    target: D1RestoreTarget;
    confirmBinding: BindingName;
    actor: UserActor;
  }): Promise<ActionResult<{ bookmark: string; previousBookmark: string }>> {
    const { store } = this.deps;
    if (input.confirmBinding !== input.binding) {
      return refuse("confirm_mismatch", "Type the binding name exactly to confirm the restore.");
    }
    const now = this.deps.now();
    if (
      "timestamp" in input.target &&
      (input.target.timestamp > now || input.target.timestamp < now - D1_POINT_IN_TIME_RECOVERY_MS)
    ) {
      return refuse(
        "outside_recovery_window",
        `Restore to a time within the last ${D1_POINT_IN_TIME_RECOVERY_DAYS} days.`
      );
    }
    const classification = (await store.getProfile(input.appName))?.classification ?? "internal";
    if (restoreRequiresScope(classification) === "any" && input.actor.scope !== "any") {
      return refuse(
        "requires_manage_any",
        "Restricted data is restored by an administrator who manages every app."
      );
    }
    const database = await this.liveResource(input.appName, input.stage, input.binding);
    if (database?.status !== "ready" || database.kind !== "d1") {
      return refuse("not_found", `${input.binding} is not a live database.`);
    }
    let restored: { bookmark: string; previousBookmark: string };
    try {
      restored = await this.deps.host.restoreD1(database.providerRef!, input.target);
    } catch (error) {
      if (!(error instanceof AppHostError)) throw error;
      log.warn("App data restore did not complete", {
        event: "app_data.restore_unavailable",
        app: input.appName,
        code: error.code,
        request_id: input.actor.requestId,
      });
      return refuse(
        "data_unavailable",
        error.code === "sql_error" || error.code === "invalid_request"
          ? "D1 cannot restore to that point."
          : "The data store could not be reached. Try again."
      );
    }
    await store.appendOperation(
      input.appName,
      {
        kind: "restore",
        result: "applied",
        stage: input.stage,
        resourceId: database.id,
        binding: input.binding,
        actor: operationActor(input.actor),
        detail: { target: input.target, ...restored },
      },
      now
    );
    return { ok: true, value: restored };
  }

  /** Administrators only: the label is locked against later manifests. */
  async setClassification(input: {
    appName: AppName;
    classification: DataClassification;
    actor: UserActor;
  }): Promise<ActionResult<{ classification: DataClassification; classificationSource: "admin" }>> {
    if (input.actor.scope !== "any") {
      return refuse(
        "requires_manage_any",
        "Only an administrator who manages every app can set its classification."
      );
    }
    await this.deps.store.classify(
      input.appName,
      input.classification,
      {
        kind: "classify",
        result: "applied",
        stage: null,
        actor: { kind: "user", userId: input.actor.userId, requestId: input.actor.requestId },
        detail: { classification: input.classification },
      },
      this.deps.now()
    );
    return {
      ok: true,
      value: { classification: input.classification, classificationSource: "admin" },
    };
  }

  // ---- System ---------------------------------------------------------------------------------

  /**
   * Resources past their retention window are deleted. Each step is its own write, so a crash or
   * a failure leaves rows the next sweep resumes: claimed rows stay `purging`, and an R2 bucket
   * stays `purging` while Cloudflare empties it.
   */
  async purgeDue(limit: number): Promise<{ purged: number; emptying: number; failed: number }> {
    const { host, store } = this.deps;
    const outcome = { purged: 0, emptying: 0, failed: 0 };
    const now = this.deps.now();
    for (const resource of await store.listPurgeDue(now, limit)) {
      try {
        if (!(await store.claimPurge(resource, now))) continue;
        const ref = resource.providerRef!;
        if (resource.kind === "r2") {
          const { status } = await host.purgeR2(resource.providerName);
          if (status === "emptying") {
            outcome.emptying += 1;
            continue;
          }
        } else if (resource.kind === "d1") {
          await host.deleteD1(ref);
        } else {
          await host.deleteKv(ref);
        }
        await store.markPurged(
          { ...resource, status: "purging" },
          {
            kind: "purge",
            result: "applied",
            stage: resource.stage,
            resourceId: resource.id,
            binding: resource.binding,
            actor: { kind: "system", job: "app_data_purge" },
            detail: { kind: resource.kind, providerName: resource.providerName },
          },
          now
        );
        outcome.purged += 1;
      } catch (error) {
        if (!(error instanceof AppHostError)) throw error;
        outcome.failed += 1;
        (error.code === "refused" ? log.error : log.warn)("App data purge did not complete", {
          event: "app_data.purge_failed",
          app: resource.appName,
          resource_id: resource.id,
          code: error.code,
        });
      }
    }
    return outcome;
  }
}

async function ensureRemote(
  host: DataHost,
  resource: AppDataResource
): Promise<{ ref: string; created: boolean }> {
  switch (resource.kind) {
    case "d1": {
      const { databaseId, created } = await host.ensureD1(resource.providerName);
      return { ref: databaseId, created };
    }
    case "kv": {
      const { namespaceId, created } = await host.ensureKv(resource.providerName);
      return { ref: namespaceId, created };
    }
    case "r2": {
      const { bucketName, created } = await host.ensureR2(resource.providerName);
      return { ref: bucketName, created };
    }
  }
}

function toBinding(resource: AppDataResource): AppDataBinding {
  const ref = resource.providerRef!;
  switch (resource.kind) {
    case "d1":
      return { kind: "d1", name: resource.binding, databaseId: ref };
    case "kv":
      return { kind: "kv", name: resource.binding, namespaceId: ref };
    case "r2":
      return { kind: "r2", name: resource.binding, bucketName: ref };
  }
}

function problemMessage(
  problem: "migration_file_changed" | "migration_file_missing" | "migration_out_of_order",
  binding: BindingName,
  name: string
): string {
  switch (problem) {
    case "migration_file_changed":
      return `${name} for ${binding} already applied and has since been edited.`;
    case "migration_file_missing":
      return `${name} for ${binding} already applied and is no longer in the bundle.`;
    case "migration_out_of_order":
      return `${name} for ${binding} sorts before a migration that already applied.`;
  }
}
