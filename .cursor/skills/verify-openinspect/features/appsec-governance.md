# AppSec governance

Editors and administrators use AppSec settings to manage verification pipelines, repository
criticality, approved components, and platform roles.

## Browser-covered

- Managed verification pipeline creation.
- Repository criticality assignment.
- Member and administrator control visibility.
- Platform role assignment by an administrator.

## Backend-only

- Pipeline editing, scoping, runtime resolution, remediation, and completion or push gates.
- Approved-component owner metadata, revision-aware consumer discovery, and agent adoption.
- Bootstrap role resolution from canonical IDs and verified provider identities.

Pipeline deletion and editor-specific browser visibility are `uncovered`.

## How to get to it (user POV)

Open **Settings** and select **AppSec**. Editors and administrators can write pipelines and
repository criticality. Only administrators see **Platform ownership**. Members can read the
catalogue but cannot change it.

## Driving it with Playwright

Run:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "administrator assign|AppSec catalogue writes"
```

The administrator test assigns Staff Engineer the editor role, creates `Corporate AppSec baseline`,
saves `acme/identity-service` as high criticality, and verifies each change in the UI. The member
test verifies that write controls and Platform ownership are absent.

## Gotchas

Browser visibility is not authorization. Pair role work with
`packages/control-plane/src/router.policy.test.ts` and
`packages/control-plane/src/db/platform-roles.test.ts`. Bootstrap role configuration can override a
lower stored role, so a UI assignment is not necessarily the effective role.

The browser test records the pipeline definition but does not execute it in a sandbox. Pair pipeline
work with `packages/control-plane/test/integration/security-pipelines.test.ts`,
`packages/control-plane/src/sandbox/lifecycle/manager.test.ts`, and
`packages/sandbox-runtime/tests/test_security_pipeline.py`. Run `test_bridge_sse.py` and
`test_push_operation.py` for bridge orchestration and push blocking.

The browser test saves repository criticality but does not prove PR draft enforcement. Run
`packages/control-plane/src/risk/change-risk.test.ts`,
`packages/control-plane/src/session/http/handlers/pull-request.handler.test.ts`, and
`packages/control-plane/src/session/pull-request-service.per-branch.test.ts`. The current PR route
is GitHub-only.

Approved-component `owner` is metadata, not owner-scoped authorization. Pair its UI with
`packages/control-plane/test/integration/approved-components.test.ts` and
`packages/sandbox-runtime/tests/test_approved_components_tool.py`.
