import { z } from "zod";
import { createLogger } from "../logger";
import { PLATFORM_ROLES, PlatformRoleStore, type PlatformRoleConfig } from "../db/platform-roles";
import type { Env } from "../types";
import {
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  defineRoutes,
  error,
  json,
  parseJsonBody,
  parsePattern,
  type Route,
  type UserRouteContext,
} from "./shared";

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
  _match: RegExpMatchArray,
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
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  return json(await new PlatformRoleStore(ctx.db, roleConfig(env)).listUsers());
}

async function handleUpdateRole(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const userId = match.groups?.id;
  if (!userId) return error("Missing user ID", 400);
  const body = await parseJsonBody<unknown>(request);
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

export const platformUserRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
  {
    method: "GET",
    pattern: parsePattern("/platform/me"),
    cacheControl: "private, no-store",
    handler: handleGetMe,
  },
  {
    method: "GET",
    pattern: parsePattern("/platform/users"),
    requiredPermission: "platform.manage",
    cacheControl: "private, no-store",
    handler: handleListUsers,
  },
  {
    method: "PATCH",
    pattern: parsePattern("/platform/users/:id/role"),
    requiredPermission: "platform.manage",
    cacheControl: "private, no-store",
    handler: handleUpdateRole,
  },
]);
