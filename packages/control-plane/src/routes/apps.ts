/**
 * Agent-deployed internal apps: the sandbox deploy route, the directory, takedown and holds. A thin
 * HTTP shell over apps/: admission, boundary parse, one call, outcome to status. Like
 * slack-notify, the deploy route emits no transcript events; the agent's own tool call is the
 * session record, and audit detail lives in structured logs and the deployments ledger.
 */

import { Hono } from "hono";
import {
  APP_DEPLOY_FAILURE_STATUS,
  appTakedownRequestSchema,
  parseAppName,
  type AppDeployFailure,
  type AppName,
} from "@open-inspect/shared/apps";
import { resolveScopedPermission } from "@open-inspect/shared/rbac";
import {
  appsFromEnv,
  deployApp,
  getApp,
  listApps,
  readDeployRequest,
  releaseHold,
  takeDownApp,
  type CanManageApp,
} from "../apps";
import { resourceViewer } from "../authorization/resource-viewer";
import { admit, dispatch } from "../routing/admit";
import { canManageApp } from "../routing/app-admission";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  json,
  NO_AUTHORIZATION,
  requireApp,
  requirePermission,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  type SandboxRouteContext,
} from "./shared";

function failure(outcome: AppDeployFailure): Response {
  return json(outcome, APP_DEPLOY_FAILURE_STATUS[outcome.reason]);
}

/** The admitted actor's `apps.manage` scope; route admission guarantees one exists. */
function manageScope(ctx: RequestContext): { userId: string; scope: "own" | "any" } {
  const scope = ctx.authorization
    ? resolveScopedPermission("apps.manage", ctx.authorization.permissions)
    : null;
  if (!ctx.authorization || !scope) throw new Error("App management route was not admitted");
  return { userId: ctx.authorization.userId, scope };
}

/** `apps.read` admits the viewer; only someone who may manage an app sees what deployed it. */
async function canManageFor(ctx: RequestContext): Promise<CanManageApp> {
  const viewer = await resourceViewer(ctx);
  return (owner) => canManageApp(viewer, owner);
}

function appNameParam(raw: string): AppName | null {
  const parsed = parseAppName(raw);
  return parsed.ok ? parsed.name : null;
}

async function handleDeploy(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const apps = appsFromEnv(env, ctx.db);
  if (!apps.ok) return failure(apps.failure);
  const body = await readDeployRequest(request);
  if (!body.ok) return failure({ ok: false, reason: body.reason, message: body.message });
  const outcome = await deployApp(apps.deps, {
    sessionId: params.id,
    requestId: ctx.request_id,
    body: body.value,
    signal: request.signal,
  });
  return outcome.ok ? json(outcome) : failure(outcome);
}

async function handleList(
  _request: Request,
  env: Env,
  _params: Record<string, never>,
  ctx: RequestContext
): Promise<Response> {
  const apps = appsFromEnv(env, ctx.db);
  if (!apps.ok) return failure(apps.failure);
  return json({ apps: await listApps(apps.deps, await canManageFor(ctx)) });
}

async function handleGet(
  _request: Request,
  env: Env,
  params: { name: string },
  ctx: RequestContext
): Promise<Response> {
  const apps = appsFromEnv(env, ctx.db);
  if (!apps.ok) return failure(apps.failure);
  const name = appNameParam(params.name);
  const found = name ? await getApp(apps.deps, name, await canManageFor(ctx)) : null;
  return found ? json(found) : error("App not found", 404);
}

async function handleTakedown(
  request: Request,
  env: Env,
  params: { name: string },
  ctx: RequestContext
): Promise<Response> {
  const apps = appsFromEnv(env, ctx.db);
  if (!apps.ok) return failure(apps.failure);
  const body = await parseBody(request, appTakedownRequestSchema);
  if (body instanceof Response) return body;
  const name = appNameParam(params.name);
  const outcome = name
    ? await takeDownApp(apps.deps, {
        name,
        actor: manageScope(ctx),
        reason: body.reason,
        signal: request.signal,
      })
    : null;
  if (!outcome?.ok) return error("App not found", 404);
  const { ok: _ok, ...result } = outcome;
  return json(result);
}

const RELEASE_REFUSAL = {
  not_found: { status: 404, message: "App not found" },
  forbidden: { status: 403, message: "Only an administrator can release an administrator's hold" },
  not_held: { status: 409, message: "The app is not taken down" },
  sweep_incomplete: {
    status: 409,
    message: "Cleanup of the app is incomplete. Take it down again to finish, then release it.",
  },
} as const;

async function handleReleaseHold(
  _request: Request,
  env: Env,
  params: { name: string },
  ctx: RequestContext
): Promise<Response> {
  const apps = appsFromEnv(env, ctx.db);
  if (!apps.ok) return failure(apps.failure);
  const name = appNameParam(params.name);
  const outcome = name
    ? await releaseHold(apps.deps, { name, actor: manageScope(ctx) })
    : ({ ok: false, reason: "not_found" } as const);
  if (!outcome.ok) {
    const refusal = RELEASE_REFUSAL[outcome.reason];
    return error(refusal.message, refusal.status);
  }
  return json({ app: outcome.app });
}

export const appRoutes = new Hono<ControlPlaneHonoEnv>();

appRoutes.post(
  "/sessions/:id/apps",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleDeploy)
);
appRoutes.get(
  "/apps",
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, authorization: requirePermission("apps.read") }),
  (c) => dispatch(c, handleList)
);
appRoutes.get(
  "/apps/:name",
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, authorization: requirePermission("apps.read") }),
  (c) => dispatch(c, handleGet)
);
appRoutes.post(
  "/apps/:name/takedown",
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, authorization: requireApp("manage") }),
  (c) => dispatch(c, handleTakedown)
);
appRoutes.post(
  "/apps/:name/release-hold",
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, authorization: requireApp("manage") }),
  (c) => dispatch(c, handleReleaseHold)
);
