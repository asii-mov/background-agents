import type { ResolvedMcpServer } from "./npm-resolver";

const MAX_MCP_ARTIFACT_BYTES = 100 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

export interface McpArtifactBuilderConfig {
  url: string;
  token: string;
}

export interface BuiltMcpArtifact {
  key: string;
  sha256: string;
  executable: string;
}

interface McpArtifactStorage {
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    }
  ): Promise<unknown>;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function mcpArtifactBuilderConfig(input: {
  url?: string;
  token?: string;
}): McpArtifactBuilderConfig | null {
  const rawUrl = input.url?.trim();
  const token = input.token?.trim();
  if (!rawUrl && !token) return null;
  if (!rawUrl || !token) throw new Error("MCP artifact builder URL and token must be set together");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("MCP artifact builder URL must use HTTPS");
  return { url: url.toString(), token };
}

export async function buildAndStoreMcpArtifact(
  server: ResolvedMcpServer,
  config: McpArtifactBuilderConfig,
  registryToken: string | undefined,
  bucket: McpArtifactStorage,
  fetchImpl: typeof fetch = fetch
): Promise<BuiltMcpArtifact> {
  if (
    server.type !== "local" ||
    !server.packageName ||
    !server.resolvedVersion ||
    !server.resolvedIntegrity ||
    !server.registryUrl ||
    !server.tarballUrl ||
    !server.executable
  ) {
    throw new Error(`${server.sourcePath}: local MCP artifact inputs are incomplete`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        packageName: server.packageName,
        version: server.resolvedVersion,
        integrity: server.resolvedIntegrity,
        registryUrl: server.registryUrl,
        registryToken,
        tarballUrl: server.tarballUrl,
        executable: server.executable,
      }),
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(
      `${server.sourcePath}: MCP artifact builder returned ${response.status}: ${(await response.text()).slice(0, 500)}`
    );
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_MCP_ARTIFACT_BYTES) {
    throw new Error(`${server.sourcePath}: MCP artifact exceeds the size limit`);
  }
  const artifact = await response.arrayBuffer();
  if (artifact.byteLength === 0 || artifact.byteLength > MAX_MCP_ARTIFACT_BYTES) {
    throw new Error(`${server.sourcePath}: MCP artifact has an invalid size`);
  }
  const sha256 = toHex(await crypto.subtle.digest("SHA-256", artifact));
  const key = `mcp-artifacts/${sha256}.tar.gz`;
  await bucket.put(key, artifact, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: {
      package: server.packageName,
      version: server.resolvedVersion,
      executable: server.executable,
    },
  });
  return { key, sha256, executable: server.executable };
}
