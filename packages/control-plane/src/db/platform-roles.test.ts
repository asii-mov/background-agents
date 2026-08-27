import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { PlatformRoleStore, type PlatformRole } from "./platform-roles";

function roleDb(input: {
  role?: PlatformRole;
  email?: string | null;
  emailVerified?: boolean;
  provider?: string;
  login?: string | null;
}): SqlDatabase {
  const user = input.role
    ? {
        id: "user-1",
        display_name: "Ada",
        email: input.email ?? null,
        email_verified: input.emailVerified ? 1 : 0,
        platform_role: input.role,
      }
    : null;
  return {
    prepare(sql: string): SqlStatement {
      const statement: SqlStatement = {
        bind: () => statement,
        first: async <T>() => (sql.includes("FROM users WHERE id") ? (user as T) : null),
        all: async <T>() => ({
          results: (sql.includes("FROM user_identities")
            ? [{ provider: input.provider ?? "github", provider_login: input.login ?? null }]
            : user
              ? [user]
              : []) as T[],
          meta: { changes: 0 },
        }),
        run: async () => ({ results: [], meta: { changes: 1 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
}

describe("PlatformRoleStore", () => {
  it("allows editors to write the catalogue but not manage platform roles", async () => {
    const roles = new PlatformRoleStore(roleDb({ role: "editor" }));
    await expect(
      roles.authorize({ kind: "user", userId: "user-1" }, "catalog.write")
    ).resolves.toMatchObject({ allowed: true, role: "editor" });
    await expect(
      roles.authorize({ kind: "user", userId: "user-1" }, "platform.manage")
    ).resolves.toEqual({ allowed: false });
  });

  it("bootstraps provider-scoped logins as administrators", async () => {
    const roles = new PlatformRoleStore(roleDb({ role: "member", login: "OctoCat" }), {
      adminUsers: "github:octocat",
    });
    await expect(roles.getEffectiveRole("user-1")).resolves.toBe("admin");
    await expect(roles.listUsers()).resolves.toEqual([
      expect.objectContaining({ id: "user-1", role: "admin" }),
    ]);
  });

  it("does not bootstrap a bare provider login", async () => {
    const roles = new PlatformRoleStore(roleDb({ role: "member", login: "OctoCat" }), {
      adminUsers: "octocat",
    });
    await expect(roles.getEffectiveRole("user-1")).resolves.toBe("member");
  });

  it("bootstraps verified email but rejects an unverified copy", async () => {
    const config = { editorUsers: "ada@example.com" };
    await expect(
      new PlatformRoleStore(
        roleDb({ role: "member", email: "ada@example.com", emailVerified: true }),
        config
      ).getEffectiveRole("user-1")
    ).resolves.toBe("editor");
    await expect(
      new PlatformRoleStore(
        roleDb({ role: "member", email: "ada@example.com", emailVerified: false }),
        config
      ).getEffectiveRole("user-1")
    ).resolves.toBe("member");
  });

  it("authorizes attributed service actors and rejects unattributed services", async () => {
    const roles = new PlatformRoleStore(roleDb({ role: "editor" }));
    await expect(
      roles.authorize(
        {
          kind: "service",
          service: "github-bot",
          actor: {
            provider: "github",
            providerUserId: "1",
            canonicalUserId: "user-1",
            participantUserId: "github:1",
          },
        },
        "catalog.write"
      )
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      roles.authorize({ kind: "service", service: "github-bot", actor: null }, "catalog.write")
    ).resolves.toEqual({ allowed: false });
  });

  it("persists explicit role changes", async () => {
    const db = roleDb({ role: "member" });
    const prepare = vi.spyOn(db, "prepare");
    await expect(new PlatformRoleStore(db).setRole("user-1", "admin")).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledWith(
      "UPDATE users SET platform_role = ?, updated_at = ? WHERE id = ?"
    );
  });
});
