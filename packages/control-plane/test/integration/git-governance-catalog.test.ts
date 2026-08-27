import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { GovernanceCatalogStore } from "../../src/governance/catalog-store";
import type { ParsedGovernanceCatalog } from "../../src/governance/catalog-schema";
import type { ResolvedMcpServer } from "../../src/governance/npm-resolver";
import { McpServerStore } from "../../src/db/mcp-servers";
import { requireRepoSecretsEncryptionKey } from "../../src/env-validation";
import { SkillStore } from "../../src/db/skills";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const source = {
  provider: "github",
  owner: "security",
  name: "agent-catalog",
  ref: "main",
  path: ".openinspect",
};

function catalog(commitSha: string): ParsedGovernanceCatalog {
  return {
    commitSha,
    skills: [
      {
        sourcePath: "skills/secure-auth",
        name: "secure-auth",
        enabled: true,
        required: true,
        assignments: [{ type: "global" }],
        content: {
          description: "Use approved authentication",
          body: "Follow the centrally managed workflow.\n",
          metadata: { owner: "appsec" },
          files: [],
        },
      },
    ],
    mcpServers: [
      {
        sourcePath: "mcps/context.yaml",
        definition: {
          schemaVersion: 1,
          name: "context",
          type: "local",
          package: "@company/context-mcp",
          args: [],
          lifecycle: "approved",
          enabled: true,
          repoScopes: null,
          environmentScopes: null,
          updatePolicy: { automatic: true, channel: "latest", range: "^3" },
        },
      },
    ],
  };
}

function resolved(version: string): ResolvedMcpServer[] {
  const artifactSha256 = (version === "3.1.0" ? "a" : "b").repeat(64);
  return [
    {
      sourcePath: "mcps/context.yaml",
      name: "context",
      type: "local",
      command: ["context-mcp"],
      repoScopes: null,
      environmentScopes: null,
      lifecycle: "approved",
      enabled: true,
      updatePolicy: { automatic: true, channel: "latest", range: "^3" },
      resolvedVersion: version,
      resolvedIntegrity: `sha512-${version}`,
      executable: "context-mcp",
      artifactKey: `mcp-artifacts/${artifactSha256}.tar.gz`,
      artifactSha256,
    },
  ];
}

async function createSession(id: string): Promise<void> {
  await env.DB.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(id, Date.now(), Date.now())
    .run();
}

describe("Git governance catalog", () => {
  beforeEach(cleanD1Tables);

  it("exposes disabled status and refuses manual sync until a Git source is configured", async () => {
    const status = await serviceFetch("https://test.local/governance/catalog");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ configured: false, lastStatus: "idle" });

    const sync = await serviceFetch("https://test.local/governance/catalog/sync", {
      method: "POST",
      body: "{}",
    });
    expect(sync.status).toBe(409);
  });

  it("atomically activates Git state and pins exact MCP revisions per session", async () => {
    const governance = new GovernanceCatalogStore(env.DB);
    const mcps = new McpServerStore(env.DB, requireRepoSecretsEncryptionKey(env));
    await governance.apply(source, catalog("commit-a"), resolved("3.1.0"));

    const skill = await env.DB.prepare(
      "SELECT source_kind, source_path, source_commit_sha FROM skills WHERE name = 'secure-auth'"
    ).first<{ source_kind: string; source_path: string; source_commit_sha: string }>();
    expect(skill).toEqual({
      source_kind: "git",
      source_path: "skills/secure-auth",
      source_commit_sha: "commit-a",
    });
    expect((await mcps.list())[0]).toMatchObject({
      sourceKind: "git",
      resolvedVersion: "3.1.0",
      updatePolicy: { automatic: true, channel: "latest", range: "^3" },
    });

    await createSession("old-session");
    const oldRuntime = await mcps.getDecryptedForSession("old-session", [], null);
    expect(oldRuntime[0]).toMatchObject({
      command: ["context-mcp"],
      resolvedVersion: "3.1.0",
      artifactSha256: "a".repeat(64),
    });
    await mcps.updateCredentials(
      oldRuntime[0].id,
      { env: { INTERNAL_TOKEN: "rotated" } },
      oldRuntime[0].revision!
    );

    await governance.apply(source, catalog("commit-b"), resolved("3.2.0"));
    expect(await mcps.getDecryptedForSession("old-session", [], null)).toEqual([
      expect.objectContaining({
        command: ["context-mcp"],
        resolvedVersion: "3.1.0",
        artifactSha256: "a".repeat(64),
        env: { INTERNAL_TOKEN: "rotated" },
      }),
    ]);
    await expect(mcps.delete(oldRuntime[0].id)).rejects.toThrow(/pinned by an existing session/);
    await createSession("new-session");
    const newRuntime = await mcps.getDecryptedForSession("new-session", [], null);
    expect(newRuntime[0]).toMatchObject({
      revision: 2,
      resolvedVersion: "3.2.0",
      resolvedIntegrity: "sha512-3.2.0",
      artifactSha256: "b".repeat(64),
    });
  });

  it("adopts matching app entries, preserves credentials, and retires unlisted legacy entries", async () => {
    const skills = new SkillStore(env.DB);
    const mcps = new McpServerStore(env.DB, requireRepoSecretsEncryptionKey(env));
    const adoptedSkill = await skills.create(
      {
        name: "secure-auth",
        content: { description: "Legacy", body: "Legacy\n", metadata: {}, files: [] },
        assignments: [{ type: "global" }],
      },
      "legacy-editor"
    );
    const obsoleteSkill = await skills.create(
      {
        name: "obsolete-skill",
        content: { description: "Obsolete", body: "Obsolete\n", metadata: {}, files: [] },
        assignments: [{ type: "global" }],
      },
      "legacy-editor"
    );
    const adoptedMcp = await mcps.create({
      name: "context",
      type: "local",
      command: ["node", "legacy.js"],
      env: { INTERNAL_TOKEN: "preserved" },
    });
    const obsoleteMcp = await mcps.create({
      name: "obsolete-mcp",
      type: "remote",
      url: "https://obsolete.example.com",
    });

    await new GovernanceCatalogStore(env.DB).apply(
      source,
      catalog("adoption-commit"),
      resolved("3.1.0")
    );

    expect(await skills.get(adoptedSkill.id)).toMatchObject({
      id: adoptedSkill.id,
      sourceKind: "git",
      sourcePath: "skills/secure-auth",
    });
    expect(await skills.get(obsoleteSkill.id)).toBeNull();
    expect(await mcps.get(adoptedMcp.id)).toMatchObject({
      id: adoptedMcp.id,
      sourceKind: "git",
      resolvedVersion: "3.1.0",
      hasEnv: true,
    });
    expect(await mcps.get(obsoleteMcp.id)).toMatchObject({
      lifecycle: "deprecated",
      enabled: false,
    });
  });

  it("records a failed attempt without replacing the last good catalog", async () => {
    const governance = new GovernanceCatalogStore(env.DB);
    await governance.apply(source, catalog("good-commit"), resolved("3.1.0"));
    await governance.recordFailure(source, new Error("invalid catalog"), 1234);

    await expect(governance.getStatus(source)).resolves.toMatchObject({
      activeCommitSha: "good-commit",
      lastStatus: "failed",
      lastAttemptedAt: 1234,
      lastError: "invalid catalog",
    });
    const row = await env.DB.prepare(
      "SELECT resolved_version FROM mcp_servers WHERE name = 'context'"
    ).first<{ resolved_version: string }>();
    expect(row?.resolved_version).toBe("3.1.0");
  });
});
