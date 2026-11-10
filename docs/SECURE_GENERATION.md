# Secure generation governance

This fork turns the secure-vibecoding proposal into controls that are owned centrally but applied
inside every relevant remote agent session. It deliberately keeps the agent autonomous inside its
sandbox. Security decisions that must not depend on model compliance are enforced by the control
plane, sandbox admission, immutable session snapshots, scanner exit codes, and pull-request gates.

## Control flow

```text
authenticated user
  -> platform role check
  -> per-user access check for every selected GitHub repository
  -> resolve centrally scoped Skills, MCPs, approved components, and AppSec pipelines
  -> pin Skill and MCP revisions and launch an isolated sandbox with the assigned network policy
  -> agent generates a change
  -> agent searches/adopts approved organizational primitives
  -> managed checks execute directly (no shell) before a managed push or PR
  -> failed output is returned to the agent for bounded remediation
  -> every check is rerun
  -> blocking failures stop successful completion
  -> PR risk = repository criticality x change criticality
  -> high-risk PR is forced to draft with a security-review note
```

## Ownership and roles

Roles are installation-wide:

| Role   | Use governed capabilities | Manage catalogues, checks, risk, and network policy | Manage roles |
| ------ | ------------------------- | --------------------------------------------------- | ------------ |
| member | yes                       | no                                                  | no           |
| editor | yes                       | yes                                                 | no           |
| admin  | yes                       | yes                                                 | yes          |

Set `platform_admin_users` and, optionally, `platform_editor_users` in the production Terraform
variables. Entries are comma-separated user IDs, verified emails, or SCM logins. The resulting
`PLATFORM_ADMIN_USERS` and `PLATFORM_EDITOR_USERS` bindings act as break-glass bootstrap ownership;
admins can assign persisted roles under **Settings > AppSec** afterward.

Write SCM logins as provider-scoped identifiers such as `github:octocat`. Bare login names and
unverified email addresses do not grant a bootstrap role.

Slack and Linear bots report each sender's email address. The control plane never treats that report
as proof of the address, so it cannot satisfy an email entry in `platform_admin_users` or
`platform_editor_users`. A bot actor links to an existing user only under two conditions.
`identity_link_email_domains` lists the address's domain, and that user's `users.email` is the
address and is verified. The actor then acts with that user's roles, and the control plane logs
`auth.identity_linked_by_email` with the provider, actor, email domain, target user, and request ID.

A bot-reported address stays on the actor's identity as `user_identities.provider_email`. It never
lands on `users.email`, so no sign-in can verify it there or link into the bot actor's user. If no
user has verified an allowed-domain address yet, the actor gets a separate user with no email. After
someone proves that address at a web sign-in, the actor's next request links to their account. The
history from before the link stays with the separate user.

The allowlist leaves one trust boundary open. With a domain listed, a bot actor that reports an
address in it links to the existing user who verified that address, and acts with that user's roles.
Anyone who can set that address on a Slack or Linear account can do this, and each link is audited
as above. The link does not check that the target user has a GitHub or Google identity. A user whose
email upstream's Slack or Linear attestation verified also counts as a verified owner, and
`docs/plans/governed-apps/bot-verified-users.sql` lists those users for review. List only domains
whose Slack and Linear accounts your company administers. The default empty list never links, so
each bot actor stays a separate user with the workspace default role.

The control plane enforces `governance.read` on every governance read and `governance.manage` on
every governance write. Owner, Administrator, and the catalogue editor role hold both. Members and
viewers hold neither. Hiding controls in the web UI is only a usability measure, not the
authorization boundary. Role changes enforce `platform.manage` and are logged with actor, target,
role, request ID, and trace ID.

## Repository admission

For GitHub-backed deployments, a repository session requires a linked GitHub identity. Before the
session is created, the control plane checks that identity has `write`, `maintain`, or `admin`
permission on every selected repository using the GitHub App installation. Read-only or triage
access, a denial, a missing identity, a provider error, or an incomplete multi-repository check
rejects the whole session. Each sandbox credential request names one admitted repository, and the
control plane mints a short-lived App token restricted to that repository. Admission to one
repository does not expose sibling repositories in the installation.

Repository-less sessions remain available. GitLab deployments remain single-tenant: Open-Inspect
does not currently have a linked per-user GitLab identity from which to perform the same admission
check. Do not treat this fork as multi-tenant isolation.

## Centrally governed capabilities

### Skills

Skills are organizational guidance and reusable context, not a security permission primitive.
Editors can make a Skill **required**. Required, enabled, in-scope Skills are included even when a
user selects **None** or a personal profile. Exact Skill revisions and content digests are stored in
the session manifest, inherited by child sessions, and reused on restore.

Required Skills fail sandbox startup if repository, user, or bundled content attempts to shadow the
same canonical name. Optional managed Skills keep the existing compatibility behavior and lose a
name collision. Skill content failure or digest mismatch also fails startup.

Use Skills to tell agents which approved libraries, services, templates, and engineering patterns to
use. Enforce the actual trust boundary in those components and in the controls described here.

When Git governance is configured, Skills are authored as normal `SKILL.md` directories in a central
repository and the application becomes a read-only runtime catalogue. The reconciler reads one
immutable commit, validates the complete snapshot, and atomically activates it. See
[`GIT_GOVERNANCE_CATALOG.md`](GIT_GOVERNANCE_CATALOG.md).

### MCP servers

MCP entries have `development`, `approved`, and `deprecated` lifecycle states plus repository and
environment scopes. Only enabled, approved, in-scope entries are injected into a sandbox.

The runtime catalogue's approval validation requires:

- HTTPS for remote MCP endpoints;
- an exact resolved package version, registry integrity, tarball URL, and unambiguous executable for
  local MCPs;
- editor ownership for mutation;
- creator/updater provenance in catalogue metadata.

Existing local MCP entries migrate to `development` so they cannot silently become approved under
the new version-pinning rule. Secrets remain omitted from catalogue responses and are decrypted only
for matching sandbox creation or restoration.

Git-managed MCP definitions intentionally declare an unpinned automatic update channel and optional
SemVer range. On every reconciliation the control plane resolves that policy to an exact package
version, integrity hash, HTTPS tarball, and executable. An isolated builder installs that exact
tarball with lifecycle scripts disabled, verifies the package lock, bundles the complete production
dependency closure, and returns it to content-addressed object storage. The runtime downloads only
the artifact pinned to its session, verifies its SHA-256 digest and manifest, and launches the
bundled executable directly without `npx` or registry access. New sessions update automatically;
restored sessions keep their existing revision. Git never contains MCP credentials, and encrypted
credentials rotate independently in the application.

### Approved organizational primitives

Editors manage approved libraries, services, templates, and snippets under **Settings > AppSec**.
Every entry has an owner, lifecycle, repository/environment scope, provenance, usage instructions,
and revision. Approval additionally requires:

- an exact version for libraries;
- HTTPS locators for services, templates, and snippets;
- a SHA-256 integrity digest for templates and snippets;
- an HTTPS source or documentation URL for provenance.

Every sandbox receives a standard `approved-components` tool. The tool searches only enabled,
approved entries applicable to that session. Its description directs the agent to search before
implementing authentication, authorization, logging, secrets handling, or database access. After
choosing a component, the agent records adoption against one repository in the session.

The consumer inventory stores the exact component revision and version. The management UI shows
consumers and flags those behind the current revision/version. Adoption is a declared inventory
event, not proof that the resulting code uses the component correctly; AppSec checks or repository
policy should verify usage where that matters.

The `GET /capabilities` read model returns Skills, MCP servers, and approved components together.

Approved components with a category, a stance, and signals also form the stack policy. The sandbox
blocks newly introduced denied technology, and a GitHub Action repeats the check on pull requests.
See [Govern the technology stack](STACK_POLICY.md).

## Managed AppSec feedback loop

Editors configure pipelines under **Settings > AppSec** or through `/security-pipelines`. A pipeline
can apply globally or to selected repositories and environments. Each command is an argv array,
never a shell string, and has a 1–900 second timeout. A pipeline contains at most 20 commands;
retained combined output per command is capped at 64 KiB. Remediation attempts are bounded from 0
to 5.

Pipelines are resolved afresh for both a new sandbox and a snapshot restore. Resolution errors stop
the sandbox from starting. Repository-scoped checks run in each matching checkout in a
multi-repository session. Before the managed push/PR path creates remote state:

1. every assigned blocking and non-blocking command runs in the target checkout;
2. blocking failure rejects the push and returns verified diagnostics to the same agent turn;
3. the agent can remediate and retry; only a clean blocking rerun can push.

After the agent produces output, the general feedback loop also runs:

1. every assigned command runs sequentially in `/workspace`;
2. failures and bounded command output are formatted as a verified remediation prompt;
3. the same agent session receives that prompt;
4. every check runs again;
5. a remaining blocking failure makes `execution_complete.success` false.

Non-blocking pipelines report findings without turning the final execution into a failure. The
pipeline image must contain the configured scanner binaries. Installing and versioning scanners in
the approved environment image is an operator responsibility.

The managed PR tool cannot push past a blocking failure. Because the sandbox intentionally permits
autonomous shell use, organizations that need protection against deliberately bypassing the managed
tool path must also configure SCM-side branch protection and required CI checks. That external
repository control is deployment-specific and is not created by this fork.

Typical commands include test suites, SAST, dependency analysis, secret scanning, and SBOM policy
checks. SBOM generation itself should normally be non-blocking; a policy command can validate the
result separately.

## Simple risk gate

Repository criticality is centrally assigned as `low`, `medium`, `high`, or `critical`; an
unclassified repository defaults to `medium`. Change criticality is derived deterministically from
the current session diff:

- `critical`: authentication, authorization, IAM/RBAC/ACL, cryptography, secrets, payments, billing,
  or production paths;
- `high`: infrastructure/networking, database migrations, dependency lock files, and API routes;
- `low`: a docs/tests/assets-only change;
- `medium`: everything else.

The weights are 1, 2, 3, and 4. The score is the two weights multiplied. A score of 8 or more
requires security review. At PR creation, the current diff must be available or the request fails
closed with `409`. High-risk PRs are forced to draft and receive a machine-generated review note. If
the target branch already has an open non-draft PR, the service refuses to push until that PR is
converted to draft; this prevents an update from bypassing the gate. The API also exposes
`POST /risk/assess` so the classification can be previewed and tested.

This is intentionally small. The path rules and threshold are a first iteration, not an assertion
that multiplication is a complete risk model.

## Remote sandbox boundary

Autonomous tool permissions inside OpenCode are intentional. The stronger boundaries are:

- repository admission before a session exists;
- one remote sandbox and filesystem scope per session;
- repository/environment-scoped capabilities and credentials;
- centrally managed outbound network policy;
- server-side credential brokering;
- centrally resolved checks that the model cannot mark as passed;
- expiring sandbox lifecycle and fresh policy resolution on every launch, restore, or supported
  in-place resume.

This work does not add an in-model approval prompt for ordinary tool calls. Editors and admins can
set sandbox egress to `unrestricted`, `blocked`, or an allowlist of TLS domains and IP CIDRs at the
global, repository, or environment level. Non-editor writes cannot change or remove that field.
Modal enforces these settings with its
[sandbox network controls](https://modal.com/docs/guide/sandbox-networking). The provider-neutral
interface advertises enforcement support, and a restrictive session fails before launch or restore
when the selected provider cannot enforce it; malformed persisted policy fails closed to `blocked`.
The control plane discards the session's policy snapshot and resolves the current central policy at
each of those lifecycle boundaries. The sandbox integration's `enabledRepos` convenience allowlist
cannot disable this security boundary. A settings lookup failure also fails closed to `blocked`.

OpenComputer, E2B, Daytona, and Vercel do not currently advertise complete policy support in this
fork, so restrictive policies intentionally reject those launches. Customer/tenant data segregation
and scanner-specific credentials still require deployment-specific identity and network design.
Changing a policy does not retrofit a currently running Modal sandbox; the new policy applies when
that sandbox is next launched or restored. Operators should terminate affected active sessions when
an immediate egress revocation is required.

## Management API

| Resource                                     | Read              | Mutate               | Notes                                                                |
| -------------------------------------------- | ----------------- | -------------------- | -------------------------------------------------------------------- |
| `/platform/me`                               | signed-in user    | —                    | Effective role                                                       |
| `/platform/users`                            | admin             | admin                | Role update is `PATCH /platform/users/:id/role`                      |
| `/capabilities`                              | user/service      | —                    | Skills, MCPs, and approved components                                |
| `/skills`                                    | user/service      | `skills.manage`      | Supports required Skills and revision CAS                            |
| `/mcp-servers`                               | user/service      | `mcp_servers.manage` | Lifecycle, scope, provenance, revision CAS                           |
| `/approved-components`                       | `governance.read` | `governance.manage`  | Lifecycle, provenance, scope, stance, signals, revision CAS          |
| `/approved-components/:id/consumers`         | `governance.read` | —                    | Revision-aware consumer inventory                                    |
| `/component-categories`                      | `governance.read` | `governance.manage`  | Technology slots and their `advise` or `block` enforcement           |
| `/stack-policy/preview`                      | `governance.read` | —                    | Instructions a session for `?repo=` would receive                    |
| `/stack-policy/export`                       | `governance.read` | —                    | Compiled policy for the CI check ([Stack policy](STACK_POLICY.md))   |
| `/stack-inventory`                           | `governance.read` | —                    | Observed stack; `/rollup` per category, `/repositories/:owner/:name` |
| `/governance/catalog`                        | `governance.read` | `governance.manage`  | Git catalogue status; mutate is `POST /governance/catalog/sync`      |
| `/sessions/:id/approved-components`          | sandbox           | sandbox              | Scoped search and adoption                                           |
| `/sessions/:id/stack-observations`           | —                 | sandbox              | Baseline and push stack reports                                      |
| `/sessions/:id/mcp-artifacts/:mcp/:revision` | sandbox           | sandbox              | Exact session-pinned MCP artifact                                    |
| `/security-pipelines`                        | `governance.read` | `governance.manage`  | Scope and revision CAS                                               |
| `/repository-risk`                           | `governance.read` | `governance.manage`  | Repository criticality profiles                                      |
| `/risk/assess`                               | `governance.read` | —                    | Deterministic preview                                                |
| `/integration-settings/sandbox`              | user/service      | mixed                | Network policy changes require editor/admin                          |

## Verification

From the repository root:

```bash
npm run typecheck
npm test
npm run test:integration
npm run test:e2e -w @open-inspect/web
npm run lint
npm run format:check

cd packages/sandbox-runtime
uv run pytest
uv run ruff check src tests
uv run mypy src
```

The focused test coverage includes role authorization, per-user multi-repository admission,
required-Skill collision handling and content digests, MCP approval rules, approved-component
provenance/scoping/consumer inventory, D1 scope/CAS behavior, pipeline timeouts/output bounds,
pre-push rejection, the agent remediation/rerun loop, network-policy validation/provider mapping,
deterministic risk scoring, and forced-draft PR behavior. The full requirement-to-evidence map is in
[Secure generation implementation audit](SECURE_GENERATION_AUDIT.md).

The browser verifier drives the real Next.js settings UI on loopback with deterministic BFF
fixtures. Its project skill and feature map live under `.cursor/skills/verify-openinspect`. The map
names the control-plane/runtime companion tests required for security claims that a browser cannot
prove.

## Explicitly out of scope

Production deployment governance is not implemented here. A user could take generated code and
deploy it through a separate manual path with arbitrary infrastructure or credentials. Closing that
gap requires approved deployment templates, workload identity, policy-as-code gates, artifact
provenance, and an inventory that links deployed workloads back to repositories and catalogue
consumers.

Central ownership also concentrates impact. This fork adds owners, provenance, lifecycle,
version/integrity requirements, revisions, disabling/deprecation, and declared consumer discovery.
It does not itself operate a compatibility programme, rotate every downstream dependency, or prove
that an adoption record matches code. Those remain organizational processes backed by this data.
