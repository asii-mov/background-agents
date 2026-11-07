# Differences from upstream Open-Inspect

This repository is a security-governed fork of
[`ColeMurray/background-agents`](https://github.com/ColeMurray/background-agents). It keeps the
upstream Open-Inspect product and adds centrally managed controls for corporate agent use.

## Comparison baseline

The original fork baseline was `4d2d7396ab3ad9de76ff36bab696e2e77510284e`. The October 5 integration
targets upstream `e364a7eec0342283c3fa8cfb9e957aee9f467559`. Upstream advanced by 499 commits across
2,281 files. The merge preview found 84 conflicting paths. The integration preserves fork commit
ancestry and ports its policies into upstream's current routing, runtime, and host modules.

## Overlapping features after the update

| Area                   | Upstream now provides                                                        | Fork policy retained                                                                  | Integration result                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Roles                  | Owner, administrator, member, viewer, custom roles, suspension, and auditing | Member/editor/admin governance grants                                                 | Both gates remain. Upstream controls workspace access. The fork adds catalogue and AppSec restrictions.                  |
| Repository access      | Team grants and session-scoped credential capabilities                       | Linked GitHub user must have write-capable access to each repository                  | Complementary admission checks. Requested repository credentials remain limited to one admitted repository.              |
| Skills                 | Revisions, profiles, assignments, imports, and session manifests             | Required assignments and Git-owned catalogue state                                    | One catalogue and resolver with additional fork constraints. These base Skills features already existed before the fork. |
| MCP                    | Configuration, credentials, strict parsing, and package installation caching | Approval lifecycle, immutable verified artifacts, Git ownership, and pinned manifests | Upstream validation is retained. Package caching does not replace digest verification.                                   |
| Browser authentication | Application identity, workspace permissions, and request correlation         | Cloudflare Access assertion validation and credential stripping                       | Complementary perimeter and application checks.                                                                          |
| Sandbox execution      | New launch coordinator, Claude harness, and Modal VM support                 | Network policy, security pipelines, and governed MCP artifacts                        | Fork policies move to current runtime owners. Unsupported governed launches fail closed.                                 |
| AppSec and components  | No equivalent policy catalogue                                               | Approved components, repair pipelines, repository risk, draft enforcement             | Retained as fork-specific capabilities.                                                                                  |

Upstream also adds teams, persistent scoped memory, unsent prompt drafts, expanded analytics, and a
Node control-plane host. The repository map records which new UI areas still lack browser coverage.

## Upgrade compatibility

- Existing fork migration numbers `0070` through `0076` remain intact. Incoming upstream migrations
  are numbered `0087` through `0102`, followed by the fork role translation in `0103`.
- Persisted members remain members. Persisted administrators map to upstream administrators. Editors
  receive a custom role with member permissions plus Skills and MCP management.
- Environment-only `PLATFORM_ADMIN_USERS` and `PLATFORM_EDITOR_USERS` grants remain additional
  governance grants. They do not create upstream owner or administrator assignments.
- No workspace owner is elected automatically. Use the upstream owner bootstrap for the intended
  operator.
- Catalogue editors need upstream `integrations.read` to see sandbox settings and
  `integrations.manage` to change them. This update does not grant broad integration administration
  automatically.
- Governed Claude launches and restrictive network policy on unsupported backends are rejected.
- A Slack or Linear first-contact actor links to an existing user by the email that the bot reports
  only when `identity_link_email_domains` lists the email's domain and that user verified the email
  at a web sign-in. The linked actor inherits the user's roles, as in upstream. A bot report never
  verifies an email, so it cannot match an email entry in `PLATFORM_ADMIN_USERS`. The default empty
  list keeps every bot actor a separate user. Users that upstream's Slack and Linear attestation
  verified before this change stay verified.
- Node 24 is required. Use `.env.web.example` for the web app and `.env.example` for the Node
  backend.

The two role systems remain a maintenance cost. A later consolidation should introduce precise
upstream permissions for every governance action before removing the fork's additional gate.

## Upstream behavior retained

The fork keeps the core Open-Inspect product:

- background coding sessions in remote sandboxes
- the Next.js web application and Cloudflare control plane
- GitHub, Slack, and Linear integrations
- automations, analytics, session collaboration, diffs, terminals, and pull requests
- Modal, Daytona, Vercel, OpenComputer, and E2B sandbox adapters
- OpenCode as the in-sandbox coding agent

## Controls added by this fork

| Area                   | Difference from upstream                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform roles         | Adds installation-wide member, editor, and administrator roles. Control-plane policies enforce catalogue writes and role management.                                                                                                                                 |
| Identity linking       | Limits upstream's linking by bot-reported email to domains in `identity_link_email_domains` and to users who verified that email at a web sign-in. A bot report never verifies an email. Each link logs `auth.identity_linked_by_email`.                             |
| Repository admission   | Requires a linked GitHub user to have `write`, `maintain`, or `admin` permission on every selected repository. The sandbox credential helper receives a short-lived read-only token limited to one admitted repository. Only the managed push receives write access. |
| Managed Skills         | Adds required assignments, Git catalogue ownership, and import provenance checks to upstream Skills and session manifests.                                                                                                                                           |
| Git governance         | Lets a reviewed Git repository own the desired state for shared Skills and MCP entries. Reconciliation validates one commit and activates a complete last-good catalogue.                                                                                            |
| MCP catalogue          | Adds approval lifecycle, governed scope and provenance, exact npm resolution, content-addressed artifacts, and session pins to upstream configuration and credential storage.                                                                                        |
| Approved components    | Adds an owned catalogue of approved libraries, services, templates, and snippets. Agents can search and record adoption, and owners can inspect consumers.                                                                                                           |
| Stack policy           | Grades each technology `preferred`, `allowed`, or `denied` within a category. Agents must remove newly introduced denials, and a `block` category also stops the push. A GitHub Action runs the same check on pull requests.                                         |
| AppSec checks          | Adds centrally assigned, argument-vector security pipelines. Checks run after generation and before the managed push path. Failures return to the agent for a bounded number of repair attempts.                                                                     |
| Pull-request risk      | Combines repository criticality with changed-path criticality. High-risk changes become draft pull requests with a security-review note.                                                                                                                             |
| Sandbox network policy | Adds global, repository, and environment egress settings. Modal enforces blocked, domain allowlist, and CIDR allowlist policies. Unsupported providers reject restrictive policies.                                                                                  |
| Internal app hosting   | Agents deploy internal apps to `<name>.<apps_domain>` in a dedicated Cloudflare account. Only a Terraform-owned broker Worker holds its token. A `*.<apps_domain>` Access floor, a per-app Access app, and a guard that checks the visitor's token gate each app.    |
| Agent verification     | Adds a checked repository map, a project verification Skill, and loopback Playwright tests for core sessions and governance settings.                                                                                                                                |

## User-visible behavior changes

- Slack and Linear requests act as the sender's web account only when `identity_link_email_domains`
  lists the sender's email domain. Otherwise they belong to a separate user with the workspace
  default role.
- A GitHub user with read-only or triage access cannot start a repository session.
- Required Skills remain selected even when a user selects **None** or a personal profile.
- When Git governance is configured, the application treats shared Skill and MCP metadata as
  read-only. Editors can still rotate MCP credentials outside Git.
- New sessions pin the exact Skill and MCP revisions that they receive.
- A restrictive network policy fails closed when the selected sandbox provider cannot enforce it.
- Blocking AppSec findings stop the managed push and pull-request path.
- Agents build with the organization's preferred technology. A newly introduced denied technology,
  such as React with the default policy, stops the turn and the push after the agent fails to remove
  it. Technology already in the repository at the session's base commit never blocks.
- Members no longer see governance settings or catalogue data. Reads need `governance.read` and
  writes need `governance.manage`.
- A pull request with a risk score of at least `8` must remain a draft.
- With `apps_enabled`, an agent can deploy an internal app that opens at
  `https://<name>.<apps_domain>` for users that the apps visitor Access policy admits.
- With `sandbox_tunnels_policy = "disabled"`, sessions cannot open public preview tunnels. The
  control plane tells the agent to deploy an app instead.

## New storage and services

The fork adds D1 migrations for platform roles, required Skills, governed MCP entries, security
pipelines, repository risk, approved components, and Git catalogue state. It also adds the
`@open-inspect/mcp-artifact-builder` service for verified local MCP dependency artifacts.

The stack policy adds component categories, component stances and signals, and the stack inventory
tables that hold observed repository facts. It also adds the `stack-policy-check` GitHub Action and
the `sandbox_runtime.stack_policy_cli` checker it runs.

Internal app hosting adds the `@open-inspect/app-broker` Worker in a dedicated apps Cloudflare
account, with that account's Access organization and, optionally, a Workers for Platforms dispatch
namespace and dispatcher Worker. Terraform creates them only when `apps_enabled` is true. The
control plane receives the broker URL, an Access service token, and a request-signing secret.

## Limits that remain

- The deployment is still single-tenant.
- GitLab does not have the linked-user repository admission check used by GitHub.
- Bitbucket governance repository reading is not implemented.
- Restrictive network policy is enforced only by Modal. Other providers reject those launches.
- An agent can use lower-level Git commands inside its sandbox. Branch protection and required CI
  checks remain necessary.
- Production deployment policy is outside this repository.
- Emergency catalogue revocation and forced termination of affected sessions remain future work.

## Detailed references

- [Secure generation governance](SECURE_GENERATION.md) describes the architecture and operating
  rules.
- [Secure generation implementation audit](SECURE_GENERATION_AUDIT.md) maps each claim to its code
  and tests.
- [Git-backed Skills and MCP governance](GIT_GOVERNANCE_CATALOG.md) defines the Git catalogue format
  and reconciliation behavior.
- [Managed Skills](MANAGED_SKILLS.md) describes Skill authoring, assignment, and runtime delivery.
- [Govern the technology stack](STACK_POLICY.md) explains the stack policy and its CI check.
- [Host agent-built internal apps](APPS.md) sets up the apps account, the broker, and Access.
- [OpenInspect repository map](REPO_MAP.md) maps user-visible capabilities to their source owners
  and verification.

## Review the exact code difference

Run these commands from the repository root:

```bash
git diff --stat e364a7eec0342283c3fa8cfb9e957aee9f467559..HEAD
git diff --name-status e364a7eec0342283c3fa8cfb9e957aee9f467559..HEAD
git log --oneline e364a7eec0342283c3fa8cfb9e957aee9f467559..HEAD
```

When the fork merges a new upstream baseline, update the pinned commit and review this page against
the resulting diff.
