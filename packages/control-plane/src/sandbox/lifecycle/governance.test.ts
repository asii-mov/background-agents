import { describe, expect, it, vi } from "vitest";
import type {
  McpServerConfig,
  SandboxNetworkPolicy,
} from "@open-inspect/shared/types/integrations";
import type { SecurityPipelineConfig } from "@open-inspect/shared/types/security-pipelines";
import type { CompiledStackPolicy } from "@open-inspect/shared/types/stack-policy";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import {
  SECURITY_PIPELINES as pipelines,
  STACK_POLICY as stackPolicy,
} from "../governance.test-helpers";
import type { CreateSandboxConfig, RestoreConfig } from "../provider";
import { SANDBOX_TUNNELS_POLICIES, type SandboxTunnelsPolicy } from "../settings";
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

const pinnedServer: McpServerConfig = {
  id: "mcp-1",
  name: "Governed MCP",
  type: "local",
  enabled: true,
  command: ["tool"],
  revision: 1,
  artifactSha256: "a".repeat(64),
  artifactExecutable: "tool",
};
const unpinnedServer: McpServerConfig = {
  id: "mcp-2",
  name: "Docs MCP",
  type: "remote",
  enabled: true,
  url: "https://mcp.example.com",
  revision: 1,
};
interface SetupOptions {
  harness?: "opencode" | "claude";
  servers?: McpServerConfig[];
  pipelines?: SecurityPipelineConfig[];
  policy?: CompiledStackPolicy | null;
  agentAppDeployEnabled?: boolean;
  sandboxTunnelsPolicy?: SandboxTunnelsPolicy;
  sandboxSettings?: string | null;
}

function setup(kind: "spawn" | "restore", options: SetupOptions = {}) {
  const session = createMockSession({
    harness: options.harness ?? "opencode",
    environment_id: "environment-1",
    sandbox_settings: options.sandboxSettings ?? null,
  });
  const storage = createMockStorage(
    session,
    createMockSandbox({
      status: kind === "spawn" ? "pending" : "stopped",
      snapshot_image_id: kind === "restore" ? "image" : null,
      snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
    })
  );
  storage.getSessionRepositories = () => [
    { repoOwner: "acme/platform", repoName: "web", baseBranch: "main" },
  ];
  const provider = createMockProvider();
  provider.capabilities.supportsNetworkEgressPolicy = true;
  const getDecryptedForSession = vi.fn(async () => options.servers ?? [pinnedServer]);
  const getForSession = vi.fn(async () => options.pipelines ?? pipelines);
  const compileForSession = vi.fn(async () =>
    options.policy === undefined ? stackPolicy : options.policy
  );
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
      stackPolicyLookup: { compileForSession },
      sandboxNetworkPolicyLookup: { getForSession: networkLookup },
      agentAppDeployEnabled: options.agentAppDeployEnabled,
      sandboxTunnelsPolicy: options.sandboxTunnelsPolicy,
    }
  );
  const launched = (): CreateSandboxConfig | RestoreConfig | undefined =>
    kind === "spawn"
      ? vi.mocked(provider.createSandbox).mock.calls[0]?.[0]
      : vi.mocked(provider.restoreFromSnapshot!).mock.calls[0]?.[0];
  return {
    manager,
    provider,
    session,
    launched,
    getDecryptedForSession,
    getForSession,
    compileForSession,
  };
}

describe.each(["spawn", "restore"] as const)("governed %s", (kind) => {
  it("passes pinned MCP, governance and current network policy to the provider", async () => {
    const h = setup(kind);
    await h.manager.spawnSandbox();
    expect(h.launched()).toMatchObject({
      mcpServers: [pinnedServer],
      governance: { securityPipelines: pipelines, stackPolicy },
      sandboxSettings: { networkPolicy: { mode: "blocked" } },
    });
    const members = [{ repoOwner: "acme/platform", repoName: "web" }];
    expect(h.getDecryptedForSession).toHaveBeenCalledWith(
      h.session.session_name,
      members,
      "environment-1"
    );
    expect(h.getForSession).toHaveBeenCalledWith(members, "environment-1");
    expect(h.compileForSession).toHaveBeenCalledWith(members, "environment-1");
  });

  it("launches with empty governance when nothing is assigned", async () => {
    const h = setup(kind, { servers: [], pipelines: [], policy: null });
    await h.manager.spawnSandbox();
    expect(h.launched()?.governance).toEqual({});
  });

  it.each<[string, { pipelines: SecurityPipelineConfig[]; policy: CompiledStackPolicy | null }]>([
    ["security pipelines", { pipelines, policy: null }],
    ["a stack policy", { pipelines: [], policy: stackPolicy }],
    ["security pipelines and a stack policy", { pipelines, policy: stackPolicy }],
  ])("launches Claude with %s", async (_label, governed) => {
    const h = setup(kind, { harness: "claude", servers: [unpinnedServer], ...governed });
    await h.manager.spawnSandbox();
    expect(h.launched()).toMatchObject({ harness: "claude", mcpServers: [unpinnedServer] });
    expect(h.launched()?.governance).toEqual({
      ...(governed.pipelines.length ? { securityPipelines: pipelines } : {}),
      ...(governed.policy ? { stackPolicy } : {}),
    });
  });

  it("rejects Claude with a pinned MCP artifact before a provider launch", async () => {
    const h = setup(kind, { harness: "claude", servers: [pinnedServer], pipelines: [] });
    await h.manager.spawnSandbox();
    expect(h.provider.createSandbox).not.toHaveBeenCalled();
    expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
  });

  it.each(["security pipeline", "stack policy"] as const)(
    "fails closed when %s resolution fails",
    async (lookup) => {
      const h = setup(kind);
      const failing = lookup === "security pipeline" ? h.getForSession : h.compileForSession;
      failing.mockRejectedValue(new Error("unavailable"));
      await h.manager.spawnSandbox();
      expect(h.provider.createSandbox).not.toHaveBeenCalled();
      expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
    }
  );

  it("rejects a restrictive network policy on an unsupported provider", async () => {
    const h = setup(kind);
    h.provider.capabilities.supportsNetworkEgressPolicy = false;
    await h.manager.spawnSandbox();
    expect(h.provider.createSandbox).not.toHaveBeenCalled();
    expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "asks for the deploy-app tool only when app hosting is configured (%s)",
    async (enabled) => {
      const h = setup(kind, { agentAppDeployEnabled: enabled });
      await h.manager.spawnSandbox();
      expect(h.launched()?.agentAppDeployEnabled).toBe(enabled);
    }
  );

  it.each(SANDBOX_TUNNELS_POLICIES)(
    "launches persisted tunnel ports only under the public policy (%s)",
    async (policy) => {
      const h = setup(kind, {
        sandboxTunnelsPolicy: policy,
        sandboxSettings: JSON.stringify({ tunnelPorts: [3000] }),
      });
      await h.manager.spawnSandbox();
      expect(h.launched()?.sandboxSettings?.tunnelPorts).toEqual(
        policy === "public" ? [3000] : undefined
      );
    }
  );
});
