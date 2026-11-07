import { governanceCatalogConfigFromEnv } from "../governance/reconciler";
import { parseJsonBody } from "./body";
import { parseBody } from "./body";
import {
  createMcpServerInputSchema,
  updateMcpServerCredentialsInputSchema,
  updateMcpServerInputSchema,
} from "@open-inspect/shared/types/integrations";
import {
  McpServerConflictError,
  McpServerStore,
  McpServerValidationError,
} from "../db/mcp-servers";
import { Hono } from "hono";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { requireRepoSecretsEncryptionKey } from "../env-validation";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  json,
  error,
  requirePermission,
} from "./shared";

const logger = createLogger("router:mcp-servers");

function gitManaged(env: Env): Response | null {
  try {
    return governanceCatalogConfigFromEnv(env)
      ? error(
          "Catalog metadata is managed by Git; submit a change to the governance repository",
          409
        )
      : null;
  } catch (value) {
    return error(value instanceof Error ? value.message : "Invalid governance configuration", 500);
  }
}

function canonicalUserId(ctx: RequestContext): string {
  if (ctx.principal?.kind === "user") return ctx.principal.userId;
  if (ctx.principal?.kind === "service") {
    return ctx.principal.actor?.canonicalUserId ?? "system";
  }
  return "system";
}

async function handleListMcpServers(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);

  const url = new URL(request.url);
  const repo = url.searchParams.get("repo") ?? undefined;
  const environment = url.searchParams.get("environment") ?? undefined;

  const store = new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env));
  const servers = await store.list(repo, environment);
  logger.info("MCP servers listed", {
    event: "mcp_server.list",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    count: servers.length,
  });
  return json(servers);
}

async function handleGetMcpServer(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  if (!ctx.db) return error("Database not configured", 503);

  const store = new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env));
  const server = await store.get(id);
  if (!server) return error("MCP server not found", 404);
  logger.info("MCP server retrieved", {
    event: "mcp_server.get",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    id,
  });
  return json(server);
}

async function handleCreateMcpServer(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  const managed = gitManaged(env);
  if (managed) return managed;

  const parsed = await parseBody(
    request,
    createMcpServerInputSchema,
    "Invalid MCP server configuration"
  );
  if (parsed instanceof Response) return parsed;

  const encryptionKey = requireRepoSecretsEncryptionKey(env);
  try {
    const store = new McpServerStore(ctx.db, encryptionKey);
    const server = await store.create(parsed, canonicalUserId(ctx));
    logger.info("MCP server created", {
      event: "mcp_server.created",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id: server.id,
      name: server.name,
    });
    return json(server, 201);
  } catch (err) {
    if (err instanceof McpServerValidationError) {
      return error(err.message, 400);
    }
    return error("Failed to create MCP server", 503);
  }
}

async function handleUpdateMcpServer(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  if (!ctx.db) return error("Database not configured", 503);
  const managed = gitManaged(env);
  if (managed) return managed;

  const parsed = await parseBody(
    request,
    updateMcpServerInputSchema,
    "Invalid MCP server configuration"
  );
  if (parsed instanceof Response) return parsed;

  const encryptionKey = requireRepoSecretsEncryptionKey(env);
  try {
    const store = new McpServerStore(ctx.db, encryptionKey);
    const { revision, ...patch } = parsed;
    const updated = await store.update(id, patch, revision, canonicalUserId(ctx));
    if (!updated) return error("MCP server not found", 404);

    logger.info("MCP server updated", {
      event: "mcp_server.updated",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id,
    });
    return json(updated);
  } catch (err) {
    if (err instanceof McpServerConflictError) {
      return error(err.message, 409);
    }
    if (err instanceof McpServerValidationError) {
      return error(err.message, 400);
    }
    return error("Failed to update MCP server", 503);
  }
}

async function handleDeleteMcpServer(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  if (!ctx.db) return error("Database not configured", 503);
  const managed = gitManaged(env);
  if (managed) return managed;

  const store = new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env));
  let deleted: boolean;
  try {
    deleted = await store.delete(id);
    if (!deleted) return error("MCP server not found", 404);
  } catch (err) {
    if (err instanceof McpServerConflictError) return error(err.message, 409);
    return error("Failed to delete MCP server", 503);
  }

  logger.info("MCP server deleted", {
    event: "mcp_server.deleted",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    id,
  });
  return json({ ok: true });
}

async function handleUpdateMcpCredentials(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;
  if (!id) return error("Missing server ID", 400);
  if (!ctx.db) return error("Database not configured", 503);
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = updateMcpServerCredentialsInputSchema.safeParse(body);
  if (!parsed.success) return error("Invalid MCP server credentials", 400);
  const { revision, ...credentials } = parsed.data;
  try {
    const updated = await new McpServerStore(
      ctx.db,
      requireRepoSecretsEncryptionKey(env)
    ).updateCredentials(id, credentials, revision, canonicalUserId(ctx));
    return updated ? json(updated) : error("MCP server not found", 404);
  } catch (value) {
    if (value instanceof McpServerConflictError) return error(value.message, 409);
    if (value instanceof McpServerValidationError) return error(value.message, 400);
    return error("Failed to update MCP server credentials", 503);
  }
}

const MCP_READ = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("mcp_servers.read"),
});
const MCP_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("mcp_servers.manage"),
  requiredPermission: "catalog.write",
});

export const mcpServerRoutes = new Hono<ControlPlaneHonoEnv>();

mcpServerRoutes.get("/mcp-servers", MCP_READ, (c) => dispatch(c, handleListMcpServers));
mcpServerRoutes.post("/mcp-servers", MCP_MANAGE, (c) => dispatch(c, handleCreateMcpServer));
mcpServerRoutes.get("/mcp-servers/:id", MCP_READ, (c) => dispatch(c, handleGetMcpServer));
mcpServerRoutes.put("/mcp-servers/:id", MCP_MANAGE, (c) => dispatch(c, handleUpdateMcpServer));
mcpServerRoutes.delete("/mcp-servers/:id", MCP_MANAGE, (c) => dispatch(c, handleDeleteMcpServer));

mcpServerRoutes.put("/mcp-servers/:id/credentials", MCP_MANAGE, (c) =>
  dispatch(c, handleUpdateMcpCredentials)
);
