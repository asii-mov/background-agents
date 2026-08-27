import type { Env } from "../types";
import { getGovernanceCatalogStatus, reconcileGovernanceCatalog } from "../governance/reconciler";
import {
  type Route,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  defineRoutes,
  type RequestContext,
  parsePattern,
  json,
  error,
} from "./shared";

async function handleStatus(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  try {
    return json(await getGovernanceCatalogStatus(env, ctx.db));
  } catch (value) {
    return error(value instanceof Error ? value.message : "Invalid governance configuration", 500);
  }
}

async function handleSync(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  try {
    return json(await reconcileGovernanceCatalog(env));
  } catch (value) {
    const message = value instanceof Error ? value.message : "Governance catalog sync failed";
    return error(message, message.includes("not configured") ? 409 : 422);
  }
}

export const governanceCatalogRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  {
    method: "GET",
    pattern: parsePattern("/governance/catalog"),
    handler: handleStatus,
  },
  {
    method: "POST",
    pattern: parsePattern("/governance/catalog/sync"),
    requiredPermission: "catalog.write",
    handler: handleSync,
  },
]);
