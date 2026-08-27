# Secure generation implementation audit

This matrix maps the concrete claims in the secure-vibecoding proposal to implementation and test
evidence in this fork. “Implemented” means the behavior exists in this repository and has focused
automated coverage. It does not mean every provider or an organization's production deployment is
configured automatically.

| Proposal requirement                                                             | Status                                        | Implementation evidence                                                                                                                                                                   | Focused verification                                                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Central organizational context instead of repository islands                     | Implemented                                   | Git-backed desired state, managed Skill catalogue, assignments, immutable revisions, last-good activation, and session manifests                                                          | `git-governance-catalog.test.ts`, `managed-skills.test.ts`, parser/content-addressing/runtime tests   |
| Mandatory organizational guidance cannot be omitted or shadowed                  | Implemented                                   | Required Skills are added independently of user profile/None selection; required name collisions and digest mismatches stop startup                                                       | control-plane managed-Skill integration tests; `test_managed_skills.py`                               |
| Central approved MCP catalogue                                                   | Implemented                                   | Git desired state, lifecycle/scopes/provenance, automatic resolution, encrypted secret handling, immutable runtime revisions, and per-session pins                                        | governance parser/resolver/provider tests, `git-governance-catalog.test.ts`, MCP integration tests    |
| Prevent floating/unreviewed MCP execution                                        | Implemented                                   | Git declares an automatic channel/range; reconciliation builds the exact tarball and dependency closure; runtime verifies and launches only the session-pinned content-addressed artifact | npm resolver, artifact builder/route, session pinning, and runtime MCP tests                          |
| Approved libraries, services, templates, and snippets                            | Implemented                                   | Approved-component catalogue with owner, usage, lifecycle, scopes, provenance, exact library versions, HTTPS locators, and template/snippet SHA-256 integrity                             | `approved-components.test.ts` and approved-component UI tests                                         |
| Agents discover organizational primitives before reimplementing common functions | Implemented                                   | Standard sandbox `approved-components` search/adopt tool, explicitly described for authn/authz/logging/secrets/database work                                                              | `test_approved_components_tool.py`                                                                    |
| Shared-component owners can find downstream adopters                             | Implemented with declared inventory           | Revision/version-aware consumer records and UI that flags outdated consumers                                                                                                              | approved-component integration and UI tests                                                           |
| Central ownership and separation of duties                                       | Implemented                                   | Installation roles: member, editor, admin; write permissions enforced in router; bootstrap role bindings and audited role changes                                                         | `platform-roles.test.ts`, route policy tests, AppSec settings tests                                   |
| AppSec tools are in the agent feedback loop                                      | Implemented                                   | Centrally scoped argv-only pipelines; bounded timeout/output/attempts; verified findings returned to the same session; rerun after remediation                                            | `test_security_pipeline.py`, `test_bridge_sse.py`, pipeline integration tests                         |
| SAST/dependency/secrets/SBOM workflows can be assigned                           | Implemented as managed commands               | Security editors configure scanner/test commands; the approved image supplies and versions the binaries                                                                                   | pipeline schemas, store, UI, runtime runner tests                                                     |
| Blocking checks run before the managed push/PR path                              | Implemented                                   | Bridge runs matching pipelines in the target checkout before its push; failures emit `push_error` and no remote push occurs                                                               | `test_bridge_push.py`                                                                                 |
| Higher-risk changes receive human review                                         | Implemented                                   | Deterministic path classifier plus repository criticality; score is repository criticality × change criticality; score ≥ 8 forces draft/security note                                     | risk classifier tests, pull-request handler/service tests, create-PR integration tests                |
| Missing diff or existing non-draft PR cannot bypass the risk gate                | Implemented                                   | PR creation fails closed without current changed paths and refuses updates to an already-open non-draft PR that now requires review                                                       | pull-request handler and per-branch service tests                                                     |
| Remote environment rather than employee laptop                                   | Existing and extended                         | Cloud sandbox provider abstraction, per-session remote filesystem/lifecycle, environment/repository images and settings                                                                   | lifecycle/provider suites across Modal, E2B, Daytona, OpenComputer, and Vercel                        |
| Small repository/filesystem boundary                                             | Implemented for admitted session repositories | Every selected GitHub repository requires write-capable linked-user permission; the whole multi-repo request fails closed on read-only access or any denial                               | `user-authorization.test.ts`, GitHub provider tests, create-session tests                             |
| Scoped credentials and secret segregation                                        | Implemented                                   | The broker requires an exact session member path and mints one-repository credentials; secrets resolve only for the target repo/environment; sandbox authentication is session-bound      | credential-helper, sandbox-handler, target-secret, and provider environment tests                     |
| Centrally governed network boundary                                              | Implemented on Modal; fail-closed elsewhere   | Global/repository/environment egress policy supports unrestricted, blocked, domain allowlist, and CIDR allowlist; restrictive policies require editor ownership and provider capability   | sandbox settings/lifecycle/Modal resource tests, integration-settings ownership test, sandbox UI test |
| Stale session settings cannot bypass a current network policy                    | Implemented at lifecycle boundaries           | Every launch/restore/resume discards the saved policy and resolves the current central value; repository enablement cannot suppress the security field; lookup errors block egress        | lifecycle live-policy and sandbox integration-resolution unit tests                                   |
| Autonomous agents keep broad in-sandbox tool permissions                         | Intentional                                   | No in-model approval loop was introduced; admission, scoping, network, scanners, and PR policy sit around the model                                                                       | documented design decision plus boundary-specific tests above                                         |
| Current library documentation such as Context7                                   | Supported through governance                  | Security editors can approve and scope a Context7 MCP entry; the generic design avoids a hard dependency on that vendor                                                                   | MCP lifecycle/scope/runtime resolution tests                                                          |
| Production deployment uses approved templates/policy gates                       | Out of scope by request                       | Explicitly documented in `SECURE_GENERATION.md`; no claim of production-deployment enforcement                                                                                            | Not applicable                                                                                        |

## Honest boundaries

- The deployment remains single-tenant. GitHub has linked-user repository admission; GitLab lacks
  equivalent linked-user identity and must not be treated as a multi-tenant boundary.
- Component adoption is recorded by the agent. It is useful inventory, but a scanner or repository
  policy must verify actual imports/configuration when proof matters.
- The managed PR tool cannot push past blocking sandbox checks. An autonomous agent can still invoke
  lower-level shell/git paths inside its sandbox; SCM-side branch protection and required CI checks
  are required against deliberate bypass.
- Restrictive outbound network policy is currently implemented by Modal. Other providers are
  rejected rather than silently weakened until their adapters advertise and implement equivalent
  controls.
- A central network-policy update applies on the next launch or restore. It does not mutate a Modal
  sandbox that is already running, so immediate revocation requires terminating affected sessions.
- Scanner binaries and their versions belong in the centrally approved sandbox image. A configured
  but missing binary is reported as a failed finding; this fork does not select an organization's
  scanner vendors.
- Emergency catalogue revocation, forced termination of affected sessions, and compromised-revision
  consumer response are future incident-response work and are not claimed as implemented.

## Verification commands

Run from the repository root:

```bash
npm run typecheck
npm test
npm run test:integration
npm run test:e2e -w @open-inspect/web
npm run lint
npm run format:check
npm run build

cd packages/sandbox-runtime
uv run --frozen pytest
uv run --frozen ruff check src tests
uv run --frozen mypy src

cd ../modal-infra
uv run --extra dev --frozen pytest
uv run --extra dev --frozen ruff check src tests
```

At the time of this audit, repository-wide TypeScript checks, lint, formatting, sandbox runtime
checks, and Modal infrastructure checks pass. CI and the commands above remain the authoritative
source because the repository continues to change after this snapshot.
