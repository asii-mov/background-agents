"""Bounded execution of centrally assigned AppSec pipelines."""

from __future__ import annotations

import asyncio
import json
import os
import signal
from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

MAX_PIPELINES = 50
MAX_COMMANDS_PER_PIPELINE = 20
MAX_ARGUMENTS = 50
MAX_OUTPUT_BYTES = 64 * 1024
MAX_REMEDIATION_PROMPT_BYTES = 64 * 1024
MAX_TIMEOUT_SECONDS = 900
PROCESS_TERMINATION_GRACE_SECONDS = 5


class SecurityPipelineConfigError(ValueError):
    """The control-plane-provided pipeline configuration is invalid."""


@dataclass(frozen=True)
class SecurityCommand:
    name: str
    argv: tuple[str, ...]
    timeout_seconds: int


@dataclass(frozen=True)
class SecurityPipeline:
    id: str
    name: str
    commands: tuple[SecurityCommand, ...]
    blocking: bool
    max_remediation_attempts: int
    repo_scopes: frozenset[str] | None


@dataclass(frozen=True)
class SecurityCommandResult:
    pipeline_id: str
    pipeline_name: str
    command_name: str
    argv: tuple[str, ...]
    exit_code: int | None
    output: str
    timed_out: bool
    blocking: bool

    @property
    def passed(self) -> bool:
        return not self.timed_out and self.exit_code == 0


@dataclass(frozen=True)
class SecurityPipelineReport:
    results: tuple[SecurityCommandResult, ...]

    @property
    def failures(self) -> tuple[SecurityCommandResult, ...]:
        return tuple(result for result in self.results if not result.passed)

    @property
    def blocking_failures(self) -> tuple[SecurityCommandResult, ...]:
        return tuple(result for result in self.failures if result.blocking)

    @property
    def passed(self) -> bool:
        return not self.blocking_failures

    def remediation_prompt(self) -> str:
        sections = [
            "Centrally managed application-security checks failed after your change.",
            "Review the verified command output below, remediate relevant findings, preserve functionality, and then stop. The platform will rerun every check automatically.",
        ]
        for failure in self.failures:
            command = " ".join(failure.argv)
            status = "timed out" if failure.timed_out else f"exit {failure.exit_code}"
            sections.append(
                f"\n## {failure.pipeline_name} / {failure.command_name}\n"
                f"Command: {command}\nStatus: {status}\n````text\n{failure.output}\n````"
            )
        return _truncate_utf8("\n\n".join(sections), MAX_REMEDIATION_PROMPT_BYTES)

    @classmethod
    def combine(cls, reports: list[SecurityPipelineReport]) -> SecurityPipelineReport:
        return cls(tuple(result for report in reports for result in report.results))


def _truncate_utf8(value: str, limit: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value
    suffix = b"\n...[diagnostic output truncated]"
    return encoded[: limit - len(suffix)].decode("utf-8", errors="ignore") + suffix.decode()


def _required_string(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SecurityPipelineConfigError(f"invalid {context}")
    return value


def parse_security_pipelines(session_config_json: str) -> tuple[SecurityPipeline, ...]:
    """Parse the SESSION_CONFIG pipeline payload with strict resource bounds."""
    try:
        document = json.loads(session_config_json or "{}")
    except json.JSONDecodeError as error:
        raise SecurityPipelineConfigError("SESSION_CONFIG is not valid JSON") from error
    if not isinstance(document, dict):
        raise SecurityPipelineConfigError("SESSION_CONFIG must be an object")
    raw_pipelines = document.get("security_pipelines")
    if raw_pipelines is None:
        return ()
    if not isinstance(raw_pipelines, list) or len(raw_pipelines) > MAX_PIPELINES:
        raise SecurityPipelineConfigError("invalid security pipeline list")

    pipelines: list[SecurityPipeline] = []
    seen_ids: set[str] = set()
    for raw_pipeline in raw_pipelines:
        if not isinstance(raw_pipeline, dict):
            raise SecurityPipelineConfigError("invalid security pipeline")
        pipeline_id = _required_string(raw_pipeline.get("id"), "pipeline id")
        if pipeline_id in seen_ids:
            raise SecurityPipelineConfigError("duplicate security pipeline id")
        seen_ids.add(pipeline_id)
        name = _required_string(raw_pipeline.get("name"), "pipeline name")
        blocking = raw_pipeline.get("blocking")
        attempts = raw_pipeline.get("maxRemediationAttempts")
        raw_repo_scopes = raw_pipeline.get("repoScopes")
        raw_commands = raw_pipeline.get("commands")
        if not isinstance(blocking, bool):
            raise SecurityPipelineConfigError("invalid pipeline blocking flag")
        if isinstance(attempts, bool) or not isinstance(attempts, int) or not 0 <= attempts <= 5:
            raise SecurityPipelineConfigError("invalid pipeline remediation attempts")
        if raw_repo_scopes is not None and (
            not isinstance(raw_repo_scopes, list)
            or not raw_repo_scopes
            or not all(isinstance(scope, str) and scope.strip() for scope in raw_repo_scopes)
        ):
            raise SecurityPipelineConfigError("invalid pipeline repository scopes")
        if (
            not isinstance(raw_commands, list)
            or not raw_commands
            or len(raw_commands) > MAX_COMMANDS_PER_PIPELINE
        ):
            raise SecurityPipelineConfigError("invalid security pipeline commands")

        commands: list[SecurityCommand] = []
        for raw_command in raw_commands:
            if not isinstance(raw_command, dict):
                raise SecurityPipelineConfigError("invalid security pipeline command")
            command_name = _required_string(raw_command.get("name"), "command name")
            argv = raw_command.get("command")
            timeout = raw_command.get("timeoutSeconds")
            if (
                not isinstance(argv, list)
                or not argv
                or len(argv) > MAX_ARGUMENTS
                or not all(isinstance(argument, str) and argument for argument in argv)
            ):
                raise SecurityPipelineConfigError("invalid security pipeline argv")
            if (
                isinstance(timeout, bool)
                or not isinstance(timeout, int)
                or not 1 <= timeout <= MAX_TIMEOUT_SECONDS
            ):
                raise SecurityPipelineConfigError("invalid security pipeline timeout")
            commands.append(SecurityCommand(command_name, tuple(argv), timeout))
        repo_scopes = (
            frozenset(scope.strip().lower() for scope in raw_repo_scopes)
            if raw_repo_scopes is not None
            else None
        )
        pipelines.append(
            SecurityPipeline(pipeline_id, name, tuple(commands), blocking, attempts, repo_scopes)
        )
    return tuple(pipelines)


class SecurityPipelineRunner:
    """Run configured commands without a shell and retain bounded diagnostic output."""

    def __init__(self, pipelines: tuple[SecurityPipeline, ...], workdir: Path, log: Any) -> None:
        self.pipelines = pipelines
        self.workdir = workdir
        self.log = log

    @property
    def max_remediation_attempts(self) -> int:
        return max((pipeline.max_remediation_attempts for pipeline in self.pipelines), default=0)

    async def run(
        self, *, workdir: Path | None = None, repo_full_name: str | None = None
    ) -> SecurityPipelineReport:
        results: list[SecurityCommandResult] = []
        for pipeline in self.pipelines:
            if pipeline.repo_scopes is not None and (
                repo_full_name is None or repo_full_name.lower() not in pipeline.repo_scopes
            ):
                continue
            for command in pipeline.commands:
                results.append(await self._run_command(pipeline, command, workdir or self.workdir))
        return SecurityPipelineReport(tuple(results))

    async def _run_command(
        self, pipeline: SecurityPipeline, command: SecurityCommand, workdir: Path
    ) -> SecurityCommandResult:
        self.log.info(
            "security_pipeline.command_start",
            pipeline_id=pipeline.id,
            pipeline_name=pipeline.name,
            command_name=command.name,
        )
        try:
            process = await asyncio.create_subprocess_exec(
                *command.argv,
                cwd=workdir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as error:
            result = SecurityCommandResult(
                pipeline.id,
                pipeline.name,
                command.name,
                command.argv,
                None,
                f"Could not start command: {error}",
                False,
                pipeline.blocking,
            )
            self.log.warn(
                "security_pipeline.command_start_failed",
                pipeline_id=pipeline.id,
                command_name=command.name,
                error=str(error),
            )
            return result
        output = bytearray()

        async def collect_output() -> None:
            assert process.stdout is not None
            while chunk := await process.stdout.read(8192):
                remaining = MAX_OUTPUT_BYTES - len(output)
                if remaining > 0:
                    output.extend(chunk[:remaining])

        collector = asyncio.create_task(collect_output())
        timed_out = False
        try:
            async with asyncio.timeout(command.timeout_seconds):
                await process.wait()
                await collector
        except TimeoutError:
            timed_out = True
            await self._terminate_process_group(process, collector)
        rendered = output.decode("utf-8", errors="replace")
        result = SecurityCommandResult(
            pipeline.id,
            pipeline.name,
            command.name,
            command.argv,
            process.returncode,
            rendered,
            timed_out,
            pipeline.blocking,
        )
        self.log.info(
            "security_pipeline.command_complete",
            pipeline_id=pipeline.id,
            command_name=command.name,
            exit_code=process.returncode,
            timed_out=timed_out,
            passed=result.passed,
        )
        return result

    async def _terminate_process_group(
        self, process: asyncio.subprocess.Process, collector: asyncio.Task[None]
    ) -> None:
        self._signal_process_group(process, signal.SIGTERM)
        if await self._wait_for_cleanup(process, collector):
            return

        self._signal_process_group(process, signal.SIGKILL)
        if await self._wait_for_cleanup(process, collector):
            return

        collector.cancel()
        with suppress(asyncio.CancelledError):
            await collector

    @staticmethod
    def _signal_process_group(process: asyncio.subprocess.Process, sig: signal.Signals) -> None:
        if process.pid is None:
            return
        with suppress(ProcessLookupError):
            os.killpg(process.pid, sig)

    @staticmethod
    async def _wait_for_cleanup(
        process: asyncio.subprocess.Process, collector: asyncio.Task[None]
    ) -> bool:
        try:
            async with asyncio.timeout(PROCESS_TERMINATION_GRACE_SECONDS):
                await process.wait()
                await collector
        except TimeoutError:
            return False
        return True
