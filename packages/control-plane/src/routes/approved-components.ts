import { parseJsonBody } from "./body";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { activeGlobal, NO_AUTHORIZATION } from "./shared";
import {
  adoptApprovedComponentSchema,
  createApprovedComponentSchema,
  updateApprovedComponentSchema,
} from "@open-inspect/shared/types/approved-components";
import {
  ApprovedComponentConflictError,
  ApprovedComponentStore,
  ApprovedComponentValidationError,
  GitManagedCatalogueError,
} from "../db/approved-components";
import type { Env } from "../types";
import {
  error,
  json,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  type SandboxRouteContext,
} from "./shared";

function actorUserId(ctx: RequestContext): string {
  if (ctx.principal?.kind === "user") return ctx.principal.userId;
  if (ctx.principal?.kind === "service") {
    return ctx.principal.actor?.canonicalUserId ?? "system";
  }
  return "system";
}

function idFromMatch(match: Record<string, string>): string | null {
  return match.componentId ?? null;
}

async function listComponents(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  return json(await new ApprovedComponentStore(ctx.db).list());
}

async function createComponent(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = createApprovedComponentSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid component", 400);
  try {
    return json(
      await new ApprovedComponentStore(ctx.db).create(parsed.data, actorUserId(ctx)),
      201
    );
  } catch (cause) {
    if (cause instanceof ApprovedComponentValidationError) return error(cause.message, 400);
    if (cause instanceof ApprovedComponentConflictError) return error(cause.message, 409);
    throw cause;
  }
}

async function updateComponent(
  request: Request,
  _env: Env,
  match: Record<string, string>,
  ctx: RequestContext
): Promise<Response> {
  const id = idFromMatch(match);
  if (!id) return error("Component ID required", 400);
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = updateApprovedComponentSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid component", 400);
  const { revision, demoteCurrentPreferred, ...definition } = parsed.data;
  try {
    const updated = await new ApprovedComponentStore(ctx.db).update(
      id,
      definition,
      revision,
      actorUserId(ctx),
      { demoteCurrentPreferred }
    );
    return updated ? json(updated) : error("Approved component not found", 404);
  } catch (cause) {
    if (cause instanceof ApprovedComponentConflictError) return error(cause.message, 409);
    if (cause instanceof GitManagedCatalogueError) return error(cause.message, 409);
    if (cause instanceof ApprovedComponentValidationError) return error(cause.message, 400);
    throw cause;
  }
}

async function deleteComponent(
  _request: Request,
  _env: Env,
  match: Record<string, string>,
  ctx: RequestContext
): Promise<Response> {
  const id = idFromMatch(match);
  if (!id) return error("Component ID required", 400);
  try {
    const deleted = await new ApprovedComponentStore(ctx.db).delete(id);
    return deleted ? json({ ok: true }) : error("Approved component not found", 404);
  } catch (cause) {
    if (cause instanceof GitManagedCatalogueError) return error(cause.message, 409);
    if (cause instanceof ApprovedComponentValidationError) return error(cause.message, 400);
    throw cause;
  }
}

async function listConsumers(
  _request: Request,
  _env: Env,
  match: Record<string, string>,
  ctx: RequestContext
): Promise<Response> {
  const id = idFromMatch(match);
  if (!id) return error("Component ID required", 400);
  const store = new ApprovedComponentStore(ctx.db);
  if (!(await store.get(id))) return error("Approved component not found", 404);
  return json(await store.listConsumers(id));
}

async function listSessionComponents(
  request: Request,
  _env: Env,
  match: Record<string, string>,
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = match.id;
  if (!sessionId) return error("Session ID required", 400);
  const query = new URL(request.url).searchParams.get("query")?.trim() ?? "";
  if (query.length > 500) return error("Query is too long", 400);
  return json(await new ApprovedComponentStore(ctx.db).listForSession(sessionId, query));
}

async function adoptSessionComponent(
  request: Request,
  _env: Env,
  match: Record<string, string>,
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = match.id;
  const componentId = idFromMatch(match);
  if (!sessionId || !componentId) return error("Session and component IDs are required", 400);
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = adoptApprovedComponentSchema.safeParse(body);
  if (!parsed.success) return error("Invalid repository", 400);
  try {
    const consumer = await new ApprovedComponentStore(ctx.db).recordConsumption(
      sessionId,
      componentId,
      parsed.data
    );
    return consumer ? json(consumer, 201) : error("Session not found", 404);
  } catch (cause) {
    if (cause instanceof ApprovedComponentConflictError) return error(cause.message, 409);
    if (cause instanceof ApprovedComponentValidationError) return error(cause.message, 403);
    throw cause;
  }
}

export const approvedComponentRoutes = new Hono<ControlPlaneHonoEnv>();
approvedComponentRoutes.get(
  "/approved-components",
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, authorization: activeGlobal() }),
  (c) => dispatch(c, listComponents)
);
approvedComponentRoutes.post(
  "/approved-components",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: activeGlobal(),
    requiredPermission: "catalog.write",
  }),
  (c) => dispatch(c, createComponent)
);
approvedComponentRoutes.put(
  "/approved-components/:componentId",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: activeGlobal(),
    requiredPermission: "catalog.write",
  }),
  (c) => dispatch(c, updateComponent)
);
approvedComponentRoutes.delete(
  "/approved-components/:componentId",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: activeGlobal(),
    requiredPermission: "catalog.write",
  }),
  (c) => dispatch(c, deleteComponent)
);
approvedComponentRoutes.get(
  "/approved-components/:componentId/consumers",
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, authorization: activeGlobal() }),
  (c) => dispatch(c, listConsumers)
);
approvedComponentRoutes.get(
  "/sessions/:id/approved-components",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, listSessionComponents)
);
approvedComponentRoutes.post(
  "/sessions/:id/approved-components/:componentId/adopt",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, adoptSessionComponent)
);
