"""The CI mirror: a pull request's head judged against its base the way the push gate judges a
pushed commit against the session's base_sha. Each golden case runs the CLI as CI does and the
sandbox's pre-push stage on the same commits, and requires the same verdict from both.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from sandbox_runtime.security_pipeline import CheckTarget
from sandbox_runtime.stack_policy_cli import load_policy_export
from tests.stack_fixtures import (
    GIT_ENVIRONMENT,
    add_submodule,
    commit,
    git,
    init_repo,
    npm,
    package_json,
    policy_payload,
    rule,
    seed_rules,
    severities,
    stage,
)

if TYPE_CHECKING:
    from collections.abc import Callable

REACT = package_json(react="^18.3.0")
SVELTE = package_json(svelte="^5")
EXPORT_FIXTURE = Path(__file__).with_name("fixtures") / "stack-policy-export.json"
PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def export_document(rules: list[dict[str, Any]] | None, repo: str | None = "acme/web") -> str:
    owner, _, name = (repo or "").rpartition("/")
    return json.dumps(
        {
            "schemaVersion": 1,
            "repository": {"repoOwner": owner, "repoName": name} if repo else None,
            "exportedAt": 1767225600000,
            "policy": policy_payload(rules) if rules is not None else None,
        }
    )


@dataclass
class Run:
    exit_code: int
    report: dict[str, Any]
    lines: list[str]


def run_cli(repo: Path, policy: str | Path, base: str, head: str, *extra: str) -> Run:
    """The CLI as the Action runs it: a separate process with the checkout as its cwd."""
    if isinstance(policy, str):
        policy_file = repo.parent / "policy.json"
        policy_file.write_text(policy)
    else:
        policy_file = policy
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "sandbox_runtime.stack_policy_cli",
            "check",
            "--policy",
            str(policy_file),
            "--base",
            base,
            "--head",
            head,
            *extra,
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        env={**GIT_ENVIRONMENT, "PYTHONPATH": str(PACKAGE_ROOT / "src")},
        check=False,
    )
    report = json.loads(completed.stdout) if completed.stdout else {}
    return Run(completed.returncode, report, completed.stderr.splitlines())


def report_severities(report: dict[str, Any]) -> dict[tuple[str, str], str]:
    return {(f["componentName"], f["path"]): f["severity"] for f in report["findings"]}


# ---- Golden cases --------------------------------------------------------------------------------


@dataclass(frozen=True)
class Golden:
    """``history`` builds a repository and returns the pull request's (base, head)."""

    id: str
    history: Callable[[Path], tuple[str, str]]
    expected: dict[tuple[str, str], str]
    exit_code: int
    rules: list[dict[str, Any]] | None = None
    line: str | None = None


def introduce(base_files: dict[str, str], head_files: dict[str, str]):
    def history(repo: Path) -> tuple[str, str]:
        base = init_repo(repo, base_files)
        git(repo, "checkout", "-q", "-b", "feature")
        return base, commit(repo, head_files, "pull request change")

    return history


def revive_an_old_commit(repo: Path) -> tuple[str, str]:
    old = init_repo(repo, {"web/package.json": REACT})
    base = commit(repo, {"web/package.json": SVELTE}, "drop react")
    git(repo, "checkout", "-q", "-b", "revive", old)
    return base, commit(repo, {"web/src/new.ts": "export {}\n"}, "pull request change")


def fork_before_base_gained_react(repo: Path) -> tuple[str, str]:
    fork_point = init_repo(repo, {"web/package.json": SVELTE})
    base = commit(repo, {"web/package.json": REACT}, "main adds react")
    git(repo, "checkout", "-q", "-b", "feature", fork_point)
    return base, commit(repo, {"web/package.json": REACT}, "pull request change")


def add_a_submodule(repo: Path) -> tuple[str, str]:
    base = init_repo(repo, {"package.json": SVELTE})
    git(repo, "checkout", "-q", "-b", "feature")
    add_submodule(repo, "ui")
    return base, commit(repo, {}, "pull request change")


def edit_beside_a_submodule(repo: Path) -> tuple[str, str]:
    init_repo(repo, {"package.json": SVELTE})
    add_submodule(repo, "ui")
    base = commit(repo, {}, "add submodule")
    git(repo, "checkout", "-q", "-b", "feature")
    return base, commit(repo, {"README.md": "edited\n"}, "pull request change")


def unrelated_history(repo: Path) -> tuple[str, str]:
    base = init_repo(repo, {"web/package.json": REACT})
    git(repo, "checkout", "-q", "--orphan", "rewrite")
    return base, commit(repo, {"web/package.json": REACT}, "pull request change")


GOLDEN = [
    Golden(
        "introduced-denial-blocks",
        introduce({"web/package.json": SVELTE}, {"web/package.json": REACT}),
        {("React", "web/package.json"): "violation"},
        1,
        line="error: web/package.json: React is not allowed for Web frontend.",
    ),
    Golden(
        "introduced-denial-in-an-advise-category-warns",
        introduce({"web/package.json": SVELTE}, {"web/package.json": REACT}),
        {("React", "web/package.json"): "advisory"},
        0,
        rules=seed_rules(frontend_blocks=False),
        line="warning: web/package.json: React is not allowed for Web frontend.",
    ),
    Golden(
        "a-workspace-under-a-build-directory-is-scanned",
        introduce(
            {"package.json": SVELTE},
            {
                "package.json": json.dumps(
                    {"workspaces": ["build/*"], "dependencies": {"svelte": "^5"}}
                ),
                "build/ui/package.json": REACT,
            },
        ),
        {("React", "build/ui/package.json"): "violation", ("Svelte", "package.json"): "standard"},
        1,
        line="error: build/ui/package.json: React",
    ),
    Golden(
        "a-file-dependency-under-dist-is-scanned",
        introduce(
            {"package.json": SVELTE},
            {
                "package.json": package_json(svelte="^5", ui="file:dist"),
                "dist/package.json": package_json(next="15"),
            },
        ),
        {("Next.js", "dist/package.json"): "violation", ("Svelte", "package.json"): "standard"},
        1,
        line="error: dist/package.json: Next.js",
    ),
    Golden(
        "pre-existing-denial-passes",
        introduce({"web/package.json": REACT}, {"web/src/fix.ts": "export {}\n"}),
        {("React", "web/package.json"): "legacy", ("TypeScript", "web/src/fix.ts"): "standard"},
        0,
    ),
    Golden(
        "legacy-elsewhere-does-not-license-a-new-manifest",
        introduce({"apps/legacy/package.json": REACT}, {"apps/new/package.json": REACT}),
        {
            ("React", "apps/legacy/package.json"): "legacy",
            ("React", "apps/new/package.json"): "violation",
        },
        1,
        line="error: apps/new/package.json: React is not allowed",
    ),
    Golden(
        "preference-deviation-in-a-new-project-is-advisory",
        introduce(
            {"README.md": "fixture\n"},
            {"tracker/package.json": SVELTE, "tracker/package-lock.json": "{}"},
        ),
        {
            ("npm", "tracker/package-lock.json"): "deviation",
            ("Svelte", "tracker/package.json"): "standard",
        },
        0,
        line="notice: tracker/package-lock.json: This new project uses npm; "
        "the organization prefers Bun for JavaScript toolchain.",
    ),
    Golden(
        "alternative-in-an-existing-project-is-silent",
        introduce({"web/package.json": SVELTE}, {"web/package-lock.json": "{}"}),
        {
            ("npm", "web/package-lock.json"): "alternative",
            ("Svelte", "web/package.json"): "standard",
        },
        0,
    ),
    Golden(
        "derived-requirements-beside-uv-lock-are-ignored",
        introduce(
            {"README.md": "fixture\n"},
            {"svc/uv.lock": "version = 1\n", "svc/requirements.txt": "httpx==0.28.1\n"},
        ),
        {("uv", "svc/uv.lock"): "standard"},
        0,
    ),
    Golden(
        "new-unreadable-manifest-blocks-under-a-blocking-rule",
        introduce({"README.md": "fixture\n"}, {"web/package.json": "{ broken"}),
        {},
        1,
        line="error: Could not check the stack policy: `web/package.json` could not be read.",
    ),
    Golden(
        "new-unreadable-manifest-warns-without-a-blocking-rule",
        introduce({"README.md": "fixture\n"}, {"web/package.json": "{ broken"}),
        {},
        0,
        rules=seed_rules(frontend_blocks=False),
        line="warning: Could not check the stack policy: `web/package.json` could not be read.",
    ),
    *(
        Golden(
            f"new-{name}-is-a-gap-that-blocks-under-a-blocking-rule",
            introduce({"README.md": "fixture\n"}, {f"web/{name}": content}),
            {},
            1,
            line=f"error: Could not check the stack policy: `web/{name}` could not be read.",
        )
        for name, content in (
            ("package.yaml", "dependencies:\n  react: ^18\n"),
            ("package.json5", "{dependencies: {react: '^18'}}\n"),
        )
    ),
    Golden(
        "react-in-a-deno-import-map-blocks",
        introduce(
            {"README.md": "fixture\n"},
            {"web/deno.json": json.dumps({"imports": {"react": "npm:react@^18"}})},
        ),
        {("React", "web/deno.json"): "violation"},
        1,
        line="error: web/deno.json: React is not allowed for Web frontend.",
    ),
    Golden(
        "a-package-json-with-a-byte-order-mark-is-read",
        introduce({"web/package.json": SVELTE}, {"web/package.json": "﻿" + REACT}),
        {("React", "web/package.json"): "violation"},
        1,
        line="error: web/package.json: React is not allowed for Web frontend.",
    ),
    Golden(
        "unreadable-manifest-at-base-passes",
        introduce({"templates/package.json": "{{ name }}"}, {"README.md": "edited\n"}),
        {},
        0,
    ),
    Golden(
        "new-submodule-blocks-under-a-blocking-rule",
        add_a_submodule,
        {("Svelte", "package.json"): "standard"},
        1,
        line="error: Could not check the stack policy: `ui` is a git submodule",
    ),
    Golden(
        "submodule-at-base-passes",
        edit_beside_a_submodule,
        {("Svelte", "package.json"): "standard"},
        0,
    ),
    Golden(
        "reviving-a-commit-that-had-react-introduces-it",
        revive_an_old_commit,
        {("React", "web/package.json"): "violation", ("TypeScript", "web/src/new.ts"): "standard"},
        1,
        line="error: web/package.json: React",
    ),
    Golden(
        "react-main-gained-after-the-fork-is-not-pre-existing",
        fork_before_base_gained_react,
        {("React", "web/package.json"): "violation"},
        1,
        line="error: web/package.json: React",
    ),
    Golden(
        "unrelated-history-has-nothing-pre-existing",
        unrelated_history,
        {("React", "web/package.json"): "violation"},
        1,
        line="error: web/package.json: React",
    ),
]

UNIDENTIFIED_GAP = (
    "Could not check the stack policy: `web/package.json` installs `ui` from a URL, git or "
    "tarball source"
)
UNIDENTIFIED_SPECS = [
    "https://registry.npmjs.org/react/-/react-dom-18.3.1.tgz",
    "https://cdn.example.test/react-18.3.1.tgz",
    "http://cdn.example.test/react.tgz",
    "git+https://github.com/facebook/react.git",
    "git+ssh://git@github.com/facebook/react.git",
    "git://github.com/facebook/react.git",
    "git@github.com:facebook/react.git",
    "github:facebook/react#v18.3.1",
    "gitlab:acme/react",
    "bitbucket:acme/react",
    "facebook/react",
    "file:vendor/react-18.3.1.tgz",
    "./vendor/react-18.3.1.tgz",
    "react-18.3.1.TGZ",
    "vendor/react-18.3.1.tar.gz",
]
GOLDEN += [
    *(
        Golden(
            f"unidentified-spec-blocks-under-a-blocking-rule: {spec}",
            introduce({"web/package.json": SVELTE}, {"web/package.json": package_json(ui=spec)}),
            {},
            1,
            line=f"error: {UNIDENTIFIED_GAP}",
        )
        for spec in UNIDENTIFIED_SPECS
    ),
    Golden(
        "unidentified-spec-warns-without-a-blocking-rule",
        introduce(
            {"web/package.json": SVELTE},
            {"web/package.json": package_json(ui="github:facebook/react")},
        ),
        {},
        0,
        rules=seed_rules(frontend_blocks=False),
        line=f"warning: {UNIDENTIFIED_GAP}",
    ),
    Golden(
        "unidentified-spec-at-base-passes",
        introduce(
            {"web/package.json": package_json(ui="github:acme/ui")}, {"README.md": "edited\n"}
        ),
        {},
        0,
    ),
    Golden(
        "unidentified-spec-at-base-does-not-license-another",
        introduce(
            {"web/package.json": package_json(ui="github:acme/ui")},
            {"web/package.json": package_json(ui="github:facebook/react")},
        ),
        {},
        1,
        line=f"error: {UNIDENTIFIED_GAP}",
    ),
    *(
        Golden(
            f"registry-tarball-url-names-the-package: {spec}",
            introduce({"web/package.json": SVELTE}, {"web/package.json": package_json(ui=spec)}),
            {("React", "web/package.json"): "violation"},
            1,
            line="error: web/package.json: React is not allowed for Web frontend.",
        )
        for spec in (
            "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
            "https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz",
        )
    ),
    Golden(
        "file-directory-dependency-is-scanned-like-a-workspace",
        introduce(
            {"web/package.json": SVELTE},
            {
                "web/package.json": package_json(ui="file:packages/ui"),
                "web/packages/ui/package.json": REACT,
            },
        ),
        {("React", "web/packages/ui/package.json"): "violation"},
        1,
        line="error: web/packages/ui/package.json: React",
    ),
    *(
        Golden(
            f"registry-and-local-specs-are-identified: {spec}",
            introduce({"web/package.json": SVELTE}, {"web/package.json": package_json(ui=spec)}),
            {},
            0,
        )
        for spec in ("^1.2.0 || >=2", "latest", "workspace:*", "link:../ui", "file:../ui")
    ),
]


@pytest.mark.parametrize("case", GOLDEN, ids=lambda case: case.id)
async def test_the_ci_verdict_matches_the_sandbox_push_gate(tmp_path, case):
    repo = tmp_path / "repo"
    base, head = case.history(repo)

    ci = run_cli(repo, export_document(case.rules or seed_rules()), base, head)
    sandbox = await stage(case.rules).check(
        CheckTarget(repo, "acme", "web", base_sha=base, revision=head)
    )

    assert report_severities(ci.report) == severities(sandbox) == case.expected
    assert ci.exit_code == (1 if sandbox.blocking else 0) == case.exit_code
    assert ci.report["blocking"] is sandbox.blocking
    assert ci.report["gaps"] == list(sandbox.new_gaps)
    assert (ci.report["base"], ci.report["head"]) == (base, head)
    if case.line is not None:
        assert any(line.startswith(case.line) for line in ci.lines), ci.lines
    else:
        assert ci.lines == []


# ---- The exported policy -------------------------------------------------------------------------


def test_the_control_plane_export_parses_with_its_repository():
    policy, repo = load_policy_export(EXPORT_FIXTURE.read_text())

    assert repo == "acme/web"
    assert policy is not None
    assert {(r.component_name, r.verdict, r.blocking) for r in policy.rules} >= {
        ("React", "forbid", True),
        ("Next.js", "forbid", True),
        ("Svelte", "prefer", False),
        ("Bun", "prefer", False),
    }


def test_the_exported_default_policy_blocks_next_js_a_pull_request_adds(tmp_path):
    repo = tmp_path / "repo"
    base, head = introduce(
        {"legacy/package.json": REACT}, {"apps/new/package.json": package_json(next="^15")}
    )(repo)

    run = run_cli(repo, EXPORT_FIXTURE, base, head)

    assert run.exit_code == 1
    assert report_severities(run.report) == {
        ("React", "legacy/package.json"): "legacy",
        ("Next.js", "apps/new/package.json"): "violation",
    }
    assert any(line.startswith("error: apps/new/package.json: Next.js") for line in run.lines)


def test_a_rule_scoped_to_the_exported_repository_applies_and_repo_overrides_it(tmp_path):
    repo = tmp_path / "repo"
    base, head = introduce(
        {"README.md": "fixture\n"}, {"web/package.json": package_json(vue="^3")}
    )(repo)
    rules = [
        *seed_rules(),
        rule(
            "Vue",
            "web-frontend",
            "forbid",
            npm("vue"),
            blocking=True,
            repo_scopes=["group/sub/portal"],
        ),
    ]
    document = export_document(rules, repo="group/sub/portal")

    scoped = run_cli(repo, document, base, head)
    elsewhere = run_cli(repo, document, base, head, "--repo", "acme/web")

    assert scoped.exit_code == 1
    assert scoped.report["repository"] == "group/sub/portal"
    assert elsewhere.exit_code == 0
    assert report_severities(elsewhere.report) == {}


def test_an_export_without_a_policy_passes_with_a_notice(tmp_path):
    repo = tmp_path / "repo"
    base, head = introduce({"README.md": "fixture\n"}, {"web/package.json": REACT})(repo)

    run = run_cli(repo, export_document(None), base, head)

    assert run.exit_code == 0
    assert run.report["findings"] == []
    assert run.lines == ["notice: No stack policy applies; nothing to check."]


# ---- Inputs it refuses ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("policy", "revision", "extra", "message"),
    [
        ("{", "HEAD", (), "not JSON"),
        (json.dumps({"schemaVersion": 2, "policy": None}), "HEAD", (), "not a supported"),
        (
            json.dumps({"schemaVersion": 1, "policy": {**policy_payload(), "schemaVersion": 9}}),
            "HEAD",
            (),
            "policy is invalid",
        ),
        (None, "missing", (), "git rev-parse failed"),
        (None, "HEAD", ("--repo", "web"), "--repo must be owner/name"),
    ],
)
def test_unusable_inputs_exit_2_without_a_verdict(tmp_path, policy, revision, extra, message):
    repo = tmp_path / "repo"
    base = init_repo(repo)

    run = run_cli(repo, policy or export_document(seed_rules()), base, revision, *extra)

    assert run.exit_code == 2
    assert run.report == {}
    assert message in run.lines[-1]


def test_a_clone_too_shallow_to_find_the_fork_is_refused(tmp_path):
    origin = tmp_path / "origin"
    init_repo(origin, {"web/package.json": REACT})
    commit(origin, {"README.md": "one\n"}, "main moves on")
    base = commit(origin, {"README.md": "two\n"}, "main moves again")
    git(origin, "checkout", "-q", "-b", "feature", "HEAD~2")
    head = commit(origin, {"web/src/a.ts": "export {}\n"}, "pull request change")
    clone = tmp_path / "clone"
    git(
        tmp_path,
        "clone",
        "-q",
        "--depth",
        "1",
        "--no-single-branch",
        f"file://{origin}",
        str(clone),
    )

    run = run_cli(clone, export_document(seed_rules()), base, head)

    assert run.exit_code == 2
    assert "fetch-depth: 0" in run.lines[-1]


def test_it_judges_the_whole_repository_from_a_subdirectory(tmp_path):
    repo = tmp_path / "repo"
    base, head = introduce({"web/package.json": REACT}, {"web/src/fix.ts": "export {}\n"})(repo)

    run = run_cli(repo / "web", export_document(seed_rules()), base, head)

    assert run.exit_code == 0
    assert report_severities(run.report) == {
        ("React", "web/package.json"): "legacy",
        ("TypeScript", "web/src/fix.ts"): "standard",
    }


# ---- GitHub annotations --------------------------------------------------------------------------


def test_github_annotations_point_at_the_file_and_cannot_be_forged_by_a_path(tmp_path):
    repo = tmp_path / "repo"
    evil = "x\n::error file=README.md::forged,y/package.json"
    base, head = introduce({"README.md": "fixture\n"}, {evil: REACT})(repo)

    run = run_cli(repo, export_document(seed_rules()), base, head, "--format", "github")

    assert run.exit_code == 1
    assert run.lines == [
        "::error file=x%0A%3A%3Aerror file=README.md%3A%3Aforged%2Cy/package.json,title=Stack "
        "policy::React is not allowed for Web frontend. React is not supported on the platform. "
        "Preferred: Svelte."
    ]
