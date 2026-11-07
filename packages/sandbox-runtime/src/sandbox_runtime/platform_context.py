"""The one owner of operator-context order for both harnesses.

Organization policy comes first, then workspace guidance, then untrusted memory. OpenCode reads
the order from its ``instructions`` file list; Claude from ``system_prompt_append``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from .durable_files import atomic_write_private, remove_abandoned_staging
from .memories import memory_path, memory_text

if TYPE_CHECKING:
    from pathlib import Path

    from .stack_policy import StackPolicy

STACK_POLICY_FILENAME: Final = "oi-stack-policy.md"


def stack_policy_path(config_dir: Path) -> Path:
    return config_dir / STACK_POLICY_FILENAME


def materialize_stack_policy(policy: StackPolicy | None, config_dir: Path) -> None:
    """Install the rendered policy for the harness, or remove a file a restored image carried
    from another session. No network: the policy arrives in SESSION_CONFIG."""
    destination = stack_policy_path(config_dir)
    remove_abandoned_staging(destination)
    if policy is None or not policy.instructions.strip():
        destination.unlink(missing_ok=True)
        return
    atomic_write_private(destination, policy.instructions)


def opencode_instruction_files(config_dir: Path) -> list[str]:
    """Policy before memory, each only when present and non-empty."""
    return [
        str(path)
        for path in (stack_policy_path(config_dir), memory_path(config_dir))
        if path.is_file() and path.stat().st_size
    ]


def claude_system_prompt_append(
    policy: StackPolicy | None, workspace_guidance: str | None, config_dir: Path
) -> str | None:
    """Policy (from the bridge's own SESSION_CONFIG, not the agent-writable file), then
    workspace guidance, then memory."""
    parts = (
        policy.instructions.strip() if policy is not None else None,
        workspace_guidance,
        memory_text(config_dir),
    )
    text = "\n\n".join(part for part in parts if part)
    return text or None
