import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { SessionIndexStore } from "../db/session-index";
import { SessionRepositoryStore } from "../db/session-repositories";
import type { SqlDatabase } from "../db/sql-database";
import type { CredentialScope } from "./credential-scope";
import { SourceControlProviderError } from "./errors";
import { resolveRepositoryCredentialScope } from "./repository-scope";

/** Resolve fresh ownership and persisted session members, never environment provenance. */
export async function resolveSessionCredentialScope(
  db: SqlDatabase,
  sessionId: string,
  loadInstallationRepositories: () => Promise<InstallationRepository[]>
): Promise<CredentialScope> {
  const session = await new SessionIndexStore(db).get(sessionId);
  if (!session) {
    throw new SourceControlProviderError(
      "Cannot resolve credential scope: session not found",
      "permanent"
    );
  }
  const members = await new SessionRepositoryStore(db).listRepositoryIds(sessionId);
  const repositories = members.length
    ? members
    : session.repoOwner && session.repoName
      ? [{ repoOwner: session.repoOwner, repoName: session.repoName, repoId: null }]
      : [];
  return await resolveRepositoryCredentialScope(
    db,
    repositories,
    session.ownerTeamId,
    loadInstallationRepositories
  );
}

/**
 * Narrow a session's admitted scope to the one member repository a sandbox
 * credential or push names, so a token never reaches sibling repositories.
 */
export async function resolveSessionRepositoryCredentialScope(
  db: SqlDatabase,
  sessionId: string,
  target: { repoOwner: string; repoName: string },
  loadInstallationRepositories: () => Promise<InstallationRepository[]>
): Promise<CredentialScope> {
  const member = (await new SessionRepositoryStore(db).listRepositoryIds(sessionId)).find(
    (repository) =>
      repository.repoOwner.toLowerCase() === target.repoOwner.toLowerCase() &&
      repository.repoName.toLowerCase() === target.repoName.toLowerCase()
  );
  const admitted = await resolveSessionCredentialScope(db, sessionId, loadInstallationRepositories);
  const requested = await resolveRepositoryCredentialScope(
    db,
    [{ repoOwner: target.repoOwner, repoName: target.repoName, repoId: member?.repoId ?? null }],
    null,
    loadInstallationRepositories
  );
  if (
    admitted.kind !== "repositories" ||
    requested.kind !== "repositories" ||
    requested.repositoryIds.some((id) => !admitted.repositoryIds.includes(id))
  ) {
    throw new SourceControlProviderError(
      "Repository is outside the session credential scope",
      "permanent"
    );
  }
  return requested;
}
