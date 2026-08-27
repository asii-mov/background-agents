import type { RepositoryPair } from "@open-inspect/shared/types/repositories";
import type { SourceControlProvider } from "../source-control";

type RepositoryUserAccessChecker = Pick<SourceControlProvider, "checkRepositoryUserAccess">;

const WRITE_CAPABLE_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export interface RepositoryAuthorizationFailure {
  repository: RepositoryPair;
  reason: "denied" | "unavailable";
}

/**
 * Verify that one provider identity can access every repository admitted to a
 * session. Checks are independent and the session is denied unless all pass.
 */
export async function authorizeSessionRepositories(
  provider: RepositoryUserAccessChecker,
  userLogin: string,
  repositories: readonly RepositoryPair[]
): Promise<RepositoryAuthorizationFailure[]> {
  const results = await Promise.all(
    repositories.map(async (repository): Promise<RepositoryAuthorizationFailure | null> => {
      try {
        const access = await provider.checkRepositoryUserAccess({
          owner: repository.repoOwner,
          name: repository.repoName,
          userLogin,
        });
        return access && WRITE_CAPABLE_PERMISSIONS.has(access.permission)
          ? null
          : { repository, reason: "denied" };
      } catch {
        return { repository, reason: "unavailable" };
      }
    })
  );
  return results.filter((result): result is RepositoryAuthorizationFailure => result !== null);
}
