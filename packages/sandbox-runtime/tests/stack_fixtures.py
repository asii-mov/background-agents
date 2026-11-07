"""Real git repositories and seed-like stack policies for stack-policy tests."""

from __future__ import annotations

import json
import os
import subprocess
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

from sandbox_runtime.stack_policy import StackConformanceStage, StackPolicy, parse_stack_policy

if TYPE_CHECKING:
    from pathlib import Path

GIT_ENVIRONMENT = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Fixture Author",
    "GIT_AUTHOR_EMAIL": "author@example.com",
    "GIT_COMMITTER_NAME": "Fixture Author",
    "GIT_COMMITTER_EMAIL": "author@example.com",
}


def git(repo: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=GIT_ENVIRONMENT,
    ).stdout.strip()


def write(repo: Path, files: dict[str, str | None]) -> None:
    """Write each file, or delete it when the content is None."""
    for relative, content in files.items():
        path = repo / relative
        if content is None:
            path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)


def commit(repo: Path, files: dict[str, str | None], message: str = "change") -> str:
    write(repo, files)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "--allow-empty", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def init_repo(repo: Path, files: dict[str, str | None] | None = None) -> str:
    """A repository with one commit; returns that commit (the session's base_sha)."""
    repo.mkdir(parents=True, exist_ok=True)
    git(repo, "init", "-q", "-b", "main")
    return commit(repo, files or {"README.md": "fixture\n"}, "initial")


def package_json(**dependencies: str) -> str:
    return json.dumps({"name": "app", "dependencies": dependencies})


def npm(name: str) -> dict[str, str]:
    return {"kind": "package", "ecosystem": "npm", "name": name}


def pypi(name: str) -> dict[str, str]:
    return {"kind": "package", "ecosystem": "pypi", "name": name}


def file(pattern: str) -> dict[str, str]:
    return {"kind": "file", "pattern": pattern}


def source(extension: str) -> dict[str, str]:
    return {"kind": "source", "extension": extension}


def store(value: str) -> dict[str, str]:
    return {"kind": "manifest", "value": value}


CATEGORY_NAMES = {
    "web-frontend": "Web frontend",
    "js-toolchain": "JavaScript toolchain",
    "python-tooling": "Python tooling",
    "language": "Language",
    "app-data-store": "App data store",
}


def rule(
    name: str,
    category: str,
    verdict: str,
    *signals: dict[str, str],
    blocking: bool = False,
    guidance: str = "",
    repo_scopes: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "componentId": f"component-{name.lower()}",
        "componentRevision": 1,
        "componentName": name,
        "categoryId": category,
        "categoryName": CATEGORY_NAMES[category],
        "verdict": verdict,
        "blocking": blocking,
        "signals": list(signals),
        "guidance": guidance,
        "repoScopes": repo_scopes,
    }


def seed_rules(*, frontend_blocks: bool = True) -> list[dict[str, Any]]:
    """The 0104 seed's shape: React and Next.js denied, Svelte, Bun, uv and TypeScript preferred."""
    return [
        rule("Svelte", "web-frontend", "prefer", npm("svelte"), guidance="Use SvelteKit."),
        rule(
            "React",
            "web-frontend",
            "forbid",
            npm("react"),
            npm("react-dom"),
            blocking=frontend_blocks,
            guidance="React is not supported on the platform.",
        ),
        rule("Next.js", "web-frontend", "forbid", npm("next"), blocking=frontend_blocks),
        rule(
            "Bun",
            "js-toolchain",
            "prefer",
            file("bun.lock"),
            file("bun.lockb"),
            guidance="bun install; commit bun.lock",
        ),
        rule("npm", "js-toolchain", "allow", file("package-lock.json")),
        rule("uv", "python-tooling", "prefer", file("uv.lock")),
        rule("pip", "python-tooling", "allow", file("requirements*.txt")),
        rule("TypeScript", "language", "prefer", source(".ts")),
        rule("JavaScript", "language", "allow", source(".js")),
    ]


def policy_payload(
    rules: list[dict[str, Any]] | None = None, *, attempts: int = 2
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "digest": "digest-1",
        "instructions": "## Organization technology standards\n- Do not use: **React**.",
        "maxRemediationAttempts": attempts,
        "rules": seed_rules() if rules is None else rules,
    }


def stack_policy(rules: list[dict[str, Any]] | None = None, *, attempts: int = 2) -> StackPolicy:
    policy = parse_stack_policy({"stack_policy": policy_payload(rules, attempts=attempts)})
    assert policy is not None
    return policy


def stage(rules: list[dict[str, Any]] | None = None, *, attempts: int = 2) -> StackConformanceStage:
    return StackConformanceStage(stack_policy(rules, attempts=attempts), MagicMock())


def severities(result: Any) -> dict[tuple[str, str], str]:
    """(component, path) -> severity, the shape every evaluate assertion reads."""
    return {
        (finding.hit.rule.component_name, str(finding.hit.path)): finding.severity
        for finding in result.findings
    }
