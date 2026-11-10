# Govern the technology stack

The stack policy tells agents which technology the organization prefers, accepts, and denies. Each
sandbox receives the policy at launch. The agent reads it as standing instructions, and the sandbox
checks the agent's work after every turn and before every managed push. A required status check runs
the same checker on pull requests, so a raw `git push` from the sandbox meets the same verdict.

Members never see the policy. They see an agent that builds with the approved stack, and in rare
cases a plain-language error when the agent could not remove a denied technology. Developers and
security own the policy through Git or **Settings > AppSec**.

## How the policy decides

### Grades

Each technology is an approved component with a category, a stance, and signals.

- A **category** is one slot in the stack, such as `web-frontend` or `js-toolchain`. Its
  `enforcement` is `advise` or `block`. Enforcement applies to denied components only.
- A **stance** is `preferred`, `allowed`, or `denied`. A category has at most one preferred
  component, its standard.
- A **signal** is how the checker recognizes the component in a repository.

| Signal kind | Matches                                                    | Example                                          |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `package`   | A dependency declared in a manifest, by ecosystem and name | `{ kind: package, ecosystem: npm, name: react }` |
| `file`      | A file basename, glob allowed                              | `{ kind: file, pattern: requirements*.txt }`     |
| `source`    | Source files with an extension                             | `{ kind: source, extension: .ts }`               |
| `manifest`  | A data store declared in `openinspect.app.json`            | `{ kind: manifest, value: d1 }`                  |

Package signals read `package.json`, `pyproject.toml`, `requirements*.txt`, and `Pipfile`. For npm,
they also read the `npm:` specifiers in the `imports` and `scopes` of `deno.json` and `deno.jsonc`.
A package name ending in `/*` matches a whole npm scope. When a fact matches several signals, an
exact signal beats a glob.

The checker reads every manifest in the tree except under `node_modules` and `.git`. Manifests under
`build`, `dist`, and `.svelte-kit` count, because a workspace glob or a `file:` spec can install
them.

An npm dependency counts as the package it installs. `"ui": "npm:react@18"` counts as `react`, and
`"react": "npm:^18"` counts as `react`. npm and Yarn read a bare `npm:<word>` spec differently, so
`"ui": "npm:latest"` counts as both `ui` and `latest`. A `registry.npmjs.org` tarball URL counts as
the package it names.

A disabled component, a component without a category, and a component in the `development` lifecycle
are not part of the policy. Every other component contributes one rule:

| Stance      | Rule     | Effect on a new use                                                       |
| ----------- | -------- | ------------------------------------------------------------------------- |
| `preferred` | `prefer` | None. The instructions steer the agent toward it.                         |
| `allowed`   | `allow`  | None. A new project gets one nudge toward the category's standard.        |
| `denied`    | `forbid` | The agent must remove it. In a `block` category, it also blocks the push. |

The shipped defaults prefer TypeScript, Bun, uv, Svelte, and D1, and deny React and Next.js. The
`web-frontend` category blocks, so a new React dependency stops the push on day one.

### Only new uses count

The checker compares the change with the commit the work started from. A finding is pre-existing
when the same signal matched the same path at that commit. Pre-existing findings never prompt
remediation and never block. A repository that already uses React keeps working, and the agent can
fix bugs in it.

The key is the pair of signal and path. React in `apps/legacy/package.json` does not license React
in a new `apps/new/package.json`.

The baseline is the base commit intersected with the merge-base of the change and the base. A
finding is pre-existing only when both commits had it. React that the base branch gained after the
change forked is therefore new on the change. When the base cannot be read, or the histories are
unrelated, nothing counts as pre-existing.

Some content hides which packages a change adds. The checker reports each of these as a scan gap:

- A manifest that cannot be parsed or is over the size limit.
- A pnpm `package.yaml` or `package.json5`. The sandbox has no YAML or JSON5 parser, so declare
  dependencies in `package.json`.
- A `deno.json` or `deno.jsonc` that names a separate `importMap` file.
- A git submodule, staged or as an untracked nested repository. Its files belong to another
  repository and are never read.
- An npm dependency installed from a URL, a git repository, or a tarball, other than a
  `registry.npmjs.org` tarball.

A new scan gap blocks only when a blocking rule applies to the repository. A gap that was already at
the base never blocks.

### Nudges for new projects

When the agent creates a project with an allowed tool while its category has a standard, the agent
receives one advisory nudge. A new `tracker/package-lock.json` beside a new `tracker/package.json`
prompts the agent to switch to Bun unless the user asked for npm. The nudge never blocks, never
repeats in the session, and never appears to the member. The same lockfile in an existing project is
silent.

`requirements*.txt` beside `uv.lock` or `pylock.toml` is generated output of uv, and the checker
ignores it.

### What gets reported

The sandbox reports the facts it sees at the base commit and after each successful push. Holders of
`governance.read` see the result under `GET /stack-inventory` and `GET /stack-inventory/rollup`.
Those reports are inventory, not enforcement. The agent's session token could forge them.

## Author the policy

Holders of `governance.manage` edit the policy. Owner and Administrator hold it, as does the
catalogue editor role. Members and viewers hold neither `governance.read` nor `governance.manage`.

### In the web app

Open **Settings > AppSec**. Edit a category's enforcement, and set each component's category,
stance, and signals. A preferred or denied component needs a category and at least one signal.

To see the instructions a session would receive, call
`GET /stack-policy/preview?repo=<owner>/<name>`. The text matches what a new session receives byte
for byte.

### In Git

When Git governance is configured, `catalog.yaml` can own the whole technology catalogue. Declare
`categories` and `components` together. See
[Git-backed Skills and MCP governance](GIT_GOVERNANCE_CATALOG.md#technology-categories-and-components)
for the format.

Running sessions keep the policy they launched with. A new or restored sandbox receives the current
policy.

## Enforce the policy on raw pushes

An agent can bypass the managed push with lower-level Git commands in its sandbox. Branch protection
with a required status check closes that path. The check runs `sandbox_runtime.stack_policy_cli`,
which calls the same `StackConformanceStage` as the sandbox's pre-push gate. The verdicts are
identical by construction, and `tests/test_stack_policy_cli.py` in `packages/sandbox-runtime` proves
them case by case.

### 1. Export the policy

Call `GET /stack-policy/export?repo=<owner>/<name>` as a user that holds `governance.read`. The
response is the compiled policy with its digest:

```json
{
  "schemaVersion": 1,
  "repository": { "repoOwner": "acme", "repoName": "web" },
  "exportedAt": 1767225600000,
  "policy": { "schemaVersion": 1, "digest": "…", "rules": ["…"] }
}
```

With `repo`, the export includes rules scoped to that repository. Without it, the export holds only
unscoped rules. Export again after every policy change. The Action does not fetch the policy and
holds no Open-Inspect credential.

### 2. Store the export where the pull request cannot change it

If the pull request can edit the policy file, it can weaken the check. Choose one of these:

- Commit the export to a central repository that runs the check as a required workflow through an
  organization ruleset.
- Commit it to the checked repository under a path that `CODEOWNERS` assigns to security, and
  require code-owner review.

### 3. Add the workflow

The check needs the full history to find where the pull request forked. A shallow clone fails with
exit code `2` and a message that names `fetch-depth: 0`.

```yaml
name: Stack policy
on:
  pull_request:
permissions:
  contents: read
jobs:
  stack-policy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: <owner>/<open-inspect-repo>/.github/actions/stack-policy-check@<ref>
        with:
          policy-file: .github/stack-policy.json
```

The Action installs the checker with uv, runs it on the pull request's base and head commits, and
annotates each finding on its file. Pin `<ref>` to a commit of your Open-Inspect fork.

| Input         | Default                              | Meaning                                    |
| ------------- | ------------------------------------ | ------------------------------------------ |
| `policy-file` | none, required                       | The export, relative to the workspace      |
| `base`        | `github.event.pull_request.base.sha` | The commit the pull request merges into    |
| `head`        | `github.event.pull_request.head.sha` | The commit under review                    |
| `repository`  | `github.repository`                  | `owner/name` that selects repository rules |

The `report` output is the path of the JSON report.

### 4. Require the check

In the repository's branch protection rule or ruleset, require the `stack-policy` job to pass before
merge. Apply the rule to every branch that deploys.

### Limits of the check

- A pull request that edits `.github/workflows` can remove or weaken the check. Run the check as an
  organization required workflow, or require code-owner review for `.github/`. Do not give the
  sandbox's push credential the `workflows` permission.
- The check judges commits that reach a pull request. A direct push to a protected branch skips it,
  so keep direct pushes disabled.
- The export is a snapshot. A policy change takes effect in CI when you export again.
- The checker sees declared dependencies, files, source extensions, and data-store manifests. Code
  that vendors a framework without a manifest entry, or loads one from a CDN, does not match a
  package signal.

The checker does not catch these cases:

- A session without a repository scans its working directory and skips `build`, `dist`,
  `.svelte-kit`, and other build directories. Such a session has no push gate.
- A force-added `node_modules` directory that a `file:` spec installs from. The checker never reads
  manifests under `node_modules`.
- A `file:` spec whose path leaves the repository.
- `npm:` and URL imports written in source files, such as `import React from "npm:react"` or an
  `https://esm.sh/react` import. Only Deno config files are read for `npm:` specifiers.
- A change that moves an existing submodule to a new commit. Only a new submodule is a gap.

## Run the checker locally

From a checkout of the repository under review:

```bash
uv run --frozen --project <open-inspect>/packages/sandbox-runtime \
	python -m sandbox_runtime.stack_policy_cli check \
	--policy stack-policy.json --base origin/main --head HEAD
```

| Argument   | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `--policy` | Path of a `GET /stack-policy/export` document                                  |
| `--base`   | Any revision. The checker resolves it to a commit.                             |
| `--head`   | Any revision. The checker judges that commit's tree, never the worktree.       |
| `--repo`   | `owner/name` for repository-scoped rules. Defaults to the export's repository. |
| `--format` | `text` (default) or `github` for workflow annotations                          |

The checker writes the JSON report to stdout. It writes one line to stderr for each finding that
needs attention: an introduced denial, an advisory denial, a preference deviation, or a scan gap.

| Exit code | Meaning                                                                                 |
| --------- | --------------------------------------------------------------------------------------- |
| `0`       | No blocking finding. Advisories, deviations, and pre-existing denials pass.             |
| `1`       | A denial in a `block` category was introduced, or a new scan gap meets a blocking rule. |
| `2`       | Unusable input: a bad policy file, an unknown revision, or a clone that is too shallow. |

Each report finding carries `severity`, `origin`, the component and category, the `signal` key, the
`path`, and the `preferred` component of its category. `severity` is one of `violation`, `advisory`,
`legacy`, `standard`, `alternative`, or `deviation`.
