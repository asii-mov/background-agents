import { z } from "zod";
import { getSignInProviderIssuer } from "@open-inspect/shared/sign-in-provider";
import {
  sessionCollaboratorCandidatesResponseSchema,
  type SessionCollaboratorCandidate,
} from "@open-inspect/shared/types/sessions";
import { generateId } from "../auth/crypto";
import { normalizeEmail } from "./email";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

// ── Public types ────────────────────────────────────────────────────

export interface ProviderIdentity {
  provider: "github" | "slack" | "linear" | "google";
  providerUserId: string;
  providerLogin?: string;
  providerEmail?: string;
  displayName?: string;
  avatarUrl?: string;
}

/**
 * Which provider-reported emails may link an identity to an existing user.
 * A reported email is never mailbox proof. It links only inside an allowed
 * domain and only to a user whose email a completed OAuth sign-in verified.
 * It stays on the identity and never lands on `users.email`, where a later
 * sign-in proving it would verify that row and link into it.
 */
export interface EmailLinkPolicy {
  /** Exact lowercase domains, such as `corp.example`. Empty never links. */
  readonly allowedEmailDomains: ReadonlySet<string>;
}

/** Parses the comma-separated `IDENTITY_LINK_EMAIL_DOMAINS` setting. */
export function parseEmailLinkPolicy(domains: string | undefined): EmailLinkPolicy {
  return {
    allowedEmailDomains: new Set(
      (domains ?? "")
        .split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean)
    ),
  };
}

const NO_EMAIL_LINKS = parseEmailLinkPolicy(undefined);

interface LinkableEmail {
  address: string;
  domain: string;
}

function linkableEmail(email: string | null, policy: EmailLinkPolicy): LinkableEmail | null {
  const [local, domain, ...rest] = email?.split("@") ?? [];
  if (!email || !local || !domain || rest.length > 0) return null;
  return policy.allowedEmailDomains.has(domain) ? { address: email, domain } : null;
}

export interface ResolvedUser {
  id: string;
  displayName: string | null;
  email: string | null;
  isNew: boolean;
  /** The allowed domain whose email linked this identity to an existing user, if one did. */
  linkedByEmailDomain: string | null;
}

export interface User {
  id: string;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UserIdentity {
  id: string;
  userId: string;
  provider: string;
  providerUserId: string;
  providerLogin: string | null;
  providerEmail: string | null;
  providerIssuer: string | null;
  createdAt: number;
}

export interface NewUser {
  displayName?: string;
  email?: string;
  /** Whether `email` comes with mailbox-ownership proof. */
  emailVerified?: boolean;
  avatarUrl?: string;
}

export interface NewUserIdentity {
  userId: string;
  provider: string;
  providerUserId: string;
  providerLogin?: string;
  providerEmail?: string;
}

export interface UserUpdate {
  displayName?: string;
  avatarUrl?: string;
}

// ── Row types (D1 snake_case) ───────────────────────────────────────

interface UserRow {
  id: string;
  display_name: string | null;
  email: string | null;
  email_verified: number;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

interface UserIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  provider_login: string | null;
  provider_email: string | null;
  provider_issuer: string | null;
  created_at: number;
}

// ── Row mappers ─────────────────────────────────────────────────────

function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    emailVerified: row.email_verified === 1,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUserIdentity(row: UserIdentityRow): UserIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    providerLogin: row.provider_login,
    providerEmail: row.provider_email,
    providerIssuer: row.provider_issuer,
    createdAt: row.created_at,
  };
}

export type CollaboratorEligibility = "eligible" | "not_found" | "inactive" | "not_team_member";

const collaboratorEligibilityRowSchema = z.object({
  suspended_at: z.number().nullable(),
  role_id: z.string().nullable(),
  team_member: z.number(),
});

// ── UserStore ───────────────────────────────────────────────────────

export class UserStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Lists active users; a team ID restricts candidates to that team's members. */
  async listCollaboratorCandidates({
    includeEmail,
    teamId = null,
  }: {
    includeEmail: boolean;
    teamId?: string | null;
  }): Promise<SessionCollaboratorCandidate[]> {
    const { results } = await this.db
      .prepare(
        `SELECT users.id AS userId, users.display_name AS displayName,
                ${includeEmail ? "users.email" : "NULL AS email"}, users.avatar_url AS avatarUrl
         FROM users
         JOIN user_role_assignments assignment ON assignment.user_id = users.id
         ${teamId === null ? "" : "JOIN team_memberships m ON m.user_id = users.id AND m.team_id = ?"}
         WHERE users.suspended_at IS NULL AND assignment.role_id IS NOT NULL
         ORDER BY LOWER(COALESCE(users.display_name, ${includeEmail ? "users.email" : "NULL"}, users.id)), users.id`
      )
      .bind(...(teamId === null ? [] : [teamId]))
      .all();
    return sessionCollaboratorCandidatesResponseSchema.parse(results);
  }

  /** Applies the candidate-list rules to one user; a team ID also requires membership in that team. */
  async getCollaboratorEligibility(
    userId: string,
    teamId: string | null
  ): Promise<CollaboratorEligibility> {
    const row = collaboratorEligibilityRowSchema.nullable().parse(
      await this.db
        .prepare(
          `SELECT users.suspended_at, assignment.role_id,
                  EXISTS (SELECT 1 FROM team_memberships m
                          WHERE m.team_id = ? AND m.user_id = users.id) AS team_member
           FROM users
           LEFT JOIN user_role_assignments assignment ON assignment.user_id = users.id
           WHERE users.id = ?`
        )
        .bind(teamId, userId)
        .first()
    );
    if (!row) return "not_found";
    if (row.suspended_at !== null || row.role_id === null) return "inactive";
    if (teamId !== null && !row.team_member) return "not_team_member";
    return "eligible";
  }

  async getUsersByIds(userIds: readonly string[]): Promise<User[]> {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) return [];

    const statements = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      const ids = uniqueIds.slice(offset, offset + 100);
      statements.push(
        this.db
          .prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => "?").join(", ")})`)
          .bind(...ids)
      );
    }
    const results = await this.db.batch<UserRow>(statements);
    return results.flatMap((result) => result.results.map(toUser));
  }

  /**
   * Core resolution entry point. Finds or creates a canonical user for the
   * given provider identity, linking by email only as `linkPolicy` allows.
   *
   * On UNIQUE constraint violation (concurrent race), retries the lookup once.
   */
  async resolveOrCreateUser(
    identity: ProviderIdentity,
    linkPolicy: EmailLinkPolicy = NO_EMAIL_LINKS
  ): Promise<ResolvedUser> {
    try {
      return await this.doResolveOrCreate(identity, linkPolicy);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return await this.doResolveOrCreate(identity, linkPolicy);
      }
      throw err;
    }
  }

  async getUserById(userId: string): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .bind(userId)
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE email = ?")
      .bind(normalizeEmail(email))
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async getIdentity(provider: string, providerUserId: string): Promise<UserIdentity | null> {
    const row = await this.db
      .prepare("SELECT * FROM user_identities WHERE provider = ? AND provider_user_id = ?")
      .bind(provider, providerUserId)
      .first<UserIdentityRow>();
    return row ? toUserIdentity(row) : null;
  }

  async getIdentitiesForUser(userId: string): Promise<UserIdentity[]> {
    // ORDER BY created_at gives a deterministic order so callers that pick a
    // single identity (e.g. resolveGitHubEnrichment) get a stable result.
    // Google's email-based cross-provider linking makes multi-identity users
    // more common, so the previously-unordered query could otherwise vary.
    const result = await this.db
      .prepare("SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at ASC")
      .bind(userId)
      .all<UserIdentityRow>();
    return (result.results ?? []).map(toUserIdentity);
  }

  async createUser(user: NewUser): Promise<User> {
    const id = generateId();
    const now = Date.now();
    const email = normalizeEmail(user.email);
    const emailVerified = email !== null && user.emailVerified === true;

    await this.db
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        user.displayName ?? null,
        email,
        emailVerified ? 1 : 0,
        user.avatarUrl ?? null,
        now,
        now
      )
      .run();

    return {
      id,
      displayName: user.displayName ?? null,
      email,
      emailVerified,
      avatarUrl: user.avatarUrl ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async createIdentity(identity: NewUserIdentity): Promise<UserIdentity> {
    const id = generateId();
    const now = Date.now();
    const email = normalizeEmail(identity.providerEmail);
    const issuer = getSignInProviderIssuer(identity.provider);

    await this.db
      .prepare(
        "INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_login, provider_email, provider_issuer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        identity.userId,
        identity.provider,
        identity.providerUserId,
        identity.providerLogin ?? null,
        email,
        issuer,
        now
      )
      .run();

    return {
      id,
      userId: identity.userId,
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      providerLogin: identity.providerLogin ?? null,
      providerEmail: email,
      providerIssuer: issuer,
      createdAt: now,
    };
  }

  async updateUser(userId: string, updates: UserUpdate): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.displayName !== undefined) {
      sets.push("display_name = ?");
      values.push(updates.displayName);
    }
    if (updates.avatarUrl !== undefined) {
      sets.push("avatar_url = ?");
      values.push(updates.avatarUrl);
    }

    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(userId);

    await this.db
      .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  // ── Private ─────────────────────────────────────────────────────

  private async doResolveOrCreate(
    identity: ProviderIdentity,
    linkPolicy: EmailLinkPolicy
  ): Promise<ResolvedUser> {
    const normalizedEmail = normalizeEmail(identity.providerEmail);
    const linkable = linkableEmail(normalizedEmail, linkPolicy);

    // Step 1: Look up by provider identity
    const existing = await this.getIdentity(identity.provider, identity.providerUserId);

    if (existing) {
      // Step 2: Existing identity → load linked user, update if needed
      const user = await this.getUserById(existing.userId);
      if (!user) {
        throw new Error(`Orphaned identity ${existing.id}: user ${existing.userId} not found`);
      }

      // Step 2a: Refresh identity-level metadata (provider_login, provider_email)
      // so getIdentity() and getIdentitiesForUser() return current values.
      await this.refreshIdentityMetadata(existing, identity.providerLogin, normalizedEmail);

      // Step 2b: User-level updates (display_name, avatar_url)
      const updates: UserUpdate = {};
      if (identity.displayName && identity.displayName !== user.displayName) {
        updates.displayName = identity.displayName;
      }
      if (identity.avatarUrl && identity.avatarUrl !== user.avatarUrl) {
        updates.avatarUrl = identity.avatarUrl;
      }

      // Step 2c: Re-link to the verified owner of an allowed-domain email.
      if (!user.email && linkable) {
        const emailOwner = await this.getUserByEmail(linkable.address);
        if (emailOwner?.emailVerified) {
          // Re-link this identity to the verified owner of its email. This
          // heals the split left when e.g. a Slack identity created without an
          // email later reports the email a GitHub sign-in already proved.
          await this.db
            .prepare("UPDATE user_identities SET user_id = ? WHERE id = ?")
            .bind(emailOwner.id, existing.id)
            .run();
          return {
            id: emailOwner.id,
            displayName: emailOwner.displayName,
            email: emailOwner.email,
            isNew: false,
            linkedByEmailDomain: linkable.domain,
          };
        }
      }

      if (Object.keys(updates).length > 0) {
        await this.updateUser(user.id, updates);
      }

      return {
        id: user.id,
        displayName: updates.displayName ?? user.displayName,
        email: user.email,
        isNew: false,
        linkedByEmailDomain: null,
      };
    }

    // Step 3: No identity found — link to the verified owner of an
    // allowed-domain email
    const emailOwner = linkable ? await this.getUserByEmail(linkable.address) : null;
    if (linkable && emailOwner?.emailVerified) {
      await this.createIdentity({
        userId: emailOwner.id,
        provider: identity.provider,
        providerUserId: identity.providerUserId,
        providerLogin: identity.providerLogin,
        providerEmail: linkable.address,
      });
      return {
        id: emailOwner.id,
        displayName: emailOwner.displayName,
        email: emailOwner.email,
        isNew: false,
        linkedByEmailDomain: linkable.domain,
      };
    }

    // Step 4: Brand new user — batch user + identity creation so a UNIQUE
    // failure on the identity INSERT rolls back the user INSERT, preventing
    // orphaned user rows under concurrent requests.
    const userId = generateId();
    const identityId = generateId();
    const now = Date.now();
    const displayName = identity.displayName ?? null;
    const avatarUrl = identity.avatarUrl ?? null;
    const issuer = getSignInProviderIssuer(identity.provider);

    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO users (id, display_name, email, email_verified, avatar_url, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?, ?)"
        )
        .bind(userId, displayName, avatarUrl, now, now),
      this.db
        .prepare(
          "INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_login, provider_email, provider_issuer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          identityId,
          userId,
          identity.provider,
          identity.providerUserId,
          identity.providerLogin ?? null,
          normalizedEmail,
          issuer,
          now
        ),
    ]);

    return {
      id: userId,
      displayName,
      email: null,
      isNew: true,
      linkedByEmailDomain: null,
    };
  }

  /**
   * Update identity-level metadata (provider_login, provider_email) if
   * the provider now reports newer values than what's stored. This keeps
   * getIdentity() and getIdentitiesForUser() accurate across repeat sign-ins.
   */
  private async refreshIdentityMetadata(
    existing: UserIdentity,
    providerLogin: string | undefined,
    normalizedEmail: string | null
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (providerLogin && providerLogin !== existing.providerLogin) {
      sets.push("provider_login = ?");
      values.push(providerLogin);
    }
    if (normalizedEmail && normalizedEmail !== existing.providerEmail) {
      sets.push("provider_email = ?");
      values.push(normalizedEmail);
    }

    if (sets.length === 0) return;

    values.push(existing.id);
    await this.db
      .prepare(`UPDATE user_identities SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }
}
