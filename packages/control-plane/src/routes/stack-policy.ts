import { Hono } from "hono";
import {
  parseRepositoryFullName,
  type RepositoryPair,
} from "@open-inspect/shared/types/repositories";
import {
  STACK_POLICY_EXPORT_SCHEMA_VERSION,
  stackObservationInputSchema,
  type StackPolicyExport,
} from "@open-inspect/shared/types/stack-policy";
import { ApprovedComponentStore } from "../db/approved-components";
import type { SqlDatabase } from "../db/sql-database";
import { StackInventoryStore, StackObservationRejectedError } from "../db/stack-inventory";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { repositoryParams } from "./repository-params";
import {
  error,
  json,
  NO_AUTHORIZATION,
  requirePermission,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  type SandboxRouteContext,
} from "./shared";

function inventory(db: SqlDatabase): StackInventoryStore {
  return new StackInventoryStore(db, new ApprovedComponentStore(db));
}

/** `?repo=owner/name`, where the owner may be nested. Absent means no repository-scoped rules. */
function repositoryQuery(request: Request): RepositoryPair | null | Response {
  const raw = new URL(request.url).searchParams.get("repo")?.trim().toLowerCase();
  if (!raw) return null;
  return parseRepositoryFullName(raw) ?? error("repo must be owner/name", 400);
}

async function previewPolicy(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const repository = repositoryQuery(request);
  if (repository instanceof Response) return repository;
  const environmentId = new URL(request.url).searchParams.get("environmentId")?.trim() || null;
  const policy = await new ApprovedComponentStore(ctx.db).compileForSession(
    repository ? [repository] : [],
    environmentId
  );
  return json({ repository, environmentId, policy });
}

async function exportPolicy(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const repository = repositoryQuery(request);
  if (repository instanceof Response) return repository;
  const exported: StackPolicyExport = {
    schemaVersion: STACK_POLICY_EXPORT_SCHEMA_VERSION,
    repository,
    exportedAt: Date.now(),
    policy: await new ApprovedComponentStore(ctx.db).compileForSession(
      repository ? [repository] : [],
      null
    ),
  };
  return json(exported);
}

async function listInventory(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  return json(await inventory(ctx.db).listRepositories());
}

async function inventoryRollup(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  return json(await inventory(ctx.db).rollup());
}

async function repositoryInventory(
  _request: Request,
  _env: Env,
  params: { owner: string; name: string },
  ctx: RequestContext
): Promise<Response> {
  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const found = await inventory(ctx.db).getRepository({
    repoOwner: repository.owner,
    repoName: repository.name,
  });
  return found ? json(found) : error("No stack observations for this repository", 404);
}

async function recordObservation(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const input = await parseBody(request, stackObservationInputSchema);
  if (input instanceof Response) return input;
  try {
    await inventory(ctx.db).recordObservation(params.id, input);
  } catch (cause) {
    if (cause instanceof StackObservationRejectedError) return error(cause.message, 403);
    throw cause;
  }
  return new Response(null, { status: 204 });
}

const GOVERNANCE_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("governance.read"),
});
const SANDBOX = admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION });

/** Stack policy preview and export, stack inventory, and sandbox stack observations. */
export const stackPolicyRoutes = new Hono<ControlPlaneHonoEnv>();
stackPolicyRoutes.get("/stack-policy/preview", GOVERNANCE_READ, (c) => dispatch(c, previewPolicy));
stackPolicyRoutes.get("/stack-policy/export", GOVERNANCE_READ, (c) => dispatch(c, exportPolicy));
stackPolicyRoutes.get("/stack-inventory", GOVERNANCE_READ, (c) => dispatch(c, listInventory));
stackPolicyRoutes.get("/stack-inventory/rollup", GOVERNANCE_READ, (c) =>
  dispatch(c, inventoryRollup)
);
stackPolicyRoutes.get("/stack-inventory/repositories/:owner/:name", GOVERNANCE_READ, (c) =>
  dispatch(c, repositoryInventory)
);
stackPolicyRoutes.post("/sessions/:id/stack-observations", SANDBOX, (c) =>
  dispatch(c, recordObservation)
);
