import { describe, expect, it, vi } from "vitest";
import type {
  McpServerConfig,
  SandboxNetworkPolicy,
} from "@open-inspect/shared/types/integrations";
import type { SecurityPipelineConfig } from "@open-inspect/shared/types/security-pipelines";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import {
  createMockSession,
  createMockSandbox,
  createMockStorage,
  createMockProvider,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createUnmanagedShutdown,
  createTestConfig,
  createTestLifecycleManager,
} from "./test-helpers";

const servers: McpServerConfig[] = [
  {
    id: "mcp-1",
    name: "Governed MCP",
    type: "local",
    enabled: true,
    command: ["tool"],
    revision: 1,
    artifactSha256: "a".repeat(64),
    artifactExecutable: "tool",
  },
];
const pipelines: SecurityPipelineConfig[] = [
  {
    id: "checks",
    name: "Security",
    commands: [{ name: "check", command: ["check"], timeoutSeconds: 30 }],
    blocking: true,
    maxRemediationAttempts: 0,
    repoScopes: null,
  },
];

function setup(kind: "spawn" | "restore", harness: "opencode" | "claude" = "opencode") {
  const session = createMockSession({ harness, environment_id: "environment-1" });
  const storage = createMockStorage(
    session,
    createMockSandbox({
      status: kind === "spawn" ? "pending" : "stopped",
      snapshot_image_id: kind === "restore" ? "image" : null,
      snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
    })
  );
  storage.getSessionRepositories = () => [
    { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
  ];
  const provider = createMockProvider();
  provider.capabilities.supportsNetworkEgressPolicy = true;
  const getDecryptedForSession = vi.fn(async () => servers);
  const getForSession = vi.fn(async () => pipelines);
  const networkPolicy: SandboxNetworkPolicy = { mode: "blocked" };
  const networkLookup = vi.fn(async () => networkPolicy);
  const manager = createTestLifecycleManager(
    provider,
    storage,
    storage,
    createMockBroadcaster(),
    createMockWebSocketManager(false),
    createMockAlarmScheduler(),
    createMockIdGenerator(),
    createUnmanagedShutdown(),
    {
      ...createTestConfig(),
      mcpServerLookup: { getDecryptedForSession },
      securityPipelineLookup: { getForSession },
      sandboxNetworkPolicyLookup: { getForSession: networkLookup },
    }
  );
  return { manager, provider, session, getDecryptedForSession, getForSession, networkLookup };
}

describe.each(["spawn", "restore"] as const)("governed %s", (kind) => {
  it("passes pinned MCP, security pipelines and current network policy to the provider", async () => {
    const h = setup(kind);
    await h.manager.spawnSandbox();
    const launch =
      kind === "spawn"
        ? vi.mocked(h.provider.createSandbox).mock.calls[0]?.[0]
        : vi.mocked(h.provider.restoreFromSnapshot!).mock.calls[0]?.[0];
    expect(launch).toMatchObject({
      mcpServers: servers,
      securityPipelines: pipelines,
      sandboxSettings: { networkPolicy: { mode: "blocked" } },
    });
    expect(h.getDecryptedForSession).toHaveBeenCalledWith(
      h.session.session_name,
      [{ repoOwner: "testowner", repoName: "testrepo" }],
      "environment-1"
    );
  });
  it("rejects governed Claude before a provider launch", async () => {
    const h = setup(kind, "claude");
    await h.manager.spawnSandbox();
    expect(h.provider.createSandbox).not.toHaveBeenCalled();
    expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
  });
  it("fails closed when mandatory pipeline resolution fails", async () => {
    const h = setup(kind);
    h.getForSession.mockRejectedValue(new Error("unavailable"));
    await h.manager.spawnSandbox();
    expect(h.provider.createSandbox).not.toHaveBeenCalled();
    expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
  });
  it("rejects a restrictive network policy on an unsupported provider", async () => {
    const h = setup(kind);
    h.provider.capabilities.supportsNetworkEgressPolicy = false;
    await h.manager.spawnSandbox();
    expect(h.provider.createSandbox).not.toHaveBeenCalled();
    expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
  });
});
