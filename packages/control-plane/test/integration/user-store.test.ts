import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { IdentityClaimStore } from "../../src/db/identity-claim-store";
import { PlatformRoleStore } from "../../src/db/platform-roles";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamStore } from "../../src/db/teams";
import { parseEmailLinkPolicy, UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import { sqlDatabase } from "./helpers";

const providerIssuers = [
  ["github", "https://github.com"],
  ["google", "https://accounts.google.com"],
  ["slack", null],
  ["linear", null],
] as const;

const BOT_PROVIDERS = ["slack", "linear"] as const;
const CORP_LINKS = parseEmailLinkPolicy("corp.example");

describe("UserStore", () => {
  let store: UserStore;

  beforeEach(async () => {
    await cleanD1Tables();
    store = new UserStore(env.DB);
  });

  describe("listCollaboratorCandidates", () => {
    it("returns an empty list when there are no active users", async () => {
      expect(await store.listCollaboratorCandidates({ includeEmail: true })).toEqual([]);
    });

    it("returns only active picker identities ordered by name with email fallback", async () => {
      const zed = await store.createUser({ displayName: "zed" });
      const alice = await store.createUser({
        displayName: "ALICE",
        avatarUrl: "https://example.com/alice.png",
      });
      const bob = await store.createUser({ email: "bob@example.com" });
      const suspended = await store.createUser({ displayName: "Suspended" });
      const unassigned = await store.createUser({ displayName: "Unassigned" });
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(suspended.id),
        env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(unassigned.id),
      ]);

      expect(await store.listCollaboratorCandidates({ includeEmail: true })).toEqual([
        {
          userId: alice.id,
          displayName: "ALICE",
          email: null,
          avatarUrl: "https://example.com/alice.png",
        },
        { userId: bob.id, displayName: null, email: "bob@example.com", avatarUrl: null },
        { userId: zed.id, displayName: "zed", email: null, avatarUrl: null },
      ]);
    });

    it("does not read or sort by email when email is excluded", async () => {
      const user = await store.createUser({ email: "private@example.com" });
      const db = sqlDatabase(env.DB);
      const prepare = vi.fn((sql: string) => db.prepare(sql));
      const candidates = await new UserStore({
        prepare,
        batch: db.batch.bind(db),
      }).listCollaboratorCandidates({ includeEmail: false });
      expect(candidates).toEqual([
        { userId: user.id, displayName: null, email: null, avatarUrl: null },
      ]);
      expect(prepare).toHaveBeenCalledWith(expect.stringContaining("NULL AS email"));
      expect(prepare.mock.calls[0][0]).not.toContain("users.email");
    });
  });

  describe("getCollaboratorEligibility", () => {
    it("requires an active user and, for a team, current membership", async () => {
      const member = await store.createUser({ displayName: "Member" });
      const outsider = await store.createUser({ displayName: "Outsider" });
      const suspended = await store.createUser({ displayName: "Suspended" });
      const unassigned = await store.createUser({ displayName: "Unassigned" });
      const team = await new TeamStore(env.DB).create({
        slug: "eligibility",
        name: "Eligibility",
        joinPolicy: "invite_only",
      });
      await new TeamMembershipStore(env.DB).add(team.id, member.id);
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(suspended.id),
        env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(unassigned.id),
      ]);

      expect(await store.getCollaboratorEligibility("missing", null)).toBe("not_found");
      expect(await store.getCollaboratorEligibility(suspended.id, null)).toBe("inactive");
      expect(await store.getCollaboratorEligibility(unassigned.id, null)).toBe("inactive");
      expect(await store.getCollaboratorEligibility(outsider.id, null)).toBe("eligible");
      expect(await store.getCollaboratorEligibility(outsider.id, team.id)).toBe("not_team_member");
      expect(await store.getCollaboratorEligibility(member.id, team.id)).toBe("eligible");
    });
  });

  // ── resolveOrCreateUser ─────────────────────────────────────────

  describe("resolveOrCreateUser", () => {
    it.each(providerIssuers)("stores the canonical issuer for %s", async (provider, issuer) => {
      await store.resolveOrCreateUser({
        provider,
        providerUserId: `${provider}-subject`,
      });

      const identity = await store.getIdentity(provider, `${provider}-subject`);
      expect(identity?.providerIssuer).toBe(issuer);
    });

    it("creates a new user with no email", async () => {
      const result = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
      });

      expect(result.isNew).toBe(true);
      expect(result.displayName).toBe("Alice");
      expect(result.email).toBeNull();

      const user = await store.getUserById(result.id);
      expect(user).not.toBeNull();
      expect(user!.displayName).toBe("Alice");
      expect(user!.email).toBeNull();
      expect(
        await env.DB.prepare("SELECT team_id, source FROM team_memberships WHERE user_id = ?")
          .bind(result.id)
          .first()
      ).toBeNull();
    });

    it("normalizes a reported email to lowercase on the identity", async () => {
      const result = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
        providerEmail: "Alice@Example.COM",
      });

      expect(result.isNew).toBe(true);
      const identity = await store.getIdentity("github", "12345");
      expect(identity!.providerEmail).toBe("alice@example.com");
    });

    it("treats whitespace-only provider emails as absent instead of persisting empty strings", async () => {
      // idx_users_email is unique: two users persisting "" would collide on
      // one slot. A blank email must normalize to NULL at every boundary.
      const first = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "U1BLANK",
        providerEmail: "   ",
      });
      const second = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "U2BLANK",
        providerEmail: "   ",
      });

      expect(first.email).toBeNull();
      expect(second.email).toBeNull();
      expect(second.id).not.toBe(first.id);
      expect((await store.getUserById(first.id))!.email).toBeNull();
      expect((await store.getIdentity("slack", "U1BLANK"))!.providerEmail).toBeNull();
      // A blank lookup matches nothing rather than an empty-string row.
      expect(await store.getUserByEmail("   ")).toBeNull();
    });

    it.each(["slack", "linear", "github"] as const)(
      "keeps an allowed-domain email that %s reports off its new user",
      async (provider) => {
        const result = await store.resolveOrCreateUser(
          { provider, providerUserId: `${provider}-reporter`, providerEmail: "alice@corp.example" },
          CORP_LINKS
        );

        expect(await store.getUserById(result.id)).toMatchObject({
          email: null,
          emailVerified: false,
        });
        expect(await store.getIdentity(provider, `${provider}-reporter`)).toMatchObject({
          providerEmail: "alice@corp.example",
        });
      }
    );

    it("keeps an email outside the allowed domains on the identity only", async () => {
      const result = await store.resolveOrCreateUser(
        {
          provider: "slack",
          providerUserId: "U-CONTRACTOR",
          providerEmail: "alice@contractor.example",
        },
        CORP_LINKS
      );

      expect(await store.getUserById(result.id)).toMatchObject({ email: null });
      expect(await store.getIdentity("slack", "U-CONTRACTOR")).toMatchObject({
        providerEmail: "alice@contractor.example",
      });
    });

    it("returns existing user for known identity and updates display_name", async () => {
      const first = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
      });
      const beforeUpdate = await store.getUserById(first.id);

      const second = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice Updated",
      });

      expect(second.id).toBe(first.id);
      expect(second.isNew).toBe(false);
      expect(second.displayName).toBe("Alice Updated");

      const user = await store.getUserById(first.id);
      expect(user!.displayName).toBe("Alice Updated");
      expect(user!.updatedAt).toBeGreaterThanOrEqual(beforeUpdate!.updatedAt);
    });

    it("does not repair a missing role assignment during identity resolution", async () => {
      const first = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "missing-assignment",
      });
      await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?")
        .bind(first.id)
        .run();

      await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "missing-assignment",
      });

      const assignment = await env.DB.prepare(
        "SELECT role_id FROM user_role_assignments WHERE user_id = ?"
      )
        .bind(first.id)
        .first();
      expect(assignment).toBeNull();
    });

    it.each(BOT_PROVIDERS)(
      "links a %s actor to the verified owner of an allowed-domain email",
      async (provider) => {
        const owner = await store.createUser({
          displayName: "Alice",
          email: "alice@corp.example",
          emailVerified: true,
        });

        const linked = await store.resolveOrCreateUser(
          {
            provider,
            providerUserId: `${provider}-alice`,
            displayName: "Alice (bot)",
            providerEmail: "Alice@Corp.Example",
          },
          CORP_LINKS
        );

        expect(linked).toMatchObject({
          id: owner.id,
          isNew: false,
          linkedByEmailDomain: "corp.example",
        });
        expect(await store.getIdentity(provider, `${provider}-alice`)).toMatchObject({
          userId: owner.id,
        });
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first()).toEqual({
          count: 1,
        });
      }
    );

    it.each(
      BOT_PROVIDERS.flatMap((provider) => [
        {
          provider,
          refusal: "the owner's email is unverified",
          email: "alice@corp.example",
          ownerVerified: false,
          policy: CORP_LINKS,
        },
        {
          provider,
          refusal: "no domain is allowed",
          email: "alice@corp.example",
          ownerVerified: true,
          policy: parseEmailLinkPolicy(undefined),
        },
        {
          provider,
          refusal: "the domain is not allowed",
          email: "alice@contractor.example",
          ownerVerified: true,
          policy: CORP_LINKS,
        },
      ])
    )(
      "keeps a $provider actor standalone when $refusal",
      async ({ provider, email, ownerVerified, policy }) => {
        const owner = await store.createUser({ email, emailVerified: ownerVerified });

        const result = await store.resolveOrCreateUser(
          { provider, providerUserId: `${provider}-actor`, providerEmail: email },
          policy
        );

        expect(result).toMatchObject({ isNew: true, linkedByEmailDomain: null });
        expect(result.id).not.toBe(owner.id);
        expect(await store.getUserById(result.id)).toMatchObject({
          email: null,
          emailVerified: false,
        });
        expect(await store.getIdentity(provider, `${provider}-actor`)).toMatchObject({
          userId: result.id,
          providerEmail: email,
        });
      }
    );

    it("links a Google identity to a verified owner without touching other providers' subjects", async () => {
      const owner = await store.createUser({ email: "cole@corp.example", emailVerified: true });

      const github = await store.resolveOrCreateUser(
        { provider: "github", providerUserId: "gh-900", providerEmail: "cole@corp.example" },
        CORP_LINKS
      );
      const google = await store.resolveOrCreateUser(
        {
          provider: "google",
          providerUserId: "google-sub-900",
          providerEmail: "cole@corp.example",
        },
        CORP_LINKS
      );

      expect(github.id).toBe(owner.id);
      expect(google.id).toBe(owner.id);
      const identities = await store.getIdentitiesForUser(owner.id);
      expect(
        identities.map(({ provider, providerUserId }) => ({ provider, providerUserId }))
      ).toEqual([
        { provider: "github", providerUserId: "gh-900" },
        { provider: "google", providerUserId: "google-sub-900" },
      ]);
    });

    it("keeps a later-reported allowed-domain email off an email-less user", async () => {
      const first = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "UABC",
        displayName: "Alice",
      });
      expect(first.email).toBeNull();

      const second = await store.resolveOrCreateUser(
        {
          provider: "slack",
          providerUserId: "UABC",
          displayName: "Alice",
          providerEmail: "alice@corp.example",
        },
        CORP_LINKS
      );

      expect(second).toMatchObject({ id: first.id, email: null, linkedByEmailDomain: null });
      expect(await store.getUserById(first.id)).toMatchObject({ email: null });
      expect(await store.getIdentity("slack", "UABC")).toMatchObject({
        providerEmail: "alice@corp.example",
      });
    });

    it("grants no bootstrap admin role from a bot-reported email, even once OAuth proves it", async () => {
      const roles = new PlatformRoleStore(env.DB, { adminUsers: "admin@corp.example" });
      const actor = await store.resolveOrCreateUser(
        { provider: "slack", providerUserId: "U-ADMIN-CLAIM", providerEmail: "admin@corp.example" },
        CORP_LINKS
      );

      expect(await roles.getEffectiveRole(actor.id)).toBe("member");

      await new IdentityClaimStore(env.DB).verifyEmailOwner("admin@corp.example");

      expect(await roles.getEffectiveRole(actor.id)).toBe("member");
    });

    it("refreshes identity metadata on repeat sign-in", async () => {
      // Create user without email or login
      await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "UABC",
        displayName: "Alice",
      });

      const before = await store.getIdentity("slack", "UABC");
      expect(before!.providerEmail).toBeNull();
      expect(before!.providerLogin).toBeNull();

      // Same identity, now with email and login (after Slack scope added)
      await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "UABC",
        displayName: "Alice",
        providerLogin: "alice.smith",
        providerEmail: "alice@example.com",
      });

      const after = await store.getIdentity("slack", "UABC");
      expect(after!.providerEmail).toBe("alice@example.com");
      expect(after!.providerLogin).toBe("alice.smith");
    });

    it("re-links an email-less identity to the verified owner of its allowed-domain email", async () => {
      const owner = await store.createUser({ email: "shared@corp.example", emailVerified: true });
      const slackUser = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "slack-222",
      });
      expect(slackUser.id).not.toBe(owner.id);

      const result = await store.resolveOrCreateUser(
        { provider: "slack", providerUserId: "slack-222", providerEmail: "shared@corp.example" },
        CORP_LINKS
      );

      expect(result).toMatchObject({
        id: owner.id,
        email: "shared@corp.example",
        linkedByEmailDomain: "corp.example",
      });
      expect(await store.getIdentity("slack", "slack-222")).toMatchObject({ userId: owner.id });
    });

    it("does not re-link an identity to an unverified owner of its email", async () => {
      const owner = await store.createUser({ email: "shared@corp.example" });
      const slackUser = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "slack-222",
      });

      const result = await store.resolveOrCreateUser(
        { provider: "slack", providerUserId: "slack-222", providerEmail: "shared@corp.example" },
        CORP_LINKS
      );

      expect(result).toMatchObject({ id: slackUser.id, email: null, linkedByEmailDomain: null });
      expect(await store.getIdentity("slack", "slack-222")).toMatchObject({
        userId: slackUser.id,
      });
      expect(await store.getUserById(owner.id)).toMatchObject({ emailVerified: false });
    });

    it("stores avatar_url on new user", async () => {
      const result = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
        avatarUrl: "https://avatars.example.com/alice.png",
      });

      const user = await store.getUserById(result.id);
      expect(user!.avatarUrl).toBe("https://avatars.example.com/alice.png");
    });

    it("concurrent calls for same identity resolve to same user without orphans", async () => {
      const identity = {
        provider: "github" as const,
        providerUserId: "race-123",
        displayName: "Racer",
      };

      const [a, b] = await Promise.all([
        store.resolveOrCreateUser(identity),
        store.resolveOrCreateUser(identity),
      ]);

      // Both resolve to the same canonical user
      expect(a.id).toBe(b.id);

      // Exactly one identity row exists (no duplicates)
      const identities = await store.getIdentitiesForUser(a.id);
      expect(identities).toHaveLength(1);

      // No orphaned user rows — count all users in the table
      const allUsers = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first<{
        cnt: number;
      }>();
      expect(allUsers!.cnt).toBe(1);
    });
  });

  // ── createIdentity ──────────────────────────────────────────────

  describe("createIdentity", () => {
    it.each(providerIssuers)("stores the canonical issuer for %s", async (provider, issuer) => {
      const user = await store.createUser({ displayName: "Alice" });
      await store.createIdentity({
        userId: user.id,
        provider,
        providerUserId: `${provider}-subject`,
      });

      const identity = await store.getIdentity(provider, `${provider}-subject`);
      expect(identity?.providerIssuer).toBe(issuer);
    });
  });

  // ── getUserById ─────────────────────────────────────────────────

  describe("getUserById", () => {
    it("returns user when found", async () => {
      const created = await store.createUser({ displayName: "Alice", email: "alice@example.com" });

      const user = await store.getUserById(created.id);
      expect(user).not.toBeNull();
      expect(user!.id).toBe(created.id);
      expect(user!.displayName).toBe("Alice");
      expect(user!.email).toBe("alice@example.com");
      expect(user!.createdAt).toBeTypeOf("number");
      expect(user!.updatedAt).toBeTypeOf("number");
    });

    it("returns null when not found", async () => {
      const user = await store.getUserById("nonexistent");
      expect(user).toBeNull();
    });
  });

  // ── getIdentitiesForUser ────────────────────────────────────────

  describe("getIdentitiesForUser", () => {
    it("returns all identities for a user", async () => {
      const user = await store.createUser({
        displayName: "Alice",
        email: "alice@example.com",
        emailVerified: true,
      });
      const links = parseEmailLinkPolicy("example.com");
      await store.resolveOrCreateUser(
        { provider: "github", providerUserId: "gh-123", providerEmail: "alice@example.com" },
        links
      );
      await store.resolveOrCreateUser(
        { provider: "slack", providerUserId: "slack-456", providerEmail: "alice@example.com" },
        links
      );

      const identities = await store.getIdentitiesForUser(user.id);
      expect(identities).toHaveLength(2);

      const github = identities.find((i) => i.provider === "github")!;
      expect(github.providerUserId).toBe("gh-123");
      expect(github.providerEmail).toBe("alice@example.com");

      const slack = identities.find((i) => i.provider === "slack")!;
      expect(slack.providerUserId).toBe("slack-456");
    });

    it("returns empty array when user has no identities", async () => {
      const identities = await store.getIdentitiesForUser("nonexistent");
      expect(identities).toEqual([]);
    });
  });

  // ── getIdentity ─────────────────────────────────────────────────

  describe("getIdentity", () => {
    it("returns identity when found", async () => {
      await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
        providerLogin: "alice",
      });

      const identity = await store.getIdentity("github", "12345");
      expect(identity).not.toBeNull();
      expect(identity!.provider).toBe("github");
      expect(identity!.providerUserId).toBe("12345");
      expect(identity!.providerLogin).toBe("alice");
      expect(identity!.createdAt).toBeTypeOf("number");
    });

    it("returns null when not found", async () => {
      const identity = await store.getIdentity("github", "nonexistent");
      expect(identity).toBeNull();
    });
  });
});
