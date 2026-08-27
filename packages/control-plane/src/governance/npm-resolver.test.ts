import { describe, expect, it, vi } from "vitest";
import { resolveDesiredMcpServer } from "./npm-resolver";

describe("resolveDesiredMcpServer", () => {
  it("resolves an automatic range to an exact package and integrity hash", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        "dist-tags": { latest: "4.0.0" },
        versions: {
          "3.1.0": {
            bin: { "context-mcp": "bin.js" },
            dist: { integrity: "sha512-old", tarball: "https://registry.example/old.tgz" },
          },
          "3.4.2": {
            bin: { "context-mcp": "bin.js" },
            dist: {
              integrity: "sha512-selected",
              tarball: "https://registry.example/selected.tgz",
            },
          },
          "4.0.0": {
            bin: { "context-mcp": "bin.js" },
            dist: { integrity: "sha512-next-major", tarball: "https://registry.example/next.tgz" },
          },
        },
      })
    );
    const result = await resolveDesiredMcpServer(
      "mcps/context.yaml",
      {
        schemaVersion: 1,
        name: "context",
        type: "local",
        package: "@company/context-mcp",
        args: ["--safe"],
        lifecycle: "approved",
        enabled: true,
        repoScopes: null,
        environmentScopes: null,
        updatePolicy: { automatic: true, channel: "latest", range: "^3" },
      },
      { fetchImpl }
    );

    expect(result.command).toEqual(["context-mcp", "--safe"]);
    expect(result.resolvedVersion).toBe("3.4.2");
    expect(result.resolvedIntegrity).toBe("sha512-selected");
    expect(result.tarballUrl).toBe("https://registry.example/selected.tgz");
  });

  it("requires an explicit executable when a package declares several", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            bin: { one: "one.js", two: "two.js" },
            dist: { integrity: "sha512-value", tarball: "https://registry.example/pkg.tgz" },
          },
        },
      })
    );
    const desired = {
      schemaVersion: 1 as const,
      name: "context",
      type: "local" as const,
      package: "context-mcp",
      args: [],
      lifecycle: "approved" as const,
      enabled: true,
      repoScopes: null,
      environmentScopes: null,
      updatePolicy: { automatic: true as const, channel: "latest" },
    };

    await expect(resolveDesiredMcpServer("mcp.yaml", desired, { fetchImpl })).rejects.toThrow(
      /exactly one executable/
    );
    await expect(
      resolveDesiredMcpServer("mcp.yaml", { ...desired, executable: "two" }, { fetchImpl })
    ).resolves.toMatchObject({ executable: "two", command: ["two"] });
  });

  it("never sends registry credentials to an insecure registry", async () => {
    await expect(
      resolveDesiredMcpServer(
        "mcp.yaml",
        {
          schemaVersion: 1,
          name: "context",
          type: "local",
          package: "context-mcp",
          args: [],
          lifecycle: "approved",
          enabled: true,
          repoScopes: null,
          environmentScopes: null,
          updatePolicy: { automatic: true, channel: "latest" },
        },
        { registryToken: "secret", defaultRegistryUrl: "http://registry.example.com" }
      )
    ).rejects.toThrow(/HTTPS/);
  });
});
