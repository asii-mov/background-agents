import { describe, expect, it } from "vitest";
import { GOVERNANCE, SECURITY_PIPELINES, STACK_POLICY } from "./governance.test-helpers";
import type { CreateSandboxConfig } from "./provider";
import { buildSandboxEnvVars, scmCloneIdentity } from "./sandbox-env";

const launch: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "sandbox-1",
  repoOwner: "acme/platform",
  repoName: "web",
  controlPlaneUrl: "https://control.example.com",
  sandboxAuthToken: "sandbox-token",
  harness: "opencode",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

function sandboxEnv(config: Partial<CreateSandboxConfig>): Record<string, string> {
  return buildSandboxEnvVars({ ...launch, ...config }, { scmIdentity: scmCloneIdentity("github") });
}

function sessionConfig(config: Partial<CreateSandboxConfig>): Record<string, unknown> {
  return JSON.parse(sandboxEnv(config).SESSION_CONFIG);
}

describe("SESSION_CONFIG governance", () => {
  it("carries pipelines and the compiled stack policy under their wire keys", () => {
    expect(sessionConfig({ governance: GOVERNANCE })).toMatchObject({
      security_pipelines: SECURITY_PIPELINES,
      stack_policy: STACK_POLICY,
    });
  });

  it("carries stack_policy only when a policy was compiled", () => {
    const config = sessionConfig({ governance: { securityPipelines: SECURITY_PIPELINES } });
    expect(config).not.toHaveProperty("stack_policy");
    expect(config.security_pipelines).toEqual(SECURITY_PIPELINES);
    expect(sessionConfig({})).not.toHaveProperty("stack_policy");
    expect(sessionConfig({})).not.toHaveProperty("security_pipelines");
  });
});

describe("AGENT_APP_DEPLOY_ENABLED", () => {
  it("is set only when app hosting is configured", () => {
    expect(sandboxEnv({ agentAppDeployEnabled: true }).AGENT_APP_DEPLOY_ENABLED).toBe("true");
    expect(sandboxEnv({ agentAppDeployEnabled: false })).not.toHaveProperty(
      "AGENT_APP_DEPLOY_ENABLED"
    );
  });

  it("cannot be switched on by a repository secret", () => {
    const env = sandboxEnv({ userEnvVars: { AGENT_APP_DEPLOY_ENABLED: "true" } });
    expect(env).not.toHaveProperty("AGENT_APP_DEPLOY_ENABLED");
  });
});
