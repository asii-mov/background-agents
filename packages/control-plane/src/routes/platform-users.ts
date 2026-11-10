import { parseJsonBody } from "./body";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { ACTIVE_SELF } from "./shared";
import { z } from "zod";
import { createLogger } from "../logger";
import { PLATFORM_ROLES, PlatformRoleStore, type PlatformRoleConfig } from "../db/platform-roles";
import type { Env } from "../types";
import { SCM_AGNOSTIC_HUMAN_USER_ROUTE, error, json, type UserRouteContext } from "./shared";

const logger = createLogger("router:platform-users");

const updateRoleSchema = z.object({ role: z.enum(PLATFORM_ROLES) }).strict();

function roleConfig(env: Env): PlatformRoleConfig {
  return {
    adminUsers: env.PLATFORM_ADMIN_USERS,
    editorUsers: env.PLATFORM_EDITOR_USERS,
  };
}

async function handleGetMe(
  _request: Request,
  env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const role = await new PlatformRoleStore(ctx.db, roleConfig(env)).getEffectiveRole(
    ctx.principal.userId
  );
  if (!role) return error("User not found", 404);
  return json({ userId: ctx.principal.userId, role });
}

async function handleListUsers(
  _request: Request,
  env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  return json(await new PlatformRoleStore(ctx.db, roleConfig(env)).listUsers());
}

async function handleUpdateRole(
  request: Request,
  env: Env,
  match: Record<string, string>,
  ctx: UserRouteContext
): Promise<Response> {
  const userId = match.id;
  if (!userId) return error("Missing user ID", 400);
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = updateRoleSchema.safeParse(body);
  if (!parsed.success) return error("Invalid platform role", 400);

  const roles = new PlatformRoleStore(ctx.db, roleConfig(env));
  const updated = await roles.setRole(userId, parsed.data.role);
  if (!updated) return error("User not found", 404);
  logger.info("Platform role updated", {
    event: "platform.role_updated",
    actor_user_id: ctx.principal.userId,
    target_user_id: userId,
    role: parsed.data.role,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return json({ userId, role: parsed.data.role });
}

export const platformUserRoutes = new Hono<ControlPlaneHonoEnv>();
platformUserRoutes.get(
  "/platform/me",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: ACTIVE_SELF,
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, handleGetMe)
);
platformUserRoutes.get(
  "/platform/users",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: ACTIVE_SELF,
    requiredPermission: "platform.manage",
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, handleListUsers)
);
platformUserRoutes.patch(
  "/platform/users/:id/role",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: ACTIVE_SELF,
    requiredPermission: "platform.manage",
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, handleUpdateRole)
);
