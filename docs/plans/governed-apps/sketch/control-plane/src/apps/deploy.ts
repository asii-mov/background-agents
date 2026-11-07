/**
 * packages/control-plane/src/apps/deploy.ts  (FINAL; replaces deploy/candidate-1 deploy.ts)
 *
 * The control plane's part of a deploy is five steps, all idempotent ensures; the broker does the
 * Cloudflare work in one call. No queue, no lease, no DO.
 *
 *   1. authorize       session -> userId -> requirePermission(userId, "apps.deploy")
 *   2. claim           AppStore.claim(name, owner, team): INSERT ... ON CONFLICT DO NOTHING, read back
 *   3. prepare data    appData.prepare(app, "production", manifest, migrations) -> AppDataBindings | blocked
 *   4. host.deploy     broker: Access -> publish(guard + module + bindings) -> attach -> verify
 *   5. commit          AppStore.commitLive(+ ledger row live, previous row superseded) in one batch
 *
 * Takedown: markTakenDown(kind) -> host.takedown -> appData.retire -> markSwept. Re-running finishes a
 * partial sweep. Owner holds are cleared by the owner; admin holds only by apps.manage.any.
 */
import type {
  AppDeployFailure,
  AppDeploySuccess,
  AppName,
  AppSummary,
  AppDeploymentView,
  AppHoldKind,
} from "@open-inspect/shared/apps";
import type {
  AppDataManifest,
  MigrationFile,
  BindingName,
  AppDataBindings,
  DataAdvisory,
  AppDataBlockReason,
} from "@open-inspect/shared/types/app-data";
import type { AuthorizationService } from "../authorization/service";
import type { SqlDatabase } from "../db/sql-database";
import type { DeployRequestBody } from "./bundle";
import type { AppHost } from "./host";
import type { AppRecord, AppStore } from "./store";

export const APP_DEPLOY_DEADLINE_MS = 120_000;

/** The app-data seam (app-data/service.ts implements it). Injected so apps/ never imports app-data/. */
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
    actor: { kind: "user"; userId: string } | { kind: "system"; job: string },
    reason: "takedown"
  ): Promise<void>;
}

export interface AppsDeps {
  db: SqlDatabase;
  store: AppStore;
  host: AppHost;
  appData: AppDataSeam;
  authorization: AuthorizationService;
  appsDomain: string;
  now?: () => number;
}

export type DeployOutcome = AppDeploySuccess | AppDeployFailure;

export async function deployApp(
  deps: AppsDeps,
  input: { sessionId: string; requestId: string; body: DeployRequestBody; signal: AbortSignal }
): Promise<DeployOutcome> {
  // TODO:
  // session = SessionIndexStore.get(sessionId); !session || !session.userId -> permission_denied
  // !await authorization.hasPermission(session.userId, "apps.deploy") -> permission_denied
  // claim = store.claim({ name, ownerUserId: session.userId, ownerTeamId: session.ownerTeamId, now })
  //   taken (other owner, not a teammate) -> name_taken
  //   held by admin -> app_taken_down
  //   owned, record.backend !== null && record.backend !== lastKnownBrokerBackend? -> handled after receipt (hosting_backend_changed)
  // deployment = store.beginDeployment({ name, bundleSha256, hasWorker, assetCount, bundleBytes, sessionId, userId, repo })
  // signal = AbortSignal.any([input.signal, AbortSignal.timeout(APP_DEPLOY_DEADLINE_MS)])
  // data = await appData.prepare(...); blocked -> store.failDeployment(deployment.id, data.reason); return failure(data)
  // bindings = toBrokerBindings(data.bindings)   // SecretText.reveal() only here, inside the request body builder
  // try receipt = await host.deploy({ name, deploymentId: deployment.id, bundle, bindings }, signal)
  //   record.backend && record.backend !== receipt.backend -> hosting_backend_changed (host.takedown is NOT called; the app stays as it was)
  //   store.commitLive({ name, deploymentId, receipt, dataDigest: data.bindings.dataDigest, now })  // one batch: supersede old live row
  //   return { ok: true, url, firstDeploy, version, hasWorker, assetCount, bindings: names, advisories }
  // catch e -> reason = classifyFailure(e); store.failDeployment(deployment.id, reason); never-live row -> status failed; live row stays live
  throw new Error("not implemented");
}

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
      failedStep?: "detach" | "remove_script" | "revoke_access";
    }
  | { ok: false; reason: "not_found" | "forbidden" }
> {
  // kind = actor.scope === "any" && actor.userId !== record.ownerUserId ? "admin_takedown" : "owner_unpublished"
  // store.markTakenDown(kind) -> host.takedown -> appData.retire(name, "production", actor, "takedown") -> store.markSwept
  throw new Error("not implemented");
}

/** Owner holds: owner or any. Admin holds: any only. Clears the hold; the agent redeploys (no stored bundle). */
export async function releaseHold(
  deps: AppsDeps,
  input: { name: AppName; actor: { userId: string; scope: "own" | "any" } }
): Promise<
  { ok: true; app: AppSummary } | { ok: false; reason: "not_found" | "forbidden" | "not_held" }
> {
  throw new Error("not implemented");
}

/** apps.read: every app (directory). Data details live under /apps/:name/data with the manage requirement. */
export async function listApps(
  deps: Pick<AppsDeps, "store" | "appsDomain">
): Promise<AppSummary[]> {
  throw new Error("not implemented");
}
export async function getApp(
  deps: Pick<AppsDeps, "store" | "appsDomain">,
  name: AppName
): Promise<{ app: AppSummary; deployments: AppDeploymentView[] } | null> {
  throw new Error("not implemented");
}

/**
 * AppHostError -> wire reason: refused|access_guard_failed -> access_guard_failed (error log);
 * hostname_conflict; script_rejected -> hosting_rejected_script (message passthrough, truncated);
 * invalid_name/reserved_name -> same; deadline -> deadline_exceeded; rate_limited/upstream_unavailable/network -> hosting_unavailable (+retryAfterSeconds).
 */
function classifyFailure(error: unknown): AppDeployFailure {
  throw new Error("not implemented");
}

// ---- store.ts signatures (one writer of apps + app_deployments) -----------------------------------
export interface AppStoreShape {
  claim(input: {
    name: AppName;
    ownerUserId: string;
    ownerTeamId: string | null;
    now: number;
  }): Promise<
    | { kind: "owned"; record: AppRecord; firstDeploy: boolean }
    | { kind: "taken" }
    | { kind: "held"; record: AppRecord; hold: AppHoldKind }
  >;
  beginDeployment(input: {
    name: AppName;
    bundleSha256: string;
    hasWorker: boolean;
    assetCount: number;
    bundleBytes: number;
    sessionId: string;
    userId: string;
    repo: { owner: string; name: string } | null;
    now: number;
  }): Promise<{ id: string; version: number }>;
  commitLive(input: {
    name: AppName;
    deploymentId: string;
    backend: string;
    cfVersionId: string;
    accessAud: string;
    dataDigest: string;
    now: number;
  }): Promise<AppRecord>;
  failDeployment(deploymentId: string, reason: string, now: number): Promise<void>;
  markTakenDown(input: {
    name: AppName;
    kind: AppHoldKind;
    actorUserId: string;
    reason: string;
    now: number;
  }): Promise<AppRecord | null>;
  markSwept(name: AppName, now: number): Promise<void>;
  releaseHold(name: AppName, now: number): Promise<AppRecord | null>;
  get(name: AppName): Promise<AppRecord | null>;
  /** Used by routing/app-admission.ts for the `app` requirement. */
  ownerOf(name: AppName): Promise<{ ownerUserId: string; ownerTeamId: string | null } | null>;
  list(): Promise<AppRecord[]>;
  listDeployments(name: AppName, limit: number): Promise<AppDeploymentView[]>;
}
void classifyFailure;
