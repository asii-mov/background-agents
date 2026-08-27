import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { governanceCatalogConfigFromEnv } from "./reconciler";

describe("governanceCatalogConfigFromEnv", () => {
  it("keeps app-managed mode when no Git repository is configured", () => {
    expect(governanceCatalogConfigFromEnv({} as Env)).toBeNull();
  });

  it("applies safe defaults after owner and repository are configured", () => {
    expect(
      governanceCatalogConfigFromEnv({
        GOVERNANCE_REPO_OWNER: " security ",
        GOVERNANCE_REPO_NAME: " governance ",
      } as Env)
    ).toEqual({
      owner: "security",
      name: "governance",
      ref: "main",
      path: ".openinspect",
    });
  });

  it("rejects partial and unsafe deployment configuration", () => {
    expect(() =>
      governanceCatalogConfigFromEnv({ GOVERNANCE_REPO_OWNER: "security" } as Env)
    ).toThrow(/must be set together/);
    expect(() =>
      governanceCatalogConfigFromEnv({
        GOVERNANCE_REPO_OWNER: "security",
        GOVERNANCE_REPO_NAME: "governance",
        GOVERNANCE_REPO_PATH: "../outside",
      } as Env)
    ).toThrow(/safe relative/);
  });
});
