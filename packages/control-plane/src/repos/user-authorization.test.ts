import { describe, expect, it, vi } from "vitest";
import { authorizeSessionRepositories } from "./user-authorization";

describe("authorizeSessionRepositories", () => {
  it("requires access to every selected repository", async () => {
    const checkRepositoryUserAccess = vi
      .fn()
      .mockResolvedValueOnce({ permission: "write" })
      .mockResolvedValueOnce(null);
    const provider = { checkRepositoryUserAccess };

    await expect(
      authorizeSessionRepositories(provider, "ada", [
        { repoOwner: "acme", repoName: "allowed" },
        { repoOwner: "acme", repoName: "denied" },
      ])
    ).resolves.toEqual([
      {
        repository: { repoOwner: "acme", repoName: "denied" },
        reason: "denied",
      },
    ]);
    expect(checkRepositoryUserAccess).toHaveBeenCalledTimes(2);
  });

  it.each(["read", "triage"] as const)(
    "rejects %s access because repository sessions can push",
    async (permission) => {
      const provider = {
        checkRepositoryUserAccess: vi.fn().mockResolvedValue({ permission }),
      };

      await expect(
        authorizeSessionRepositories(provider, "ada", [
          { repoOwner: "acme", repoName: "read-only" },
        ])
      ).resolves.toEqual([
        {
          repository: { repoOwner: "acme", repoName: "read-only" },
          reason: "denied",
        },
      ]);
    }
  );

  it("fails closed when the provider check is unavailable", async () => {
    const provider = {
      checkRepositoryUserAccess: vi.fn().mockRejectedValue(new Error("upstream unavailable")),
    };

    await expect(
      authorizeSessionRepositories(provider, "ada", [{ repoOwner: "acme", repoName: "app" }])
    ).resolves.toEqual([
      {
        repository: { repoOwner: "acme", repoName: "app" },
        reason: "unavailable",
      },
    ]);
  });
});
