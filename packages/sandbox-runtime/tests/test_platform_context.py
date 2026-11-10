"""Operator context delivery: policy first, then workspace guidance, then untrusted memory."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.platform_context import (
    STACK_POLICY_FILENAME,
    claude_system_prompt_append,
    materialize_stack_policy,
    opencode_instruction_files,
)
from sandbox_runtime.repository_boot import RepositoryBootResult
from sandbox_runtime.runtime_config import RuntimeConfig
from sandbox_runtime.stack_policy import StackPolicyConfigError
from sandbox_runtime.supervisor import SandboxSupervisor
from tests.stack_fixtures import policy_payload, stack_policy

POLICY_TEXT = policy_payload()["instructions"]


def test_the_policy_is_written_owner_only_and_removed_when_absent(tmp_path):
    (tmp_path / f".{STACK_POLICY_FILENAME}-abandoned.tmp").write_text("partial")

    materialize_stack_policy(stack_policy(), tmp_path)
    written = tmp_path / STACK_POLICY_FILENAME

    assert written.read_text() == POLICY_TEXT
    assert written.stat().st_mode & 0o777 == 0o600
    assert not list(tmp_path.glob("*.tmp"))
    materialize_stack_policy(None, tmp_path)
    assert not written.exists()


def test_opencode_lists_policy_before_memory(tmp_path):
    (tmp_path / "oi-memory.md").write_text("# Memory\n")
    assert opencode_instruction_files(tmp_path) == [str(tmp_path / "oi-memory.md")]

    materialize_stack_policy(stack_policy(), tmp_path)

    assert opencode_instruction_files(tmp_path) == [
        str(tmp_path / STACK_POLICY_FILENAME),
        str(tmp_path / "oi-memory.md"),
    ]


def test_claude_append_orders_policy_guidance_memory(tmp_path):
    (tmp_path / "oi-memory.md").write_text("# Memory\n")
    # The agent-writable file is ignored: Claude's copy comes from SESSION_CONFIG.
    (tmp_path / STACK_POLICY_FILENAME).write_text("tampered")

    append = claude_system_prompt_append(stack_policy(), "Workspace guidance", tmp_path)

    assert append == f"{POLICY_TEXT}\n\nWorkspace guidance\n\n# Memory\n"


def test_without_policy_guidance_or_memory_claude_gets_nothing(tmp_path):
    assert claude_system_prompt_append(None, None, tmp_path) is None


async def test_opencode_config_lists_policy_then_memory(tmp_path, monkeypatch):
    from tests.runtime_helpers import make_opencode_server

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "oi-memory.md").write_text("# Memory\n")
    materialize_stack_policy(stack_policy(), config_dir)
    monkeypatch.setattr(
        "sandbox_runtime.opencode_server.resolve_opencode_global_config_dir", lambda: config_dir
    )
    server = make_opencode_server({}, workspace_path=tmp_path)
    with (
        patch.object(server, "_setup_managed_oauth"),
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=MagicMock(stdout=None),
        ) as spawn,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        await server.start((), tmp_path)

    config = json.loads(spawn.call_args.kwargs["env"]["OPENCODE_CONFIG_CONTENT"])
    assert [Path(path).name for path in config["instructions"]] == [
        STACK_POLICY_FILENAME,
        "oi-memory.md",
    ]


def _supervisor(tmp_path: Path, session_config: dict, seen: list[str]) -> SandboxSupervisor:
    config = RuntimeConfig.from_env(
        {"SANDBOX_ID": "sandbox-1", "SESSION_CONFIG": json.dumps(session_config)},
        workspace_path=tmp_path,
    )
    policy_dir = tmp_path / "config"
    harness = MagicMock()
    harness.start = AsyncMock(
        side_effect=lambda *_: seen.append(
            (policy_dir / STACK_POLICY_FILENAME).read_text()
            if (policy_dir / STACK_POLICY_FILENAME).exists()
            else "no policy"
        )
    )
    starter = MagicMock(start=AsyncMock(), stop=AsyncMock())
    return SandboxSupervisor(
        config,
        MagicMock(),
        harness,
        MagicMock(),
        starter,
        starter,
        MagicMock(),
        None,
        asyncio.Event(),
        MagicMock(),
        policy_dir=policy_dir,
        boot_events=MagicMock(),
    )


async def test_boot_writes_the_policy_before_the_harness_starts(tmp_path):
    seen: list[str] = []
    supervisor = _supervisor(tmp_path, {"stack_policy": policy_payload()}, seen)

    await supervisor._start_session_services(
        RepositoryBootResult(True, [], True, True, (), tmp_path)
    )

    assert seen == [POLICY_TEXT]


async def test_a_restore_without_policy_removes_the_stale_file(tmp_path):
    stale = tmp_path / "config" / STACK_POLICY_FILENAME
    stale.parent.mkdir()
    stale.write_text("another session's policy")
    seen: list[str] = []
    supervisor = _supervisor(tmp_path, {}, seen)

    await supervisor._start_session_services(
        RepositoryBootResult(True, [], True, True, (), tmp_path)
    )

    assert seen == ["no policy"]


async def test_a_malformed_policy_fails_the_boot_before_the_harness(tmp_path):
    seen: list[str] = []
    payload = policy_payload()
    payload["rules"] = "all"
    supervisor = _supervisor(tmp_path, {"stack_policy": payload}, seen)

    with pytest.raises(StackPolicyConfigError):
        await supervisor._start_session_services(
            RepositoryBootResult(True, [], True, True, (), tmp_path)
        )
    assert seen == []


def test_the_claude_harness_prepends_the_policy_from_its_own_session_config(tmp_path, monkeypatch):
    from sandbox_runtime.claude_stager import ClaudeHarnessHandoff
    from sandbox_runtime.harness import BridgeIdentity, build_agent_harness
    from sandbox_runtime.harness.base import HarnessId, PromptLimits

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "oi-memory.md").write_text("# Memory\n")
    (tmp_path / "AGENTS.md").write_text("Repository guidance")
    monkeypatch.setenv("SESSION_CONFIG", json.dumps({"stack_policy": policy_payload()}))
    with (
        patch(
            "sandbox_runtime.harness.ClaudeHarnessHandoff.read",
            return_value=ClaudeHarnessHandoff(tmp_path, config_dir, False),
        ),
        patch("sandbox_runtime.harness.ClaudeHarness") as claude,
    ):
        build_agent_harness(
            HarnessId.CLAUDE,
            identity=BridgeIdentity(
                "sandbox", "session", "https://control.test", "token", tmp_path / "repos.json"
            ),
            attachment_processor=MagicMock(),
            log=MagicMock(),
            limits=PromptLimits(60, 120, 10),
            opencode_port=4096,
        )

    assert claude.call_args.kwargs["config"].system_prompt_append == (
        f"{POLICY_TEXT}\n\nWorkspace guidance (AGENTS.md):\n\nRepository guidance\n\n# Memory\n"
    )
