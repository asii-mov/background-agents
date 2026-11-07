import asyncio
import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import sandbox_runtime.security_pipeline as security_pipeline
from sandbox_runtime.security_pipeline import (
    MAX_OUTPUT_BYTES,
    MAX_REMEDIATION_PROMPT_BYTES,
    CheckTarget,
    SecurityPipelineConfigError,
    SecurityPipelineRunner,
    parse_security_pipelines,
)


def _config(command, *, blocking=True, attempts=2, repo_scopes=None, timeout_seconds=10):
    return json.dumps(
        {
            "security_pipelines": [
                {
                    "id": "pipeline-1",
                    "name": "Application security",
                    "commands": [
                        {
                            "name": "scanner",
                            "command": command,
                            "timeoutSeconds": timeout_seconds,
                        }
                    ],
                    "blocking": blocking,
                    "maxRemediationAttempts": attempts,
                    "repoScopes": repo_scopes,
                }
            ]
        }
    )


async def _assert_process_is_gone(pid: int) -> None:
    for _ in range(20):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        await asyncio.sleep(0.05)
    pytest.fail(f"descendant process {pid} is still running")


def _parent_with_descendant(pid_path: Path, *, ignores_term: bool) -> list[str]:
    child = "import signal, time; time.sleep(60)"
    if ignores_term:
        child = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
    parent = (
        "import subprocess, sys, time; "
        f"child = subprocess.Popen([sys.executable, '-c', {child!r}]); "
        "open(sys.argv[1], 'w').write(str(child.pid)); "
        "time.sleep(60)"
    )
    return [sys.executable, "-c", parent, str(pid_path)]


def test_parse_rejects_shell_strings_instead_of_argv():
    document = json.loads(_config(["scanner"]))
    document["security_pipelines"][0]["commands"][0]["command"] = "scanner --all"

    with pytest.raises(SecurityPipelineConfigError, match="argv"):
        parse_security_pipelines(json.dumps(document))


def test_parse_rejects_unbounded_remediation_attempts():
    with pytest.raises(SecurityPipelineConfigError, match="remediation"):
        parse_security_pipelines(_config(["scanner"], attempts=99))


async def test_runner_reports_failure_and_builds_agent_remediation_prompt(tmp_path):
    pipelines = parse_security_pipelines(
        _config([sys.executable, "-c", "print('verified finding'); raise SystemExit(2)"])
    )
    report = await SecurityPipelineRunner(pipelines, tmp_path, MagicMock()).run()

    assert not report.passed
    assert report.blocking_failures[0].exit_code == 2
    assert "verified finding" in report.remediation_prompt()
    assert "platform will rerun" in report.remediation_prompt()


async def test_nonblocking_failure_does_not_fail_the_report(tmp_path):
    pipelines = parse_security_pipelines(
        _config([sys.executable, "-c", "raise SystemExit(1)"], blocking=False)
    )

    report = await SecurityPipelineRunner(pipelines, tmp_path, MagicMock()).run()

    assert report.failures
    assert report.passed


async def test_runner_caps_retained_output_while_draining_the_process(tmp_path):
    pipelines = parse_security_pipelines(
        _config([sys.executable, "-c", f"print('x' * {MAX_OUTPUT_BYTES * 2})"])
    )

    report = await SecurityPipelineRunner(pipelines, tmp_path, MagicMock()).run()

    assert report.passed
    assert len(report.results[0].output.encode()) == MAX_OUTPUT_BYTES


async def test_runner_executes_only_scoped_pipeline_from_target_checkout(tmp_path):
    frontend = tmp_path / "frontend"
    backend = tmp_path / "backend"
    frontend.mkdir()
    backend.mkdir()
    pipelines = parse_security_pipelines(
        _config(
            [sys.executable, "-c", "from pathlib import Path; print(Path.cwd().name)"],
            repo_scopes=["acme/backend"],
        )
    )
    runner = SecurityPipelineRunner(pipelines, frontend, MagicMock())

    skipped = await runner.run(CheckTarget(frontend, "acme", "frontend"))
    report = await runner.run(CheckTarget(backend, "ACME", "BACKEND"))

    assert skipped.results == ()
    assert report.passed
    assert report.results[0].output.strip() == "backend"


async def test_missing_scanner_is_a_blocking_finding_not_a_runtime_crash(tmp_path):
    pipelines = parse_security_pipelines(_config(["definitely-not-an-installed-scanner"]))

    report = await SecurityPipelineRunner(pipelines, tmp_path, MagicMock()).run()

    assert not report.passed
    assert report.blocking_failures[0].exit_code is None
    assert "Could not start command" in report.blocking_failures[0].output


async def test_timeout_kills_descendant_that_keeps_output_pipe_open(tmp_path):
    pid_path = tmp_path / "descendant.pid"
    pipelines = parse_security_pipelines(
        _config(_parent_with_descendant(pid_path, ignores_term=False), timeout_seconds=1)
    )

    started_at = time.monotonic()
    report = await SecurityPipelineRunner(pipelines, tmp_path, MagicMock()).run()
    elapsed_seconds = time.monotonic() - started_at

    descendant_pid = int(pid_path.read_text())
    assert report.results[0].timed_out
    assert elapsed_seconds < 2
    await _assert_process_is_gone(descendant_pid)


async def test_timeout_escalates_to_kill_for_descendant_ignoring_term(tmp_path, monkeypatch):
    monkeypatch.setattr(security_pipeline, "PROCESS_TERMINATION_GRACE_SECONDS", 0.1)
    pid_path = tmp_path / "descendant.pid"
    pipelines = parse_security_pipelines(
        _config(_parent_with_descendant(pid_path, ignores_term=True), timeout_seconds=1)
    )

    started_at = time.monotonic()
    report = await SecurityPipelineRunner(pipelines, tmp_path, MagicMock()).run()
    elapsed_seconds = time.monotonic() - started_at

    descendant_pid = int(pid_path.read_text())
    assert report.results[0].timed_out
    assert elapsed_seconds < 2
    await _assert_process_is_gone(descendant_pid)


async def test_combined_remediation_prompt_has_a_total_byte_bound(tmp_path):
    document = json.loads(_config([sys.executable, "-c", "raise SystemExit(1)"]))
    document["security_pipelines"][0]["commands"] = [
        {
            "name": f"scanner-{index}",
            "command": [
                sys.executable,
                "-c",
                f"print('x' * {MAX_OUTPUT_BYTES}); raise SystemExit(1)",
            ],
            "timeoutSeconds": 10,
        }
        for index in range(3)
    ]
    report = await SecurityPipelineRunner(
        parse_security_pipelines(json.dumps(document)), Path(tmp_path), MagicMock()
    ).run()

    prompt = report.remediation_prompt()

    assert len(prompt.encode()) <= MAX_REMEDIATION_PROMPT_BYTES
    assert prompt.endswith("...[diagnostic output truncated]")
