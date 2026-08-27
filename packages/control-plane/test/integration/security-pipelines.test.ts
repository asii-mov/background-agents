import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SecurityPipelineStore } from "../../src/db/security-pipelines";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const pipelineInput = {
  name: "AppSec baseline",
  commands: [
    {
      name: "secret scan",
      command: ["gitleaks", "detect", "--no-banner"],
      timeoutSeconds: 120,
    },
  ],
  repoScopes: ["acme/api"],
  environmentScopes: ["production"],
  enabled: true,
  blocking: true,
  maxRemediationAttempts: 2,
};

describe("security pipeline governance", () => {
  beforeEach(cleanD1Tables);

  it("creates, assigns, resolves, and updates a pipeline with revision preconditions", async () => {
    const createdResponse = await serviceFetch("https://test.local/security-pipelines", {
      method: "POST",
      body: JSON.stringify(pipelineInput),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{
      id: string;
      revision: number;
      createdBy: string;
    }>();
    expect(created.createdBy).toBe("11111111111111111111111111111111");

    const store = new SecurityPipelineStore(env.DB);
    await expect(
      store.getForSession([{ repoOwner: "acme", repoName: "api" }], null)
    ).resolves.toEqual([
      expect.objectContaining({
        id: created.id,
        name: "AppSec baseline",
        blocking: true,
        repoScopes: ["acme/api"],
      }),
    ]);
    await expect(store.getForSession([], "production")).resolves.toEqual([
      expect.objectContaining({ id: created.id, repoScopes: null }),
    ]);
    await expect(store.getForSession([], "development")).resolves.toHaveLength(0);

    const updatedResponse = await serviceFetch(
      `https://test.local/security-pipelines/${created.id}`,
      {
        method: "PUT",
        body: JSON.stringify({ revision: created.revision, maxRemediationAttempts: 1 }),
      }
    );
    expect(updatedResponse.status).toBe(200);
    await expect(updatedResponse.json()).resolves.toMatchObject({
      revision: 2,
      maxRemediationAttempts: 1,
    });

    const missingRevision = await serviceFetch(
      `https://test.local/security-pipelines/${created.id}`,
      {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      }
    );
    expect(missingRevision.status).toBe(400);

    const staleResponse = await serviceFetch(
      `https://test.local/security-pipelines/${created.id}`,
      {
        method: "PUT",
        body: JSON.stringify({ revision: created.revision, enabled: false }),
      }
    );
    expect(staleResponse.status).toBe(409);
  });

  it("exposes Skills, MCPs, and approved components through one capability catalogue", async () => {
    const skill = await serviceFetch("https://test.local/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "secure-auth",
        content: { description: "Use approved authentication", body: "Use the shared library." },
        assignments: [{ type: "global" }],
        required: true,
      }),
    });
    expect(skill.status).toBe(201);
    const mcp = await serviceFetch("https://test.local/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "context",
        type: "remote",
        url: "https://mcp.example.com",
        lifecycle: "approved",
      }),
    });
    expect(mcp.status).toBe(201);
    const component = await serviceFetch("https://test.local/approved-components", {
      method: "POST",
      body: JSON.stringify({
        name: "Acme authentication",
        kind: "library",
        description: "Reviewed authentication primitive",
        owner: "Product Security",
        locator: "@acme/auth",
        version: "1.2.3",
        sourceUrl: "https://github.example.com/platform/auth",
        usage: "Install and use createAuthenticatedApp().",
        lifecycle: "approved",
        enabled: true,
      }),
    });
    expect(component.status).toBe(201);

    const response = await serviceFetch("https://test.local/capabilities");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      skills: { skills: [{ name: "secure-auth", required: true }] },
      mcpServers: [{ name: "context", lifecycle: "approved" }],
      approvedComponents: [{ name: "Acme authentication", lifecycle: "approved" }],
    });
  });

  it("applies the simple repository-criticality times change-criticality rule", async () => {
    const profile = await serviceFetch("https://test.local/repository-risk", {
      method: "PUT",
      body: JSON.stringify({
        repoOwner: "acme",
        repoName: "identity",
        criticality: "high",
        rationale: "Production authentication boundary",
      }),
    });
    expect(profile.status).toBe(200);

    const highRisk = await serviceFetch("https://test.local/risk/assess", {
      method: "POST",
      body: JSON.stringify({
        repoOwner: "ACME",
        repoName: "IDENTITY",
        paths: ["src/auth/authorize.ts"],
      }),
    });
    expect(highRisk.status).toBe(200);
    await expect(highRisk.json()).resolves.toEqual({
      repositoryCriticality: "high",
      changeSensitivity: "critical",
      score: 12,
      requiresSecurityReview: true,
      matchedPaths: ["src/auth/authorize.ts"],
    });

    const defaultRisk = await serviceFetch("https://test.local/risk/assess", {
      method: "POST",
      body: JSON.stringify({
        repoOwner: "acme",
        repoName: "unclassified",
        paths: ["docs/readme.md"],
      }),
    });
    await expect(defaultRisk.json()).resolves.toMatchObject({
      repositoryCriticality: "medium",
      changeSensitivity: "low",
      score: 2,
      requiresSecurityReview: false,
    });
  });
});
