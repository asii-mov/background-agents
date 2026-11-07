/**
 * packages/control-plane/src/sandbox/governance.ts  (NEW)
 *
 * Everything centrally governed that the sandbox enforces, threaded as ONE value through
 * provider.ts, client.ts, every provider and sandbox-env.ts (replacing the lone `securityPipelines`
 * field). Only buildSessionConfig splits it back into wire keys:
 *   security_pipelines: governance.securityPipelines   (unchanged key)
 *   stack_policy:       governance.stackPolicy         (new key; omitted when undefined, so old
 *                                                       runtimes ignore it)
 */
import type { SecurityPipelineConfig } from "@open-inspect/shared/types/security-pipelines";
import type { CompiledStackPolicy } from "@open-inspect/shared/types/stack-policy";

export interface SessionGovernance {
  securityPipelines?: SecurityPipelineConfig[];
  stackPolicy?: CompiledStackPolicy;
}

/** Implemented by ApprovedComponentStore. Launch fails closed when it throws (like loadMcpServers). */
export interface StackPolicyLookup {
  compileForSession(
    repositories: ReadonlyArray<{ repoOwner: string; repoName: string }>,
    environmentId: string | null
  ): Promise<CompiledStackPolicy | null>;
}

// launch-context.ts deltas:
//   SandboxLaunchConfig gains `stackPolicyLookup?: StackPolicyLookup`
//   loadSecurityPipelines(...) -> loadGovernance(session, repositories): Promise<SessionGovernance>
//   assertHarnessGovernance(session, mcpServers, governance):
//     - unchanged for MCP artefacts
//     - no longer refuses command pipelines or a stack policy for the Claude harness: both run in
//       bridge.py (harness-agnostic) and Claude's PR path reaches PushOperation (unit test proves it)
//
// sandbox/settings.ts delta:
//   normalizeTunnelPorts(...): when env.SANDBOX_TUNNELS_POLICY === "disabled", reject with
//   "Public preview tunnels are disabled in this workspace. Deploy with the deploy-app tool instead."
export const SANDBOX_TUNNELS_POLICIES = ["public", "disabled"] as const;
export type SandboxTunnelsPolicy = (typeof SANDBOX_TUNNELS_POLICIES)[number];
