import inspect

import modal
import pytest

from src.sandbox.launch_policy import network_policy_kwargs


class TestNetworkPolicyKwargs:
    """Restrictive policies map exactly to Modal's enforced launch arguments."""

    def test_unrestricted_is_provider_default(self):
        assert network_policy_kwargs({"networkPolicy": {"mode": "unrestricted"}}) == {}

    def test_blocked_disables_all_outbound_network(self):
        assert network_policy_kwargs({"networkPolicy": {"mode": "blocked"}}) == {
            "block_network": True
        }

    def test_allowlist_maps_cidrs_and_domains(self):
        assert network_policy_kwargs(
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
            network_policy_kwargs({"networkPolicy": policy})

    def test_installed_modal_supports_domain_allowlists(self):
        parameters = inspect.signature(modal.Sandbox.create).parameters

        assert "outbound_domain_allowlist" in parameters
