import type { Principal } from "../auth/principal";
import type { SqlDatabase } from "./sql-database";

export const PLATFORM_ROLES = ["member", "editor", "admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export type PlatformPermission = "catalog.write" | "platform.manage";

export interface PlatformRoleConfig {
  adminUsers?: string;
  editorUsers?: string;
}

export interface PlatformUserSummary {
  id: string;
  displayName: string | null;
  email: string | null;
  role: PlatformRole;
}

interface PlatformUserRow {
  id: string;
  display_name: string | null;
  email: string | null;
  email_verified: number;
  platform_role: PlatformRole;
}

interface PlatformIdentityRow {
  provider: string;
  provider_login: string | null;
}

const ROLE_RANK: Readonly<Record<PlatformRole, number>> = {
  member: 0,
  editor: 1,
  admin: 2,
};

const PERMISSION_ROLE: Readonly<Record<PlatformPermission, PlatformRole>> = {
  "catalog.write": "editor",
  "platform.manage": "admin",
};

function normalizeIdentifiers(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function principalUserId(principal: Principal): string | null {
  if (principal.kind === "user") return principal.userId;
  if (principal.kind === "service") return principal.actor?.canonicalUserId ?? null;
  return null;
}

export class PlatformRoleStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly config: PlatformRoleConfig = {}
  ) {}

  async getEffectiveRole(userId: string): Promise<PlatformRole | null> {
    const user = await this.db
      .prepare(
        "SELECT id, display_name, email, email_verified, platform_role FROM users WHERE id = ?"
      )
      .bind(userId)
      .first<PlatformUserRow>();
    if (!user) return null;

    const identities = await this.db
      .prepare("SELECT provider, provider_login FROM user_identities WHERE user_id = ?")
      .bind(userId)
      .all<PlatformIdentityRow>();

    const identifiers = new Set<string>([user.id.toLowerCase()]);
    if (user.email && user.email_verified === 1) identifiers.add(user.email.toLowerCase());
    for (const identity of identities.results) {
      if (identity.provider_login) {
        identifiers.add(`${identity.provider}:${identity.provider_login}`.toLowerCase());
      }
    }

    const configuredAdmins = normalizeIdentifiers(this.config.adminUsers);
    if ([...identifiers].some((identifier) => configuredAdmins.has(identifier))) {
      return "admin";
    }
    const configuredEditors = normalizeIdentifiers(this.config.editorUsers);
    if ([...identifiers].some((identifier) => configuredEditors.has(identifier))) {
      return ROLE_RANK[user.platform_role] > ROLE_RANK.editor ? user.platform_role : "editor";
    }
    return user.platform_role;
  }

  async authorize(
    principal: Principal,
    permission: PlatformPermission
  ): Promise<{ allowed: true; userId: string; role: PlatformRole } | { allowed: false }> {
    const userId = principalUserId(principal);
    if (!userId) return { allowed: false };
    const role = await this.getEffectiveRole(userId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[PERMISSION_ROLE[permission]]) {
      return { allowed: false };
    }
    return { allowed: true, userId, role };
  }

  async listUsers(): Promise<PlatformUserSummary[]> {
    const result = await this.db
      .prepare(
        "SELECT id, display_name, email, email_verified, platform_role FROM users ORDER BY display_name, email, id"
      )
      .all<PlatformUserRow>();
    return Promise.all(
      result.results.map(async (row) => ({
        id: row.id,
        displayName: row.display_name,
        email: row.email,
        role: (await this.getEffectiveRole(row.id)) ?? row.platform_role,
      }))
    );
  }

  async setRole(userId: string, role: PlatformRole): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE users SET platform_role = ?, updated_at = ? WHERE id = ?")
      .bind(role, Date.now(), userId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
