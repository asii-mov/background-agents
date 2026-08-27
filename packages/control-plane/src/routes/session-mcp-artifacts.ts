import { McpServerStore } from "../db/mcp-servers";
import { requireRepoSecretsEncryptionKey } from "../env-validation";
import type { Env } from "../types";
import {
  defineRoute,
  error,
  parsePattern,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type Route,
  type SandboxRouteContext,
} from "./shared";

async function handleMcpArtifact(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const serverId = match.groups?.serverId;
  const revision = Number(match.groups?.revision);
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

export const sessionMcpArtifactRoutes: Route[] = [
  defineRoute(SCM_AGNOSTIC_SANDBOX_ROUTE, {
    method: "GET",
    pattern: parsePattern("/sessions/:id/mcp-artifacts/:serverId/:revision"),
    handler: handleMcpArtifact,
  }),
];
