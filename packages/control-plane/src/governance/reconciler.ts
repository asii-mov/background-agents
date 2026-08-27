import { validateApprovedMcpServer } from "../db/mcp-servers";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import { createSourceControlProviderFromEnv } from "../source-control/provider-from-env";
import { readRepositorySnapshot } from "../source-control/repository-snapshot";
import type { Env } from "../types";
import {
  GOVERNANCE_MAX_BYTES,
  GOVERNANCE_MAX_FILES,
  parseGovernanceCatalog,
} from "./catalog-schema";
import {
  GovernanceCatalogStore,
  type GovernanceCatalogStatus,
  type GovernanceSource,
} from "./catalog-store";
import { resolveDesiredMcpServer, type ResolvedMcpServer } from "./npm-resolver";
import { buildAndStoreMcpArtifact, mcpArtifactBuilderConfig } from "./mcp-artifact-builder";

const log = createLogger("governance:reconciler");

/** Runs every 15 minutes, offset from the other control-plane schedules. */
export const GOVERNANCE_CATALOG_SYNC_CRON = "11,26,41,56 * * * *";

export interface GovernanceCatalogConfig {
  owner: string;
  name: string;
  ref: string;
  path: string;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function governanceCatalogConfigFromEnv(env: Env): GovernanceCatalogConfig | null {
  const owner = optionalTrimmed(env.GOVERNANCE_REPO_OWNER);
  const name = optionalTrimmed(env.GOVERNANCE_REPO_NAME);
  if (!owner && !name) return null;
  if (!owner || !name) {
    throw new Error("GOVERNANCE_REPO_OWNER and GOVERNANCE_REPO_NAME must be set together");
  }
  const ref = optionalTrimmed(env.GOVERNANCE_REPO_REF) ?? "main";
  const path = optionalTrimmed(env.GOVERNANCE_REPO_PATH) ?? ".openinspect";
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error("GOVERNANCE_REPO_PATH must be a safe relative POSIX path");
  }
  return { owner, name, ref, path: path.replace(/^\/+|\/+$/g, "") };
}

function sourceFor(env: Env, config: GovernanceCatalogConfig): GovernanceSource {
  return {
    provider: createSourceControlProviderFromEnv(env).name,
    ...config,
  };
}

export async function getGovernanceCatalogStatus(
  env: Env,
  db: SqlDatabase
): Promise<GovernanceCatalogStatus> {
  const config = governanceCatalogConfigFromEnv(env);
  return new GovernanceCatalogStore(db).getStatus(config ? sourceFor(env, config) : undefined);
}

/** Reconcile Git desired state into one atomic, validated last-good catalog. */
export async function reconcileGovernanceCatalogNow(
  env: Env,
  db: SqlDatabase
): Promise<GovernanceCatalogStatus> {
  const config = governanceCatalogConfigFromEnv(env);
  if (!config) throw new Error("Git governance catalog is not configured");
  const provider = createSourceControlProviderFromEnv(env);
  const source: GovernanceSource = { provider: provider.name, ...config };
  const store = new GovernanceCatalogStore(db);
  try {
    const snapshot = await readRepositorySnapshot(provider, {
      owner: config.owner,
      name: config.name,
      ref: config.ref,
      path: config.path,
      maxFiles: GOVERNANCE_MAX_FILES,
      maxBytes: GOVERNANCE_MAX_BYTES,
    });
    const catalog = parseGovernanceCatalog(snapshot, config.path);
    const resolvedMcpMetadata = await Promise.all(
      catalog.mcpServers.map(({ sourcePath, definition }) =>
        resolveDesiredMcpServer(sourcePath, definition, {
          defaultRegistryUrl: env.GOVERNANCE_NPM_REGISTRY_URL,
          registryToken: env.GOVERNANCE_NPM_REGISTRY_TOKEN,
        })
      )
    );
    const builderConfig = mcpArtifactBuilderConfig({
      url: env.GOVERNANCE_MCP_BUILDER_URL,
      token: env.GOVERNANCE_MCP_BUILDER_TOKEN,
    });
    const resolvedMcpServers: ResolvedMcpServer[] = [];
    for (const server of resolvedMcpMetadata) {
      if (server.type === "remote") {
        resolvedMcpServers.push(server);
        continue;
      }
      if (!builderConfig) {
        throw new Error("Local Git-governed MCP servers require an MCP artifact builder");
      }
      const artifact = await buildAndStoreMcpArtifact(
        server,
        builderConfig,
        env.GOVERNANCE_NPM_REGISTRY_TOKEN,
        env.MEDIA_BUCKET
      );
      resolvedMcpServers.push({
        ...server,
        artifactKey: artifact.key,
        artifactSha256: artifact.sha256,
        executable: artifact.executable,
      });
    }
    for (const server of resolvedMcpServers) {
      validateApprovedMcpServer({
        type: server.type,
        command: server.command,
        url: server.url,
        lifecycle: server.lifecycle,
        artifactKey: server.artifactKey,
        artifactSha256: server.artifactSha256,
        artifactExecutable: server.executable,
      });
    }
    await store.apply(source, catalog, resolvedMcpServers);
    log.info("Git governance catalog reconciled", {
      event: "governance_catalog.reconciled",
      commit_sha: catalog.commitSha,
      skills: catalog.skills.length,
      mcp_servers: resolvedMcpServers.length,
    });
    return store.getStatus(source);
  } catch (error) {
    await store.recordFailure(source, error);
    log.error("Git governance catalog reconciliation failed; retaining last good catalog", {
      event: "governance_catalog.failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function reconcileGovernanceCatalog(env: Env): Promise<GovernanceCatalogStatus> {
  const namespace = env.GOVERNANCE_CATALOG;
  if (!namespace) throw new Error("Governance catalogue coordinator is not configured");
  const id = namespace.idFromName("singleton");
  const response = await namespace.get(id).fetch("https://governance.internal/sync", {
    method: "POST",
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : "Governance catalogue sync failed";
    throw new Error(message);
  }
  return body as GovernanceCatalogStatus;
}

export async function runGovernanceCatalogSchedule(env: Env): Promise<void> {
  const config = governanceCatalogConfigFromEnv(env);
  if (!config) return;
  await reconcileGovernanceCatalog(env);
}
