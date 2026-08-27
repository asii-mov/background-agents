import { describe, expect, it } from "vitest";
import { createSecurityPipelineSchema, updateSecurityPipelineSchema } from "./security-pipelines";

const command = { name: "secret scan", command: ["gitleaks", "detect"] };

describe("security pipeline schemas", () => {
  it("applies safe create defaults", () => {
    expect(createSecurityPipelineSchema.parse({ name: "baseline", commands: [command] })).toEqual({
      name: "baseline",
      commands: [{ ...command, timeoutSeconds: 300 }],
      enabled: true,
      blocking: true,
      maxRemediationAttempts: 2,
    });
  });

  it("requires a revision precondition on every update", () => {
    expect(updateSecurityPipelineSchema.safeParse({ enabled: false }).success).toBe(false);
    expect(updateSecurityPipelineSchema.parse({ revision: 3, enabled: false })).toEqual({
      revision: 3,
      enabled: false,
    });
  });

  it("rejects shell-shaped command strings and excessive remediation", () => {
    expect(
      createSecurityPipelineSchema.safeParse({ name: "bad", commands: ["npm test"] }).success
    ).toBe(false);
    expect(
      createSecurityPipelineSchema.safeParse({
        name: "bad",
        commands: [command],
        maxRemediationAttempts: 6,
      }).success
    ).toBe(false);
  });
});
