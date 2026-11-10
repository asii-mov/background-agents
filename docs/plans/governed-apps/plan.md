# Implementation plan (units for Opus subagents)

Target tree: `/home/asiimov/Projects/secure-generation/open-inspect-upstream-sync` at commit
`fb066612` (branch `codex/upstream-sync-2026-10-05`; parents 76912270 and e364a7ee; verified: TS
typecheck, unit, integration, pytest, lint all green). Latest migration is
`0103_fork_catalog_editor.sql`; new migrations start at 0104 (there is an unrelated gap 0077–0086).
Read `architecture.md` and `sketch/README.md` first. Candidate sketches referenced below live under
`../stack`, `../deploy`, `../data` (same scratchpad).

Conventions for every unit:

- Toolchain: `/usr/lib/node_modules/npm` is incomplete. Use the corepack npm 10.9.2 shim the merge
  agent set up: `export PATH=<scratchpad>/bin:$PATH NPM_CONFIG_UPDATE_NOTIFIER=false UV_NO_CONFIG=1`
  (then plain `npm` works). The whole-tree check is `sh <scratchpad>/verify-all.sh <worktree>`
  (rerunnable; logs under `<scratchpad>/logs/final/`). Every unit's final verification is
  `verify-all.sh` green plus the unit's own targeted commands. `<scratchpad>` =
  `${SCRATCH:-/tmp/oi-scratch}`.
- Node is 22 locally; the repo wants 24. Do not "fix" engine warnings; CI runs 24.
- Python: always `UV_NO_CONFIG=1`; run with
  `uv run --frozen --extra dev pytest tests/ -q -p no:cacheprovider`.
- Web tests: `npm test -w @open-inspect/web -- --maxWorkers=4`.
- Build shared first whenever shared types change: `npm run build -w @open-inspect/shared`.
- Unit test commands: `npm test -w @open-inspect/<pkg>`; integration:
  `npm run test:integration -w @open-inspect/control-plane`; lint: `npm run lint:fix`; types:
  `npm run typecheck`; repo map: `npm run repo-map:check`; Python lint: ruff check + format --check.
- `docs/FORK_DIFFERENCES.md` is tracked in the sync tree. U7, U11 and U12 each add their rows to its
  "Controls added by this fork", "User-visible behavior changes" and "New storage and services"
  sections (U7: apps + broker + Terraform; U11: stack policy; U12: identity linking). Edit only your
  own rows; they are disjoint bullets.
- Each unit owns the files listed and no others. "Touches" lists shared files a unit may edit only
  in the named region. Where two units need one file, the earlier unit lands the stub and the later
  fills it.
- Durations: ms in TS (`_MS`), seconds in Python (`_seconds`); each default defined once.
- Migrations: 0104 (stack policy), 0105 (apps), 0106 (app data). Confirm with
  `ls terraform/d1/migrations | tail -1` before writing; renumber if the merge added one.
- Commit per unit, conventional commits. No push, no deploy, no data deletion.

Sequencing: riskiest unknown first (U1 live smoke + fake), scaffold first (U0 contracts). Parallel
tracks after U0: stack (U2→U3→U4a/U4b→U11), apps (U1→U6→U7; U5), data (U8), tool (U9), web (U10).

```
U0 ──┬── U1 ── U6 ── U7
     ├── U2 ── U3 ── U10a
     │    └── U4a   U4b ── U11
     ├── U5 (after U2 for helpers.ts) ── U8 ── U10b
     ├── U9
     └── U12 (identity linking; independent of the feature tracks)
```

---

## U0. Shared contracts and route scaffold (scaffold; everything types against this)

**Goal.** Land every shared type, permission, protocol and generated contract, plus empty route
modules registered once, so later units never touch `routes/catalog.ts`, `routes/shared.ts`,
`types.ts` or `rbac.ts` again.

**Owns.**

- `packages/shared/src/types/stack-policy.ts` (new; from
  `../stack/candidate-1/sketch/shared-stack-policy.ts` section B plus
  `sketch/shared/src/types/stack-policy.delta.ts`), `types/stack-policy.test.ts`
- `packages/shared/src/types/approved-components.ts` (extend per candidate 1 section A +
  `data_store` kind), its test
- `packages/shared/src/apps.ts` (new; `sketch/shared/src/apps.ts`), test
- `packages/shared/src/app-broker.ts` (new; `sketch/shared/src/app-broker.ts`; absorbs
  `../data/fable/sketch/shared/src/app-broker-data.ts` minus export ops and hyperdrive), test
- `packages/shared/src/types/app-data.ts` (new; from
  `../data/fable/sketch/shared/src/types/app-data.ts` with deltas in `sketch/README.md`), test
- `packages/shared/src/rbac.ts` (six permissions, scoped pair, member set), `rbac.test.ts`
- `packages/shared/src/service-auth.ts` (`SERVICE_NAMES += "control-plane"`)
- `packages/shared/package.json` scripts `generate:stack-contract`, `generate:app-deploy-contract`,
  `generate:app-data-contract` (pattern: `generate:memory-contract`)
- Generated: `packages/sandbox-runtime/src/sandbox_runtime/stack_policy_contract.json`,
  `.../app_deploy_contract.json`, `.../conformance/app_data_contract.json`,
  `.../tools/_app-deploy-contract.js`
- `packages/control-plane/src/types.ts` (EnvConfig: `APP_BROKER_URL`, `APPS_DOMAIN`,
  `SERVICE_AUTH_SECRET_APP_BROKER`, `APP_BROKER_ACCESS_CLIENT_ID`,
  `APP_BROKER_ACCESS_CLIENT_SECRET`, `APP_DATA_JURISDICTION`, `SANDBOX_TUNNELS_POLICY`,
  `IDENTITY_LINK_EMAIL_DOMAINS`)
- `packages/control-plane/src/routes/shared.ts` (AUDITED += `governance.manage`, `apps.manage.own`,
  `apps.manage.any`; `RouteAuthorizationRequirement` +=
  `{ kind: "app"; operation: "manage"; appParam: string }`)
- `packages/control-plane/src/routing/app-admission.ts` (new: `AppOwnerLookup` interface,
  `resolveAppRequirement` with injected lookup; default lookup throws `not configured`)
- `packages/control-plane/src/routes/stack-policy.ts`, `routes/apps.ts`, `routes/app-data.ts` (new,
  empty `Hono` exports), `routes/catalog.ts` (register the three)

**Migrations.** None.

**Acceptance tests.**

- shared: stance/kind validation table (preferred/denied need category + ≥1 signal; `data_store`
  needs a `manifest` signal and no version; a categorised library needs no exact version;
  uncategorised approved library still does); signal grammar (npm `@scope/*` ok, pypi wildcard
  rejected; file glob rejects `[ / **`; `manifest` value ∈ `d1|kv|r2`); `stackSignalKey` stable;
  `DERIVED_FILE_RULES` exported in the contract; golden cases exported; contract files current
  (staleness test fails when stale).
- shared: `parseAppName` corpus (pattern, length 40, reserved incl. `deployer`/`dispatcher`, `xn--`,
  `ab--cd`, uppercase rejected not repaired); `APP_DEPLOY_REASON_GUIDANCE` and status maps
  exhaustive (`satisfies`); broker schemas round-trip; `brokerDeployRequestSchema` rejects a binding
  named like a platform var.
- shared: manifest schema (reserved prefixes, platform names, `data ∩ secrets = ∅`, denied secret
  names, limits, `external` rejected with the v1 message); `SecretText` serializes as `[redacted]`.
- rbac: member has `apps.read/deploy/manage.own`, lacks `governance.*` and `apps.manage.any`; viewer
  has none of the six; administrator has all; `SCOPED_PERMISSION_PAIRS["apps.manage"]` resolves.
- control-plane: `routes/catalog.ts` registers the three empty routers (route-contracts test
  passes); typecheck green.

**Verify.**
`npm run build -w @open-inspect/shared && npm test -w @open-inspect/shared && npm run typecheck && npm test -w @open-inspect/control-plane`

---

## U1. Fake Cloudflare + live smoke (riskiest unknowns)

**Goal.** Pin every Cloudflare assumption in one in-memory fake with an ingress-invariant checker,
and one opt-in live script that checks the same assumptions against a real test account.

**Owns.**

- `packages/app-broker/` package scaffold: `package.json` (name `@open-inspect/app-broker`; deps
  hono, zod, jose; esbuild build to `dist/index.js`, `dist/guard.mjs`, `dist/dispatcher.js`),
  `tsconfig.json`, `vitest.config.ts`, `README.md`
- `packages/app-broker/test/fake-cloudflare.ts` (from
  `../deploy/candidate-1/sketch/control-plane/test/fake-cloudflare.ts`, extended with D1/KV/R2
  endpoints: database create/list/get/query/bookmark/restore/delete, KV namespaces, R2 buckets +
  lifecycle; `d1.query` executes against an in-memory SQLite-like statement log with per-request
  rollback on failure)
- `packages/app-broker/scripts/live-smoke.ts` (opt-in `APP_BROKER_LIVE_SMOKE=1`; needs a dedicated
  test account token; asserts: exact Access app beats wildcard and issues its own AUD; per-app token
  refused at a sibling hostname; Worker created with subdomain disabled stays disabled after
  versions/deployments; SHA-256 asset hashes accepted; custom-domain cert issuance time recorded; D1
  `/query` with a failing second statement leaves the first unapplied; takedown stops resolution)
- Root `package.json` workspaces entry; `tsconfig` references; eslint config entry for the new
  package

**Migrations.** None. **Deps.** U0 (types only; the fake can start before U0 lands).

**Acceptance tests.** The fake's self-tests: invariant checker records a violation when a domain PUT
happens without a per-app Access app, when the floor is missing, when a workers backend script has
`subdomain.enabled`, when `CF_ACCESS_AUD` ≠ the app's AUD; injected failures (`status`, `null`,
`applyThenFail`, `times`) behave; `onStep` hooks run;
`newWorkerSubdomainDefault = { enabled: true }` is honoured (the fake never assumes the safe
default); D1 fake rolls back a failing multi-statement body.

**Verify.** `npm test -w @open-inspect/app-broker`; live:
`APP_BROKER_LIVE_SMOKE=1 npm run smoke -w @open-inspect/app-broker` (operator-run; results recorded
in the PR).

---

## U2. Migration 0104 + catalogue store + pure compile + inventory store

**Goal.** The schema and the two pure functions everything else consumes: `compileStackPolicy` (rows
→ `CompiledStackPolicy`) and `renderStackInstructions`, plus read-time matching and inventory.

**Owns.**

- `terraform/d1/migrations/0104_stack_policy.sql` (from
  `../stack/candidate-1/sketch/0104_stack_policy.sql` with
  `sketch/terraform/d1/migrations/0104_stack_policy.delta.sql`: `data_store` kind, `manifest` signal
  kind, `app-data-store` category + D1/KV/R2 rows, `web-frontend` enforcement `block`, full
  component INSERTs)
- `packages/control-plane/src/stack-policy/compile.ts` (+ `compile.test.ts`; from candidate 1
  `control-plane.ts` top section; add `dataStorePolicyFromRules`, derived-fact skipping, data
  instructions hook via an injected `renderDataInstructions`)
- `packages/control-plane/src/db/approved-components.ts` (categories CRUD, signals, one-preferred,
  `demoteCurrentPreferred`, git-owned guard, `compileForSession`, `resolveForApp`
  (DataPolicyLookup), narrowed `recordConsumption`, merged `listConsumers`)
- `packages/control-plane/src/db/stack-inventory.ts` (new: `recordObservation`, `listRepositories`,
  `getRepository`, `rollup`, `listDetectedConsumers`, `prune`)
- `packages/control-plane/src/db/governance-scope.ts` (new; scope resolution shared with
  `SecurityPipelineStore.getForSession`; refactor that store to call it)
- `packages/control-plane/test/integration/stack-policy.test.ts` (new)
- Touches `packages/control-plane/test/integration/helpers.ts`: add the new tables to the cleanup
  helper.

**Migrations.** 0104. **Deps.** U0.

**Acceptance tests.**

- unit `stackRuleVerdict` full table (disabled, development, uncategorised, deprecated allowed, each
  stance); `compileStackPolicy`: null with zero categories; empty rules when nothing applies; scope
  parity with pipelines; `blocking` only for `forbid` in `block` categories; digest/text stable
  under reordering; budget trims guidance never rule lines; **seed golden test** renders the exact
  expected block (Workers note on Bun, "existing repository keeps its choice", "never ask a
  non-technical user to choose", data section listing D1 preferred / KV, R2 allowed); `matchFact`
  precedence (exact beats glob, smallest key among globs, `requirements*.txt` matches
  `requirements-dev.txt`, `bun.lock` ≠ `bun.lockb`, derived facts never match);
  `dataStorePolicyFromRules` yields `{ d1: preferred, kv: allowed, r2: allowed }` from the seed.
- integration: 0104 over seeded consumer rows keeps every consumer id; existing components become
  `allowed` with null category; the seed categories, components and signals are present and compile;
  CHECKs/partial index reject denied-without-category, deprecated preferred, a second approved
  enabled preferred (a disabled draft preferred is accepted); `demoteCurrentPreferred` swaps
  atomically; a signal owned by A cannot be added to B (400 names A); deleting a referenced category
  → 409; git rows → 409 on PUT/DELETE; `recordObservation` idempotent, newer observation replaces,
  non-member repo → 403, nested owner round-trips; a signal added after observation reclassifies
  stored facts; status derivation (bun.lock alone standard; + package-lock.json mixed; yarn.lock
  alone nonstandard; react violating; `requirements.txt` beside `uv.lock` is standard not mixed);
  rollup counts; adopting a component with signals → 409.

**Verify.**
`npm test -w @open-inspect/control-plane -- stack-policy && npm run test:integration -w @open-inspect/control-plane -- stack-policy`

---

## U3. Governance routes, permissions tightening, Git catalogue extension

**Goal.** Members can no longer read governance; admins get categories, preview, inventory, export;
Git can own categories and components.

**Owns.**

- `packages/control-plane/src/routes/approved-components.ts` (GET → `governance.read`; writes →
  `governance.manage`, drop `requiredPermission: "catalog.write"`; category routes; consumers merge)
- `routes/security-pipelines.ts`, `routes/repository-risk.ts`, `routes/governance-catalog.ts` (same
  gate change)
- `routes/stack-policy.ts` (fill: `GET /stack-policy/preview?repo=&environmentId=`,
  `GET /stack-policy/export?repo=`, `GET /stack-inventory`, `GET /stack-inventory/rollup`,
  `GET /stack-inventory/repositories/:owner/:name` with `repositoryParams()`,
  `POST /sessions/:id/stack-observations` sandbox route → 204)
- `packages/control-plane/src/governance/catalog-schema.ts`, `reconciler.ts`, `catalog-store.ts`
  (optional `categories` + `components` keys reusing the API schema; applied in the same batch as
  skills and MCP; absent keys leave app rows untouched; both present → Git owns, app rows disabled;
  invalid → last good kept), their tests
- `packages/control-plane/test/integration/governance-routes.test.ts` (new)

**Migrations.** None. **Deps.** U2.

**Acceptance tests.** Route policy matrix: member → 403 on every governance GET and POST; catalogue
editor role → 200 on reads and writes; administrator → 200; sandbox token → 204 on observations for
a member repo, 403 for a non-member repo, 401 for another session's token. Preview returns
byte-identical text to what `compileForSession` renders. Export returns the compiled JSON with
digest. Catalogue: a `catalog.yaml` with categories+components applies and app rows are disabled; a
missing key leaves rows untouched; an unknown category or duplicate signal rejects the whole
catalogue and keeps last good. `route-contracts.test.ts` passes.

**Verify.**
`npm test -w @open-inspect/control-plane -- routes && npm run test:integration -w @open-inspect/control-plane -- governance`

---

## U4a. Control-plane launch threading: `SessionGovernance`

**Goal.** Replace the hand-threaded `securityPipelines` field with one `SessionGovernance` value
that also carries the compiled stack policy, wire the lookup, narrow the Claude assertion, add the
tunnels policy switch.

**Owns.**

- `packages/control-plane/src/sandbox/lifecycle/launch-context.ts` (`loadGovernance`, fail-closed
  lookup, narrowed `assertHarnessGovernance`), `lifecycle/manager.ts`, `sandbox/provider.ts`,
  `sandbox/client.ts`, `sandbox/providers/*` (pass `governance`), `sandbox/sandbox-env.ts`
  (`buildSessionConfig` spreads `security_pipelines` unchanged + new `stack_policy`),
  `sandbox/governance.ts` (new: `SessionGovernance`, `StackPolicyLookup`;
  `sketch/control-plane/src/sandbox/governance.ts`)
- `packages/control-plane/src/session/components.ts` (wire `ApprovedComponentStore` as the lookup;
  register inventory `prune` on the existing abandoned-draft cron slot in `scheduled-jobs.ts`)
- `packages/control-plane/src/sandbox/settings.ts` (`SANDBOX_TUNNELS_POLICY=disabled` rejects
  `tunnelPorts` with a message naming `deploy-app`)
- Tests beside each file.

**Migrations.** None. **Deps.** U0, U2.

**Acceptance tests.** `stack_policy` appears in `SESSION_CONFIG` only when compiled; a lookup
failure throws (session does not start); Claude + stack policy without pipelines launches; Claude +
command pipelines launches (assertion narrowed) and a test proves Claude's `POST /pr` path
constructs `PushOperation` with the runner; MCP artefact refusal unchanged; every provider receives
the same `governance` object (provider contract test); `tunnelPorts` accepted under `public`,
rejected under `disabled` with the deploy-app message; scheduled-jobs ↔ Terraform cron test still
green.

**Verify.** `npm test -w @open-inspect/control-plane -- sandbox`

---

## U4b. Sandbox runtime: facts, policy, stage, delivery, observations

**Goal.** Deterministic enforcement after each turn and before push; always-on operator block in
both harnesses; baseline and push observations.

**Owns.**

- `packages/sandbox-runtime/src/sandbox_runtime/stack_facts.py` (new; candidate 1 + `derived`
  tagging + `manifest` facts from `openinspect.app.json`), `stack_policy.py` (new; candidate 1 +
  severity `deviation` with the new-project condition and per-session dedupe; see
  `sketch/sandbox-runtime/stack_policy.delta.py`), `platform_context.py` (new),
  `security_pipeline.py` (`CheckResult` protocol, `CheckTarget`, `has_checks`, hosts the stage),
  `push_operation.py`, `bridge.py` (loop uses `has_checks`; stack-only passes and preference
  findings emit no events; one advisory round; baseline report after git sync; push report after
  success), `supervisor.py` (`policy` phase before `skills`/`memory`), `opencode_server.py`
  (`instructions` = policy then memory), `harness/__init__.py` (`claude_system_prompt_append`),
  `tools/approved-components.js` (show stance and category; adopt explains detection),
  `boot_events.py` + shared `types/sandbox-events.ts` phase enum if a closed list exists
- `packages/sandbox-runtime/tests/test_stack_facts.py`, `test_stack_policy.py`,
  `test_platform_context.py`, and extensions to the existing bridge/push tests

**Migrations.** None. **Deps.** U0 (contract JSON).

**Acceptance tests.** Registry equals the contract; golden cases pass (normalisation, globs,
exclusions, derived rules); npm/pypi parsing per candidate 1's list; `WorktreeSource` sees a
force-added ignored file, `CommitSource` reads the commit; `hits` precedence; evaluate table: React
introduced in `block` → violation, in `advise` → advisory, at baseline → legacy, in a new manifest
path beside legacy → violation; new `package-lock.json` in a directory with no manifest at baseline
→ `deviation` (one nudge, no error, no repeat next turn); same file in a directory that had a
manifest → `alternative` (silent); `bun.lock`/`uv.lock` → `standard`; `requirements.txt` beside
`uv.lock` → derived, no finding; incomplete scan blocks only if a blocking rule applies; runner:
stack-only policy runs with `has_checks`; remediation prompt names path, replacement and guidance
within bound; push: uncommitted React only → push proceeds; committed React in a `block` category →
rejected before `git push`; successful push reports facts and a reporting failure does not fail the
push; bridge: violation → remediation → turn errors after attempts; passes and nudges emit no
events; baseline reported once per `(repo, base_sha)`; delivery: OpenCode `instructions` lists
policy before memory; Claude append orders policy, guidance, memory; no policy → nothing written and
a stale file is removed on restore.

**Verify.**
`cd packages/sandbox-runtime && uv run --frozen --extra dev pytest tests -q && uv run ruff check && uv run ruff format --check`

---

## U5. Migration 0105 + control-plane `apps/` module + routes

**Goal.** Ownership, inventory, deploy orchestration and takedown in the control plane against the
`AppHost` port, with a fake host; no Cloudflare knowledge here.

**Owns.**

- `terraform/d1/migrations/0105_apps.sql` (`sketch/terraform/d1/migrations/0105_apps.sql`)
- `packages/control-plane/src/apps/config.ts` (parse `APP_BROKER_URL`, `APPS_DOMAIN`, credentials →
  `AppsAvailability`; `appHostname`, `appUrl`), `apps/bundle.ts` (multipart → `AppBundle` + optional
  `AppDataManifest` + `MigrationFile[]`; 16 MiB; from candidate 1 plus `app`/`m*` parts),
  `apps/store.ts` (`AppStore`: claim-first, commitLive, recordFailure, markTakenDown/markSwept,
  releaseHold, list, deployments ledger), `apps/host.ts` (`AppHost` + `DataHost` ports,
  `AppHostError`; `sketch/control-plane/src/apps/host.ts`), `apps/broker-client.ts` (sig1 + Access
  service token client implementing both ports; `fetch` injectable), `apps/deploy.ts` (`deployApp`,
  `takeDownApp`, `releaseHold`, `listApps`; the `appData` seam is an injected interface so U8 plugs
  in later), `apps/index.ts`, `apps/fake-app-host.test-support.ts`, tests
- `packages/control-plane/src/routes/apps.ts` (fill: `POST /sessions/:id/apps` sandbox; `GET /apps`
  `apps.read`; `GET /apps/:name` `apps.read`; `POST /apps/:name/takedown`
  `{ kind: "app", operation: "manage" }`; `POST /apps/:name/release-hold` `apps.manage.any` for
  admin holds, `app manage` for owner holds)
- `packages/control-plane/src/routing/route-admission.ts` (resolve the `app` requirement using
  `AppStore` via the lookup from U0's `app-admission.ts`), `http/create-request-context.ts` (inject
  the lookup)
- `packages/control-plane/test/integration/apps.test.ts`
- eslint `no-restricted-imports`: `apps/*` only via `apps/index` (except `app-data/`, tests)
- Touches `test/integration/helpers.ts`: add `apps`, `app_deployments`.

**Migrations.** 0105. **Deps.** U0; U2 for `helpers.ts` ordering.

**Acceptance tests (fake host).** Config: absent → `not_configured`; each missing field reported.
Bundle: traversal corpus, duplicates, reserved asset paths, limits (declared length over cap
rejected before buffering), `notFoundHandling` derivation, static-only vs worker, `app` part parsed
with the shared schema, migration parts named per `MIGRATION_FILE_PATTERN`, sha256 computed
server-side. Deploy: first deploy + redeploy (`deployCount` 2, one ledger row per deploy, one
`live`); another owner's name → `name_taken` with zero host calls; teammate redeploy allowed;
concurrent `claim` → exactly one owner; viewer session owner → `permission_denied`; no `userId` →
`permission_denied`; host `access_guard_failed` → row `failed`, no commit; host transient →
`hosting_unavailable` and a retry converges; `backend` mismatch → `hosting_backend_changed`;
takedown race (`onStep`) → not live, `app_taken_down`; admin takedown blocks redeploy until
`release-hold`; owner takedown then redeploy → live; partial sweep → `cleanupComplete: false`,
re-run completes. Routes: sandbox token for another session → 401; user token on the sandbox route →
401/403; hosting unset → 503 `feature_unavailable`; scope matrix for takedown (any, own-owner,
own-teammate, own-other → 403). Integration: 0105 applies; CHECKs reject illegal states; partial
unique one-live-deployment index holds.

**Verify.**
`npm test -w @open-inspect/control-plane -- apps && npm run test:integration -w @open-inspect/control-plane -- apps`

---

## U6. `packages/app-broker`: the only Cloudflare client

**Goal.** A Hono Worker that holds the apps token and implements `/deploy`, `/takedown`, `/data`,
`/health` with the publish-order invariant, both hosting backends, the guard, and the dispatcher.

**Owns.** `packages/app-broker/src/index.ts` (routes, sig1 verify with
`ServiceName "control-plane"`, body cap), `src/env.ts`, `src/cloudflare-api.ts` (from candidate 1
`cloudflare-api.ts`), `src/edge.ts` (candidate 1; `AccessGrant`), `src/backends.ts` (candidate 1;
`HostingBackend` workers + dispatch-namespace; bindings from the request:
`d1|kv_namespace|r2_bucket|secret_text` + platform vars), `src/publish.ts` (order: assertFloor →
ensureAccess → put → attach → verify; `sketch/app-broker/src/publish.ts`), `src/takedown.ts`,
`src/data.ts` (from `../data/fable/sketch/app-broker/src/data.ts` minus export/hyperdrive),
`src/names.ts` (pattern, reserved, `app-` prefix assertions), `guard/guard.ts` +
`guard/access-jwt.ts` (jose; host pin; AUD verify; identity headers; `run_worker_first`),
`dispatcher/dispatcher.ts`, `build.mjs`, tests under `test/` (uses U1's fake).

**Migrations.** None. **Deps.** U0, U1.

**Acceptance tests.** Auth: unsigned → 401; wrong service → 401; replayed/expired → 401; body over
cap → 413. Names: reserved and invalid → 400; every path derives from the name (a request can never
name a script or hostname). Edge: ensureAccess creates then reuses; drift repaired; duplicates
reduced; attach refuses when the Access app vanished (no domain PUT); foreign hostname →
`hostname_conflict`; revoke never touches the floor. Backends (both kinds): uploads only requested
buckets; empty buckets uses the session JWT; bindings are exactly ASSETS + platform vars + requested
bindings; `main_module: guard.mjs`; `run_worker_first: true`. Workers backend: created with
subdomain disabled; existing enabled subdomain repaired; post-publish read-back enabled → script
deleted, `access_guard_failed`; validation codes → `script_rejected` with message passthrough.
Publish: failure-injection sweep over every step then retry → live, no duplicates, `fake.violations`
empty; `applyThenFail` on creates converges. Data ops: ensure adopts by name; prefix refusal on
request names and on resolved names (id of a non-`app-` database → `refused`); `d1.execute` relays
D1 errors as `sql_error`; `r2.purge` sets lifecycle then reports emptying/deleted; 429 honours
Retry-After; token never in logs. Guard (miniflare): rejects
missing/expired/wrong-aud/wrong-iss/`alg:none`/wrong Host; serves assets only after verification;
sets `x-openinspect-user-sub/email`, strips inbound copies and every `FORBIDDEN_IDENTITY_HEADERS`
entry; a user module that patches `crypto.subtle` cannot forge. Dispatcher: `scriptNameForHost`
equals the broker's `scriptName` over a table; two-label host → 404.

**Verify.** `npm test -w @open-inspect/app-broker && npm run build -w @open-inspect/app-broker`

---

## U7. Terraform: apps account, broker, Access, backend switch, control-plane wiring

**Goal.** Everything security decides lives in Terraform; the control plane learns only a URL and
two secrets.

**Owns.** `terraform/environments/production/apps-account.tf` (new; provider alias
`cloudflare.apps`; `sketch/terraform/environments/production/apps-account.tf`), `apps.tf` (new;
platform-side control plane bindings), `variables.tf` (apps vars), `locals.tf`, `checks.tf` (apps
domain not a suffix of the web domain), `versions.tf` (alias), `workers-control-plane.tf` (merge
bindings, `global_fetch_strictly_public` not needed),
`terraform/modules/cloudflare-worker/{variables,main}.tf` (`workers_dev_enabled`,
`dispatch_namespaces`, `provider` passthrough via `providers` map),
`terraform/tests/apps.tftest.hcl`, `docs/APPS.md` (new: apps account setup, zone choice, Enterprise
delegation alternative, device posture trade-off, token rotation, WfP switch, tunnels policy),
`.claude/skills/onboarding/SKILL.md` (apps section),
`terraform/environments/production/terraform.tfvars.example`.

**Migrations.** None. **Deps.** U6 (script paths), U0 (env names).

**Acceptance tests (plan-only `terraform test`).** `apps_enabled=false` plans nothing new and sets
no `APP_*` bindings. `workers`: floor `*.<domain>` with the visitor policy; broker Worker with
`workers_dev_enabled=false`, custom domain `deployer.<domain>`, exact Access app with the
service-token policy; account token resource with the listed permission groups (or the fallback
var); control plane gets `APP_BROKER_URL`, `APPS_DOMAIN`, `SERVICE_AUTH_SECRET_APP_BROKER`, Access
client id/secret, `APP_DATA_JURISDICTION`, `SANDBOX_TUNNELS_POLICY`. `dispatch-namespace`:
namespace + dispatcher with `workers_dev_enabled=false` and a `dispatch_namespace` binding; broker
binding `APPS_HOSTING_BACKEND`. Validation: enabled without domain/zone/include fails; web custom
domain under the apps domain fails.

**Verify.**
`cd terraform/environments/production && terraform init -backend=false && terraform validate && terraform test`

---

## U8. Migration 0106 + `app-data/` module + routes + conformance + dev tool

**Goal.** Hardened data by default: converge step, destructive-migration gate, secrets, restore,
retire/purge, ledger, inventory, checker.

**Owns.** `terraform/d1/migrations/0106_app_data.sql`
(`sketch/terraform/d1/migrations/0106_app_data.sql`),
`packages/control-plane/src/app-data/model.ts`, `service.ts` (from `../data/fable/sketch/...` minus
export methods and hyperdrive; `prepare` consumes `DataPolicyLookup` from U2 and `DataHost` from
U5), `src/db/app-data.ts`, `src/routes/app-data.ts` (fill: summary, operations, secrets set/delete,
approve, restore, classification, `GET /app-data/inventory` under `governance.read`),
`scheduled-jobs.ts` (purge sweep on the existing abandoned-draft cron slot), `apps/deploy.ts` wiring
of the `appData` seam (touch: the composition root only), `app-data/fake-data-host.test-support.ts`,
tests, `test/integration/app-data.test.ts`;
`packages/sandbox-runtime/src/sandbox_runtime/conformance/__init__.py`, `__main__.py` (locates and
execs Bun on the bundled script), `app-data.ts` (token-based rules, conservative), `app-dev.ts`
(derives `.openinspect/wrangler.generated.jsonc` + dev entry), `tests/test_conformance.py`;
`.openinspect/skills/internal-app-auth/SKILL.md` **not here** (U9). Touches
`test/integration/helpers.ts`: add the five tables.

**Migrations.** 0106. **Deps.** U0, U2, U5.

**Acceptance tests.** Pure: `evaluateDataPolicy` table (stance × kind × classification ×
jurisdiction); `classifyStatement` forms incl. quoting/comments; `planMigrations` (changed, missing,
out of order, re-evaluated blocked); `mintResourceName` (determinism, 63-byte cap with hash tail);
`renderDataInstructions` bounded and deterministic. Store (integration): partial unique indexes
under concurrent `insertProvisioning`; retire → reinstate round trip; CHECKs; secrets round-trip and
stage isolation; ledger keyset pagination. Service with fake host: prepare twice → identical
bindings, zero new operations; fault after every host call then re-run → converges; binding removed
→ retired, re-added within window → same provider ref; destructive blocked → approve (sha) → applied
with bookmark; edited blocked file → re-blocked; secret missing → blocked → set → ready; purge sweep
resumability (R2 emptying across runs); restricted restore requires `any`. Routes: owner (own) and
admin (any) matrix; member on another's app → 403; values never echoed; `no-store`. Conformance: one
fixture per rule pass/fail; no manifest → exit 0; output consumed by the remediation prompt; the
seeded pipeline row is returned by `SecurityPipelineStore.getForSession` for any repo.

**Verify.**
`npm test -w @open-inspect/control-plane -- app-data && npm run test:integration -w @open-inspect/control-plane -- app-data && cd packages/sandbox-runtime && uv run --frozen --extra dev pytest tests/test_conformance.py -q`

---

## U9. Sandbox `deploy-app` tool and the rewritten skill

**Goal.** One implementation for both harnesses; the agent never sees a credential.

**Owns.** `packages/sandbox-runtime/src/sandbox_runtime/app_deploy.py` (candidate 1 + `app`/`m*`
parts; `name` optional when `openinspect.app.json` present; `projectDir` arg), `tools/deploy-app.js`
(shim), `harness/claude_tools.py` (register `deploy-app`, conditional like Slack),
`tests/test_app_deploy.py`, `tests/deploy-app.test.mjs`;
`.openinspect/skills/internal-app-auth/SKILL.md` + `references/` (platform guard verifies; read
`x-openinspect-user-sub`; data via `openinspect.app.json`; never wrangler config; self-verification
moves to a reference for non-platform hosts).

**Migrations.** None. **Deps.** U0 (contract JSON).

**Acceptance tests.** `pack_bundle`: symlink escaping refused; dotfiles skipped except
`.well-known`; limits from the contract; parts in sorted order; manifest and migrations included
when present; a migration name not matching the pattern → agent-facing error. `deploy_app`: every
reason maps to its guidance (deploy + data block reasons), unknown reason falls back by status,
timeout envelope. Shim: forwards args, relays stdout, `bridge_error` on no output. Claude tool
registered only when enabled. Skill lints (`markdownlint` if present) and the catalogue
`required: true` entry still parses.

**Verify.**
`cd packages/sandbox-runtime && uv run --frozen --extra dev pytest tests/test_app_deploy.py -q && node --test tests/deploy-app.test.mjs`

---

## U10a. Web: governance visibility + stack policy UI

**Goal.** Members see no governance; admins get grades, signals, categories, preview and inventory.

**Owns.** `packages/web/src/components/settings/settings-registry.ts` (`appsec` →
`anyOf("governance.read")`), `approved-components-settings.tsx` (+test: category/stance/signal
editors, make-standard with demote, categories Advise/Block toggle, policy preview, adoption
matrix + rollup, data inventory tab), `appsec-governance-settings.tsx` (permission hook instead of
`usePlatformRole`), `mcp-servers-settings.tsx` (same hook swap), a `useHasPermission` hook if none
exists, BFF `app/api/component-categories/**`, `app/api/stack-policy/**`,
`app/api/stack-inventory/**`, `app/api/app-data/inventory`, `prompt-skill-autocomplete.tsx` +
`prompt-skill-suggestion-panel.tsx` + the session sidebar skill list (filter `required`),
`docs/REPO_MAP.md` regen, Playwright specs under `e2e/`.

**Deps.** U3 (APIs), U8 for the inventory proxy (can stub).

**Acceptance tests.** Registry hides `appsec` without `governance.read`; direct URL shows no data;
grade editor requires category + signals for preferred/denied; matrix renders all five statuses;
required skills absent from autocomplete and sidebar; E2E: admin flips `web-frontend` to block and
sees the preview change; member nav has no AppSec entry. `repo-map:check` passes.

**Verify.** `npm test -w @open-inspect/web && npm run repo-map:check`

## U10b. Web: Apps tab (own + admin) with data panel

**Owns.** `components/settings/apps-settings.tsx` (+test; list own/all; URL; status; takedown with
reason; release hold; Data panel: resources, classification badge (admin-editable), schema changes
with Approve, secrets names per stage set/replace/delete, restore-to-time with typed confirmation,
operations ledger), `settings-registry.ts` `apps` entry `anyOf("apps.read")` (coordinate: U10a lands
the registry file first; U10b adds one entry), BFF `app/api/apps/**`, Playwright,
`docs/REPO_MAP.md`.

**Deps.** U5, U8, U10a.

**Acceptance tests.** Member sees own apps and no takedown on others'; admin sees all, takes down,
releases hold; secrets never display values; approve sends sha; restore requires typing the binding
name; `repo-map:check` passes.

**Verify.** `npm test -w @open-inspect/web && npm run repo-map:check`

---

## U11. CI mirror: CLI, Action, docs

**Owns.** `packages/sandbox-runtime/src/sandbox_runtime/stack_policy_cli.py` (new;
`check --policy --base --head [--repo]`; exit 1 on blocking findings; JSON report),
`tests/test_stack_policy_cli.py`, `.github/actions/stack-policy-check/action.yml` (composite:
installs the package with uv, runs the CLI on `inputs.policy-file`), `docs/STACK_POLICY.md`
(authoring in Git and UI, grades, delta semantics, nudges, export + Action + required status check,
bypass caveats).

**Deps.** U4b, U3.

**Acceptance tests.** CLI on a fixture repo: introduced denied package → exit 1 and names the path;
legacy denied → exit 0; preference deviation → exit 0 with an advisory line; policy JSON from
`GET /stack-policy/export` fixture parses. Action YAML validates (`actionlint` if present).

**Verify.**
`cd packages/sandbox-runtime && uv run --frozen --extra dev pytest tests/test_stack_policy_cli.py -q`

---

## U12. Identity: restrict bot-attested email linking (security call left open by the merge)

**Goal.** Keep upstream's cross-provider linking for the corporate domain, but a Slack- or
Linear-reported email never counts as mailbox proof, never links outside an operator allowlist, and
never links to an unproven owner. See `architecture.md` D10.

**Owns.** `packages/control-plane/src/db/user-store.ts` (remove `EMAIL_ATTESTING_PROVIDERS`; bot
emails are stored as `provider_email` and backfilled to `users.email` only with
`email_verified = 0`; new `linkPolicy` input: `{ allowedEmailDomains: ReadonlySet<string> }`; step 3
and step 2c link only when the normalised email's domain is allowed AND the owner's
`email_verified = 1`; otherwise create/keep a standalone user), `db/user-store.test.ts`,
`routing/route-admission.ts` (build the link policy from `env.IDENTITY_LINK_EMAIL_DOMAINS`,
comma-separated, lowercase; emit audit event `auth.identity_linked_by_email` with provider, domain,
target user id, request id), `auth/user/sign-in-claim.ts` only if a test shows the OAuth claim path
relied on bot-minted verification (expected: no change),
`terraform/environments/production/variables.tf` + `workers-control-plane.tf`
(`identity_link_email_domains`, default `[]`, bound as `IDENTITY_LINK_EMAIL_DOMAINS`),
`docs/FORK_DIFFERENCES.md` (replace the "Slack and Linear first-contact actors follow upstream
enrollment" bullet), `docs/SECURE_GENERATION.md` (one paragraph). Touches `types.ts` only to add
`IDENTITY_LINK_EMAIL_DOMAINS?: string` (coordinate with U0, which owns the file: U0 adds the key).

**Migrations.** None (no schema change; existing `email_verified = 1` rows minted by bot attestation
before this change are left as-is and listed by a one-off read-only query in the PR description for
the operator to review).

**Deps.** U0 (env key).

**Acceptance tests.**

- Slack actor with `alice@corp.example`, allowlist `corp.example`, existing GitHub user with that
  email and `email_verified = 1` → identity linked to that user (role inheritance preserved); audit
  event emitted.
- Same, but the existing owner has `email_verified = 0` → no link; a standalone user is created with
  `email = NULL` and `provider_email` recorded on the identity.
- Same, allowlist empty (default) → no link, standalone user.
- Email domain not in the allowlist (`alice@contractor.example`) → no link.
- Slack-first user with no email: the bot now reports an allowed-domain email → `users.email`
  backfilled with `email_verified = 0` (never 1); a later GitHub OAuth sign-in proving that email
  mints verification through the existing sign-in claim path (test runs the claim store
  `verifyEmail` flow).
- Re-link (step 2c): an existing Slack identity whose user has no email, when another user owns the
  allowed-domain email **and is verified** → re-linked; when the owner is unverified → not
  re-linked.
- `PLATFORM_ADMIN_USERS` email bootstrap: a user whose only email evidence is bot attestation
  (`email_verified = 0`) gets no platform role (existing platform-roles test extended).
- Concurrency: the UNIQUE-retry path still converges under a concurrent `claimEmail`.
- Linear actor cases mirror the Slack ones (same code path).

**Verify.**
`npm test -w @open-inspect/control-plane -- user-store route-admission platform-roles && npm run test:integration -w @open-inspect/control-plane -- route-admission-matrix`

---

## Cut list (v1)

See `architecture.md` D9. In unit terms: no reconcile job/queue (U5), no R2 bundle store (U5), no
rollback routes (U5/U10b), no export/backups bucket (U8/U7), no Hyperdrive (U8/U7), no preview stage
UI (U8/U10b), no probe (U6), no per-session pins (U2), no `required` stance (U0), no CI credential
(U11), no preview proxy (U4a), no platform-roles deletion (U3; follow-up), no drift/integrity sweep
(U7 docs only).
