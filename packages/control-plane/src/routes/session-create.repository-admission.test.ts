import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as UserAuthorizationModule from "../repos/user-authorization";
import type * as SharedRoutesModule from "./shared";
import { UserStore } from "../db/user-store";
import { authorizeSessionRepositories } from "../repos/user-authorization";
import {
  createTestEnv,
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_USER_ID,
} from "../router.test-support";
import { sessionCreateRoutes } from "./session-create";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedRoutesModule>()),
  resolveRepoOrError: vi.fn(async () => ({ repoId: 12345, defaultBranch: "main" })),
}));

vi.mock("../repos/user-authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof UserAuthorizationModule>()),
  authorizeSessionRepositories: vi.fn(),
}));

const handleRequest = createTestRequestHandler([sessionCreateRoutes]);
const env = createTestEnv({ SCM_PROVIDER: "github", DB: ownerAuthorizationDatabase() });

function createRepositorySession(): Promise<Response> {
  return handleRequest(
    new Request("https://test.local/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoOwner: "Acme",
        repoName: "Web-App",
        title: "Test session",
        model: "anthropic/claude-haiku-4-5",
      }),
    }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("repository session admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: TEST_USER_ID },
      request,
    }));
  });

  it("rejects repository sessions without a linked GitHub identity", async () => {
    vi.spyOn(UserStore.prototype, "getIdentitiesForUser").mockResolvedValue([]);

    const response = await createRepositorySession();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "A linked GitHub identity is required for repository sessions",
    });
    expect(authorizeSessionRepositories).not.toHaveBeenCalled();
  });

  it("rejects the session when the linked identity cannot write to a repository", async () => {
    vi.spyOn(UserStore.prototype, "getIdentitiesForUser").mockResolvedValue([
      {
        provider: "github",
        providerUserId: "2002",
        providerLogin: "ada",
        providerEmail: null,
      },
    ] as never);
    vi.mocked(authorizeSessionRepositories).mockResolvedValueOnce([
      { repository: { repoOwner: "acme", repoName: "web-app" }, reason: "denied" },
    ]);

    const response = await createRepositorySession();

    expect(authorizeSessionRepositories).toHaveBeenCalledWith(expect.anything(), "ada", [
      { repoOwner: "acme", repoName: "web-app", repoId: 12345 },
    ]);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "You are not authorized to use one or more selected repositories",
    });
  });
});
