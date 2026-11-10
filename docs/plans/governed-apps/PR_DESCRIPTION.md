# Governed apps: central stack policy and Access-protected app hosting

## Goal

Security and engineering set the technology stack and the deployment rules once, centrally, and
nobody else has to see them. Agents build internal apps on the approved stack (graded policy:
preferred / allowed / denied; the defaults prefer TypeScript, Bun, uv and Svelte, and deny
React/Next.js). The apps deploy to `https://<app>.<apps_domain>` behind Cloudflare Access, in a
dedicated apps Cloudflare account. Only a broker Worker in that account holds the apps API token,
and the sandbox never holds a credential. App data (D1, KV, R2) is hardened by default: there are no
public endpoints, bindings are least-privilege, destructive migrations wait for approval, secrets
are write-only, restore is point-in-time, and takedown retires data before purging it. Plain members
never see governance. They see their own apps, and admins see everything.

Nothing in this PR turns hosting on. `apps_enabled` defaults to `false`, `sandbox_tunnels_policy`
defaults to `public`, and `identity_link_email_domains` defaults to empty (never link).

## Operator steps (before and after merge)

Merging to `main` auto-deploys (Terraform, D1 migrations, web, Modal). Do these in order.

1. **Back up D1 first.** Record a D1 Time Travel bookmark for the control-plane database. The branch
   carries the upstream sync (`fb066612`) and 19 new migrations (0088–0106). Migration 0104 rebuilds
   `approved_components` over live consumer rows.
2. **Check the GitHub Actions variables** that the new Terraform inputs read: `CF_ACCESS_*` (web
   Access, from `76912270`) and `IDENTITY_LINK_EMAIL_DOMAINS` if you want Slack/Linear linking. See
   `docs/GETTING_STARTED.md` and `terraform/environments/production/terraform.tfvars.example`.
3. **Merge with `APPS_ENABLED` unset or false.** Stack policy, the AppSec and Apps tabs, and the
   identity restriction work without app hosting.
4. **Run the read-only bot-attestation query** below and review every row it returns.
5. **Run the broker live smoke** (`packages/app-broker`, `APP_BROKER_LIVE_SMOKE=1`) against a
   separate test Cloudflare account. It checks the open Cloudflare assumptions: Access precedence of
   an exact hostname over `*.<apps_domain>`, D1 `/query` atomicity, and `workers.dev` staying off.
   It does not cover Workers for Platforms. Treat `apps_hosting_backend = "dispatch-namespace"` as
   experimental until it has its own smoke.
6. **Turn on hosting** by following `docs/APPS.md`: a dedicated apps account and zone, a Zero Trust
   org with your IdP, an apps Terraform token different from `cloudflare_api_token`, then the
   `apps_*` variables and `terraform apply`. Then run the three checks in "Check the deployment".
7. **Set `sandbox_tunnels_policy = "disabled"`** once hosting works. Public preview tunnels have no
   Access, and agents are then told to use `deploy-app`.
8. **Make the stack-policy check an org-required workflow** and require CODEOWNERS review on
   `.github/`. Otherwise a PR can edit its own workflow and bypass the CI mirror.
9. **On the free Workers plan**, consider lowering `MAX_OBSERVED_FACTS`. Parsing a full 5000-fact
   observation measured 12–16 ms locally against the 10 ms CPU limit.

### Bot-attestation query (U12)

Before U12, Slack and Linear attestation (and migration 0057's one-time backlog verify) could set
`users.email_verified = 1` without any mailbox proof. U12 stops that for new rows but leaves
existing rows as they are. This query lists them. It is read-only. Also committed as
`docs/plans/governed-apps/bot-verified-users.sql`.

```sql
-- Read-only. Users whose email is marked verified but that no GitHub or Google sign-in proved.
SELECT
  u.id,
  u.email,
  u.display_name,
  datetime(u.created_at / 1000, 'unixepoch') AS created_at_utc,
  (SELECT group_concat(provider, ',') FROM (
     SELECT DISTINCT provider FROM user_identities WHERE user_id = u.id ORDER BY provider)
  ) AS providers,
  u.platform_role
FROM users u
WHERE u.email_verified = 1
  AND u.email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_identities w
    WHERE w.user_id = u.id
      AND w.provider IN ('github', 'google')
      AND lower(trim(w.provider_email)) = lower(trim(u.email))
  )
ORDER BY u.created_at;
```

Run it with
`wrangler d1 execute <database> --remote --file docs/plans/governed-apps/bot-verified-users.sql`.
For each listed user, either confirm the email through a web sign-in or reset `email_verified` to 0.
Pay particular attention to any user that has a `platform_role` or a match in
`PLATFORM_ADMIN_USERS`.

## What changed

| Area                                | Change                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack policy (U0, U2, U3, U4a, U4b) | Catalogue categories with graded stances and detection signals (migration 0104). Admin and editor APIs. The policy is compiled into the launch prompt. The sandbox enforces it per turn and before push, and reports observations for adoption tracking.                                                                                                                      |
| CI mirror (U11)                     | A CLI and composite Action that run the sandbox's own pre-push checker on PRs.                                                                                                                                                                                                                                                                                                |
| App hosting (U1, U5, U6, U7, U9)    | `deploy-app` sandbox tool → sandbox-token route → control-plane `apps/` → signed broker Worker → apps account. Plain Workers, or Workers for Platforms as an option. Every app is behind a `*.<apps_domain>` Access floor plus its own Access app. Takedown, admin holds and a deployments ledger (migration 0105). The Terraform apps account, broker and Access.            |
| App data (U8)                       | `openinspect.app.json` manifest; D1, KV and R2 provisioning through the broker; a destructive-migration gate (the deploy returns 423 until approved by sha256); write-only secrets per stage; point-in-time restore; retire and purge; an operations ledger; workspace inventory (migration 0106).                                                                            |
| Web (U10a, U10b)                    | The AppSec tab is visible only with `governance.read`, and required governance skills are hidden from members. The new **Apps** tab (`apps.read`): members manage their own apps and browse others read-only. Holders of `apps.manage.any` take down, release holds, edit classification, approve schema changes, set or delete secrets, and restore with typed confirmation. |
| Identity (U12)                      | A Slack- or Linear-reported email never counts as mailbox proof. It links an identity only inside `identity_link_email_domains`, and only to an owner whose email is already verified. Every such link emits `auth.identity_linked_by_email`.                                                                                                                                 |
| Cleanups                            | API catalogue creation returns 409 while the Git catalogue owns it. Admin writes reject `tunnelPorts` when tunnels are disabled. The `deploy-app` gate uses the parsed apps config. knip findings for app-broker and sandbox tools are cleared. MCP and skills writes are gated on named permissions only.                                                                    |

### Access changes reviewers should confirm

- **MCP and skills writes** (`cb0d74e8`). These no longer require the fork's `platform_role` editor
  (`catalog.write`) on top of `mcp_servers.manage` / `skills.manage`. Owners, administrators, the
  0103 catalogue-editor role, and custom roles that hold those permissions can now write without a
  platform role. Members and viewers still cannot. No one lost access, because the named permission
  was already required. `routes/integration-settings.ts` still uses `catalog.write` for network
  policy, so two permission models remain until a later consolidation.
- **`GET /apps`** lists every app to anyone with `apps.read`, which includes members. For an app the
  viewer cannot manage, it leaves out the session and repository that deployed it. The UI shows
  other people's apps read-only, with no data, takedown or secrets actions. Data routes are
  owner-or-`apps.manage.any`, and service principals are refused.

## Known risks and open items

- **Broker scoping.** The broker refuses any resource whose name lacks the `app-` prefix, and any
  binding to such a resource. It does not check that a resource belongs to the app named in the
  request; the control plane enforces that mapping. So the isolation guarantee is: platform account
  separate from apps account, and only `app-*` resources reachable. It is not per-app isolation
  against a compromised control plane.
- **Data retention.** Taken-down apps' data is purged after `APP_DATA_RETENTION_MS` (production 30
  days, preview 7). Data exports and a backups bucket were cut from v1 (architecture D9). If an
  admin takes an app down by mistake, it must be released before the window ends.
- **D10 trust boundary.** Within an allowlisted domain, linking trusts the email the Slack or Linear
  workspace reports. Keep `identity_link_email_domains` empty unless you trust those workspaces'
  admins as much as your IdP.
- **Unverified Cloudflare behaviour.** Access precedence, D1 atomicity and certificate timing are
  covered only by the live smoke (step 5). Workers for Platforms has no smoke.
- **Broker token scopes.** The Terraform-minted broker token also carries zone
  `Workers Routes Write` and `DNS Write` for app custom domains. Its Terraform token and the broker
  token live in Terraform state.

## Verification

Run on this branch (Node 22 locally; CI uses 24):

| Check                                                                | Result                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run typecheck` (all workspaces)                                 | pass                                                                         |
| shared                                                               | 58 files, 1236 tests pass                                                    |
| control-plane unit                                                   | 266 files, 4891 pass, 1 skipped                                              |
| control-plane integration (workerd + D1)                             | 168 files, 2421 pass, 1 skipped                                              |
| web (`--maxWorkers=4`)                                               | 215 files, 2431 pass (no `automation-form` flake this run)                   |
| slack-bot / github-bot / linear-bot                                  | 553 / 302 / 298 pass                                                         |
| app-broker                                                           | 148 pass                                                                     |
| mcp-artifact-builder                                                 | 4 pass                                                                       |
| modal-infra pytest                                                   | 525 pass                                                                     |
| sandbox-runtime pytest                                               | 1659 pass, 7 environment-only failures (see below)                           |
| sandbox-runtime node, ruff, mypy; infra ruff                         | pass                                                                         |
| eslint, prettier, SQL portability, script tests, migration numbering | pass                                                                         |
| `repo-map:check`                                                     | current (20 Settings tabs)                                                   |
| e2e-apps harness (workers, dispatch-namespace)                       | pass, fake violations `[]`                                                   |
| e2e-data harness (workers, dispatch-namespace)                       | pass, fake violations `[]`, 423 block then approve                           |
| e2e-launch harness                                                   | launch text == admin preview for OpenCode and Claude; 14/14 mutations caught |
| Playwright settings specs (real Chrome)                              | 14/14                                                                        |

The 7 sandbox-runtime failures are specific to the container this ran in, and none comes from this
branch. Five git-signing tests pick up the container's global SSH commit-signing config and pass
with `GIT_CONFIG_GLOBAL=/dev/null`. Two `security_pipeline` process-tree timeout tests fail
identically on `main` in the same container. CI should run them clean.

The fake Cloudflare recorded **zero violations** in every e2e harness run.

The web UI was proven with the loopback Playwright verifier in real Chrome: `settings-apps.spec.ts`
covers the member view and the admin view (take down, release hold, approve by sha256, write-only
secret, restore with typed binding name). The existing settings specs were re-run alongside it,
14/14.

Decision trail: `docs/plans/governed-apps/decisions.tsv`. It was reviewed independently by a fresh
Opus 5.5 instance, which was not cross-model. The flagged items are listed in the decision log and
under "Known risks" above.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_018gVZjkh4ZaXwxCRgLCYsfc
