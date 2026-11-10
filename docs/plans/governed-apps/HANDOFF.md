# Governed apps: handoff

This branch turns Open-Inspect into a platform where security and engineering set central controls
that nontechnical users never see. Agents build internal apps on an approved stack, and the apps
deploy behind Cloudflare Access in a dedicated apps account.

## State at handoff

`feat/governed-apps` is built on the verified upstream sync `fb066612` (fork + upstream e364a7ee).
Units U0 to U12, the `[cleanup]` items, and a review-fix round are merged. Each unit was verified on
its own and again on the merged tree. The last full merged-tree run, before the review-fix round,
passed typecheck, control-plane unit 4879, control-plane integration, sandbox-runtime pytest 1666,
app-broker 148, web, Terraform tests, lint and repo map. The only failures were web timeouts
(`automation-form.test.tsx`) that also occur on pure upstream.

## Review-fix round

A review found nine issues. Each fix was verified on its own branch before merge
(`git log --oneline 541753cc..4b0679a5`):

- The stack-policy checker reads manifests under `build`, `dist`, and `.svelte-kit`.
- It reports git submodules, npm URL, git, and tarball specs, and pnpm `package.yaml` and
  `package.json5` as scan gaps. It parses Deno import maps.
- It reads `npm:` range and tag specs as the dependency key.
- The broker refuses signatures older than 30 seconds.
- Every `CREATE TRIGGER` migration needs approval on a non-empty production database.
- Bot-reported emails stay on `user_identities.provider_email` and never reach `users.email`.
- `GET /apps` hides session and repository linkage from viewers who cannot manage the app.

The residual limits are in `docs/STACK_POLICY.md`, `docs/SECURE_GENERATION.md`, and `docs/APPS.md`.
Run `harness/verify-all.sh` again before the PR, because no whole-tree run covers this round.

Nothing has been pushed to `main`, deployed, or applied to a Cloudflare account.

## Remaining work

1. Run `harness/verify-all.sh` on the current head.
2. Open the PR to `main` from `PR_DESCRIPTION.md`, with the bot-attestation SQL from U12
   (`bot-verified-users.sql`) in the description.

## Read first

- `architecture.md`: decisions D1 to D10 and why.
- `plan.md`: the units, file ownership, and the acceptance tests.
- `unit-brief.md`: the rules every unit followed.
- `followups.md`: open items, each tagged with its owner.
- `decisions.tsv`: the decision trail (`column -s$'\t' -t decisions.tsv`).
- `grounding.md`: the user's binding decisions.
- `sketch/`: the synthesized contracts.

Paths in these files that begin with `/home/asiimov/` or mention worktrees refer to the original
machine. In a cloud session, work in the repo checkout directly. Set `SCRATCH` to a temp dir for the
harness scripts.

## Harnesses

- `harness/verify-all.sh <repo>`: whole-tree verification, with logs under `$SCRATCH`.
- `harness/e2e-apps/run.mjs`: sandbox tool → control-plane route → broker → fake Cloudflare.
- `harness/e2e-data/run.mjs`: the same path for an app that declares D1 and a migration.
- `harness/e2e-launch/`: proves the launch policy text equals the admin preview, plus mutations.

Toolchain notes from the original machine: Node 24 is expected (CI uses it), Python runs with
`UV_NO_CONFIG=1`, and web tests run with `--maxWorkers=4`.

## Needs the operator

- Run the live smoke (`packages/app-broker`, `APP_BROKER_LIVE_SMOKE=1`) on a test Cloudflare account
  before enabling hosting. See `docs/APPS.md`.
- Make the stack-policy check an org-required workflow, and require CODEOWNERS review on `.github/`.
- On the free Workers plan, consider lowering `MAX_OBSERVED_FACTS`. Parsing a full observation
  measured 12 to 16 ms on local Node against a 10 ms limit.
