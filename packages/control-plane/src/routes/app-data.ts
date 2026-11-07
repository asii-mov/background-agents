/**
 * App data for people: an app's data summary and ledger, secrets, migration approvals, restores
 * and classification, plus the workspace inventory for governance. The sandbox has no data routes:
 * the deploy bundle carries the manifest and migrations, and the deploy answer carries any block.
 *
 * A thin HTTP shell over app-data/: admission, boundary parse, one call, outcome to status. Every
 * per-app route requires app management (the owner's `own`, or `any`); responses are never cached,
 * and no response ever carries a secret value.
 */

import { Hono } from "hono";
import { parseAppName, type AppName } from "@open-inspect/shared/apps";
import { resolveScopedPermission } from "@open-inspect/shared/rbac";
import {
  APP_STAGES,
  DATA_CLASSIFICATIONS,
  approveMigrationRequestSchema,
  parseBindingName,
  restoreRequestSchema,
  setAppSecretsRequestSchema,
  setClassificationRequestSchema,
  type DataClassification,
} from "@open-inspect/shared/types/app-data";
import type { ActionResult, AppDataRefusalCode, AppDataService, UserActor } from "../app-data";
import { appsFromEnv } from "../apps";
import {
  listAppDataInventory,
  type InventoryStatusFilter,
  type KeysetCursor,
} from "../db/app-data";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  json,
  requireApp,
  requirePermission,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
} from "./shared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const REFUSAL_STATUS = {
  not_found: 404,
  requires_manage_any: 403,
  not_blocked: 409,
  sha_mismatch: 409,
  undeclared_secret: 409,
  invalid_secret: 400,
  confirm_mismatch: 400,
  outside_recovery_window: 400,
  data_unavailable: 502,
} as const satisfies Record<AppDataRefusalCode, number>;

const INVENTORY_STATUS_FILTERS: readonly InventoryStatusFilter[] = ["live", "retired", "purged"];

function answer<T>(result: ActionResult<T>): Response {
  return result.ok
    ? json(result.value)
    : json({ error: result.message, code: result.code }, REFUSAL_STATUS[result.code]);
}

/** The admitted actor; route admission guarantees an `apps.manage` scope. */
function userActor(ctx: RequestContext): UserActor {
  const scope = ctx.authorization
    ? resolveScopedPermission("apps.manage", ctx.authorization.permissions)
    : null;
  if (!ctx.authorization || !scope) throw new Error("App data route was not admitted");
  return { userId: ctx.authorization.userId, scope, requestId: ctx.request_id };
}

/** `?cursor=<ms>.<id>` from a previous page, or null. */
function cursorParam(url: URL): KeysetCursor | null | Response {
  const raw = url.searchParams.get("cursor");
  if (!raw) return null;
  const dot = raw.indexOf(".");
  const at = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  return dot > 0 && Number.isSafeInteger(at) && id ? { at, id } : error("Invalid cursor", 400);
}

function limitParam(url: URL): number | Response {
  const raw = url.searchParams.get("limit");
  if (!raw) return DEFAULT_PAGE_SIZE;
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE
    ? limit
    : error(`limit must be 1 to ${MAX_PAGE_SIZE}`, 400);
}

function encodeCursor(cursor: KeysetCursor | null): string | null {
  return cursor ? `${cursor.at}.${cursor.id}` : null;
}

/** Hosting must be configured, and the name must parse; admission already found the app. */
function withApp(
  env: Env,
  ctx: RequestContext,
  raw: string
): { data: AppDataService; name: AppName } | Response {
  const apps = appsFromEnv(env, ctx.db);
  if (!apps.ok) return json(apps.failure, 503);
  const parsed = parseAppName(raw);
  return parsed.ok ? { data: apps.data, name: parsed.name } : error("App not found", 404);
}

async function handleSummary(
  _request: Request,
  env: Env,
  params: { name: string },
  ctx: RequestContext
): Promise<Response> {
  const app = withApp(env, ctx, params.name);
  if (app instanceof Response) return app;
  return json(await app.data.summary(app.name));
}

async function handleOperations(
  request: Request,
  env: Env,
  params: { name: string },
  ctx: RequestContext
): Promise<Response> {
  const app = withApp(env, ctx, params.name);
  if (app instanceof Response) return app;
  const url = new URL(request.url);
  const cursor = cursorParam(url);
  if (cursor instanceof Response) return cursor;
  const limit = limitParam(url);
  if (limit instanceof Response) return limit;
  const page = await app.data.listOperations(app.name, cursor, limit);
  return json({ operations: page.operations, nextCursor: encodeCursor(page.nextCursor) });
}

async function handleSetSecrets(
  request: Request,
  env: Env,
  params: { name: string },
  ctx: RequestContext
): Promise<Response> {
  const app = withApp(env, ctx, params.name);
  if (app instanceof Response) return app;
  const body = await parseBody(request, setAppSecretsRequestSchema);
  if (body instanceof Response) return body;
  return answer(
    await app.data.setSecrets({
      appName: app.name,
      stage: body.stage,
      secrets: body.secrets,
      actor: userActor(ctx),
    })
  );
}

async function handleDeleteSecret(
  request: Request,
  env: Env,
  params: { name: string; key: string },
  ctx: RequestContext
): Promise<Response> {
  const app = withApp(env, ctx, params.name);
  if (app instanceof Response) return app;
  const stage = APP_STAGES.find(
    (value) => value === (new URL(request.url).searchParams.get("stage") ?? "production")
  );
  const key = parseBindingName(params.key);
  if (!stage || !key) {
    return error("A secret is named by an UPPER_SNAKE_CASE key and a stage", 400);
  }
  return answer(
    await app.data.deleteSecret({ appName: app.name, stage, key, actor: userActor(ctx) })
  );
}

async function handleApprove(
  request: Request,
  env: Env,
  params: { name: string },
  ctx: RequestContext
): Promise<Response> {
  const app = withApp(env, ctx, params.name);
  if (app instanceof Response) return app;
  const body = await parseBody(request, approveMigrationRequestSchema);
  if (body instanceof Response) return body;
  return answer(
    await app.data.approveMigration({ appName: app.name, ...body, actor: userActor(ctx) })
  );
}

async function handleRestore(
  request: Request,
  env: Env,
  params: { name: string },
  ctx: RequestContext
): Promise<Response> {
  const app = withApp(env, ctx, params.name);
  if (app instanceof Response) return app;
  const body = await parseBody(request, restoreRequestSchema);
  if (body instanceof Response) return body;
  return answer(
    await app.data.restoreToPointInTime({ appName: app.name, ...body, actor: userActor(ctx) })
  );
}

async function handleClassification(
  request: Request,
  env: Env,
  params: { name: string },
  ctx: RequestContext
): Promise<Response> {
  const app = withApp(env, ctx, params.name);
  if (app instanceof Response) return app;
  const body = await parseBody(request, setClassificationRequestSchema);
  if (body instanceof Response) return body;
  return answer(
    await app.data.setClassification({
      appName: app.name,
      classification: body.classification,
      actor: userActor(ctx),
    })
  );
}

/** A governance view over D1 only, so it answers even where app hosting is not configured. */
async function handleInventory(
  request: Request,
  _env: Env,
  _params: Record<string, never>,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const rawClassification = url.searchParams.get("classification");
  const rawStatus = url.searchParams.get("status");
  const classification = DATA_CLASSIFICATIONS.find((value) => value === rawClassification);
  const status = INVENTORY_STATUS_FILTERS.find((value) => value === rawStatus);
  if ((rawClassification && !classification) || (rawStatus && !status)) {
    return error("Unknown classification or status filter", 400);
  }
  const cursor = cursorParam(url);
  if (cursor instanceof Response) return cursor;
  const limit = limitParam(url);
  if (limit instanceof Response) return limit;
  const filter: { classification?: DataClassification; status?: InventoryStatusFilter } = {
    ...(classification ? { classification } : {}),
    ...(status ? { status } : {}),
  };
  const page = await listAppDataInventory(ctx.db, filter, cursor, limit);
  return json({ rows: page.rows, nextCursor: encodeCursor(page.nextCursor) });
}

const MANAGE_APP_DATA = {
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  cacheControl: "private, no-store",
  authorization: requireApp("manage"),
} as const;

export const appDataRoutes = new Hono<ControlPlaneHonoEnv>();

appDataRoutes.get("/apps/:name/data", admit(MANAGE_APP_DATA), (c) => dispatch(c, handleSummary));
appDataRoutes.get("/apps/:name/data/operations", admit(MANAGE_APP_DATA), (c) =>
  dispatch(c, handleOperations)
);
appDataRoutes.post("/apps/:name/data/secrets", admit(MANAGE_APP_DATA), (c) =>
  dispatch(c, handleSetSecrets)
);
appDataRoutes.delete("/apps/:name/data/secrets/:key", admit(MANAGE_APP_DATA), (c) =>
  dispatch(c, handleDeleteSecret)
);
appDataRoutes.post("/apps/:name/data/migrations/approve", admit(MANAGE_APP_DATA), (c) =>
  dispatch(c, handleApprove)
);
appDataRoutes.post("/apps/:name/data/restore", admit(MANAGE_APP_DATA), (c) =>
  dispatch(c, handleRestore)
);
appDataRoutes.put("/apps/:name/data/classification", admit(MANAGE_APP_DATA), (c) =>
  dispatch(c, handleClassification)
);
appDataRoutes.get(
  "/app-data/inventory",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    cacheControl: "private, no-store",
    authorization: requirePermission("governance.read"),
  }),
  (c) => dispatch(c, handleInventory)
);
