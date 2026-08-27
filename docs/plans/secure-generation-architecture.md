# Secure generation implementation shape

## Problem

OpenInspect must keep Git references moving so central policy updates automatically, while each
session runs exact Skill and MCP revisions. It must also prevent a user's repository access from
becoming installation-wide GitHub authority. The existing fork records most of this state, but its
credentials, reconciliation order, and MCP runtime bytes do not yet match those claims.

Production deployment controls and incident response remain future work. This change does not reduce
the agent's OpenCode tool permissions, treat approved central MCPs as hostile input, or replace the
current risk formula.

## Usage

The governance caller requests a complete outcome. It does not coordinate fetch, parse, build, or
publication phases.

```ts
const result = await governance.reconcile({ trigger: "schedule" });
await governance.activate({ releaseId: rollbackTarget, actor });
```

Session creation admits each repository separately and pins one immutable release.

```ts
const grants = await repositoryAuthority.admitSession({ userId, repositories });
const manifest = await sessionGovernance.pin({ sessionId, grants, environmentId });
```

Git operations request authority for one exact repository.

```ts
const credential = await repositoryAuthority.issueGitCredential({
  sessionId,
  repository: { repoOwner: "acme", repoName: "api" },
});
```

Verification runs through one disposable local command.

```bash
npm run verify:user -- --feature managed-capabilities
```

## Shape

### Repository authority

```ts
type RepositoryCapability = "read" | "write";

interface SessionRepositoryGrant {
  sessionId: string;
  repository: {
    repoOwner: string;
    repoName: string;
    providerRepoId: number;
  };
  capability: RepositoryCapability;
  admittedUserId: string;
}

interface RepositoryAuthority {
  admitSession(input: AdmitSessionInput): Promise<readonly SessionRepositoryGrant[]>;
  issueGitCredential(input: RepositoryCredentialRequest): Promise<CredentialHelperAuth>;
  issuePushAuthority(input: RepositoryCredentialRequest): Promise<GitPushAuthContext>;
}
```

Map GitHub `read` and `triage` to `read`. Map `write`, `maintain`, and `admin` to `write`. Persist
that fact once. Mint each GitHub App token with one `repository_id` and the matching permission set.
Cache by repository ID and permissions, never by installation alone. The credential helper must
parse and match the full repository path. This models the authority directly, per
type-system-discipline.

### Bootstrap roles

```ts
type BootstrapSubject =
  | { kind: "canonical-user"; userId: string }
  | { kind: "verified-email"; email: string }
  | { kind: "provider-login"; provider: "github" | "gitlab"; login: string };
```

Resolve bootstrap roles from canonical user IDs, canonical email with `email_verified = 1`, and
provider-qualified SCM logins. Do not use `provider_email` or display email. Parse configuration
into `BootstrapSubject` at the environment boundary and trust the domain type inside, per
boundary-discipline.

### Governance releases

One singleton `GovernanceDO` owns reconciliation and activation. Scheduled and manual requests both
call it. The public operation resolves the moving Git ref, imports external Skills, builds MCP
artifacts, validates the full result, stores immutable content, and changes the active release
pointer.

```ts
interface GovernanceRelease {
  id: string;
  sourceCommitSha: string;
  resolutionDigest: string;
  skills: readonly ReleasedSkill[];
  mcpServers: readonly ReleasedMcpRuntime[];
}

interface GovernanceService {
  reconcile(input: { trigger: "schedule" | "manual" }): Promise<ReconcileResult>;
  activate(input: ActivateReleaseInput): Promise<void>;
}
```

Derive the release ID from the canonical resolved manifest. Repeated reconciliation of the same
input reuses the same release and artifact rows. Rollback changes only the active pointer. MCP
credentials live in a separate mutable binding and never participate in reconciliation or rollback.
This separates independent writers before serialization and makes retries converge.

Session creation pins the active release before sandbox startup. Existing sessions keep exact
runtime revisions. Credential rotation remains live and does not mutate the pinned runtime.

### External Skill sources

Catalog entries may reference a repository, moving ref, and one Skill subdirectory. Resolve the ref
to a commit and call the upstream `fetchSkillImport` implementation. Store its existing source
provenance and content digest. This lets the governance catalog select entries from `openai/skills`
without copying that repository or exceeding its tree limits.

### MCP artifacts

Resolve npm policy into builder input:

```ts
interface ResolvedNpmArtifactInput {
  packageName: string;
  packageVersion: string;
  registryUrl: string;
  tarballUrl: string;
  integrity: string;
  executable: string;
}

interface McpExecutableArtifact {
  bundleDigest: `sha256:${string}`;
  objectKey: string;
  lockDigest: string;
  executable: string;
  sizeBytes: number;
}
```

The builder receives private registry credentials as an ephemeral secret. It verifies the selected
tarball, denies lifecycle scripts by default, resolves a complete locked dependency closure, and
writes a deterministic bundle to object storage. Reject packages with multiple binaries unless the
catalog names one.

The sandbox downloads the pinned bundle through an authenticated control-plane route, verifies size
and digest, rejects unsafe archive paths and links, and installs with an atomic rename. OpenCode
executes the pinned launcher directly. It does not use `npx` or contact the registry.

### Network and process boundaries

Require Modal 1.5 or later for domain allowlists and verify the real `Sandbox.create` signature in
tests. Represent provider network capability as supported modes rather than a boolean. Reject
unsupported policies.

Start pipeline subprocesses in their own process group. On timeout, terminate the group, wait for a
bounded grace period, kill the group, and bound or cancel output collection.

### Verification

Use project-local Playwright as the repeatable web verifier. Use the in-app browser and CDP tools
for interactive diagnosis against the same local services. The verifier starts local Wrangler D1,
local object storage, a fixture-only external-provider adapter, the control plane, and the real web
app. It seeds Better Auth state and uses the normal cookie and BFF paths.

The verifier refuses non-loopback origins, production configuration, persistent data roots, and
external write credentials. It retains Playwright traces, screenshots, browser console errors,
request failures, worker logs, and a local D1 snapshot on failure.

The first feature map covers sign-in and role gates, repository Skill import, MCP catalog and
credentials, AppSec settings, session creation, governed launch, and managed PR behavior.

## Module map

```text
packages/control-plane/src/repository-authority/
packages/control-plane/src/auth/bootstrap-roles/
packages/control-plane/src/governance/durable-object.ts
packages/control-plane/src/governance/release-store.ts
packages/control-plane/src/governance/session-resolver.ts
packages/control-plane/src/governance/artifact-builder.ts
packages/modal-infra/src/mcp-artifacts/
packages/sandbox-runtime/src/sandbox_runtime/mcp_artifacts.py
tests/e2e/
.cursor/skills/verify-openinspect/
```

`packages/control-plane/src/session/components.ts` remains the composition root. `SessionDO` stays a
thin Cloudflare adapter.

## Synthesis decision

Candidate 1 is the base because it represents authority per repository, uses proof-bearing role
subjects, serializes publication through one writer, and removes registry access from the sandbox.
Candidate 2 contributed the module inventory, npm artifact input fields, the ambiguous-binary rule,
and focused boundary tests.

Reject Candidate 2's session-wide capability, multi-repository write token, public
acquire/read/resolve/apply protocol, and sandbox registry installation. Those choices leave the
reviewed authorization and artifact bugs in place.

## Tradeoffs accepted

- We accept a new singleton Durable Object in exchange for deterministic publication order.
- We accept object storage and an artifact build step in exchange for a runnable dependency closure
  that the sandbox can verify offline.
- We accept one token per repository and permission set in exchange for correct mixed-permission
  sessions.
- We keep credentials outside immutable releases so rotation works without rebuilding runtime state.

## Acceptance gates

- A session with repository A at `write` and repository B at `read` can push only A. Neither
  credential can access an unadmitted sibling repository.
- Unverified email, wrong-provider login, and display email grant no bootstrap role.
- A delayed reconciliation cannot replace a newer release or change MCP credentials. Reactivating an
  old release reuses existing rows.
- A private-registry MCP launches from a verified stored bundle with registry network access
  disabled. Byte and extraction-path mismatches fail closed.
- Importing one selected `openai/skills` subdirectory stores the resolved commit and digest without
  mirroring the repository.
- The user verifier starts disposable services, drives a real signed-in browser path, and retains
  trace artifacts on failure.
