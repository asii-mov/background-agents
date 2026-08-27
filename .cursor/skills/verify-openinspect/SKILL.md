---
name: verify-openinspect
description:
  Drive the real OpenInspect Next.js UI with Playwright when reproducing, debugging, or proving core
  sessions, automations, analytics, integrations, Settings, Skills, MCP, AppSec, or sandbox
  behavior.
---

# Verify OpenInspect

Use this skill for user-visible OpenInspect work. Start with the generated
[repository map](../../../docs/REPO_MAP.md), then read the relevant file in
[the verification feature map](features/README.md).

## Locate

Find a route, owner, and exact proof before searching the tree:

```bash
npm run repo-map -- session
npm run repo-map -- "Slack settings"
npm run repo-map:check
```

The check fails when a mapped source path or exact Playwright title disappears, a user route or
Settings tab lacks a coverage status, or the generated map is stale.

## Launch

Run from the repository root:

```bash
npm run build -w @open-inspect/shared
npm run test:e2e -w @open-inspect/web
```

The Playwright config starts the verification gateway at `http://127.0.0.1:3301` and Next.js at
`http://127.0.0.1:3300`. Playwright runs one Chrome worker and stops both servers. Both URLs must be
loopback HTTP origins.

Choose different free loopback ports when needed:

```bash
OPENINSPECT_VERIFY_BASE_URL=http://127.0.0.1:3312 \
OPENINSPECT_VERIFY_GATEWAY_URL=http://127.0.0.1:3313 \
npm run test:e2e -w @open-inspect/web
```

Do not point this verifier at a deployed app or use a signed-in personal browser profile.

## Doctor

```bash
node -e "require.resolve('@playwright/test/package.json'); console.log('Playwright available')"
test -x /usr/bin/google-chrome && echo "Chrome available"
ss -ltnp '( sport = :3300 or sport = :3301 )'
```

During a run, these commands must succeed:

```bash
curl -fsS http://127.0.0.1:3300/settings >/dev/null
curl -fsS http://127.0.0.1:3301/health
```

## Drive

Run the exact mapped Playwright test:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "sessions.core-workflow"
npm run test:e2e -w @open-inspect/web -- --grep "automations.trigger"
npm run test:e2e -w @open-inspect/web -- --grep "analytics.dashboard"
npm run test:e2e -w @open-inspect/web -- --grep "integrations.open-slack"
npm run test:e2e -w @open-inspect/web -- --grep "settings.navigation"
```

Use roles, labels, placeholders, and headings. Do not call React setters or add an authentication
bypass. Add every new browser `/api/*` call to `packages/web/e2e/verification-api.ts`; unmatched
calls return 501 and fail the test.

The session test also exercises boundaries that browser interception cannot model: server-side
snapshot loading, the session WebSocket, and the terminal iframe. Those use the schema-validated
loopback gateway in `packages/web/e2e/verification-gateway.ts`.

Use MCP or CDP browser control in the current agent session for exploratory console, network,
accessibility, and layout debugging. Use this Playwright suite for repeatable acceptance evidence.

## Evidence

Evidence is retained under `.artifacts/verify-openinspect/`. Each mapped test attaches a screenshot
and its redacted browser API observations.

`browser-covered` proves the Next.js UI against deterministic loopback boundaries. It does not prove
the real control plane, Durable Objects, Modal, GitHub, npm registry, or a sandbox runtime. Run the
lower-level proofs in `docs/REPO_MAP.md` when a claim crosses those systems.

## Cleanup

Playwright stops the processes it starts. Evidence remains on disk. If an interrupted run leaves a
port open, inspect the PID with `ss` and `ps`, confirm it belongs to this checkout, and stop only
that PID. Never kill a process by name.
