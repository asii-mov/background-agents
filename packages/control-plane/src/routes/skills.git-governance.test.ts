import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_USER_ID,
} from "../router.test-support";
import type { Env } from "../types";
import { skillRoutes } from "./skills";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([skillRoutes]);

const gitManagedEnv: Env = createTestEnv({
  GOVERNANCE_REPO_OWNER: "security",
  GOVERNANCE_REPO_NAME: "agent-governance",
  GOVERNANCE_REPO_REF: "main",
  GOVERNANCE_REPO_PATH: ".openinspect",
  DB: authorizationDatabase(),
});

describe("Git-managed skill catalog writes", () => {
  beforeEach(() => {
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: TEST_USER_ID },
      request,
    }));
  });

  it.each([
    ["POST", "/skills"],
    ["POST", "/skills/import"],
    ["POST", "/skills/skill-1/reimport"],
    ["PATCH", "/skills/skill-1"],
    ["PUT", "/skills/skill-1"],
    ["DELETE", "/skills/skill-1"],
  ])("rejects %s %s before request parsing or storage", async (method, path) => {
    const response = await handleRequest(
      new Request(`https://test.local${path}`, { method, body: method === "DELETE" ? null : "{" }),
      gitManagedEnv,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Catalog metadata is managed by Git; submit a change to the governance repository",
    });
  });
});
