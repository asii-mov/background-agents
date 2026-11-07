import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { activeGlobal } from "./shared";
import { SKILL_LIST_PAGE_SIZE, skillNameSchema } from "@open-inspect/shared/types/skills";
import { McpServerStore } from "../db/mcp-servers";
import { ApprovedComponentStore } from "../db/approved-components";
import { SkillStore } from "../db/skills";
import { requireRepoSecretsEncryptionKey } from "../env-validation";
import type { Env } from "../types";
import { error, json, SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, type RequestContext } from "./shared";

async function handleCapabilityCatalog(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const rawCursor = url.searchParams.get("skillCursor");
  const cursor = rawCursor === null ? null : skillNameSchema.safeParse(rawCursor);
  if (cursor !== null && !cursor.success) return error("Invalid skill cursor", 400);
  const parsedCursor = cursor?.success ? cursor.data : null;

  const [skills, mcpServers, approvedComponents] = await Promise.all([
    new SkillStore(ctx.db).list({
      limit: SKILL_LIST_PAGE_SIZE,
      cursor: parsedCursor,
    }),
    new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env)).list(),
    new ApprovedComponentStore(ctx.db).list(),
  ]);

  return json({ skills, mcpServers, approvedComponents });
}

/** One read model for centrally governed guidance, capabilities, and primitives. */
export const capabilityCatalogRoutes = new Hono<ControlPlaneHonoEnv>();
capabilityCatalogRoutes.get(
  "/capabilities",
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, authorization: activeGlobal() }),
  (c) => dispatch(c, handleCapabilityCatalog)
);
