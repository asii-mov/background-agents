# Final architecture: stack policy, app deploy, hardened app data

Synthesis note for arena Phase D (pick) and Phase E (graft). Target tree:
`open-inspect-upstream-sync` (post-merge; routes via `admit()`, upstream `PermissionId`s, next D1
migration 0104). Every decision below is final; nobody is available to ask. Where a decision rests
on a Cloudflare behaviour we have not observed live, it is marked **smoke** and Unit 1's live smoke
script checks it before rollout.

Cross-judge: skipped (only Claude models available, same family as the parent). Picks below are
mine, scored criterion by criterion against the rubric: maintainer extensibility without breaking
invariants, interface depth, single source of truth, fit to the post-sync tree, fail-closed
security, v1 size.

Candidate packages read in full: `arena/stack/candidate-{1,2}`, `arena/deploy/candidate-{1,2}`,
`arena/data/fable`.

---

## 1. Bases, grafts, rejections

### Stack policy: base = candidate 1 (catalogue extension), grafts from candidate 2

**Why candidate 1.** "Svelte" must exist once. In candidate 1 the catalogue row _is_ the policy
entry: locator, usage guidance, lifecycle, repo scope, stance, signals, one revision model, one Git
path (`.openinspect/catalog.yaml` already reconciles into D1 with last-good semantics). Candidate 2
keeps a separate `stackPolicy` document whose options reference catalogue entries through `starter`;
the technology still appears twice (option label and signals in the policy, locator and usage in the
catalogue), and it adds four tables, a per-session pin written into the session-create batch
(touching `session-index.ts`, `session-create.ts`, `session-child-spawn.ts`, `scheduler.ts`), a new
store, and a new reconciler section. Candidate 1 encodes every grade invariant in the schema (CHECK,
partial unique index, FK) and reuses the existing admin API, UI, and Git reconciler. It is the
smaller diff (laziness-protocol) and the shape a future maintainer extends by adding rows, not code
(toolchains are data: file signals, not parsers). Candidate 2's strongest property, byte-identical
policy across relaunches via pins, is bought with machinery we do not need: policy is compiled at
launch and restore like pipelines and MCP servers already are.

**Data stores join the same model** (data design R5): kind `data_store` is added to the catalogue
kind enum, category `app-data-store`, and a fourth signal kind `manifest` (`manifest:d1`,
`manifest:kv`, `manifest:r2`) matched against `openinspect.app.json` `data[*].kind`. The data
module's `DataPolicyLookup.resolveForApp` is `compileForSession(...)` filtered to that category plus
a pure `dataStorePolicyFromRules`. One compile, two consumers; no second policy model.

**Grafts from candidate 2.**

- Operator-block wording: framed as operator instructions that outrank repo files and memory; "never
  ask a non-technical user to choose between technologies; pick the standard." Goes into
  `renderStackInstructions`.
- Advisory nudge for preference deviations, narrowed by candidate 1's open question: one advisory
  round per turn, only for a manifest/lockfile path whose _directory had no manifest at baseline_ (a
  project created in this session), deduplicated per session per evidence key, silent in the member
  UI. Encoded as a new severity `deviation` in the Python table. This is what makes "prefer Bun"
  steer an agent that defaults to npm without fighting an existing repository's choice.
- `rendered` block delivered as a file in the harness config dir and listed first in OpenCode
  `instructions` / prepended to Claude `system_prompt_append` (both candidates converged on this).

**Rejected from candidate 2.** Per-session pins and content-addressed revisions (machinery without a
v1 need); `required` stance (see decision 3); closed marker/extension registries (candidate 1's
globs and `WELL_KNOWN_TOOLCHAIN_FILES` are data, not code); per-repo dated exceptions (candidate 1's
`repoScopes` on a denial covers the realistic case; dated exceptions deferred); `rollout: observe`
(disable the component instead); `TurnGate` refactor of the AppSec loop (candidate 1's `CheckResult`
protocol inside the existing runner is the smaller change with the same single-loop property).

**Rejected from candidate 1.** Shipping `web-frontend` as `advise` (decision 3); separate
`demoteCurrentPreferred` flag stays (it is the one-request standard switch); the phase-2 "commit
status from managed pushes" mirror (a sandbox-attested status is forgeable with the session token;
see decision 2).

### App deploy: base = candidate 1 (synchronous, thin), grafts from candidate 2, reshaped around the broker

The user's isolation decision (dedicated apps account; a Terraform-owned broker Worker is the only
token holder; the control plane calls a narrow authenticated interface) changes both candidates: the
control plane no longer talks to `api.cloudflare.com` at all. Everything either candidate put in
`cloudflare-api.ts`, `edge.ts`, `backends.ts` moves **into the broker package**. The control plane
keeps ownership, authorization, the bundle boundary, the data converge step, and the inventory.

**Why candidate 1's shape.** With the broker doing the ten Cloudflare calls inside one request, the
control plane's part of a deploy is: authorize, claim the name, `appData.prepare`, one broker call,
commit. Every step is an idempotent ensure; retry is "call the tool again". Candidate 2's reconcile
job, lease, R2 bundle store and nine-state machine solve crash-resumability for a multi-request
pipeline the broker collapses into one request. They would also add a queue binding, a bucket, a
Node-host emulation and a two-call tool protocol for the agent. The synchronous path exposes the
smaller surface (one tool call, one route, one broker op) and hides the same invariants.

**Grafts from candidate 2.**

- **Platform guard as the main module of every app script** (host pin to `APP_HOSTNAME`, per-app AUD
  JWT verification against `${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, `run_worker_first: true`
  so static assets are covered, fail closed). It also **sets the identity headers** the data design
  needs (`x-openinspect-user-sub`, `x-openinspect-user-email`) after verification and strips inbound
  copies. This resolves data R2 and gives static-only apps JWT verification, which candidate 1
  lacked. The guard lives in `packages/app-broker/guard/` and is embedded by the broker at script
  upload.
- `app_deployments` history ledger (version, bundle sha, cf version id, who/when/session, data
  digest, failure reason). Not for rollback in v1; it is the audit record and the one-live-row
  invariant.
- Team ownership (`owner_team_id` from `session.ownerTeamId`; teammates may redeploy).
- Takedown kinds `owner_unpublished | admin_takedown`; names are never released in v1 (an old
  bookmark can never land on someone else's app).
- Reserved-name list includes the platform's own labels (`deployer`, `dispatcher`).

**Rejected from candidate 2.** Reconcile queue/lease/state machine; R2 content-addressed bundle
store and the three-route upload protocol; rollback/restore/repair deployments; post-attach probe
and `security_hold` (the guard and the wildcard floor make the probe redundant in v1); 100 MiB
bundles.

**Rejected from candidate 1.** Control-plane-held Cloudflare token (replaced by the broker);
`purgeApp` and name release; the `OI_APP_URL` var (derivable).

### App data: base = Fable design, confirmed with revisions (decision 5)

### Convergence worth noting

Both stack candidates: introduced-only blocking, fact-reporting sandboxes, operator block in the
system prompt, same four seed domains. Both deploy candidates: per-app Access app with its own AUD
over a Terraform wildcard floor, workers.dev and previews forced off, custom domain as the only
ingress, claim-first ownership, named permissions with a scoped `apps.manage` pair, `deploy-app`
tool shared by both harnesses, a fake Cloudflare with an ingress-invariant checker as the primary
test asset. These are shipped as consensus.

---

## 2. Decisions

### D1. Stack policy storage

- **Catalogue extension** (candidate 1). Migration 0104 rebuilds `approved_components` (0031 recipe,
  consumers staged and restored) to widen `kind` to
  `library|service|template|snippet|language|tool|data_store`, add `category_id`,
  `stance (preferred|allowed|denied)`, `source_*`; adds `component_categories`
  (`enforcement advise|block` applies to denials only), `approved_component_signals` (PK
  `(kind, ecosystem, value)`; kinds `package|file|source|manifest`), and the inventory tables
  `repository_stack_observations` / `repository_stack_facts`.
- **Single source of truth for "Svelte"**: one `approved_components` row. The Git catalogue
  (`.openinspect/catalog.yaml`) gains optional `categories` and `components` keys that reconcile
  into the same rows (`source_kind='git'`; API writes to git-owned rows return 409). App rows and
  Git rows never coexist for the same name; the uniqueness index is on `lower(name)`.
- **Seed** lives once, in 0104: categories `language`, `js-toolchain`, `python-tooling`,
  `web-frontend`, `app-data-store`; components TypeScript/JavaScript, Bun/npm/Yarn/pnpm/Node.js,
  uv/pip/Poetry/Pipenv/conda, Svelte/React/Next.js, D1/KV/R2. A golden test pins the rendered
  instructions.
- **Data stores**: `kind='data_store'`, locator `d1|kv|r2`, signals `manifest:<kind>`; validation
  for this kind requires a category and a manifest signal, no version/integrity. External
  (Hyperdrive) stores are deferred (decision 5) but the locator grammar reserves
  `hyperdrive:<service>`.

### D2. Delivery, enforcement stage, CI mirror

- **Delivery**: compiled at sandbox launch and restore by
  `ApprovedComponentStore.compileForSession`, threaded as one
  `SessionGovernance { securityPipelines?, stackPolicy? }` value (replacing the hand-threaded
  `securityPipelines` field through `provider.ts`, `client.ts`, providers, `sandbox-env.ts`),
  serialized to the `stack_policy` key of `SESSION_CONFIG`. Tamper-proof against the agent (the
  bridge parses its own env), no network at boot. Supervisor gains a `policy` boot phase that writes
  `oi-stack-policy.md` into the harness config dir; `platform_context.py` is the one owner of
  ordering (policy, then AGENTS.md guidance, then untrusted memory) for both harnesses: Claude
  `system_prompt_append`, OpenCode `instructions[0]`. The data instructions
  (`renderDataInstructions`) render into the same block when `app-data-store` exists.
- **Enforcement**: a built-in `StackConformanceStage` hosted by `SecurityPipelineRunner`, results
  behind a three-member `CheckResult` protocol so the remediation loop (`bridge.py`) and the
  pre-push gate (`push_operation.py`) are unchanged except `runner.has_checks`. Per turn: the
  worktree (`git ls-files --cached --others --exclude-standard`). Pre-push: the pushed commit tree.
  Baseline: `base_sha` from the repo manifest. The app-data conformance checker is **not** a second
  stage: it is a seeded platform `security_pipelines` row invoking
  `python -m sandbox_runtime.conformance app-data` (which execs Bun on the bundled checker).
  `assertHarnessGovernance` is narrowed so neither the stack policy nor command pipelines are
  refused for the Claude harness: the stage and the pipelines run in `bridge.py`, which is
  harness-agnostic, and Claude's PR path goes through `POST /pr` → `PushOperation`.
- **CI mirror for raw `git push`**: v1 ships (a) a pure offline CLI
  `python -m sandbox_runtime.stack_policy_cli check --policy <json> --base <sha> --head <sha>` (same
  `collect_tree_facts` + `evaluate`), (b) `GET /stack-policy/export?repo=` (`governance.read`)
  returning the compiled policy JSON, (c) a composite GitHub Action
  `.github/actions/stack-policy-check` that runs the CLI on a policy file a prior step supplies, and
  (d) docs for a required status check. The Action does **not** invent a CI credential; operators
  supply the policy file (fetched with a user/service token of their choosing, or a committed
  export). Rejected: control-plane-posted commit statuses from managed pushes (the observation is
  sandbox-reported and therefore forgeable with the session token: theatre against a malicious
  agent, which is the only bypass that matters).

### D3. Grades

- **No `required` grade.** "Only X" is preferred X plus denied siblings; "must be present" needs
  category-occupancy detection no signal provides. The data design's `required ≈ preferred`
  collapses into `preferred`. Stances: `preferred | allowed | denied`.
- **React/Next.js block on day one**: seed `web-frontend.enforcement = 'block'`. The user's example
  is a denial; delta semantics (only `(signal, manifest path)` pairs absent at `base_sha` count)
  mean no legacy repository is blocked; a product whose headline denial ships as advice does not do
  what it says. The other seed categories hold no denials, so their enforcement value is moot.
- **`uv export` mixed signal**: a platform constant `DERIVED_FILE_RULES` (`requirements*.txt` is
  derived when `uv.lock` or `pylock.toml` is a sibling in the same directory), exported into the
  sandbox contract. The scanner tags such file facts `derived: true`; matching and status derivation
  skip derived facts. JS lockfile pairs are **not** derived (two lockfiles is a real mix). Platform
  rule, not per-signal, like the source exclusions.
- **Nudge for new projects on non-preferred tools**: yes, as grafted (one advisory round,
  new-project condition, per-session dedupe, silent to members, never blocks, never affects a push).

### D4. Deploy

- **Synchronous** request from the sandbox tool (≤150 s) → control-plane route (≤120 s) → one broker
  `deploy` call. Every step is an idempotent ensure; the tool's guidance for `hosting_unavailable`
  and `deadline_exceeded` is "call once more". No queue, no DO, no lease.
- **Bundle transport**: one multipart request, **16 MiB cap** (matches
  `SERVICE_REQUEST_MAX_BODY_BYTES` so the control plane → broker hop is sig1-signed over the body).
  Parts: `manifest` (deploy manifest), `app` (`openinspect.app.json`, optional), `m0..mN` (migration
  files), `a0..aN` assets, `worker` (optional single ES module). The control plane re-streams assets
  and worker to the broker; the broker runs the assets-upload-session flow (only buckets Cloudflare
  asks for). R2 staging rejected for v1.
- **Versions/rollback**: `app_deployments` records `cf_version_id` per deploy; rollback UI deferred
  (plain Workers can later roll back via the deployments API without stored bundles; WfP cannot).
- **Per-app Access app + wildcard floor**: both. The floor (`*.<apps domain>`, Terraform,
  security-owned policy) guarantees no hostname is ever reachable without Access; the per-app app
  gives each app its own AUD so a prompt-injected app cannot replay a visitor's token against
  another app. Exact beats wildcard **(smoke)**.
- **Guard layer**: the platform guard (above) is the main module; `run_worker_first: true`; static
  assets are behind JWT verification too. WfP: dispatcher derives the namespace script from the Host
  header (contract test against `appScriptName`); the guard inside each script still verifies.
- **Broker interface** (`packages/shared/src/app-broker.ts`): `POST /deploy` (multipart: request
  JSON + parts; response `{ url, backend, cfVersionId, accessAud, firstDeploy }`), `POST /takedown`
  (`{ name }` → `{ cleanupComplete, failedStep? }`), `POST /data` (the data ops), `GET /health`. The
  broker enforces: app names match the pattern and reserved list; every Workers/Access/domain object
  it touches derives from `<script prefix><name>` / `<name>.<apps domain>`; every data resource name
  starts with `app-` (re-checked on the _resolved_ resource for id-based ops). **Auth**: sig1
  (existing `@open-inspect/shared/service-auth`) with new `ServiceName "control-plane"`, secret
  `SERVICE_AUTH_SECRET_CONTROL_PLANE` on the broker, `SERVICE_AUTH_SECRET_APP_BROKER` on the control
  plane (Terraform `random_password`), **plus** an exact-hostname Access application on
  `deployer.<apps domain>` with a service-token policy (Terraform-owned; the control plane presents
  `CF-Access-Client-Id/Secret`). The exact app takes precedence over the wildcard floor, so the
  control plane is never redirected to SSO. mTLS rejected (certificate distribution to a Worker
  client is heavier than a service token and adds nothing over sig1 + Access). Service bindings are
  impossible across accounts.
- **Plain Workers vs WfP inside the apps account**: Terraform variable `apps_hosting_backend`
  (`workers` default, `dispatch-namespace` optional) becomes a broker binding; the broker has the
  two `HostingBackend` implementations (candidate 1's interface, moved). The control plane is
  backend-agnostic: it stores the `backend` the broker reports and refuses redeploy with
  `hosting_backend_changed` if the broker now reports another. WfP: Terraform creates the namespace
  and the dispatcher Worker (workers.dev off) in the apps account.
- **Broker runtime token**: Terraform mints it with `cloudflare_account_token` in the apps account
  (scopes: Workers Scripts Edit, Workers Custom Domains, Access Apps and Policies Edit, D1 Edit, KV
  Edit, R2 Edit; WfP Edit when enabled) and binds it as a broker secret. Rotation = taint/re-apply.
  Fallback variable if the pinned provider (`>=5.16,<5.20`) lacks the resource **(verify in
  Unit 7)**. The operator's Terraform token for the apps account (provider alias `cloudflare.apps`)
  is separate and never reaches any Worker.

### D5. Data

Confirmed with these revisions:

- The broker is the single Worker holding both halves (deploy and data); `DataHost` is the sig1
  broker client; `AppDataService.prepare` runs **before** the broker deploy call and its
  `AppDataBindings` (D1/KV/R2 ids plus `SecretText` secrets) travel inside the deploy request; the
  broker turns them into `d1|kv_namespace|r2_bucket|secret_text` bindings. Takedown → `retire`;
  redeploy within the window → `reinstate` inside `prepare`. No separate restore path.
- **R1 (D1 atomicity)**: D1 documents batch submission as one SQL transaction with full rollback on
  failure; the REST `/query` endpoint accepts a multi-statement body. The broker sends one migration
  file per `/query` request and we treat that as atomic, **but correctness never depends on it**: a
  Time Travel bookmark is recorded before every file and surfaced on failure. The live smoke test
  runs a file whose second statement fails and asserts the first did not persist; if it did, the
  broker switches to one statement per request (one-function change) and the recorded bookmark
  remains the recovery path.
- **R2 (identity contract)**: resolved by the guard (D4). `ACCESS_IDENTITY_HEADERS` and
  `FORBIDDEN_IDENTITY_HEADERS` are defined once in `shared/types/app-data.ts`; the guard, the
  conformance checker, the dev entry and the skill all read them. The `internal-app-auth` skill is
  rewritten: on this platform the guard verifies Access and the app reads `x-openinspect-user-sub`;
  self-verification guidance moves to a reference for apps hosted elsewhere.
- **Stage**: the `stage` column stays (structural preview/production separation is cheap) but v1 is
  production-only; no preview UI or routes.
- **Cut from v1**: exports to a backups bucket (and the bucket); external/Hyperdrive services (the
  manifest schema rejects `external` with guidance "not enabled; tell the user"); per-row runtime
  audit; secret rotation reminders. **Kept**: classification label + admin lock,
  destructive-migration approval (owner or admin), per-stage secrets (write-only, encrypted with
  `REPO_SECRETS_ENCRYPTION_KEY`), restore-to-point-in-time (one broker op, typed confirmation),
  retire → 30-day window → resumable purge, operations ledger as the audit log, workspace data
  inventory, KV-under-jurisdiction rule, conformance checker (token-based rules, conservative),
  `oi-app dev` config generator.
- **Permissions collapse**: no `apps.data.*` permissions. Data management rides
  `apps.manage.own/any` (the owner manages their app, which includes its data); classification lock
  and restricted-app restores need `apps.manage.any`; the workspace data inventory is a governance
  view under `governance.read`.

### D6. Members' visibility and permissions

New `PermissionId`s (six): `governance.read`, `governance.manage`, `apps.read`, `apps.deploy`,
`apps.manage.own`, `apps.manage.any`; `SCOPED_PERMISSION_PAIRS["apps.manage"]`. Member gets
`apps.read`, `apps.deploy`, `apps.manage.own`. Viewer gets nothing new. Owner/Administrator get all
through `permissionsForBuiltInRole`. `role_fork_catalog_editor` (0103) gets `governance.read`,
`governance.manage` (0104) and the member apps grants (0105). `governance.manage`, `apps.manage.*`
join `AUDITED_ALLOWED_PERMISSIONS`.

| Surface                                                                                                                                                                             | Rule                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings tab `appsec` (catalogue, categories, pipelines, risk, catalogue status, stack inventory, data inventory)                                                                   | `anyOf("governance.read")` (was `publicSettings`)                                                                                                                                                                  |
| `GET` approved-components, component-categories, security-pipelines, repository-risk, governance catalogue status, stack-policy preview/export, stack-inventory, app-data inventory | `requirePermission("governance.read")` (was `activeGlobal()`)                                                                                                                                                      |
| Governance writes                                                                                                                                                                   | `requirePermission("governance.manage")`; the fork's `requiredPermission: "catalog.write"` is removed from these routes (one gate, not two); `platform-roles.ts` is left for other callers and queued for deletion |
| Settings tab `apps` (own apps: URL, status, secrets, schema approvals, restore, ledger, take down)                                                                                  | `anyOf("apps.read")`; admin-only actions (all apps, takedown any, classification lock) by `apps.manage.any`                                                                                                        |
| Composer skill autocomplete and session sidebar skill list                                                                                                                          | required (governance) skills are filtered out for everyone; nobody picks a required skill, it is auto-loaded                                                                                                       |
| Stack policy in the session UI                                                                                                                                                      | nothing: no skill entry, no timeline events for passes, preference findings or nudges; a blocking violation surfaces only as the agent's own fix or a plain-language turn/push error                               |
| `usePlatformRole` edit-button gating in web                                                                                                                                         | replaced by a permission check (`governance.manage`)                                                                                                                                                               |

Route-level app ownership uses a new `RouteAuthorizationRequirement`
`{ kind: "app"; operation: "manage"; appParam: string }` that mirrors `automation`: resolve the
scoped pair, `own` ⇔ actor is the owner or a member of the owner team. Permission IDs everywhere; no
role comparisons.

### D7. Preview tunnels (public today)

Fix now, minimally: a Terraform-driven control-plane setting
`SANDBOX_TUNNELS_POLICY = public | disabled` (default `public`, upstream behaviour). When
`disabled`, `tunnelPorts` is rejected at `sandbox/settings.ts` validation with a message pointing to
`deploy-app`. The onboarding docs set it to `disabled` when app hosting is enabled. The
Access-fronted preview proxy (candidate 2's optional design) is deferred; proxying does not help
while the Modal URL itself stays public.

### D8. Domain and WARP

- **Apps zone** is operator config: `apps_zone_id` + `apps_domain` in the apps account. Recommended:
  a separate registered domain owned by the apps account (e.g. `acme-apps.example`), because a zone
  cannot be split across accounts without Enterprise subdomain delegation; that delegation
  (`apps.acme.com` delegated to the apps account) is documented as the alternative. A Terraform
  check refuses an apps domain that is a suffix of the web app's custom domain.
- **Device posture**: the Terraform-owned visitor policy has `include` (identity: email domain, IdP
  groups via IdP federation or re-registration) and `require` rules. Posture/WARP rules can only be
  evaluated for devices enrolled in the apps account's Zero Trust org; a device enrolls in one org.
  v1 default is SSO-only; the docs state the trade-off and leave posture to the operator.

### D10. Bot-attested email linking (decision requested by the coordinator after the merge)

**Context.** Upstream (`db/user-store.ts`) treats Slack and Linear as `EMAIL_ATTESTING_PROVIDERS`:
an email the bot reports is written with `email_verified = 1`, links a new bot identity to any
existing user with that email (step 3), re-links an existing identity to the email's owner (step
2c), and so inherits that user's roles. The fork previously refused display email as identity proof,
and its bootstrap roles (`PLATFORM_ADMIN_USERS` by email) require `email_verified = 1`. Combining
the two means a bot-reported email can mint platform admin: whoever can make the slack-bot or
linear-bot Worker report `alice@corp.example` for their actor (a compromised bot Worker, a Slack
workspace admin editing a profile, a second Slack workspace the app is installed in) becomes Alice.

**Decision: restrict, do not keep or revert.**

1. Bot-reported emails are **never mailbox proof**: `EMAIL_ATTESTING_PROVIDERS` is removed;
   `email_verified = 1` is minted only by the sign-in claim after a completed OAuth proof (the
   fork's stated rule). Bot emails are kept on `user_identities.provider_email` and may backfill a
   NULL `users.email` with `email_verified = 0`.
2. Email-based linking from bot providers happens **only inside an operator domain allowlist**
   (`IDENTITY_LINK_EMAIL_DOMAINS`, Terraform `identity_link_email_domains`, default empty = never
   link) **and only to a user whose email is already verified**. With the corporate domain
   configured, upstream's experience is intact: a Slack user links to their GitHub-signed-in account
   and inherits its roles. Unconfigured, bot actors are standalone users with whatever the workspace
   default grants.
3. Every link is an audit event (`auth.identity_linked_by_email`). Why not keep: the escalation path
   above is real and silent. Why not revert: upstream's healing of identity splits (step 2c) is
   valuable, and the Slack-first-then-web flow still heals because the OAuth sign-in proves the
   email and the next bot action re-links to the proven owner.

### D9. Explicitly deferred (v1 cuts)

Rollback/restore deployments and the R2 bundle store; preview stage UI; data exports + backups
bucket; external (Hyperdrive) services and the Terraform secrets they carry; dated per-repo policy
exceptions; `rollout: observe`; `required` stance; per-session policy pins; CI credential for the
Action (and any commit-status mirror); Access-fronted preview proxy; name release/rename; app
launcher visibility; post-attach probe and `security_hold`; drift/integrity scheduled check of the
apps account (reported-only listing; a broker `data.list`/`apps.list` op); automatic quarantine of
unowned `app-*` resources; version-range policy; CDN/vendored detection; `.svelte` script extraction
in the checker; pnpm/yarn lockfile package parsing; deletion of `platform-roles.ts` and
`catalog.write`; an admin UI for external services; secret rotation reminders; data size quotas;
field-level encryption for `restricted`; R2 bucket lock; D1 read replication (created disabled).

---

## 3. Open risks (ordered)

1. **Access precedence for public self-hosted apps** (exact hostname over `*.<domain>`) is
   documented for private destinations; the public case is confirmed only by the live smoke. If it
   fails, the fallback is wildcard-only Access (shared AUD) with the guard's host pin as the per-app
   boundary.
2. **D1 `/query` atomicity** (R1): see D5; recovery path exists regardless.
3. **`cloudflare_account_token` under provider `>=5.16,<5.20`**: fallback is a pasted
   `apps_broker_api_token` variable.
4. **`approved_components` rebuild** over live consumer rows: the 0031 recipe plus an integration
   test over seeded consumers; `PRAGMA defer_foreign_keys` must survive the migration splitter.
5. **Narrowing `assertHarnessGovernance`** for Claude: verify in a unit test that Claude's PR path
   actually reaches `PushOperation` in the merged tree before removing the refusal.
6. **Workers created via the Workers API with the subdomain disabled stay disabled** across versions
   and deployments (smoke; the broker also reads the setting back after every publish and deletes
   the script if it is on).
7. **Custom-domain certificate issuance time** for second-level hostnames; the tool says "may take a
   minute" and the deploy response carries `url` either way.
8. **sig1 body cap vs bundle size**: the 16 MiB cap is a product constraint (source maps and media
   must be trimmed); the tool's `bundle_too_large` guidance says so.
9. **Nudge false positives**: a user who explicitly asked for npm in a new project gets one nudge
   whose wording defers to that request; the agent should not flip. Watch in dogfooding.
10. **Existing bot-minted verifications** (D10): rows already carrying `email_verified = 1` from
    Slack/Linear attestation before U12 lands keep it; U12's PR lists them for the operator. Better
    Auth's implicit-linking gate at first web sign-in may now create a split user for a Slack-first
    actor until their next bot action re-links; acceptable, and only when the allowlist is set.
