import { permissionsForBuiltInRole, type PermissionId } from "@open-inspect/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_USER_ID,
} from "../router.test-support";
import { mcpServerRoutes } from "./mcp-servers";
import { skillRoutes } from "./skills";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([mcpServerRoutes, skillRoutes]);
const GIT_MANAGED_STATUS = 409;

function gitManagedEnv(permissions: PermissionId[]) {
  return createTestEnv({
    GOVERNANCE_REPO_OWNER: "security",
    GOVERNANCE_REPO_NAME: "agent-governance",
    GOVERNANCE_REPO_REF: "main",
    GOVERNANCE_REPO_PATH: ".openinspect",
    DB: authorizationDatabase({ permissions }),
  });
}

const WRITE_ROUTES: ReadonlyArray<readonly [string, string, PermissionId]> = [
  ["POST", "/mcp-servers", "mcp_servers.manage"],
  ["PUT", "/mcp-servers/mcp-1", "mcp_servers.manage"],
  ["DELETE", "/mcp-servers/mcp-1", "mcp_servers.manage"],
  ["POST", "/skills", "skills.manage"],
  ["PATCH", "/skills/skill-1", "skills.manage"],
  ["DELETE", "/skills/skill-1", "skills.manage"],
];

async function send(method: string, path: string, permissions: PermissionId[]) {
  return handleRequest(
    new Request(`https://test.local${path}`, { method, body: method === "DELETE" ? null : "{" }),
    gitManagedEnv(permissions),
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("MCP server and skill catalog write admission", () => {
  beforeEach(() => {
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: TEST_USER_ID },
      request,
    }));
  });

  it.each(WRITE_ROUTES)(
    "admits %s %s for a role granting %s without any platform role",
    async (method, path, permission) => {
      const response = await send(method, path, [
        ...permissionsForBuiltInRole("member"),
        permission,
      ]);

      expect(response.status).toBe(GIT_MANAGED_STATUS);
    }
  );

  it.each(WRITE_ROUTES)("denies %s %s to a member without %s", async (method, path, permission) => {
    const response = await send(method, path, permissionsForBuiltInRole("member"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ permission });
  });
});
