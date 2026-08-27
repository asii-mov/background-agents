# Analytics

## Browser-covered

- Open Analytics through the sidebar.
- Render session, repository, user, cost, and pull-request outcomes.
- Change from the 30-day view to the 7-day view and observe refetches.

Run:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "analytics.dashboard"
```

## Boundary

The browser uses deterministic metrics. Query correctness, aggregation windows, and pull-request
cohort semantics remain lower-level control-plane claims. Their proofs are in `docs/REPO_MAP.md`.
