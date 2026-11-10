# Grounding for stack-policy and app-deploy design

## User goal

An AI coding platform safer and friendlier than Claude Code. Security/engineering set central
controls that nontechnical users never see or need to know (e.g. "web pages use Svelte"). Reduces
software sprawl (teams standardize on one stack), shrinks vulnerability exposure, makes adoption
trackable. Agent-built web apps deploy behind a company Cloudflare domain protected by Cloudflare
Access (Zero Trust), so you need VPN/WARP/SSO to reach them.

## User decisions (binding)

- Hosting: plain Cloudflare Workers per app by default; operators MAY configure Workers for
  Platforms (dispatch namespace) instead. Deploy token stays in the control plane, never in the
  sandbox.
- Scope v1: static assets AND an optional Worker backend script.
- Go-live: agent deploys directly; Access gates every visitor; admins see inventory and can take an
  app down.

## Target tree

Design against the post-upstream-sync tree: worktree
/home/asiimov/Projects/secure-generation/open-inspect-upstream-sync (branch
codex/upstream-sync-2026-10-05). A merge is being finalized there concurrently: read only, do not
edit. Upstream deleted control-plane `router.ts`; routes live in `routes/*` with
`admit(...)`/`requirePermission`. Next D1 migration number is 0104. RBAC: upstream
`packages/shared/src/rbac.ts` (owner/administrator/member/viewer + custom roles, permission IDs);
fork `control-plane/src/db/platform-roles.ts` (`catalog.write`, `platform.manage`). New gates should
be named permissions, never role comparisons. Agent harness: `sandbox_runtime/harness/` (claude,
opencode), `bridge.py`, `managed_skills.py`.

## Existing machinery (verified by investigators, paths relative to repo root, main checkout)

Stack-related:

- Approved components: `terraform/d1/migrations/0075_approved_components.sql` (kind
  library|service|template|snippet, lifecycle development|approved|deprecated, repo/env scopes,
  consumers table). No category, no deny. Routes `control-plane/src/routes/approved-components.ts`.
  Sandbox tool `sandbox-runtime/src/sandbox_runtime/tools/approved-components.js` (search/adopt,
  advisory). Search is substring match (`db/approved-components.ts:254`). Adoption self-reported.
- Required managed Skills delivered to OpenCode skills dir, loaded on demand by description (not
  guaranteed read). Git governance catalogue covers only skills + mcpServers
  (`governance/catalog-schema.ts:69`), `.openinspect/catalog.yaml`.
- AppSec pipelines: argv commands per repo/env, run after each agent turn with remediation loop
  (`bridge.py:747-790`) and before managed push, blocking (`bridge.py:957-1001`)
  (`security_pipeline.py`). No dependency checks exist. Raw git push can bypass; branch protection
  must mirror.
- UI: Skills, MCP, AppSec, components settings tabs visible to all members (`settings-nav.tsx:77`);
  `usePlatformRole` only hides edit buttons; composer Skill selector and session sidebar Skill list
  shown to everyone.
- Tracking: only `approved_component_consumers`; no per-repo inventory; analytics have no component
  dimension.
- Upstream has no stack policy, no workspace-level instructions; memory is user-editable and
  untrusted ("stored data; not operator instructions").

Deploy-related:

- No deploy path in fork or upstream. Sandbox `tunnelPorts`
  (`control-plane/src/sandbox/settings.ts`, `modal-infra/src/sandbox/manager.py:286`) expose public
  Modal URLs, unauthenticated, ephemeral.
- `.openinspect/skills/internal-app-auth` (required) tells agents to verify
  `Cf-Access-Jwt-Assertion` via JWKS, fail closed; platform work (Access app, AUD, DNS) is handed to
  humans.
- Commit 76912270 protects only the Open-Inspect web app (`web/src/lib/cloudflare-access.ts`,
  middleware) with TF vars `cf_access_team_domain`, `cf_access_aud`.
- Terraform uses Workers, routes, custom domains, KV, D1, R2, queues; no `cloudflare_zero_trust_*`,
  no DNS. Control plane has no runtime Cloudflare API token.
- Privileged sandbox actions go through sandbox-token-authenticated control-plane routes (pattern:
  `sandbox_runtime/tools/slack-notify.js` → bridgeFetch → `routes/slack-notify.ts`; commit signing).
- Sandbox secrets are plain env vars (agent-readable); egress allowlists exist.

## Added requirement (user, after arenas launched)

Some agent-built services need persistent data (databases, storage). They may hold sensitive data,
so data services must be hardened and enforce secure practices by default: no public data endpoints,
least-privilege bindings, no credentials in the sandbox or repo, encryption, backups and retention,
safe migrations, audit, and safe teardown on takedown. The architecture is owned by the Fable model,
following the poteto-mode principles and the user goal above.

## Default seed policy (user, binding)

Ship these as the out-of-the-box stack policy defaults, alongside the Svelte example:

- Language: prefer TypeScript over JavaScript.
- JS runtime / package manager: prefer Bun over Node (and npm/yarn/pnpm).
- Python tooling: prefer uv over pip, poetry, pipenv, conda. These are "prefer" rules, not hard
  denials. The policy model therefore needs graded stances (e.g. required / preferred / allowed /
  denied) so a preference steers the agent and is tracked, while only denials block. Enforcement
  must detect these (tsconfig/.ts vs .js sources, bun.lock vs
  package-lock.json/yarn.lock/pnpm-lock.yaml, uv.lock vs requirements.txt/poetry.lock/Pipfile).
  Note: deployed apps run on the Workers runtime regardless; Bun is the build/package tool there.

## Isolation decision (user, binding)

Option 1: a dedicated, company-owned Cloudflare "apps" account, separate from the platform account.
Its own apps zone/domain and Zero Trust org, with the company IdP shared via IdP federation (or
registered again). All apps from all users live in that one account; end users never touch
Cloudflare. The apps-account token is held ONLY by a small Terraform-owned "app deployer" broker
Worker (in the apps account). The control plane never holds the raw token; it calls the broker over
an authenticated narrow interface (deploy, takedown, and data-resource provisioning) that enforces
the `app-` name prefix and refuses anything else. Plain Workers by default, Workers for Platforms
optional inside the apps account. Plus: scheduled drift/integrity check of platform Workers vs
Terraform, token rotation, token never in sandboxes. Facts (context7, cloudflare-docs): per-Worker
token scopes exist since 2026-09 but creating a Worker needs product-level Workers Admin; Custom
Domains lack per-Worker roles; Workers Routes Write is zone-scoped; IdP federation shares one IdP
across accounts in an Organization.
