"""Tests for sandbox CPU/memory resource reservations in SandboxManager."""

import inspect
from unittest.mock import AsyncMock

import modal
import pytest

from src.sandbox.manager import (
    SandboxConfig,
    SandboxManager,
    _network_policy_kwargs,
    _resource_kwargs,
)


class TestResourceKwargs:
    """_resource_kwargs maps sandbox settings to Modal create kwargs."""

    def test_empty_settings(self):
        assert _resource_kwargs({}) == {}

    def test_maps_cpu_and_memory(self):
        assert _resource_kwargs({"cpuCores": 2, "memoryMib": 4096}) == {
            "cpu": 2.0,
            "memory": 4096,
        }

    def test_allows_fractional_cpu(self):
        assert _resource_kwargs({"cpuCores": 0.5}) == {"cpu": 0.5}

    def test_independent_fields(self):
        assert _resource_kwargs({"memoryMib": 2048}) == {"memory": 2048}


class TestNetworkPolicyKwargs:
    """Restrictive policies map exactly to Modal's enforced launch arguments."""

    def test_unrestricted_is_provider_default(self):
        assert _network_policy_kwargs({"networkPolicy": {"mode": "unrestricted"}}) == {}

    def test_blocked_disables_all_outbound_network(self):
        assert _network_policy_kwargs({"networkPolicy": {"mode": "blocked"}}) == {
            "block_network": True
        }

    def test_allowlist_maps_cidrs_and_domains(self):
        assert _network_policy_kwargs(
            {
                "networkPolicy": {
                    "mode": "allowlist",
                    "allowedCidrs": ["10.0.0.0/8"],
                    "allowedDomains": ["api.openai.com", "*.github.com"],
                }
            }
        ) == {
            "outbound_cidr_allowlist": ["10.0.0.0/8"],
            "outbound_domain_allowlist": ["api.openai.com", "*.github.com"],
        }

    @pytest.mark.parametrize("policy", [{"mode": "invalid"}, {"mode": "allowlist"}])
    def test_invalid_restrictive_policy_fails_closed(self, policy):
        with pytest.raises(ValueError):
            _network_policy_kwargs({"networkPolicy": policy})

    def test_installed_modal_supports_domain_allowlists(self):
        parameters = inspect.signature(modal.Sandbox.create).parameters

        assert "outbound_domain_allowlist" in parameters


def _fake_create(captured: dict):
    async def fake_create_aio(*args, **kwargs):
        captured["kwargs"] = kwargs

        class FakeSandbox:
            object_id = "obj-1"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    return fake_create_aio


class TestCreateSandboxResources:
    """create_sandbox / restore_from_snapshot forward resources to Modal."""

    @pytest.mark.asyncio
    async def test_create_sandbox_passes_cpu_and_memory(self, monkeypatch):
        captured: dict = {}
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_create(captured))
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, None, None, None)),
        )

        manager = SandboxManager()
        await manager.create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                settings={"cpuCores": 2, "memoryMib": 4096},
            )
        )

        assert captured["kwargs"]["cpu"] == 2.0
        assert captured["kwargs"]["memory"] == 4096

    @pytest.mark.asyncio
    async def test_restore_from_snapshot_passes_resources(self, monkeypatch):
        captured: dict = {}

        class FakeImage:
            object_id = "img-1"

        monkeypatch.setattr(
            "src.sandbox.manager.modal.Image.from_id", lambda *_a, **_kw: FakeImage()
        )
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_create(captured))
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, None, None, None)),
        )

        manager = SandboxManager()
        await manager.restore_from_snapshot(
            snapshot_image_id="img-abc",
            session_config={"repo_owner": "acme", "repo_name": "repo"},
            settings={"cpuCores": 1, "memoryMib": 2048},
        )

        assert captured["kwargs"]["cpu"] == 1.0
        assert captured["kwargs"]["memory"] == 2048

    @pytest.mark.asyncio
    async def test_create_sandbox_passes_network_policy(self, monkeypatch):
        captured: dict = {}
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_create(captured))
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, None, None, None)),
        )

        manager = SandboxManager()
        await manager.create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                settings={
                    "networkPolicy": {
                        "mode": "allowlist",
                        "allowedDomains": ["api.openai.com"],
                    }
                },
            )
        )

        assert captured["kwargs"]["outbound_domain_allowlist"] == ["api.openai.com"]
        assert "block_network" not in captured["kwargs"]
