"""Stack policy: parsing, matching, and the introduced-versus-pre-existing judgment.

Every judgment test runs against a real git repository. Per turn the stage reads the worktree;
pre-push it reads the pushed commit. The baseline is the session's base_sha intersected with the
subject's merge-base with it: only denials the session introduced may block.
"""

import copy
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.runtime_config import RuntimeConfig
from sandbox_runtime.security_pipeline import (
    MAX_REMEDIATION_PROMPT_BYTES,
    CheckTarget,
    SecurityPipelineRunner,
)
from sandbox_runtime.stack_facts import DirectorySource, collect_tree_facts
from sandbox_runtime.stack_policy import (
    StackConformanceStage,
    StackPolicyConfigError,
    parse_stack_policy,
)
from tests.stack_fixtures import (
    add_submodule,
    commit,
    file,
    git,
    init_repo,
    npm,
    package_json,
    policy_payload,
    rule,
    seed_rules,
    severities,
    source,
    stack_policy,
    stage,
    write,
)

MODES = ["per_turn", "pre_push"]
REACT = package_json(react="^18.3.0")


async def judge(checker: StackConformanceStage, repo: Path, base: str, mode: str, files: dict):
    """Apply the agent's change, then check it the way the bridge (per turn) or the push gate
    (pre-push) would."""
    write(repo, files)
    if mode == "pre_push":
        commit(repo, {}, "agent change")
    target = CheckTarget(
        repo, "acme", "web", base_sha=base, revision="HEAD" if mode == "pre_push" else None
    )
    return await checker.check(target)


# ---- Parsing -------------------------------------------------------------------------------------


def test_no_policy_key_means_no_policy():
    assert parse_stack_policy({"security_pipelines": []}) is None


def test_the_supervisor_frozen_config_parses_like_plain_json():
    config = RuntimeConfig.from_env(
        {"SESSION_CONFIG": json.dumps({"stack_policy": policy_payload()})}
    )

    policy = parse_stack_policy(config.session_config)

    assert policy is not None
    assert [rule.component_name for rule in policy.rules][:2] == ["Svelte", "React"]
    assert policy.max_remediation_attempts == 2


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(schemaVersion=2),
        lambda p: p.update(maxRemediationAttempts=6),
        lambda p: p.update(instructions=" "),
        lambda p: p["rules"][0].update(blocking=True),
        lambda p: p["rules"][0].update(verdict="require"),
        lambda p: p["rules"][0].update(signals=[]),
        lambda p: p["rules"][0].update(repoScopes=[]),
        lambda p: p["rules"][0].update(signals=[npm("React")]),
        lambda p: p["rules"][0].update(
            signals=[{"kind": "package", "ecosystem": "cargo", "name": "x"}]
        ),
        lambda p: p["rules"][0].update(signals=[file("apps/bun.lock")]),
        lambda p: p["rules"][0].update(signals=[file("**")]),
        lambda p: p["rules"][0].update(signals=[source("ts")]),
        lambda p: p["rules"][0].update(signals=[{"kind": "manifest", "value": "hyperdrive"}]),
    ],
)
def test_a_malformed_policy_is_refused(mutate):
    payload = copy.deepcopy(policy_payload())
    mutate(payload)

    with pytest.raises(StackPolicyConfigError):
        parse_stack_policy({"stack_policy": payload})


def test_the_stage_refuses_a_session_config_that_is_not_json():
    with pytest.raises(StackPolicyConfigError):
        StackConformanceStage.from_session_config("{", MagicMock())


# ---- Matching ------------------------------------------------------------------------------------


async def hit_names(rules, files, tmp_path, repo="acme/web"):
    write(tmp_path, files)
    facts = await collect_tree_facts(DirectorySource(tmp_path))
    return {(h.rule.component_name, str(h.path)) for h in stack_policy(rules).hits(facts, repo)}


async def test_an_exact_signal_beats_a_glob(tmp_path):
    rules = [
        rule("Acme UI", "web-frontend", "allow", npm("@acme/ui")),
        rule("Acme scope", "web-frontend", "forbid", npm("@acme/*")),
    ]
    files = {"package.json": json.dumps({"dependencies": {"@acme/ui": "1", "@acme/charts": "1"}})}

    assert await hit_names(rules, files, tmp_path) == {
        ("Acme UI", "package.json"),
        ("Acme scope", "package.json"),
    }
    hits = stack_policy(rules).hits(await collect_tree_facts(DirectorySource(tmp_path)), None)
    assert {(h.subject, h.rule.component_name) for h in hits} == {
        ("@acme/ui", "Acme UI"),
        ("@acme/charts", "Acme scope"),
    }


async def test_among_globs_the_smallest_signal_key_wins(tmp_path):
    rules = [
        rule("pip", "python-tooling", "allow", file("requirements*.txt")),
        rule("Requirements", "python-tooling", "forbid", file("req*.txt")),
    ]

    assert await hit_names(rules, {"requirements.txt": ""}, tmp_path) == {
        ("Requirements", "requirements.txt")
    }


async def test_rules_scoped_to_other_repositories_are_invisible(tmp_path):
    rules = [rule("React", "web-frontend", "forbid", npm("react"), repo_scopes=["acme/legacy"])]

    assert await hit_names(rules, {"package.json": REACT}, tmp_path, "acme/web") == set()
    assert await hit_names(rules, {}, tmp_path, "ACME/Legacy") == {("React", "package.json")}


async def test_svelte_sources_and_data_store_manifests_hit_their_rules(tmp_path):
    rules = [
        rule("Svelte", "web-frontend", "prefer", source(".svelte")),
        rule("D1", "app-data-store", "prefer", {"kind": "manifest", "value": "d1"}),
    ]
    files = {
        "src/App.svelte": "",
        "openinspect.app.json": json.dumps({"data": {"DB": {"kind": "d1"}}}),
    }

    assert await hit_names(rules, files, tmp_path) == {
        ("Svelte", "src/App.svelte"),
        ("D1", "openinspect.app.json"),
    }


# ---- Judgment: introduced versus pre-existing ----------------------------------------------------


@pytest.mark.parametrize("mode", MODES)
async def test_react_introduced_in_a_blocking_category_is_a_violation(tmp_path, mode):
    base = init_repo(tmp_path, {"web/package.json": package_json(svelte="^5")})

    result = await judge(stage(), tmp_path, base, mode, {"web/package.json": REACT})

    assert severities(result)[("React", "web/package.json")] == "violation"
    assert result.blocking
    assert not result.passed


@pytest.mark.parametrize("mode", MODES)
async def test_react_introduced_in_an_advise_category_prompts_but_never_blocks(tmp_path, mode):
    base = init_repo(tmp_path, {"web/package.json": package_json(svelte="^5")})
    checker = stage(seed_rules(frontend_blocks=False))

    result = await judge(checker, tmp_path, base, mode, {"web/package.json": REACT})

    assert severities(result)[("React", "web/package.json")] == "advisory"
    assert not result.blocking
    assert not result.passed


@pytest.mark.parametrize("mode", MODES)
async def test_react_present_at_the_base_commit_is_legacy_and_passes(tmp_path, mode):
    base = init_repo(tmp_path, {"web/package.json": REACT})

    result = await judge(stage(), tmp_path, base, mode, {"web/src/fix.ts": "export {}\n"})

    assert severities(result)[("React", "web/package.json")] == "legacy"
    assert result.passed
    assert not result.blocking


@pytest.mark.parametrize("mode", MODES)
async def test_legacy_react_elsewhere_does_not_license_a_new_manifest(tmp_path, mode):
    base = init_repo(tmp_path, {"apps/legacy/package.json": REACT})

    result = await judge(stage(), tmp_path, base, mode, {"apps/new/package.json": REACT})

    assert severities(result) == {
        ("React", "apps/legacy/package.json"): "legacy",
        ("React", "apps/new/package.json"): "violation",
    }
    assert result.blocking


@pytest.mark.parametrize("mode", MODES)
async def test_npm_lockfile_in_a_new_project_is_a_deviation_nudged_once(tmp_path, mode):
    base = init_repo(tmp_path)
    checker = stage()

    result = await judge(
        checker,
        tmp_path,
        base,
        mode,
        {"tracker/package.json": package_json(svelte="^5"), "tracker/package-lock.json": "{}"},
    )

    assert severities(result)[("npm", "tracker/package-lock.json")] == "deviation"
    assert result.passed
    assert not result.blocking
    nudge = checker.pending_nudge([result])
    assert nudge is not None
    assert "You introduced `tracker/package-lock.json`" in nudge.text
    assert "prefers Bun for JavaScript toolchain" in nudge.text
    assert "Unless the user explicitly asked for npm" in nudge.text
    assert "bun install; commit bun.lock" in nudge.text
    checker.acknowledge(nudge)
    next_turn = await checker.check(CheckTarget(tmp_path, "acme", "web", base_sha=base))
    assert checker.pending_nudge([next_turn]) is None


@pytest.mark.parametrize("mode", MODES)
async def test_npm_lockfile_in_an_existing_project_is_a_silent_alternative(tmp_path, mode):
    base = init_repo(tmp_path, {"web/package.json": package_json(svelte="^5")})
    checker = stage()

    result = await judge(checker, tmp_path, base, mode, {"web/package-lock.json": "{}"})

    assert severities(result)[("npm", "web/package-lock.json")] == "alternative"
    assert result.passed
    assert checker.pending_nudge([result]) is None


@pytest.mark.parametrize("mode", MODES)
async def test_preferred_toolchains_are_standard(tmp_path, mode):
    base = init_repo(tmp_path)

    result = await judge(
        stage(), tmp_path, base, mode, {"web/bun.lock": "{}", "svc/uv.lock": "version = 1\n"}
    )

    assert severities(result) == {
        ("Bun", "web/bun.lock"): "standard",
        ("uv", "svc/uv.lock"): "standard",
    }
    assert stage().pending_nudge([result]) is None


@pytest.mark.parametrize("mode", MODES)
async def test_requirements_exported_beside_uv_lock_is_derived_and_ignored(tmp_path, mode):
    base = init_repo(tmp_path)

    result = await judge(
        stage(),
        tmp_path,
        base,
        mode,
        {"svc/uv.lock": "version = 1\n", "svc/requirements.txt": "httpx==0.28.1\n"},
    )

    assert severities(result) == {("uv", "svc/uv.lock"): "standard"}


@pytest.mark.parametrize("mode", MODES)
async def test_a_new_unreadable_manifest_blocks_only_when_a_blocking_rule_applies(tmp_path, mode):
    base = init_repo(tmp_path)

    blocked = await judge(stage(), tmp_path, base, mode, {"web/package.json": "{ broken"})
    advised = await stage(seed_rules(frontend_blocks=False)).check(
        CheckTarget(
            tmp_path, "acme", "web", base_sha=base, revision="HEAD" if mode == "pre_push" else None
        )
    )

    assert blocked.blocking
    assert "`web/package.json` could not be read" in blocked.remediation_section()
    assert advised.passed
    assert not advised.blocking


@pytest.mark.parametrize("mode", MODES)
async def test_a_dependency_installed_from_git_tells_the_agent_to_use_the_registry(tmp_path, mode):
    base = init_repo(tmp_path, {"web/package.json": package_json(svelte="^5")})

    result = await judge(
        stage(),
        tmp_path,
        base,
        mode,
        {"web/package.json": package_json(ui="github:facebook/react")},
    )

    assert result.blocking
    remediation = result.remediation_section()
    assert "`web/package.json` installs `ui` from a URL, git or tarball source" in remediation
    assert "registry name" in remediation


@pytest.mark.parametrize("mode", MODES)
async def test_an_unreadable_manifest_that_predates_the_session_never_blocks(tmp_path, mode):
    base = init_repo(tmp_path, {"templates/package.json": "{{ name }}"})

    result = await judge(stage(), tmp_path, base, mode, {"README.md": "edited\n"})

    assert result.passed
    assert not result.blocking


@pytest.mark.parametrize("mode", MODES)
async def test_a_new_submodule_blocks_only_when_a_blocking_rule_applies(tmp_path, mode):
    repo = tmp_path / "repo"
    base = init_repo(repo, {"package.json": package_json(svelte="^5")})
    add_submodule(repo, "ui")

    blocked = await judge(stage(), repo, base, mode, {})
    advised = await stage(seed_rules(frontend_blocks=False)).check(
        CheckTarget(
            repo, "acme", "web", base_sha=base, revision="HEAD" if mode == "pre_push" else None
        )
    )

    assert blocked.blocking
    assert "`ui` is a git submodule" in blocked.remediation_section()
    assert advised.passed
    assert not advised.blocking


@pytest.mark.parametrize("mode", MODES)
async def test_a_submodule_that_predates_the_session_never_blocks(tmp_path, mode):
    repo = tmp_path / "repo"
    init_repo(repo)
    add_submodule(repo, "vendor/ui")
    base = commit(repo, {}, "add submodule")

    result = await judge(stage(), repo, base, mode, {"README.md": "edited\n"})

    assert result.passed
    assert not result.blocking


# ---- Judgment: the merge-base ---------------------------------------------------------------------


@pytest.mark.parametrize("mode", MODES)
async def test_returning_to_a_commit_that_still_had_react_counts_as_introducing_it(tmp_path, mode):
    old = init_repo(tmp_path, {"web/package.json": REACT})
    base = commit(tmp_path, {"web/package.json": package_json(svelte="^5")}, "drop react")
    git(tmp_path, "checkout", "-q", "-b", "revive", old)

    result = await judge(stage(), tmp_path, base, mode, {"web/src/new.ts": "export {}\n"})

    assert severities(result)[("React", "web/package.json")] == "violation"
    assert result.blocking


@pytest.mark.parametrize("mode", MODES)
async def test_react_the_base_gained_after_the_fork_point_is_not_pre_existing_on_the_fork(
    tmp_path, mode
):
    fork_point = init_repo(tmp_path, {"web/package.json": package_json(svelte="^5")})
    base = commit(tmp_path, {"web/package.json": REACT}, "upstream adds react")
    git(tmp_path, "checkout", "-q", "-b", "agent", fork_point)

    result = await judge(stage(), tmp_path, base, mode, {"web/package.json": REACT})

    assert severities(result)[("React", "web/package.json")] == "violation"


@pytest.mark.parametrize("mode", MODES)
async def test_work_on_top_of_the_base_keeps_its_legacy(tmp_path, mode):
    base = init_repo(tmp_path, {"web/package.json": REACT})
    commit(tmp_path, {"web/src/a.ts": "export {}\n"}, "session commit one")
    git(tmp_path, "checkout", "-q", "-b", "feature")
    commit(tmp_path, {"web/src/b.ts": "export {}\n"}, "session commit two")

    result = await judge(stage(), tmp_path, base, mode, {"web/src/c.ts": "export {}\n"})

    assert severities(result)[("React", "web/package.json")] == "legacy"
    assert result.passed


@pytest.mark.parametrize("mode", MODES)
async def test_unrelated_history_has_no_pre_existing_denials(tmp_path, mode):
    base = init_repo(tmp_path, {"web/package.json": REACT})
    git(tmp_path, "checkout", "-q", "--orphan", "rewrite")

    result = await judge(stage(), tmp_path, base, mode, {"web/package.json": REACT})

    assert severities(result)[("React", "web/package.json")] == "violation"


async def test_without_a_base_sha_the_first_head_seen_is_the_baseline(tmp_path):
    init_repo(tmp_path, {"web/package.json": REACT})
    checker = stage()
    target = CheckTarget(tmp_path, "acme", "web")

    first = await checker.check(target)
    write(tmp_path, {"apps/new/package.json": REACT})
    commit(tmp_path, {}, "agent adds react")
    second = await checker.check(target)

    assert first.passed
    assert severities(second) == {
        ("React", "web/package.json"): "legacy",
        ("React", "apps/new/package.json"): "violation",
    }
    checker.log.warn.assert_any_call(
        "stack_policy.baseline_fallback",
        repo="acme/web",
        commit_sha=git(tmp_path, "rev-parse", "HEAD~1"),
    )


async def test_an_unreadable_baseline_fails_closed(tmp_path):
    init_repo(tmp_path, {"web/package.json": REACT})

    result = await stage().check(CheckTarget(tmp_path, "acme", "web", base_sha="f" * 40))

    assert severities(result)[("React", "web/package.json")] == "violation"
    assert result.blocking


async def test_a_scratch_workspace_has_nothing_pre_existing(tmp_path):
    write(
        tmp_path,
        {
            "tracker/package.json": REACT,
            ".opencode/package.json": package_json(),
            ".opencode/tool/x.js": "",
        },
    )

    result = await stage().check(CheckTarget(tmp_path))

    assert severities(result) == {("React", "tracker/package.json"): "violation"}


async def test_a_push_of_an_unresolvable_revision_blocks(tmp_path):
    base = init_repo(tmp_path)

    result = await stage().check(CheckTarget(tmp_path, "acme", "web", base, revision="missing"))

    assert result.blocking
    assert "could not be scanned" in result.summary()


# ---- What the agent and the member read ----------------------------------------------------------


async def test_remediation_names_the_path_the_replacement_and_guidance(tmp_path):
    base = init_repo(tmp_path)

    result = await judge(stage(), tmp_path, base, "per_turn", {"portal/package.json": REACT})
    section = result.remediation_section()

    assert "`react` was added to `portal/package.json` (runtime dependency)." in section
    assert "React is not allowed for Web frontend in this organization." in section
    assert "React is not supported on the platform." in section
    assert "Use instead: Svelte. Use SvelteKit." in section
    assert "Remove React and any code that relies on it, then build with Svelte." in section
    assert result.summary() == (
        "This change uses technology your organization does not allow, and it is still there "
        "after the agent tried to remove it: React (Web frontend)."
    )


async def test_the_remediation_prompt_stays_within_its_bound(tmp_path):
    rules = [
        rule(
            f"Denied{i}",
            "web-frontend",
            "forbid",
            npm(f"denied-{i}"),
            blocking=True,
            guidance="g" * 16_000,
        )
        for i in range(6)
    ]
    rules.append(rule("Svelte", "web-frontend", "prefer", npm("svelte"), guidance="s" * 16_000))
    base = init_repo(tmp_path)
    write(tmp_path, {"web/package.json": package_json(**{f"denied-{i}": "1" for i in range(6)})})
    runner = SecurityPipelineRunner((), tmp_path, MagicMock(), stack=stage(rules))

    report = await runner.run(CheckTarget(tmp_path, "acme", "web", base))
    prompt = report.remediation_prompt()

    assert len(prompt.encode()) <= MAX_REMEDIATION_PROMPT_BYTES
    assert prompt.startswith("Your change does not meet your organization's technology standards.")
    assert "`denied-0` was added to `web/package.json`" in prompt


async def test_a_stack_only_runner_has_checks_and_reports_a_stack_failure(tmp_path):
    base = init_repo(tmp_path)
    write(tmp_path, {"web/package.json": package_json(next="15")})
    runner = SecurityPipelineRunner((), tmp_path, MagicMock(), stack=stage(attempts=3))

    report = await runner.run(CheckTarget(tmp_path, "acme", "web", base))

    assert runner.has_checks
    assert runner.max_remediation_attempts == 3
    assert report.results == ()
    assert not report.passed
    assert report.turn_error() == (
        "stack_policy_failed",
        "This change uses technology your organization does not allow, and it is still there "
        "after the agent tried to remove it: Next.js (Web frontend).",
    )
    reason, message = report.push_rejection()
    assert reason == "stack_policy_failed"
    assert message.startswith("Push blocked by your organization's technology standards.")


def test_a_runner_without_pipelines_or_policy_has_no_checks(tmp_path):
    assert not SecurityPipelineRunner((), tmp_path, MagicMock()).has_checks
