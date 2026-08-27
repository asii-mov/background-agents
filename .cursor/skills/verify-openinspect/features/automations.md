# Automations

## Browser-covered

- Open Automations through the sidebar.
- See a seeded automation.
- Trigger it manually and see the completed recent-execution indicator.

Run:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "automations.trigger"
```

## Backend-only

- Create and edit forms.
- Template selection.
- Automation detail and full invocation history.
- List search, pagination, pause, resume, and delete.
- Scheduling, event delivery, and fan-out orchestration.

## Uncovered

No browser test launches a sandbox. See `docs/REPO_MAP.md` for lower-level coverage.
