"""DELTA over stack/candidate-1/sketch/sandbox_runtime.py (stack_facts.py, stack_policy.py,
security_pipeline.py, platform_context.py). Apply on top of that sketch."""

from __future__ import annotations

import enum
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Literal

# --- stack_facts.py --------------------------------------------------------------------------------
# TreeFacts gains:
#   files: tuple[FileFact, ...]        # replaces bare `paths` for file facts: (path, derived)
#   manifests: tuple[ManifestFact, ...]


@dataclass(frozen=True)
class FileFact:
    path: PurePosixPath
    derived: bool  # True when a DERIVED_FILE_RULES sibling exists in the same directory (contract)


@dataclass(frozen=True)
class ManifestFact:
    """openinspect.app.json `data[*].kind`; value is the data-store locator (d1|kv|r2)."""

    path: PurePosixPath
    value: str


# collect_tree_facts: parse every `openinspect.app.json` (bounded, strict JSON) into ManifestFacts;
# compute `derived` per DERIVED_FILE_RULES from the contract; unreadable manifest => incomplete.
# Directory-level helper used by evaluate's new-project condition:
#   def directories_with_manifests(facts: TreeFacts) -> frozenset[PurePosixPath]
#   (directories containing a package manifest, lockfile or well-known toolchain file)

# --- stack_policy.py --------------------------------------------------------------------------------

Severity = Literal["violation", "advisory", "legacy", "standard", "alternative", "deviation"]


class Origin(enum.Enum):
    BASELINE = "baseline"
    INTRODUCED = "introduced"


@dataclass(frozen=True)
class StackFinding:
    hit: object  # SignalHit
    origin: Origin
    new_project: bool  # the hit's directory had no manifest/lockfile/toolchain file at base_sha
    category_has_preferred: bool

    @property
    def severity(self) -> Severity:
        """forbid+INTRODUCED+blocking -> violation; forbid+INTRODUCED -> advisory; forbid+BASELINE -> legacy;
        prefer -> standard; allow+INTRODUCED+new_project+category_has_preferred -> deviation; allow -> alternative.
        Derived file facts never produce hits (skipped in StackPolicy.hits)."""
        raise NotImplementedError


@dataclass(frozen=True)
class StackConformanceResult:
    # unchanged members, plus:
    def nudge_section(self, already_nudged: frozenset[tuple[str, str]]) -> str | None:
        """Deviation findings whose keys are not in already_nudged. Rendered from rule data:
        'You introduced <path>; this organization prefers <Preferred> for <category>. Unless the user
        explicitly asked for <Alternative>, switch to <Preferred> (<guidance>) and remove <path>. Then continue.'
        Bounded like remediation_section. Never counts toward `blocking` or `passed`."""
        raise NotImplementedError


class StackConformanceStage:
    """Adds per-session nudge bookkeeping: self._nudged: set[tuple[str, str]] (signal key, path).
    acknowledge_nudges(keys) after the advisory prompt is delivered, so a key is nudged once per session."""

    STACK_NUDGE_ROUNDS_PER_TURN = 1


# --- bridge.py loop delta (pseudocode) ---------------------------------------------------------------
#   if not had_error and runner.has_checks:
#       attempt, nudged_this_turn = 0, False
#       while True:
#           report = await self._run_security_pipelines_for_workspace()
#           blocking_prompt = report.remediation_prompt() if report.failures else None     # unchanged semantics
#           nudge = report.nudge_section(stage.already_nudged) if (stage and not nudged_this_turn) else None
#           if blocking_prompt is None and nudge is None: break
#           if blocking_prompt is not None and attempt >= runner.max_remediation_attempts: had_error=...; break
#           text = "\n\n".join(p for p in (blocking_prompt, nudge) if p)
#           remediation = await harness.run_prompt(HarnessPrompt(text=text, ...))    # cost/cancel unchanged
#           if nudge: stage.acknowledge_nudges(...); nudged_this_turn = True
#           if blocking_prompt: attempt += 1
#   Events: the existing "checks running/passed" warnings fire only when command pipelines ran; stack-only
#   passes, preference findings and nudges emit nothing visible to members.
#
# --- push_operation.py: unchanged except `runner.has_checks`, CheckTarget(revision=refspec source),
#   and nudges are ignored pre-push (preferences never affect a push).
#
# --- platform_context.py (NEW; one owner of ordering) ----------------------------------------------
STACK_POLICY_FILENAME = "oi-stack-policy.md"
# materialize_stack_policy(policy|None, config_dir): write/unlink atomically (supervisor phase "policy")
# opencode_instruction_files(config_dir) -> [policy, memory] (replaces the memory-only list)
# claude_system_prompt_append(workspace_guidance, config_dir) -> policy, guidance, memory
#
# --- stack_policy_cli.py (NEW, U11) ---------------------------------------------------------------
# python -m sandbox_runtime.stack_policy_cli check --policy policy.json --base <sha> --head <sha> [--repo owner/name] [--json]
#   policy.json = GET /stack-policy/export body; facts via CommitSource for base and head; evaluate; exit 1 on blocking.
