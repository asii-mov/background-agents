"""The sandbox's pre-push stack check, run in CI against a pull request.

``check`` judges ``--head`` against ``--base`` with the same :class:`StackConformanceStage` the
push gate uses for a pushed commit against the session's ``base_sha``. A raw ``git push`` that
never went through the sandbox therefore meets the same verdict in a required status check.

Prints a JSON report on stdout and one line per finding a reader must act on to stderr. Exit 0
passes (including advisories and preference deviations), 1 blocks, 2 is a usage error.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final, Literal

from .security_pipeline import CheckTarget
from .stack_facts import STACK_CONTRACT, TreeScanError, run_git
from .stack_policy import (
    StackConformanceStage,
    StackPolicy,
    StackPolicyConfigError,
    merge_base,
    parse_stack_policy,
    resolve_commit,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .stack_policy import StackConformanceResult, StackFinding

EXIT_PASSED: Final = 0
EXIT_BLOCKED: Final = 1
EXIT_USAGE: Final = 2
REPORT_SCHEMA_VERSION: Final = 1
MAX_POLICY_FILE_BYTES = 4 * 1024 * 1024

Level = Literal["error", "warning", "notice"]
OutputFormat = Literal["text", "github"]


class UsageError(ValueError):
    """The inputs cannot be judged: a bad policy file, repository or revision."""


def load_policy_export(text: str) -> tuple[StackPolicy | None, str | None]:
    """Parse a ``GET /stack-policy/export`` document into its policy and repository."""
    try:
        document = json.loads(text)
    except json.JSONDecodeError as error:
        raise UsageError(f"the policy file is not JSON: {error}") from error
    if (
        not isinstance(document, dict)
        or document.get("schemaVersion") != STACK_CONTRACT["exportSchemaVersion"]
    ):
        raise UsageError("the policy file is not a supported stack policy export")
    repository = document.get("repository")
    repo_full_name = None
    if repository is not None:
        owner = repository.get("repoOwner") if isinstance(repository, dict) else None
        name = repository.get("repoName") if isinstance(repository, dict) else None
        if not isinstance(owner, str) or not isinstance(name, str):
            raise UsageError("the policy file's repository must be {repoOwner, repoName}")
        repo_full_name = f"{owner}/{name}"
    try:
        policy = parse_stack_policy({"stack_policy": document.get("policy")})
    except StackPolicyConfigError as error:
        raise UsageError(f"the policy file's policy is invalid: {error}") from error
    return policy, repo_full_name


def split_repository(full_name: str) -> tuple[str, str]:
    """Owners may nest (``group/sub``); only the name is one segment."""
    owner, _, name = full_name.strip().rpartition("/")
    if not owner or not name or "" in owner.split("/"):
        raise UsageError(f"--repo must be owner/name, got {full_name!r}")
    return owner, name


class _StderrLog:
    """The stage's structured logger. Warnings explain a fail-closed baseline; info is noise."""

    def info(self, event: str, **fields: Any) -> None:
        pass

    def warn(self, event: str, **fields: Any) -> None:
        print(
            json.dumps({"level": "warning", "event": event, **fields}, default=str), file=sys.stderr
        )


async def _resolve(checkout: Path, base: str, head: str) -> tuple[Path, str, str]:
    """The checkout root and both commits, refusing a history too shallow to find the fork."""
    try:
        _, top = await run_git(checkout, "rev-parse", "--show-toplevel")
        root = Path(top.decode().strip())
        base_sha, head_sha = await resolve_commit(root, base), await resolve_commit(root, head)
        _, shallow = await run_git(root, "rev-parse", "--is-shallow-repository")
        if shallow.strip() == b"true" and await merge_base(root, head_sha, base_sha) is None:
            raise UsageError(
                "the clone is too shallow to find where --head forked from --base; "
                "fetch full history (actions/checkout with fetch-depth: 0)"
            )
    except TreeScanError as error:
        raise UsageError(str(error)) from error
    return root, base_sha, head_sha


async def check(
    policy: StackPolicy | None,
    checkout: Path,
    base: str,
    head: str,
    repo_full_name: str | None,
) -> tuple[StackConformanceResult | None, str, str]:
    owner, name = split_repository(repo_full_name) if repo_full_name else (None, None)
    root, base_sha, head_sha = await _resolve(checkout, base, head)
    if policy is None:
        return None, base_sha, head_sha
    target = CheckTarget(root, owner, name, base_sha=base_sha, revision=head_sha)
    return await StackConformanceStage(policy, _StderrLog()).check(target), base_sha, head_sha


def _finding_json(finding: StackFinding) -> dict[str, Any]:
    hit = finding.hit
    return {
        "severity": finding.severity,
        "origin": finding.origin.value,
        "componentId": hit.rule.component_id,
        "componentName": hit.rule.component_name,
        "categoryId": hit.rule.category_id,
        "categoryName": hit.rule.category_name,
        "signal": hit.signal.key,
        "path": str(hit.path),
        "subject": hit.subject,
        "scope": hit.scope,
        "preferred": finding.preferred.component_name if finding.preferred else None,
    }


def build_report(
    policy: StackPolicy | None,
    result: StackConformanceResult | None,
    repo_full_name: str | None,
    base_sha: str,
    head_sha: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "blocking": result is not None and result.blocking,
        "repository": repo_full_name,
        "base": base_sha,
        "head": head_sha,
        "policyDigest": policy.digest if policy else None,
        "findings": [_finding_json(f) for f in result.findings] if result else [],
        "gaps": list(result.new_gaps) if result else [],
    }


def _message(finding: StackFinding) -> tuple[Level, str] | None:
    """What a reviewer must act on. Pre-existing and accepted findings stay in the JSON only."""
    rule, preferred = finding.hit.rule, finding.preferred
    preference = f" Preferred: {preferred.component_name}." if preferred else ""
    guidance = f" {rule.guidance.strip()}" if rule.guidance.strip() else ""
    denied = f"{rule.component_name} is not allowed for {rule.category_name}.{guidance}{preference}"
    match finding.severity:
        case "violation":
            return "error", denied
        case "advisory":
            return "warning", f"{denied} This is advisory and does not block the merge."
        case "deviation":
            assert preferred is not None
            return "notice", (
                f"This new project uses {rule.component_name}; the organization prefers "
                f"{preferred.component_name} for {rule.category_name}."
            )
        case _:
            return None


def _escape_data(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_property(value: str) -> str:
    return _escape_data(value).replace(":", "%3A").replace(",", "%2C")


def _line(level: Level, path: str | None, message: str, output: OutputFormat) -> str:
    """Repository paths are attacker-controlled: escape them so no line starts a new command."""
    if output == "github":
        where = f" file={_escape_property(path)}," if path else " "
        return f"::{level}{where}title=Stack policy::{_escape_data(message)}"
    text = f"{path}: {message}" if path else message
    return f"{level}: " + text.replace("\r", "\\r").replace("\n", "\\n")


def render_lines(result: StackConformanceResult | None, output: OutputFormat) -> list[str]:
    if result is None:
        return [_line("notice", None, "No stack policy applies; nothing to check.", output)]
    lines = []
    for finding in result.findings:
        message = _message(finding)
        if message is not None:
            lines.append(_line(message[0], str(finding.hit.path), message[1], output))
    gap_level: Level = "error" if result.any_blocking_rule else "warning"
    lines.extend(
        _line(gap_level, None, f"Could not check the stack policy: {gap}.", output)
        for gap in result.new_gaps
    )
    return lines


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m sandbox_runtime.stack_policy_cli")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("check", help="judge --head against --base")
    command.add_argument("--policy", required=True, type=Path, help="stack policy export JSON")
    command.add_argument("--base", required=True, help="the pull request's base commit")
    command.add_argument("--head", required=True, help="the pull request's head commit")
    command.add_argument(
        "--repo", help="owner/name for repository-scoped rules; defaults to the export's"
    )
    command.add_argument("--format", choices=("text", "github"), default="text")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    options = _parser().parse_args(argv)
    try:
        with options.policy.open("rb") as handle:
            raw = handle.read(MAX_POLICY_FILE_BYTES + 1)
        if len(raw) > MAX_POLICY_FILE_BYTES:
            raise UsageError("the policy file exceeds its size bound")
        policy, exported_repo = load_policy_export(raw.decode("utf-8"))
        repo_full_name = options.repo or exported_repo
        result, base_sha, head_sha = asyncio.run(
            check(policy, Path.cwd(), options.base, options.head, repo_full_name)
        )
    except (OSError, UnicodeDecodeError, UsageError) as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_USAGE
    for line in render_lines(result, options.format):
        print(line, file=sys.stderr)
    report = build_report(policy, result, repo_full_name, base_sha, head_sha)
    sys.stdout.write(json.dumps(report, indent=2) + "\n")
    return EXIT_BLOCKED if report["blocking"] else EXIT_PASSED


if __name__ == "__main__":
    raise SystemExit(main())
