import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth, serviceFetch } from "./helpers";

const componentInput = {
  name: "Acme authentication",
  kind: "library",
  description: "The reviewed authentication primitive for internal applications.",
  owner: "Product Security",
  locator: "@acme/auth",
  version: "1.2.3",
  integrity: null,
  sourceUrl: "https://github.example.com/platform/auth",
  documentationUrl: "https://docs.example.com/auth",
  usage: "Install the exact version and use createAuthenticatedApp().",
  lifecycle: "approved",
  repoScopes: ["acme/web-app"],
  environmentScopes: null,
  enabled: true,
} as const;

async function createComponent(overrides: Record<string, unknown> = {}) {
  const response = await serviceFetch("https://test.local/approved-components", {
    method: "POST",
    body: JSON.stringify({ ...componentInput, ...overrides }),
  });
  return { response, body: await response.json<Record<string, unknown>>() };
}

async function createSandboxSession() {
  const sessionName = `components-${Date.now()}-${crypto.randomUUID()}`;
  const { stub } = await initNamedSession(sessionName);
  await seedSandboxAuth(stub, { authToken: "component-token", sandboxId: "component-sandbox" });
  return sessionName;
}

function sandboxFetch(sessionName: string, path = "", init: RequestInit = {}) {
  return SELF.fetch(`https://test.local/sessions/${sessionName}/approved-components${path}`, {
    ...init,
    headers: {
      Authorization: "Bearer component-token",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

describe("approved component governance", () => {
  beforeEach(cleanD1Tables);

  it("requires immutable provenance before a primitive can be approved", async () => {
    const invalidLibrary = await createComponent({ version: null });
    expect(invalidLibrary.response.status).toBe(400);
    expect(invalidLibrary.body).toMatchObject({
      error: "approved libraries require an exact version",
    });

    const invalidTemplate = await createComponent({
      name: "Application template",
      kind: "template",
      locator: "https://templates.example.com/service",
      version: null,
      integrity: null,
    });
    expect(invalidTemplate.response.status).toBe(400);
    expect(invalidTemplate.body).toMatchObject({
      error: "approved templates require a SHA-256 integrity digest",
    });
  });

  it("exposes only approved scoped primitives to the sandbox tool", async () => {
    const approved = await createComponent();
    expect(approved.response.status).toBe(201);
    expect(
      (await createComponent({ name: "Draft logger", lifecycle: "development" })).response.status
    ).toBe(201);
    expect(
      (
        await createComponent({
          name: "Other repository auth",
          repoScopes: ["acme/backend"],
        })
      ).response.status
    ).toBe(201);
    const sessionName = await createSandboxSession();

    const response = await sandboxFetch(sessionName, "?query=authentication");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        id: approved.body.id,
        name: "Acme authentication",
        version: "1.2.3",
      }),
    ]);
  });

  it("records revision-aware consumers and rejects repositories outside the session", async () => {
    const created = await createComponent();
    expect(created.response.status).toBe(201);
    const componentId = String(created.body.id);
    const sessionName = await createSandboxSession();

    const denied = await sandboxFetch(sessionName, `/${componentId}/adopt`, {
      method: "POST",
      body: JSON.stringify({ repoOwner: "acme", repoName: "backend" }),
    });
    expect(denied.status).toBe(403);

    const adopted = await sandboxFetch(sessionName, `/${componentId}/adopt`, {
      method: "POST",
      body: JSON.stringify({ repoOwner: "acme", repoName: "web-app" }),
    });
    expect(adopted.status).toBe(201);
    await expect(adopted.json()).resolves.toMatchObject({
      componentId,
      componentRevision: 1,
      componentVersion: "1.2.3",
      repoOwner: "acme",
      repoName: "web-app",
    });

    const update = await serviceFetch(`https://test.local/approved-components/${componentId}`, {
      method: "PUT",
      body: JSON.stringify({ ...componentInput, revision: 1, version: "1.3.0" }),
    });
    expect(update.status).toBe(200);

    const consumers = await serviceFetch(
      `https://test.local/approved-components/${componentId}/consumers`
    );
    expect(consumers.status).toBe(200);
    await expect(consumers.json()).resolves.toEqual([
      expect.objectContaining({ componentRevision: 1, componentVersion: "1.2.3" }),
    ]);

    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionName).run();
    const retained = await serviceFetch(
      `https://test.local/approved-components/${componentId}/consumers`
    );
    await expect(retained.json()).resolves.toEqual([
      expect.objectContaining({ sessionId: sessionName, repoOwner: "acme", repoName: "web-app" }),
    ]);
  });

  it("retains approved and deprecated catalogue entries for consumer discovery", async () => {
    const created = await createComponent();
    const response = await serviceFetch(
      `https://test.local/approved-components/${String(created.body.id)}`,
      { method: "DELETE" }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Approved or deprecated components must be retained for consumer discovery",
    });
  });
});
