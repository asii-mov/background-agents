"""A Modal launch delivers the stack policy in SESSION_CONFIG and gates the deploy-app tool."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.types import SessionConfig
from src.sandbox.manager import SandboxConfig, SandboxManager
from src.sandbox.tunnels import SandboxTunnels, TunnelUrls

STACK_POLICY = {
    "schemaVersion": 1,
    "digest": "digest-1",
    "instructions": "## Organization technology standards\n- Do not use: **React**.",
    "maxRemediationAttempts": 2,
    "rules": [],
}


def _patch_create(monkeypatch, captured: dict) -> None:
    async def fake_create_aio(*args, **kwargs):
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-123"
            stdout = None

        return FakeSandbox()

    fake_create = MagicMock()
    fake_create.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create)
    monkeypatch.setattr(
        SandboxTunnels,
        "resolve",
        AsyncMock(return_value=TunnelUrls(None, None, None, None)),
    )


def _config(**overrides) -> SandboxConfig:
    return SandboxConfig(
        clone_host="github.com",
        clone_username="x-access-token",
        repo_owner="acme",
        repo_name="repo",
        control_plane_url="https://cp.example.com",
        sandbox_auth_token="token-123",
        session_config=SessionConfig(session_id="session-1", stack_policy=STACK_POLICY),
        **overrides,
    )


@pytest.mark.asyncio
async def test_create_delivers_the_stack_policy_in_session_config(monkeypatch):
    captured: dict = {}
    _patch_create(monkeypatch, captured)

    await SandboxManager().create_sandbox(_config())

    assert json.loads(captured["env"]["SESSION_CONFIG"])["stack_policy"] == STACK_POLICY


@pytest.mark.asyncio
async def test_restore_delivers_the_stack_policy_in_session_config(monkeypatch):
    captured: dict = {}
    _patch_create(monkeypatch, captured)

    await SandboxManager().restore_from_snapshot(
        snapshot_image_id="snapshot-image-1",
        session_config={"session_id": "session-1", "stack_policy": STACK_POLICY},
        clone_host="github.com",
        clone_username="x-access-token",
    )

    assert json.loads(captured["env"]["SESSION_CONFIG"])["stack_policy"] == STACK_POLICY


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [True, False])
async def test_deploy_app_tool_is_gated_by_the_control_plane_only(monkeypatch, enabled):
    captured: dict = {}
    _patch_create(monkeypatch, captured)

    await SandboxManager().create_sandbox(
        _config(
            agent_app_deploy_enabled=enabled,
            user_env_vars={"AGENT_APP_DEPLOY_ENABLED": "true"},
        )
    )

    assert captured["env"].get("AGENT_APP_DEPLOY_ENABLED") == ("true" if enabled else None)
