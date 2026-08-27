import {
  createSecurityPipelineSchema,
  updateSecurityPipelineSchema,
} from "@open-inspect/shared/types/security-pipelines";
import {
  SecurityPipelineConflictError,
  SecurityPipelineStore,
  SecurityPipelineValidationError,
} from "../db/security-pipelines";
import type { Env } from "../types";
import {
  defineRoutes,
  error,
  json,
  parseJsonBody,
  parsePattern,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  type Route,
} from "./shared";

function actorUserId(ctx: RequestContext): string {
  if (ctx.principal?.kind === "user") return ctx.principal.userId;
  if (ctx.principal?.kind === "service") {
    return ctx.principal.actor?.canonicalUserId ?? "system";
  }
  return "system";
}

async function listPipelines(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  return json(await new SecurityPipelineStore(ctx.db).list());
}

async function createPipeline(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const parsed = createSecurityPipelineSchema.safeParse(body);
  if (!parsed.success) return error("Invalid security pipeline", 400);
  try {
    return json(await new SecurityPipelineStore(ctx.db).create(parsed.data, actorUserId(ctx)), 201);
  } catch (cause) {
    if (cause instanceof SecurityPipelineValidationError) return error(cause.message, 400);
    throw cause;
  }
}

async function updatePipeline(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Missing pipeline ID", 400);
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const parsed = updateSecurityPipelineSchema.safeParse(body);
  if (!parsed.success) return error("Invalid security pipeline", 400);
  const { revision, ...patch } = parsed.data;
  try {
    const updated = await new SecurityPipelineStore(ctx.db).update(
      id,
      patch,
      revision,
      actorUserId(ctx)
    );
    return updated ? json(updated) : error("Security pipeline not found", 404);
  } catch (cause) {
    if (cause instanceof SecurityPipelineConflictError) return error(cause.message, 409);
    if (cause instanceof SecurityPipelineValidationError) return error(cause.message, 400);
    throw cause;
  }
}

async function deletePipeline(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Missing pipeline ID", 400);
  const deleted = await new SecurityPipelineStore(ctx.db).delete(id);
  return deleted ? json({ ok: true }) : error("Security pipeline not found", 404);
}

export const securityPipelineRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  { method: "GET", pattern: parsePattern("/security-pipelines"), handler: listPipelines },
  {
    method: "POST",
    pattern: parsePattern("/security-pipelines"),
    requiredPermission: "catalog.write",
    handler: createPipeline,
  },
  {
    method: "PUT",
    pattern: parsePattern("/security-pipelines/:id"),
    requiredPermission: "catalog.write",
    handler: updatePipeline,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/security-pipelines/:id"),
    requiredPermission: "catalog.write",
    handler: deletePipeline,
  },
]);
