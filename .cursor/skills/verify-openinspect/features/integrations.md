# Integrations

## Browser-covered

- Open Settings through the sidebar.
- Select Integrations.
- Open Slack configuration.
- Load empty global and repository settings through the production response shapes.
- Confirm the default master switch, mentions policy, and repository-override state.

Run:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "integrations.open-slack"
```

## Backend-only

Slack writes and runtime notifications have lower-level tests but no Playwright test. GitHub,
Linear, code-server, VNC, and commit signing also lack Playwright tests. See `docs/REPO_MAP.md` for
owners and coverage.

The shared integration catalog exposes `sandbox`, but the detail-page registry has no Sandbox
component. `/settings/integrations/sandbox` currently renders an empty detail body and is marked
`uncovered`.
