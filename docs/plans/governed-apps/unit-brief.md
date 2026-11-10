# Common brief for every implementation unit

Read first: poteto-mode SKILL.md at
/home/asiimov/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/skills/poteto-mode/SKILL.md and
the Claude Code adapter at
/home/asiimov/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/docs/harness/claude-code.md.

## User goal

An AI coding platform safer and friendlier than Claude Code. Nontechnical users ask for an internal
app; the agent builds it on the company's approved stack (graded policy: preferred / allowed /
denied; defaults prefer TypeScript, Bun, uv, Svelte; React/Next denied), enforced invisibly and with
adoption tracked. Apps deploy to `<app>.<apps domain>` behind Cloudflare Access in a dedicated apps
Cloudflare account, through a broker Worker that alone holds the apps token. Data services are
hardened by default. Developers and security own the controls; members never see governance UI.

## Design sources (the contract)

Scratchpad `S=${SCRATCH:-/tmp/oi-scratch}`.

- `$S/arena/final/architecture.md` (decisions D1-D10), `$S/arena/final/plan.md` (your unit's section
  is the spec, plus its "Conventions for every unit"), `$S/arena/final/sketch/` and its README.
- Candidate sketches it references live under `$S/arena/{stack,deploy,data}/`. Deviations from the
  sketch are signal: if the sketch is wrong, make the smallest correct change and report the
  deviation explicitly. Do not silently expand scope beyond your unit.

## Workspace rules

- Integration branch: `feat/governed-apps` (worktree
  /home/asiimov/Projects/secure-generation/open-inspect-governed-apps). Do NOT edit that worktree.
  Create your own:
  `git -C /home/asiimov/Projects/secure-generation/open-inspect-governed-apps worktree add -b unit/<ID> /home/asiimov/Projects/secure-generation/oi-unit-<ID> <BASE_SHA>`
  then `cd` there and install:
  `export PATH=$S/bin:$PATH NPM_CONFIG_UPDATE_NOTIFIER=false UV_NO_CONFIG=1; npm ci` (python
  packages use `uv run --frozen --extra dev ...`).
- Own only the files your unit lists. Never touch another unit's files.
- Whole-tree verification: `VERIFY_LOG_DIR=$S/logs/unit-<ID> sh $S/verify-all.sh <your worktree>`
  plus the unit's targeted commands. Integration tests:
  `npm run test:integration -w @open-inspect/control-plane` when your unit touches control-plane
  routes, D1 or migrations.
- Tests assert behaviour users of the code observe; no phase-narrating comments; comments only for a
  non-obvious why. Follow CLAUDE.md conventions (`_MS` / `_seconds`, one definition per default,
  named permissions not role comparisons, repo owners may contain `/`).
- Security: no secrets in code, tests or fixtures; placeholder data only; no PII in logs.
- Commit on your branch with conventional commits (subject < 72 chars), ending with: Co-Authored-By:
  Claude Opus 5.5 <noreply@anthropic.com> Claude-Session:
  https://claude.ai/code/session_018gVZjk5fqXoLN1rn486ZUZ No push, no deploy, no --no-verify, no
  force, no data deletion. Do not remove your worktree.

## Report (under 400 words)

Verdict VERIFIED / NOT VERIFIED / INCONCLUSIVE; branch and final commit SHA; files changed; each
acceptance test from the plan mapped to the test that proves it; exact commands run with pass/fail
counts; deviations from the sketch; anything a reviewer or a later unit must know.
