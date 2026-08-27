import {
  adoptApprovedComponentSchema,
  createApprovedComponentSchema,
  updateApprovedComponentSchema,
} from "@open-inspect/shared/types/approved-components";
import {
  ApprovedComponentConflictError,
  ApprovedComponentStore,
  ApprovedComponentValidationError,
} from "../db/approved-components";
import type { Env } from "../types";
import {
  defineRoute,
  defineRoutes,
  error,
  json,
  parseJsonBody,
  parsePattern,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  type Route,
  type SandboxRouteContext,
} from "./shared";

function actorUserId(ctx: RequestContext): string {
  if (ctx.principal?.kind === "user") return ctx.principal.userId;
  if (ctx.principal?.kind === "service") {
    return ctx.principal.actor?.canonicalUserId ?? "system";
  }
  return "system";
}

function idFromMatch(match: RegExpMatchArray): string | null {
  return match.groups?.componentId ?? null;
}

async function listComponents(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  return json(await new ApprovedComponentStore(ctx.db).list());
}

async function createComponent(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
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
    throw cause;
  }
}

async function updateComponent(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = idFromMatch(match);
  if (!id) return error("Component ID required", 400);
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const parsed = updateApprovedComponentSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid component", 400);
  const { revision, ...definition } = parsed.data;
  try {
    const updated = await new ApprovedComponentStore(ctx.db).update(
      id,
      definition,
      revision,
      actorUserId(ctx)
    );
    return updated ? json(updated) : error("Approved component not found", 404);
  } catch (cause) {
    if (cause instanceof ApprovedComponentConflictError) return error(cause.message, 409);
    if (cause instanceof ApprovedComponentValidationError) return error(cause.message, 400);
    throw cause;
  }
}

async function deleteComponent(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = idFromMatch(match);
  if (!id) return error("Component ID required", 400);
  try {
    const deleted = await new ApprovedComponentStore(ctx.db).delete(id);
    return deleted ? json({ ok: true }) : error("Approved component not found", 404);
  } catch (cause) {
    if (cause instanceof ApprovedComponentValidationError) return error(cause.message, 400);
    throw cause;
  }
}

async function listConsumers(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
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
  match: RegExpMatchArray,
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);
  const query = new URL(request.url).searchParams.get("query")?.trim() ?? "";
  if (query.length > 500) return error("Query is too long", 400);
  return json(await new ApprovedComponentStore(ctx.db).listForSession(sessionId, query));
}

async function adoptSessionComponent(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const componentId = idFromMatch(match);
  if (!sessionId || !componentId) return error("Session and component IDs are required", 400);
  const body = await parseJsonBody<unknown>(request);
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
    if (cause instanceof ApprovedComponentValidationError) return error(cause.message, 403);
    throw cause;
  }
}

const managementRoutes = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  { method: "GET", pattern: parsePattern("/approved-components"), handler: listComponents },
  {
    method: "POST",
    pattern: parsePattern("/approved-components"),
    requiredPermission: "catalog.write",
    handler: createComponent,
  },
  {
    method: "PUT",
    pattern: parsePattern("/approved-components/:componentId"),
    requiredPermission: "catalog.write",
    handler: updateComponent,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/approved-components/:componentId"),
    requiredPermission: "catalog.write",
    handler: deleteComponent,
  },
  {
    method: "GET",
    pattern: parsePattern("/approved-components/:componentId/consumers"),
    handler: listConsumers,
  },
]);

export const approvedComponentRoutes: Route[] = [
  ...managementRoutes,
  defineRoute(SCM_AGNOSTIC_SANDBOX_ROUTE, {
    method: "GET",
    pattern: parsePattern("/sessions/:id/approved-components"),
    handler: listSessionComponents,
  }),
  defineRoute(SCM_AGNOSTIC_SANDBOX_ROUTE, {
    method: "POST",
    pattern: parsePattern("/sessions/:id/approved-components/:componentId/adopt"),
    handler: adoptSessionComponent,
  }),
];
