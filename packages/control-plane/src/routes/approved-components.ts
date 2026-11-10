import { parseBody, parseJsonBody } from "./body";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { NO_AUTHORIZATION, requirePermission } from "./shared";
import {
  adoptApprovedComponentSchema,
  createApprovedComponentSchema,
  updateApprovedComponentSchema,
} from "@open-inspect/shared/types/approved-components";
import {
  componentCategoryInputSchema,
  updateComponentCategorySchema,
} from "@open-inspect/shared/types/stack-policy";
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

function catalogueWriteError(cause: unknown): Response {
  if (cause instanceof ApprovedComponentValidationError) return error(cause.message, 400);
  if (cause instanceof ApprovedComponentConflictError) return error(cause.message, 409);
  if (cause instanceof GitManagedCatalogueError) return error(cause.message, 409);
  throw cause;
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
    return catalogueWriteError(cause);
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
    return catalogueWriteError(cause);
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
    return catalogueWriteError(cause);
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

async function listCategories(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  return json(await new ApprovedComponentStore(ctx.db).listCategories());
}

async function createCategory(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const input = await parseBody(request, componentCategoryInputSchema);
  if (input instanceof Response) return input;
  try {
    return json(
      await new ApprovedComponentStore(ctx.db).createCategory(input, actorUserId(ctx)),
      201
    );
  } catch (cause) {
    return catalogueWriteError(cause);
  }
}

async function updateCategory(
  request: Request,
  _env: Env,
  match: Record<string, string>,
  ctx: RequestContext
): Promise<Response> {
  const id = match.categoryId;
  if (!id) return error("Category ID required", 400);
  const input = await parseBody(request, updateComponentCategorySchema);
  if (input instanceof Response) return input;
  try {
    const updated = await new ApprovedComponentStore(ctx.db).updateCategory(
      id,
      input,
      actorUserId(ctx)
    );
    return updated ? json(updated) : error("Component category not found", 404);
  } catch (cause) {
    return catalogueWriteError(cause);
  }
}

async function deleteCategory(
  _request: Request,
  _env: Env,
  match: Record<string, string>,
  ctx: RequestContext
): Promise<Response> {
  const id = match.categoryId;
  if (!id) return error("Category ID required", 400);
  try {
    const deleted = await new ApprovedComponentStore(ctx.db).deleteCategory(id);
    return deleted ? json({ ok: true }) : error("Component category not found", 404);
  } catch (cause) {
    return catalogueWriteError(cause);
  }
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

const GOVERNANCE_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("governance.read"),
});
const GOVERNANCE_MANAGE = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("governance.manage"),
});
const SANDBOX = admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION });

export const approvedComponentRoutes = new Hono<ControlPlaneHonoEnv>();
approvedComponentRoutes.get("/approved-components", GOVERNANCE_READ, (c) =>
  dispatch(c, listComponents)
);
approvedComponentRoutes.post("/approved-components", GOVERNANCE_MANAGE, (c) =>
  dispatch(c, createComponent)
);
approvedComponentRoutes.put("/approved-components/:componentId", GOVERNANCE_MANAGE, (c) =>
  dispatch(c, updateComponent)
);
approvedComponentRoutes.delete("/approved-components/:componentId", GOVERNANCE_MANAGE, (c) =>
  dispatch(c, deleteComponent)
);
approvedComponentRoutes.get("/approved-components/:componentId/consumers", GOVERNANCE_READ, (c) =>
  dispatch(c, listConsumers)
);
approvedComponentRoutes.get("/component-categories", GOVERNANCE_READ, (c) =>
  dispatch(c, listCategories)
);
approvedComponentRoutes.post("/component-categories", GOVERNANCE_MANAGE, (c) =>
  dispatch(c, createCategory)
);
approvedComponentRoutes.put("/component-categories/:categoryId", GOVERNANCE_MANAGE, (c) =>
  dispatch(c, updateCategory)
);
approvedComponentRoutes.delete("/component-categories/:categoryId", GOVERNANCE_MANAGE, (c) =>
  dispatch(c, deleteCategory)
);
approvedComponentRoutes.get("/sessions/:id/approved-components", SANDBOX, (c) =>
  dispatch(c, listSessionComponents)
);
approvedComponentRoutes.post("/sessions/:id/approved-components/:componentId/adopt", SANDBOX, (c) =>
  dispatch(c, adoptSessionComponent)
);
