import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { skillRoutes } from "./skills";
import type { RequestContext } from "./shared";

const gitManagedEnv = {
  GOVERNANCE_REPO_OWNER: "security",
  GOVERNANCE_REPO_NAME: "agent-governance",
  GOVERNANCE_REPO_REF: "main",
  GOVERNANCE_REPO_PATH: ".openinspect",
} as Env;

function routeFor(method: string, path: string) {
  const route = skillRoutes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path)
  );
  if (!route) throw new Error(`Missing route ${method} ${path}`);
  return route;
}

describe("Git-managed skill catalog writes", () => {
  it.each([
    ["POST", "/skills"],
    ["POST", "/skills/import"],
    ["POST", "/skills/skill-1/reimport"],
    ["PATCH", "/skills/skill-1"],
    ["PUT", "/skills/skill-1"],
    ["DELETE", "/skills/skill-1"],
  ])("rejects %s %s before request parsing or storage", async (method, path) => {
    const route = routeFor(method, path);
    const match = path.match(route.pattern);
    if (!match) throw new Error(`Route pattern did not match ${path}`);

    const response = await route.handler(
      new Request(`https://test.local${path}`, { method }),
      gitManagedEnv,
      match,
      {} as RequestContext
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Catalog metadata is managed by Git; submit a change to the governance repository",
    });
  });
});
