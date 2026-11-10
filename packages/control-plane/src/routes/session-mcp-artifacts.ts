import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { NO_AUTHORIZATION } from "./shared";
import { McpServerStore } from "../db/mcp-servers";
import { requireRepoSecretsEncryptionKey } from "../env-validation";
import type { Env } from "../types";
import { error, SCM_AGNOSTIC_SANDBOX_ROUTE, type SandboxRouteContext } from "./shared";

async function handleMcpArtifact(
  _request: Request,
  env: Env,
  match: Record<string, string>,
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = match.id;
  const serverId = match.serverId;
  const revision = Number(match.revision);
  if (!sessionId || !serverId || !Number.isSafeInteger(revision) || revision < 1) {
    return error("Invalid MCP artifact target", 400);
  }
  const pinned = await new McpServerStore(
    ctx.db,
    requireRepoSecretsEncryptionKey(env)
  ).getPinnedArtifact(sessionId, serverId, revision);
  if (!pinned) return error("MCP artifact not found", 404);
  const object = await env.MEDIA_BUCKET.get(pinned.key);
  if (!object) return error("MCP artifact is unavailable", 503);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/gzip",
    "X-Artifact-Sha256": pinned.sha256,
  });
  return new Response(object.body, { headers });
}

export const sessionMcpArtifactRoutes = new Hono<ControlPlaneHonoEnv>();
sessionMcpArtifactRoutes.get(
  "/sessions/:id/mcp-artifacts/:serverId/:revision",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleMcpArtifact)
);
