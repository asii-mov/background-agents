import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { activeGlobal } from "./shared";
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

export const governanceCatalogRoutes = new Hono<ControlPlaneHonoEnv>();
governanceCatalogRoutes.get(
  "/governance/catalog",
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, authorization: activeGlobal() }),
  (c) => dispatch(c, handleStatus)
);
governanceCatalogRoutes.post(
  "/governance/catalog/sync",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: activeGlobal(),
    requiredPermission: "catalog.write",
  }),
  (c) => dispatch(c, handleSync)
);
