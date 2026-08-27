# Git-backed Skills and MCP governance

Git can be the canonical desired-state source for the centrally approved Skills and MCP servers used
by Open-Inspect. The control plane remains the runtime catalogue: it reads Git with the deployment's
SCM credentials, validates the complete snapshot, resolves automatic package updates, and atomically
activates a last-good copy in D1. Agents never clone the governance repository.

```text
reviewed Git change
  -> immutable repository snapshot at one commit
  -> full schema, path, size, scope, and lifecycle validation
  -> resolve MCP package channel/range to exact version + integrity + tarball
  -> build and store the complete verified MCP dependency closure
  -> atomic last-good D1 activation through one reconciliation coordinator
  -> new session pins exact Skill and MCP revisions
```

If fetching, parsing, validation, package resolution, or persistence fails, the attempted commit is
recorded as failed and the prior active catalogue remains available.

## Repository layout

The default root is `.openinspect`:

```text
.openinspect/
  catalog.yaml
  skills/
    secure-authentication/
      SKILL.md
      references/example.md
      scripts/preflight.sh
  mcps/
    context/mcp.yaml
```

`catalog.yaml` references only files below this root:

```yaml
schemaVersion: 1
skills:
  - path: skills/secure-authentication
    required: true
    enabled: true
    executableFiles:
      - scripts/preflight.sh
    assignments:
      - type: global
      - type: repository
        repository:
          repoOwner: example
          repoName: payments-api
mcpServers:
  - path: mcps/context/mcp.yaml
```

When `assignments` is omitted, a Skill is global. Repository and environment assignments use the
same matching semantics as the application catalogue.

Each Skill is a normal `SKILL.md` plus optional UTF-8 supporting files:

```markdown
---
name: secure-authentication
description: Use the organization's approved authentication component.
license: Internal
metadata:
  owner: appsec
---

Follow the approved authentication workflow and component documentation.
```

Supporting files are non-executable unless their relative path is listed in `executableFiles`;
executable entries must be below `scripts/`.

## MCP automatic updates

A local MCP definition deliberately does not pin a package version:

```yaml
schemaVersion: 1
name: context
type: local
package: "@example/context-mcp"
args: ["--safe"]
updatePolicy:
  automatic: true
  channel: latest
  range: "^3"
repoScopes:
  - example/payments-api
```

The Git definition is update policy, not a pinned executable command. On every scheduled or manual
sync, the control plane queries the configured npm registry. It first considers the selected
distribution tag and, when that tag falls outside `range`, selects the highest matching published
version. It resolves the package's exact version, integrity, HTTPS tarball, and declared executable.
Packages with several executables must set `executable` explicitly.

The authenticated artifact builder installs the exact tarball with lifecycle scripts disabled,
checks the root version and integrity in the generated lockfile, and archives the complete
production dependency closure. The control plane stores that archive under its SHA-256 digest.
Sandboxes fetch only the artifact pinned to their session, verify the digest and manifest, extract
it safely, and launch the bundled executable directly. They do not run `npx` or contact the
registry.

New sessions pin the exact MCP catalogue revision and artifact they resolve. Restoring an existing
session keeps that exact version and artifact after the central policy resolves a newer package.
Credentials are read from the current encrypted catalogue row, so they can rotate without changing
the pinned executable revision.

Remote MCP definitions use an approved HTTPS endpoint and have no package update policy:

```yaml
schemaVersion: 1
name: internal-knowledge
type: remote
url: https://mcp.example.com/sse
environmentScopes: [production]
```

Git definitions are strict and reject `env`, `headers`, tokens, and arbitrary runtime commands.
Manage credentials with **Settings > MCP Servers** or `PUT /mcp-servers/:id/credentials`;
credentials are never returned by catalogue APIs or committed to Git.

## Deployment configuration

Set these Terraform variables:

```hcl
governance_repo_owner       = "security"
governance_repo_name        = "agent-governance"
governance_repo_ref         = "main"
governance_repo_path        = ".openinspect"
governance_npm_registry_url = "https://registry.npmjs.org"
governance_mcp_builder_url   = "https://mcp-builder.example.com"
```

Set `governance_mcp_builder_token` to the same bearer token accepted by the builder. For a private
registry, inject `governance_npm_registry_token` through the deployment's secret mechanism. The
control plane passes it only to the builder for that build. Do not put either token in the
repository or a committed tfvars file. Local Git-managed MCPs are rejected when the builder is not
configured.

The control plane uses `GovernanceCatalogDO` as the single reconciliation writer. Apply the Worker
Durable Object migration before enabling Git governance in an existing deployment; the production
Terraform configuration carries the binding and migration tag.

The SCM App/PAT configured for Open-Inspect must have read access to the governance repository. The
catalogue reconciles every 15 minutes. Editors can inspect `GET /governance/catalog`, trigger
`POST /governance/catalog/sync`, and use **Sync now** in Settings. When Git governance is
configured, direct Skill/MCP metadata writes return `409`; profiles and MCP credential rotation
remain mutable in the application.

On the first successful sync, an existing app-managed Skill or MCP with the same name is adopted so
its stable ID, history, and MCP credentials are retained. Other app-managed Skills and MCPs that are
not present in Git are retired for future sessions. Review the initial catalogue carefully and test
this cutover in staging before enabling the repository bindings in production.

## Verification guide

Start with focused automated checks from the repository root:

```bash
npm run build -w @open-inspect/shared
npm test -w @open-inspect/control-plane -- --run \
  src/governance/catalog-schema.test.ts \
  src/governance/npm-resolver.test.ts \
  src/source-control/providers/github-provider.test.ts \
  src/source-control/providers/gitlab-provider.test.ts
npm run test:integration -w @open-inspect/control-plane -- --run \
  test/integration/git-governance-catalog.test.ts
```

Then test a staging deployment:

1. Create a governance repository with one harmless global Skill and one test MCP definition.
2. Configure the staging control plane and invoke `POST /governance/catalog/sync` as an editor.
3. Check that the status reports `succeeded` and the expected `activeCommitSha`.
4. Confirm Settings shows Git-managed metadata as read-only and the MCP's exact resolved version.
5. Start session A and record its MCP revision and artifact digest from the session manifest.
6. Publish or select a newer matching test package, sync again, and start session B.
7. Confirm B receives the newer exact artifact while restoring A retains the older artifact.
8. Commit an invalid catalogue entry and sync. Confirm status becomes `failed`, the prior
   `activeCommitSha` remains active, and new sessions still receive the last-good catalogue.
9. Rotate a test MCP credential in Settings. Confirm the credential is absent from Git/API output
   and is available only to a matching sandbox.
10. Remove a Skill/MCP from Git and sync. Confirm it is unavailable to new sessions while sessions
    that already pinned it remain reproducible.

Before production rollout, also run the full verification commands in
[`SECURE_GENERATION_AUDIT.md`](SECURE_GENERATION_AUDIT.md) and protect the governance branch with
the organization's required review and CI policies.

## Deliberately deferred

Incident-response features are a future TODO: emergency revocation, forced session termination,
consumer enumeration for compromised MCP/Skill revisions, and a tested break-glass recovery
workflow. They are not implemented by this change.
