import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey } from "../auth/crypto";
import type { SqlDatabase } from "../db/sql-database";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import type { Env } from "../types";
import { sessionMcpArtifactRoutes } from "./session-mcp-artifacts";
import type { SandboxRouteContext } from "./shared";

const { getPinnedArtifact } = vi.hoisted(() => ({ getPinnedArtifact: vi.fn() }));

vi.mock("../db/mcp-servers", () => ({
  McpServerStore: class {
    getPinnedArtifact = getPinnedArtifact;
  },
}));

function createContext(): SandboxRouteContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db: {} as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    principal: { kind: "sandbox", sessionId: "session-1" },
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function getArtifactRoute(path: string) {
  const route = sessionMcpArtifactRoutes.find(
    (candidate) => candidate.method === "GET" && path.match(candidate.pattern)
  );
  if (!route) throw new Error("MCP artifact route not found");
  const match = path.match(route.pattern);
  if (!match) throw new Error("MCP artifact route did not match");
  return { route, match };
}

function createEnv(get: ReturnType<typeof vi.fn>): Env {
  return {
    REPO_SECRETS_ENCRYPTION_KEY: generateEncryptionKey(),
    MEDIA_BUCKET: { get },
  } as unknown as Env;
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
    const path = "/sessions/session-1/mcp-artifacts/server-1/7";
    const { route, match } = getArtifactRoute(path);

    const response = await route.handler(
      new Request(`https://test.local${path}`),
      createEnv(get),
      match,
      createContext()
    );

    expect(getPinnedArtifact).toHaveBeenCalledWith("session-1", "server-1", 7);
    expect(get).toHaveBeenCalledWith("mcp-artifacts/abc123.tar.gz");
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Artifact-Sha256")).toBe("abc123");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.text()).resolves.toBe("artifact");
  });

  it("does not touch object storage when the session has no matching pin", async () => {
    getPinnedArtifact.mockResolvedValueOnce(null);
    const get = vi.fn();
    const path = "/sessions/session-1/mcp-artifacts/server-2/8";
    const { route, match } = getArtifactRoute(path);

    const response = await route.handler(
      new Request(`https://test.local${path}`),
      createEnv(get),
      match,
      createContext()
    );

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects malformed revisions before database access", async () => {
    const path = "/sessions/session-1/mcp-artifacts/server-1/0";
    const { route, match } = getArtifactRoute(path);

    const response = await route.handler(
      new Request(`https://test.local${path}`),
      createEnv(vi.fn()),
      match,
      createContext()
    );

    expect(response.status).toBe(400);
    expect(getPinnedArtifact).not.toHaveBeenCalled();
  });
});
