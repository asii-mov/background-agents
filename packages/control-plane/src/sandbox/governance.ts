import type { RepositoryPair } from "@open-inspect/shared/types/repositories";
import type { SecurityPipelineConfig } from "@open-inspect/shared/types/security-pipelines";
import type { CompiledStackPolicy } from "@open-inspect/shared/types/stack-policy";

/**
 * Everything centrally governed that the sandbox enforces, resolved at launch and restore and
 * threaded to every provider as one value. Only the session-config builder splits it into wire keys.
 */
export interface SessionGovernance {
  securityPipelines?: SecurityPipelineConfig[];
  stackPolicy?: CompiledStackPolicy;
}

/** Implemented by ApprovedComponentStore. A throw stops the launch, like the MCP lookup. */
export interface StackPolicyLookup {
  compileForSession(
    repositories: readonly RepositoryPair[],
    environmentId: string | null
  ): Promise<CompiledStackPolicy | null>;
}
