import { describe, expect, it, vi } from "vitest";
import type { ResolvedMcpServer } from "./npm-resolver";
import { buildAndStoreMcpArtifact, mcpArtifactBuilderConfig } from "./mcp-artifact-builder";

const server: ResolvedMcpServer = {
  sourcePath: "mcps/context.yaml",
  name: "context",
  type: "local",
  command: ["context-mcp", "--safe"],
  repoScopes: null,
  environmentScopes: null,
  lifecycle: "approved",
  enabled: true,
  resolvedVersion: "3.4.2",
  resolvedIntegrity: "sha512-root",
  packageName: "@company/context-mcp",
  registryUrl: "https://registry.example",
  tarballUrl: "https://registry.example/context.tgz",
  executable: "context-mcp",
};

describe("MCP artifact builder", () => {
  it("requires a complete HTTPS builder configuration", () => {
    expect(mcpArtifactBuilderConfig({})).toBeNull();
    expect(() => mcpArtifactBuilderConfig({ url: "https://builder.example" })).toThrow(/together/);
    expect(() =>
      mcpArtifactBuilderConfig({ url: "http://builder.example", token: "secret" })
    ).toThrow(/HTTPS/);
  });

  it("content-addresses and stores the returned full-closure bundle", async () => {
    const put = vi.fn(async () => undefined);
    let requestBody: string | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response(new TextEncoder().encode("bundle"), {
        headers: { "Content-Type": "application/gzip" },
      });
    });

    const result = await buildAndStoreMcpArtifact(
      server,
      { url: "https://builder.example/", token: "builder-secret" },
      "registry-secret",
      { put },
      fetchImpl
    );

    expect(result).toMatchObject({ executable: "context-mcp" });
    expect(result.key).toBe(`mcp-artifacts/${result.sha256}.tar.gz`);
    expect(put).toHaveBeenCalledWith(result.key, expect.any(ArrayBuffer), expect.any(Object));
    expect(JSON.parse(requestBody ?? "null")).toMatchObject({
      registryToken: "registry-secret",
      integrity: "sha512-root",
    });
  });
});
