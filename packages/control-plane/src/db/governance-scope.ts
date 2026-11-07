import type { RepositoryPair } from "@open-inspect/shared/types/repositories";
import type { SqlDatabase } from "./sql-database";

/** Where a centrally governed entry (security pipeline, catalogue component) applies. */
export interface GovernanceScopes {
  /** Lowercased `owner/name` entries. The owner may itself contain `/`. */
  repoScopes: string[] | null;
  environmentScopes: string[] | null;
}

/**
 * Whether a governed entry applies to a session, and to which of its repositories. Null means it
 * does not apply. A global or environment match applies to every repository in the session
 * (`repoScopes: null`). A repo-only match stays narrowed, so a multi-repo sandbox runs the entry
 * against the right checkout.
 */
export function resolveGovernanceScope(
  entry: GovernanceScopes,
  repositories: readonly RepositoryPair[],
  environmentId: string | null
): { repoScopes: string[] | null } | null {
  const repositoryNames = new Set(
    repositories.map(({ repoOwner, repoName }) => `${repoOwner}/${repoName}`.toLowerCase())
  );
  const environmentMatches =
    environmentId !== null && entry.environmentScopes?.includes(environmentId) === true;
  const matchingRepoScopes =
    entry.repoScopes?.filter((scope) => repositoryNames.has(scope.toLowerCase())) ?? [];
  const global = !entry.repoScopes && !entry.environmentScopes;
  if (!global && !environmentMatches && matchingRepoScopes.length === 0) return null;
  return { repoScopes: global || environmentMatches ? null : matchingRepoScopes };
}

export interface SessionGovernanceScope {
  repositories: RepositoryPair[];
  environmentId: string | null;
}

/** The repositories and environment a session is governed by, or null for an unknown session. */
export async function loadSessionGovernanceScope(
  db: SqlDatabase,
  sessionId: string
): Promise<SessionGovernanceScope | null> {
  const session = await db
    .prepare("SELECT repo_owner, repo_name, environment_id FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{
      repo_owner: string | null;
      repo_name: string | null;
      environment_id: string | null;
    }>();
  if (!session) return null;
  const members = await db
    .prepare(
      `SELECT repo_owner, repo_name FROM session_repositories
       WHERE session_id = ? ORDER BY position`
    )
    .bind(sessionId)
    .all<{ repo_owner: string; repo_name: string }>();
  const repositories = (members.results ?? []).map((entry) => ({
    repoOwner: entry.repo_owner,
    repoName: entry.repo_name,
  }));
  if (repositories.length === 0 && session.repo_owner && session.repo_name) {
    repositories.push({ repoOwner: session.repo_owner, repoName: session.repo_name });
  }
  return { repositories, environmentId: session.environment_id };
}

/** The session repository matching `repository` case-insensitively, as the session stores it. */
export function findSessionRepository(
  scope: SessionGovernanceScope,
  repository: RepositoryPair
): RepositoryPair | null {
  return (
    scope.repositories.find(
      (entry) =>
        entry.repoOwner.toLowerCase() === repository.repoOwner.toLowerCase() &&
        entry.repoName.toLowerCase() === repository.repoName.toLowerCase()
    ) ?? null
  );
}
