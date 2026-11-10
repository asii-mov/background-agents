import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey } from "../auth/crypto";
import {
  createTestEnv,
  createTestRequestHandler,
  fakeSessionRuntimeDispatch,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "../router.test-support";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { sessionMcpArtifactRoutes } from "./session-mcp-artifacts";

const { getPinnedArtifact } = vi.hoisted(() => ({ getPinnedArtifact: vi.fn() }));

vi.mock("../db/mcp-servers", () => ({
  McpServerStore: class {
    getPinnedArtifact = getPinnedArtifact;
  },
}));

const handleRequest = createTestRequestHandler([sessionMcpArtifactRoutes]);

function createEnv(get: ReturnType<typeof vi.fn>, sandboxTokenValid = true): Env {
  return createTestEnv({
    REPO_SECRETS_ENCRYPTION_KEY: generateEncryptionKey(),
    MEDIA_BUCKET: { get } as unknown as Env["MEDIA_BUCKET"],
    SESSION: fakeSessionRuntimeDispatch(async (request) =>
      new URL(request.url).pathname === SessionInternalPaths.verifySandboxToken && sandboxTokenValid
        ? Response.json({ sandboxId: "sandbox-1" })
        : new Response("Unauthorized", { status: 401 })
    ),
  });
}

function requestArtifact(path: string, env: Env): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local${path}`, {
      headers: { Authorization: "Bearer sandbox-token" },
    }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("session MCP artifact route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves only the exact artifact pinned to the authenticated session", async () => {
    getPinnedArtifact.mockResolvedValueOnce({
      key: "mcp-artifacts/abc123.tar.gz",
      sha256: "abc123",
    });
    const get = vi.fn(async () => ({ body: new Blob(["artifact"]).stream() }));

    const response = await requestArtifact(
      "/sessions/session-1/mcp-artifacts/server-1/7",
      createEnv(get)
    );

    expect(getPinnedArtifact).toHaveBeenCalledWith("session-1", "server-1", 7);
    expect(get).toHaveBeenCalledWith("mcp-artifacts/abc123.tar.gz");
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Artifact-Sha256")).toBe("abc123");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.text()).resolves.toBe("artifact");
  });

  it("rejects a sandbox token the session does not recognize", async () => {
    const get = vi.fn();

    const response = await requestArtifact(
      "/sessions/session-1/mcp-artifacts/server-1/7",
      createEnv(get, false)
    );

    expect(response.status).toBe(401);
    expect(getPinnedArtifact).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("does not touch object storage when the session has no matching pin", async () => {
    getPinnedArtifact.mockResolvedValueOnce(null);
    const get = vi.fn();

    const response = await requestArtifact(
      "/sessions/session-1/mcp-artifacts/server-2/8",
      createEnv(get)
    );

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects malformed revisions before database access", async () => {
    const response = await requestArtifact(
      "/sessions/session-1/mcp-artifacts/server-1/0",
      createEnv(vi.fn())
    );

    expect(response.status).toBe(400);
    expect(getPinnedArtifact).not.toHaveBeenCalled();
  });
});
