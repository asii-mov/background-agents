import { expect } from "vitest";
import type { SecurityPipelineConfig } from "@open-inspect/shared/types/security-pipelines";
import type { CompiledStackPolicy } from "@open-inspect/shared/types/stack-policy";
import type { SessionGovernance } from "./governance";

export const SECURITY_PIPELINES: SecurityPipelineConfig[] = [
  {
    id: "checks",
    name: "Security",
    commands: [{ name: "check", command: ["check"], timeoutSeconds: 30 }],
    blocking: true,
    maxRemediationAttempts: 0,
    repoScopes: null,
  },
];

export const STACK_POLICY: CompiledStackPolicy = {
  schemaVersion: 1,
  digest: "digest-1",
  instructions: "## Organization technology standards\n- Do not use: **React**.",
  maxRemediationAttempts: 2,
  rules: [],
};

export const GOVERNANCE: SessionGovernance = {
  securityPipelines: SECURITY_PIPELINES,
  stackPolicy: STACK_POLICY,
};

/** What the sandbox runtime reads: governance under its SESSION_CONFIG keys, the tool gate in env. */
export function expectGovernedSandboxEnv(env: Record<string, string> | undefined): void {
  expect(JSON.parse(env?.SESSION_CONFIG ?? "{}")).toMatchObject({
    security_pipelines: SECURITY_PIPELINES,
    stack_policy: STACK_POLICY,
  });
  expect(env?.AGENT_APP_DEPLOY_ENABLED).toBe("true");
}
