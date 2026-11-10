import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { requirePermission } from "./shared";
import type { Env } from "../types";
import { getGovernanceCatalogStatus, reconcileGovernanceCatalog } from "../governance/reconciler";
import { SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, type RequestContext, json, error } from "./shared";

async function handleStatus(
  _request: Request,
  env: Env,
  _params: object,
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
  _params: object,
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

const GOVERNANCE_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("governance.read"),
});
const GOVERNANCE_MANAGE = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("governance.manage"),
});

export const governanceCatalogRoutes = new Hono<ControlPlaneHonoEnv>();
governanceCatalogRoutes.get("/governance/catalog", GOVERNANCE_READ, (c) =>
  dispatch(c, handleStatus)
);
governanceCatalogRoutes.post("/governance/catalog/sync", GOVERNANCE_MANAGE, (c) =>
  dispatch(c, handleSync)
);
