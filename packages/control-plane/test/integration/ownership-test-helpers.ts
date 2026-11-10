import { createExecutionContext, env } from "cloudflare:test";
import { expect, vi } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { TeamRole } from "@open-inspect/shared/types/teams";
import { EnvironmentStore, type EnvironmentRepositoryInsert } from "../../src/db/environments";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import {
  routeRequest,
  serviceRequestHeaders,
  sqlDatabase,
  type ServiceRequestInit,
} from "./helpers";

/**
 * Satisfy the fork's repository admission for a browser user: give the linked
 * GitHub identity a login and have GitHub report a write-capable collaborator.
 */
export async function admitRepositoryWriter(userId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE user_identities SET provider_login = COALESCE(provider_login, ?) WHERE user_id = ? AND provider = 'github'"
  )
    .bind(`writer-${userId}`, userId)
    .run();
  vi.spyOn(GitHubSourceControlProvider.prototype, "checkRepositoryUserAccess").mockResolvedValue({
    permission: "write",
  });
}

export async function expectStatus(response: Promise<Response>, status: number) {
  expect((await response).status).toBe(status);
}

// Direct dispatch keeps SCM boundary spies in the same module context as the route.
export async function ownershipRequest(path: string, init: ServiceRequestInit = {}) {
  const url = `https://test.local${path}`;
  return routeRequest(
    new Request(url, {
      method: init.method ?? "GET",
      body: init.body,
      headers: await serviceRequestHeaders(url, init),
    }),
    env,
    createExecutionContext()
  );
}

export async function seedTeam(id: string, members: Array<[string, TeamRole]> = []) {
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, default_visibility, created_at, updated_at) VALUES (?, ?, ?, 'team', 1, 1)"
  )
    .bind(id, id, id)
    .run();
  for (const [userId, role] of members) {
    await new TeamMembershipStore(env.DB).add(id, userId, role);
  }
  return id;
}

export async function seedEnvironment(
  id: string,
  ownerTeamId: string | null,
  repositories: EnvironmentRepositoryInsert[] = [],
  overrides: { name?: string; prebuild_enabled?: number } = {}
) {
  await sqlDatabase(env.DB).batch([
    env.DB.prepare(
      "INSERT INTO environments (id, name, owner_team_id, prebuild_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)"
    ).bind(id, overrides.name ?? id, ownerTeamId, overrides.prebuild_enabled ?? 0),
    ...new EnvironmentStore(env.DB).bindRepositoryInserts(id, repositories),
  ]);
  return id;
}

export async function seedGrant(
  teamId: string,
  repository:
    "installation" | Pick<EnvironmentRepositoryInsert, "repo_id" | "repo_owner" | "repo_name">
) {
  const repo = repository === "installation" ? null : repository;
  await env.DB.prepare(
    `INSERT INTO team_repository_grants
     (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(
      crypto.randomUUID(),
      teamId,
      repo ? "repository" : "installation",
      repo?.repo_id ?? null,
      repo?.repo_owner ?? null,
      repo?.repo_name ?? null
    )
    .run();
}

export async function assignCustomRole(userId: string, permissions: readonly PermissionId[]) {
  const roleId = `role_custom_${userId}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO roles (id, name, normalized_name, is_system) VALUES (?, ?, ?, 0)"
    ).bind(roleId, `Custom ${userId}`, `custom ${userId}`),
    ...permissions.map((permission) =>
      env.DB.prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)").bind(
        roleId,
        permission
      )
    ),
    env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
      roleId,
      userId
    ),
  ]);
}
