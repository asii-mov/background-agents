import { describe, expect, it } from "vitest";
import { assessChangeRisk, classifyChangeSensitivity } from "./change-risk";

describe("change risk matrix", () => {
  it("classifies authentication and authorization changes as critical", () => {
    expect(classifyChangeSensitivity(["src/auth/authorize.ts"])).toMatchObject({
      level: "critical",
      matchedPaths: ["src/auth/authorize.ts"],
    });
  });

  it("keeps documentation-only changes low", () => {
    expect(classifyChangeSensitivity(["docs/setup.md", "README.md"]).level).toBe("low");
  });

  it("uses the simple multiplicative review threshold", () => {
    expect(assessChangeRisk("medium", ["src/auth/login.ts"])).toMatchObject({
      score: 8,
      requiresSecurityReview: true,
    });
    expect(assessChangeRisk("low", ["docs/setup.md"])).toMatchObject({
      score: 1,
      requiresSecurityReview: false,
    });
  });
});
