# MCP Servers

MCP Settings list catalog entries. When Git governance is configured, Git owns metadata while
OpenInspect stores encrypted credentials outside the repository. New sessions receive only enabled,
approved entries matching repository and environment scope, pinned to exact revisions.

## Browser-covered

- Git governance source and ref, resolved-version row, and enabled state.
- Editor credential rotation for a Git-managed local server, with no metadata mutation.
- Member read-only row behavior.

## Backend-only

- Git-governed local npm MCP resolution, content-addressed artifact build, session pinning, digest
  validation, and executable rewrite.
- Remote HTTPS MCP configuration and header credentials. Remote MCPs are not built or installed.
- App-managed creation, editing, scoping, toggling, and deletion when Git governance is disabled.
- Git sync failure with last-good catalog retention.

## How to get to it (user POV)

Open **Settings** and select **MCP Servers**. When Git governance is configured, the page names the
governance repository and ref. Editors and admins can expand a row to rotate credentials. Members
can inspect the row but cannot expand editable controls.

## Driving it with Playwright

Run:

```bash
npm run test:e2e -w @open-inspect/web -- --grep "Git-governed MCP"
```

The editor test checks the Git source and ref, lifecycle, creator, resolved version, command, global
scope, enabled switch, and absence of the metadata edit form in the expanded row. It enters a fake
environment credential and asserts the credential PUT body with no metadata mutation. A member test
confirms the same catalog row cannot expose editable controls.

## Gotchas

The browser fixture does not build or install an MCP package. Pair this check with:

- `packages/control-plane/src/governance/npm-resolver.test.ts` for moving range to exact version,
  integrity, and executable selection.
- `packages/control-plane/src/governance/mcp-artifact-builder.test.ts` for HTTPS builder
  configuration and content-addressed request/storage behavior.
- `packages/control-plane/test/integration/git-governance-catalog.test.ts` for atomic activation,
  session revision pinning, credential preservation, retirement, and last-good retention.
- `packages/control-plane/src/routes/session-mcp-artifacts.test.ts` for session-pinned artifact
  access-route shape.
- `packages/sandbox-runtime/tests/test_mcp.py` for digest validation, materialization, and
  executable rewrite. Safe-extraction edge cases are not yet comprehensively regression-tested.
- `packages/control-plane/src/db/mcp-servers.test.ts` and
  `packages/control-plane/test/integration/mcp-servers.test.ts` for revisions and credentials.
- `packages/control-plane/src/router.policy.test.ts` and
  `packages/control-plane/src/db/platform-roles.test.ts` for route permission metadata and role
  authorization.

Governance repository reading follows the configured SCM provider. GitHub and GitLab implement the
needed repository reader; Bitbucket governance reading is not implemented. Manual local entries
default to development and cannot become approved without a Git-built artifact. Manual remote
entries may be approved only with HTTPS.

Use fake values in browser tests. Playwright attachments record request bodies.
