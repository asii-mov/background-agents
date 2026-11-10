/**
 * The control plane's part of an app deploy: authorize, claim the name, prepare data, one broker
 * call, commit. Each step is an idempotent ensure, so a timeout or crash is recovered by calling
 * deploy again. No queue, lease or Durable Object.
 *
 * Takedown marks the app, asks the broker to detach, remove and revoke, retires its data, then
 * records the sweep as complete. Re-running it finishes a partial sweep. An owner may clear their
 * own hold; only `apps.manage.any` clears an administrator's.
 */

import {
  APP_DEPLOY_DEADLINE_MS,
  type AppDeployFailure,
  type AppDeployFailureReason,
  type AppDeploySuccess,
  type AppDeploymentEntry,
  type AppDeploymentView,
  type AppDirectoryEntry,
  type AppName,
  type AppSummary,
  type RedactedAppDeploymentView,
  type RedactedAppSummary,
} from "@open-inspect/shared/apps";
import type { FetchClient } from "@open-inspect/shared/service-auth";
import type {
  AppDataBindings,
  AppDataBlockReason,
  AppDataManifest,
  BindingName,
  DataAdvisory,
  MigrationFile,
} from "@open-inspect/shared/types/app-data";
import { createAppDataService, type AppDataService } from "../app-data";
import { AuthorizationError, AuthorizationService } from "../authorization/service";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import { TeamMembershipStore } from "../db/team-memberships";
import { createLogger } from "../logger";
import type { EnvConfig } from "../types";
import { createBrokerClient } from "./broker-client";
import type { DeployRequestBody } from "./bundle";
import { appUrl, parseAppsConfig } from "./config";
import {
  AppHostError,
  type AppHost,
  type AppHostErrorCode,
  type DeployReceipt,
  type TakedownResult,
} from "./host";
import { AppStore, type AppRecord, type DeploymentFacts } from "./store";

const log = createLogger("apps");

/** Deployments shown with an app. */
export const APP_DEPLOYMENT_HISTORY_LIMIT = 20;
/** Broker messages relayed to the agent are cut to this length. */
const RELAYED_MESSAGE_MAX_LENGTH = 2_000;

export type DataActor = { kind: "user"; userId: string } | { kind: "system"; job: string };

/** The app-data seam. Deploy code depends only on this; the composition root wires the service. */
export interface AppDataSeam {
  prepare(input: {
    app: {
      name: AppName;
      ownerUserId: string;
      repository: { repoOwner: string; repoName: string } | null;
      environmentId: string | null;
    };
    stage: "production";
    manifest: AppDataManifest | null;
    migrations: ReadonlyMap<BindingName, readonly MigrationFile[]>;
    actor: { kind: "session"; sessionId: string; userId: string; requestId: string };
  }): Promise<
    | { kind: "ready"; bindings: AppDataBindings; advisories: readonly DataAdvisory[] }
    | {
        kind: "blocked";
        reason: AppDataBlockReason;
        message: string;
        detail?: Record<string, unknown>;
      }
  >;
  retire(
    appName: AppName,
    stage: "production",
    actor: DataActor,
    reason: "takedown"
  ): Promise<void>;
}

export interface AppsDeps {
  db: SqlDatabase;
  host: AppHost;
  appData: AppDataSeam;
  appsDomain: string;
  now?: () => number;
}

export type DeployOutcome = AppDeploySuccess | AppDeployFailure;

function refusal(
  reason: AppDeployFailureReason,
  message: string,
  extra: Pick<AppDeployFailure, "retryAfterSeconds" | "detail"> = {}
): AppDeployFailure {
  return { ok: false, reason, message, ...extra };
}

/** How each broker or transport outcome reaches the agent. */
const HOST_FAILURE_REASON = {
  refused: "access_guard_failed",
  access_guard_failed: "access_guard_failed",
  invalid_name: "invalid_name",
  reserved_name: "reserved_name",
  hostname_conflict: "hostname_conflict",
  script_rejected: "hosting_rejected_script",
  invalid_request: "invalid_bundle",
  too_large: "bundle_too_large",
  unauthorized: "feature_unavailable",
  deadline: "deadline_exceeded",
  not_found: "hosting_unavailable",
  sql_error: "hosting_unavailable",
  rate_limited: "hosting_unavailable",
  upstream_unavailable: "hosting_unavailable",
  network: "hosting_unavailable",
} as const satisfies Record<AppHostErrorCode, AppDeployFailureReason>;

/** Only these carry a message written for the agent; the rest stay generic. */
const RELAYED_CODES: ReadonlySet<AppHostErrorCode> = new Set([
  "script_rejected",
  "invalid_request",
]);

/** Platform faults an operator must see, not the agent's mistakes. */
const OPERATOR_CODES: ReadonlySet<AppHostErrorCode> = new Set([
  "refused",
  "access_guard_failed",
  "unauthorized",
]);

function hostFailure(error: AppHostError): AppDeployFailure {
  const message = RELAYED_CODES.has(error.code)
    ? error.message.slice(0, RELAYED_MESSAGE_MAX_LENGTH)
    : `The hosting step did not complete (${error.code}).`;
  return refusal(
    HOST_FAILURE_REASON[error.code],
    message,
    error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }
  );
}

async function mayDeploy(db: SqlDatabase, userId: string): Promise<boolean> {
  try {
    await new AuthorizationService(db).requirePermission(userId, "apps.deploy");
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) return false;
    throw error;
  }
}

/**
 * Deploy on behalf of a sandbox. The deployer is the session's owner; the sandbox principal itself
 * carries no grants.
 */
export async function deployApp(
  deps: AppsDeps,
  input: { sessionId: string; requestId: string; body: DeployRequestBody; signal: AbortSignal }
): Promise<DeployOutcome> {
  const now = deps.now ?? Date.now;
  const store = new AppStore(deps.db);
  const { name, bundle, data } = input.body;
  const session = await new SessionIndexStore(deps.db).get(input.sessionId);
  const userId = session?.userId ?? null;
  if (!session || !userId) {
    return refusal("permission_denied", "This session has no owner who may deploy apps.");
  }
  if (!(await mayDeploy(deps.db, userId))) {
    return refusal("permission_denied", "The session owner may not deploy apps.");
  }

  const teams = await new TeamMembershipStore(deps.db).listForUser(userId);
  const claim = await store.claim({
    name,
    ownerUserId: userId,
    ownerTeamId: session.ownerTeamId,
    actorTeamIds: new Set(teams.keys()),
    now: now(),
  });
  if (claim.kind === "taken") {
    return refusal("name_taken", `The name ${name} belongs to someone else's app.`);
  }
  if (claim.kind === "held") {
    return refusal("app_taken_down", `An administrator took ${name} down.`);
  }

  const repo =
    session.repoOwner && session.repoName
      ? { owner: session.repoOwner, name: session.repoName }
      : null;
  const facts: DeploymentFacts = {
    name,
    bundleSha256: bundle.sha256,
    hasWorker: bundle.worker !== null,
    assetCount: bundle.assets.length,
    bundleBytes: bundle.bytes,
    sessionId: input.sessionId,
    userId,
    repo,
  };
  const deployment = await store.beginDeployment(facts, now());
  if (deployment.kind === "busy") {
    return refusal(
      "hosting_unavailable",
      `Another deploy of ${name} is still running. Wait for it to finish, then deploy again.`
    );
  }

  const fields = {
    app: name,
    session_id: input.sessionId,
    user_id: userId,
    deployment_id: deployment.id,
    request_id: input.requestId,
  };
  const fail = async (failure: AppDeployFailure, level: "warn" | "error" = "warn") => {
    await store.failDeployment({
      name,
      deploymentId: deployment.id,
      reason: failure.reason,
      now: now(),
    });
    log[level]("App deploy failed", {
      event: "apps.deploy_failed",
      reason: failure.reason,
      ...fields,
    });
    return failure;
  };

  try {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(APP_DEPLOY_DEADLINE_MS)]);
    const prepared = await deps.appData.prepare({
      app: {
        name,
        ownerUserId: claim.record.ownerUserId,
        repository: repo ? { repoOwner: repo.owner, repoName: repo.name } : null,
        environmentId: session.environmentId ?? null,
      },
      stage: "production",
      manifest: data.manifest,
      migrations: data.migrations,
      actor: { kind: "session", sessionId: input.sessionId, userId, requestId: input.requestId },
    });
    if (prepared.kind === "blocked") {
      return await fail(
        refusal(
          prepared.reason,
          prepared.message,
          prepared.detail ? { detail: prepared.detail } : {}
        )
      );
    }

    let receipt: DeployReceipt;
    try {
      receipt = await deps.host.deploy(
        { name, deploymentId: deployment.id, bundle, bindings: prepared.bindings.bindings },
        signal
      );
    } catch (error) {
      if (!(error instanceof AppHostError)) throw error;
      return await fail(hostFailure(error), OPERATOR_CODES.has(error.code) ? "error" : "warn");
    }
    if (claim.record.backend !== null && claim.record.backend !== receipt.backend) {
      return await fail(
        refusal(
          "hosting_backend_changed",
          `${name} is recorded on ${claim.record.backend}, but the platform now hosts on ${receipt.backend}.`
        ),
        "error"
      );
    }

    const committed = await store.commitLive({
      facts,
      deploymentId: deployment.id,
      version: deployment.version,
      receipt,
      // Without bindings there is nothing to digest: no secrets, no databases, no migrations.
      dataDigest: prepared.bindings.bindings.length > 0 ? prepared.bindings.dataDigest : null,
      now: now(),
    });
    if (!committed)
      return await undoUncommitted(deps, name, deployment.id, receipt, fields, signal);

    log.info("App deployed", {
      event: "apps.deployed",
      version: deployment.version,
      backend: receipt.backend,
      first_deploy: receipt.firstDeploy,
      ...fields,
    });
    return {
      ok: true,
      name,
      url: receipt.url,
      firstDeploy: receipt.firstDeploy,
      version: deployment.version,
      hasWorker: facts.hasWorker,
      assetCount: facts.assetCount,
      bindings: prepared.bindings.bindings.map((binding) => binding.name),
      advisories: prepared.advisories,
    };
  } catch (error) {
    // An unexpected fault must not leave the deployment pending and block the next deploy.
    await fail(refusal("hosting_unavailable", "The deploy failed unexpectedly."), "error");
    throw error;
  }
}

/**
 * The broker published, but the commit did not apply. A takedown that raced the deploy wins:
 * whatever the broker attached is swept again. Otherwise a newer deploy closed this one as
 * abandoned, and the agent is told to deploy again.
 */
async function undoUncommitted(
  deps: AppsDeps,
  name: AppName,
  deploymentId: string,
  receipt: DeployReceipt,
  fields: Record<string, unknown>,
  signal: AbortSignal
): Promise<AppDeployFailure> {
  const now = deps.now ?? Date.now;
  const store = new AppStore(deps.db);
  const record = await store.get(name);
  if (!record?.hold) {
    log.warn("App deploy was superseded", { event: "apps.deploy_superseded", ...fields });
    return refusal("deadline_exceeded", "A newer deploy of this app replaced this one.");
  }
  await store.closeDeploymentAsTakenDown(deploymentId, receipt.cfVersionId, now());
  await store.reopenSweep(name, now());
  const sweep = await sweepApp(deps, name, { kind: "system", job: "apps.deploy" }, signal);
  log.warn("App was taken down while it deployed", {
    event: "apps.deploy_raced_takedown",
    cleanup_complete: sweep.cleanupComplete,
    ...fields,
  });
  return refusal("app_taken_down", `${name} was taken down while it deployed.`);
}

/** Broker cleanup, then data retirement, then the sweep is recorded. Safe to repeat. */
async function sweepApp(
  deps: AppsDeps,
  name: AppName,
  actor: DataActor,
  signal: AbortSignal
): Promise<TakedownResult> {
  const now = deps.now ?? Date.now;
  let result: TakedownResult;
  try {
    result = await deps.host.takedown(name, signal);
  } catch (error) {
    if (!(error instanceof AppHostError)) throw error;
    log.warn("App takedown did not complete", {
      event: "apps.takedown_incomplete",
      app: name,
      code: error.code,
    });
    return { cleanupComplete: false };
  }
  if (!result.cleanupComplete) return result;
  await deps.appData.retire(name, "production", actor, "takedown");
  await new AppStore(deps.db).markSwept(name, now());
  return result;
}

function toRedactedAppSummary(record: AppRecord, appsDomain: string): RedactedAppSummary {
  return {
    name: record.name,
    url: appUrl(appsDomain, record.name),
    status: record.status,
    owner: {
      userId: record.ownerUserId,
      displayName: record.ownerDisplayName,
      teamId: record.ownerTeamId,
    },
    backend: record.backend,
    hasWorker: record.hasWorker,
    assetCount: record.assetCount,
    bundleBytes: record.bundleBytes,
    version: record.version,
    lastDeployedAt: record.lastDeployedAt,
    lastErrorReason: record.lastErrorReason,
    takedown: record.hold
      ? {
          kind: record.hold.kind,
          at: record.hold.at,
          byUserId: record.hold.byUserId,
          reason: record.hold.reason,
          cleanupComplete: record.hold.sweptAt !== null,
        }
      : null,
  };
}

function toAppSummary(record: AppRecord, appsDomain: string): AppSummary {
  return {
    ...toRedactedAppSummary(record, appsDomain),
    lastSessionId: record.lastSessionId,
    lastRepo: record.lastRepo,
  };
}

function toRedactedDeploymentView(view: AppDeploymentView): RedactedAppDeploymentView {
  return { ...view, requestedBy: { userId: view.requestedBy.userId } };
}

/** Whether the viewer may manage an app with this owner, and so see what deployed it. */
export type CanManageApp = (owner: { userId: string; teamId: string | null }) => boolean;

function ownerOf(record: AppRecord): { userId: string; teamId: string | null } {
  return { userId: record.ownerUserId, teamId: record.ownerTeamId };
}

/**
 * Take an app down. Route admission has already decided the actor may manage it. An actor with
 * `any` scope who is not the owner places an administrator's hold; anyone else unpublishes.
 */
export async function takeDownApp(
  deps: AppsDeps,
  input: {
    name: AppName;
    actor: { userId: string; scope: "own" | "any" };
    reason: string;
    signal: AbortSignal;
  }
): Promise<
  | {
      ok: true;
      app: AppSummary;
      cleanupComplete: boolean;
      failedStep?: TakedownResult["failedStep"];
    }
  | { ok: false; reason: "not_found" }
> {
  const now = deps.now ?? Date.now;
  const store = new AppStore(deps.db);
  const record = await store.get(input.name);
  if (!record) return { ok: false, reason: "not_found" };
  const kind =
    input.actor.scope === "any" && input.actor.userId !== record.ownerUserId
      ? "admin_takedown"
      : "owner_unpublished";
  await store.markTakenDown({
    name: input.name,
    kind,
    actorUserId: input.actor.userId,
    reason: input.reason,
    now: now(),
  });
  const sweep = await sweepApp(
    deps,
    input.name,
    { kind: "user", userId: input.actor.userId },
    input.signal
  );
  log.info("App taken down", {
    event: "apps.taken_down",
    app: input.name,
    kind,
    actor_user_id: input.actor.userId,
    cleanup_complete: sweep.cleanupComplete,
    failed_step: sweep.failedStep ?? null,
  });
  const app = toAppSummary((await store.get(input.name))!, deps.appsDomain);
  return sweep.failedStep
    ? { ok: true, app, cleanupComplete: sweep.cleanupComplete, failedStep: sweep.failedStep }
    : { ok: true, app, cleanupComplete: sweep.cleanupComplete };
}

/** Clear a swept hold. Owner holds: `own` or `any`. Administrator holds: `any` only. */
export async function releaseHold(
  deps: Pick<AppsDeps, "db" | "appsDomain" | "now">,
  input: { name: AppName; actor: { scope: "own" | "any" } }
): Promise<
  | { ok: true; app: AppSummary }
  | { ok: false; reason: "not_found" | "forbidden" | "not_held" | "sweep_incomplete" }
> {
  const now = deps.now ?? Date.now;
  const store = new AppStore(deps.db);
  const record = await store.get(input.name);
  if (!record) return { ok: false, reason: "not_found" };
  if (!record.hold) return { ok: false, reason: "not_held" };
  if (record.hold.kind === "admin_takedown" && input.actor.scope !== "any") {
    return { ok: false, reason: "forbidden" };
  }
  if (!(await store.releaseHold(input.name, now()))) {
    const current = await store.get(input.name);
    return { ok: false, reason: current?.hold ? "sweep_incomplete" : "not_held" };
  }
  return { ok: true, app: toAppSummary((await store.get(input.name))!, deps.appsDomain) };
}

/** Every app: `apps.read` is a workspace directory. */
export async function listApps(
  deps: Pick<AppsDeps, "db" | "appsDomain">,
  canManage: CanManageApp
): Promise<AppDirectoryEntry[]> {
  const records = await new AppStore(deps.db).list();
  return records.map((record) =>
    canManage(ownerOf(record))
      ? toAppSummary(record, deps.appsDomain)
      : toRedactedAppSummary(record, deps.appsDomain)
  );
}

export async function getApp(
  deps: Pick<AppsDeps, "db" | "appsDomain">,
  name: AppName,
  canManage: CanManageApp
): Promise<{ app: AppDirectoryEntry; deployments: AppDeploymentEntry[] } | null> {
  const store = new AppStore(deps.db);
  const record = await store.get(name);
  if (!record) return null;
  const deployments = await store.listDeployments(name, APP_DEPLOYMENT_HISTORY_LIMIT);
  return canManage(ownerOf(record))
    ? { app: toAppSummary(record, deps.appsDomain), deployments }
    : {
        app: toRedactedAppSummary(record, deps.appsDomain),
        deployments: deployments.map(toRedactedDeploymentView),
      };
}

const globalFetch: FetchClient = { fetch: (input, init) => fetch(input, init) };

/**
 * The composition root routes and the purge sweep use: hosting configuration, the broker client,
 * and app data on the same client. `data` is the full service; `deps.appData` is the same object
 * seen through the deploy seam.
 */
export function appsFromEnv(
  env: EnvConfig,
  db: SqlDatabase,
  fetcher: FetchClient = globalFetch
): { ok: true; deps: AppsDeps; data: AppDataService } | { ok: false; failure: AppDeployFailure } {
  const availability = parseAppsConfig(env);
  const unavailable = {
    ok: false,
    failure: refusal("feature_unavailable", "App hosting is not configured."),
  } as const;
  if (availability.kind === "not_configured") return unavailable;
  if (availability.kind === "invalid") {
    log.error("App hosting is misconfigured", {
      event: "apps.misconfigured",
      problems: availability.problems,
    });
    return unavailable;
  }
  const { config } = availability;
  const host = createBrokerClient({ config, fetch: fetcher });
  const data = createAppDataService({ db, host, env });
  if (!data.ok) {
    log.error("App hosting is misconfigured", {
      event: "apps.misconfigured",
      problems: data.problems,
    });
    return unavailable;
  }
  return {
    ok: true,
    deps: { db, appsDomain: config.appsDomain, host, appData: data.service },
    data: data.service,
  };
}
