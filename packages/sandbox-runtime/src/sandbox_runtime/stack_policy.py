"""What the organization decided, applied to a tree.

The control plane compiles catalogue rows into ``SESSION_CONFIG["stack_policy"]`` (stance,
lifecycle and enforcement already folded into ``verdict`` and ``blocking``). This module parses
that payload, matches signals against :mod:`stack_facts`, and owns the one decision the sandbox
makes: whether a finding was introduced in this session. Only introduced denials prompt
remediation or block; anything present in the session's baseline never does.
"""

from __future__ import annotations

import asyncio
import enum
import json
import re
from dataclasses import dataclass
from fnmatch import fnmatchcase
from typing import TYPE_CHECKING, Any, Final, Literal, cast

from .stack_facts import (
    EMPTY_TREE_FACTS,
    MAX_LISTED_PATHS,
    STACK_CONTRACT,
    CommitSource,
    DependencyScope,
    DirectorySource,
    TreeFacts,
    TreeScanError,
    WorktreeSource,
    collect_tree_facts,
    run_git,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence
    from pathlib import Path, PurePosixPath

    from .security_pipeline import CheckTarget

MAX_STACK_RULES = 2000
MAX_SIGNALS_PER_RULE = 200
MAX_INSTRUCTIONS_CHARS = 256 * 1024
MAX_RULE_TEXT_CHARS = 16 * 1024
MAX_REMEDIATION_ATTEMPTS = 5
MAX_EVIDENCE_LINES_PER_RULE = 10

Verdict = Literal["prefer", "allow", "forbid"]
SignalKind = Literal["package", "file", "source", "manifest"]
Severity = Literal["violation", "advisory", "legacy", "standard", "alternative", "deviation"]
HitKey = tuple[str, str]

_VERDICTS: Final = ("prefer", "allow", "forbid")
_FILE_PATTERN: Final = re.compile(r"^[A-Za-z0-9._*?-]+$")
_SOURCE_EXTENSION: Final = re.compile(r"^\.[a-z0-9]{1,10}$")


class StackPolicyConfigError(ValueError):
    """``SESSION_CONFIG.stack_policy`` is malformed. Boot and the bridge refuse it (fail closed)."""


# ---- Compiled policy -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Signal:
    kind: SignalKind
    ecosystem: str  # "" unless kind == "package"
    value: str  # normalized package name | basename glob | ".ext" | data-store kind

    @property
    def key(self) -> str:
        """The same canonical key as ``stackSignalKey`` in TypeScript."""
        if self.kind == "package":
            return f"package:{self.ecosystem}:{self.value}"
        return f"{self.kind}:{self.value}"

    @property
    def is_glob(self) -> bool:
        if self.kind == "package":
            return self.value.endswith("/*")
        return self.kind == "file" and ("*" in self.value or "?" in self.value)

    def matches(self, value: str) -> bool:
        if self.kind == "package" and self.is_glob:
            return value.startswith(self.value[:-1])
        if self.kind == "file" and self.is_glob:
            return fnmatchcase(value, self.value)
        return value == self.value


@dataclass(frozen=True)
class StackRule:
    component_id: str
    component_revision: int
    component_name: str
    category_id: str
    category_name: str
    verdict: Verdict
    blocking: bool
    signals: tuple[Signal, ...]
    guidance: str
    repo_scopes: frozenset[str] | None

    def applies_to(self, repo_full_name: str | None) -> bool:
        """Same semantics as ``SecurityPipeline.repo_scopes``."""
        return self.repo_scopes is None or (
            repo_full_name is not None and repo_full_name.lower() in self.repo_scopes
        )


@dataclass(frozen=True)
class SignalHit:
    """One fact matched to one rule. ``key`` is the unit of baseline comparison: a denied package
    already in ``apps/legacy`` does not license adding it to ``apps/new``."""

    rule: StackRule
    signal: Signal
    path: PurePosixPath
    subject: str  # package name, file basename, extension or data-store kind
    scope: DependencyScope | None = None

    @property
    def key(self) -> HitKey:
        return (self.signal.key, str(self.path))


class SignalIndex:
    """One fact maps to at most one rule: an exact value beats a glob, and among globs the
    smallest signal key wins (identical to ``matchFact`` in TypeScript)."""

    def __init__(self, rules: Iterable[StackRule]) -> None:
        self._exact: dict[tuple[SignalKind, str, str], tuple[Signal, StackRule]] = {}
        self._globs: dict[tuple[SignalKind, str], list[tuple[Signal, StackRule]]] = {}
        for rule in rules:
            for signal in rule.signals:
                if signal.is_glob:
                    self._globs.setdefault((signal.kind, signal.ecosystem), []).append(
                        (signal, rule)
                    )
                else:
                    self._exact[(signal.kind, signal.ecosystem, signal.value)] = (signal, rule)
        for candidates in self._globs.values():
            candidates.sort(key=lambda pair: pair[0].key)

    @property
    def has_file_signals(self) -> bool:
        return ("file", "") in self._globs or any(kind == "file" for kind, _, _ in self._exact)

    def match(
        self, kind: SignalKind, ecosystem: str, value: str
    ) -> tuple[Signal, StackRule] | None:
        exact = self._exact.get((kind, ecosystem, value))
        if exact is not None:
            return exact
        return next(
            (pair for pair in self._globs.get((kind, ecosystem), ()) if pair[0].matches(value)),
            None,
        )


@dataclass(frozen=True)
class StackPolicy:
    digest: str
    instructions: str
    max_remediation_attempts: int
    rules: tuple[StackRule, ...]

    def rules_for(self, repo_full_name: str | None) -> tuple[StackRule, ...]:
        return tuple(rule for rule in self.rules if rule.applies_to(repo_full_name))

    def hits(self, facts: TreeFacts, repo_full_name: str | None) -> tuple[SignalHit, ...]:
        """Match every fact against the rules in scope. Package signals match declared
        dependencies (enforcement reads manifests); derived file facts never match."""
        index = SignalIndex(self.rules_for(repo_full_name))
        candidates: list[tuple[SignalKind, str, str, PurePosixPath, DependencyScope | None]] = [
            ("package", d.ecosystem, d.name, d.manifest_path, d.scope) for d in facts.declared
        ]
        if index.has_file_signals:
            candidates.extend(
                ("file", "", path.name, path, None)
                for path in facts.paths
                if path not in facts.derived
            )
        candidates.extend(
            ("source", "", extension, path, None)
            for extension, paths in facts.sources.items()
            for path in paths
        )
        candidates.extend(("manifest", "", s.kind, s.path, None) for s in facts.data_stores)
        found: dict[HitKey, SignalHit] = {}
        for kind, ecosystem, subject, path, scope in candidates:
            match = index.match(kind, ecosystem, subject)
            if match is not None:
                hit = SignalHit(match[1], match[0], path, subject, scope)
                found.setdefault(hit.key, hit)
        return tuple(sorted(found.values(), key=lambda hit: hit.key))


def _text(value: Any, context: str, *, limit: int, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > limit or (not allow_empty and not value.strip()):
        raise StackPolicyConfigError(f"invalid {context}")
    return value


def _sequence(value: Any, context: str, *, limit: int) -> Sequence[Any]:
    # SESSION_CONFIG reaches the supervisor frozen (tuples), the bridge as plain JSON (lists).
    if not isinstance(value, list | tuple) or len(value) > limit:
        raise StackPolicyConfigError(f"invalid {context}")
    return cast("Sequence[Any]", value)


def _parse_signal(raw: Any) -> Signal:
    if not hasattr(raw, "get"):
        raise StackPolicyConfigError("invalid stack policy signal")
    kind = raw.get("kind")
    if kind == "package":
        ecosystem = raw.get("ecosystem")
        name = _text(raw.get("name"), "package signal", limit=214)
        if ecosystem not in STACK_CONTRACT["ecosystems"] or name != name.strip().lower():
            raise StackPolicyConfigError("invalid package signal")
        return Signal("package", ecosystem, name)
    if kind == "file":
        pattern = _text(raw.get("pattern"), "file signal", limit=100)
        if not _FILE_PATTERN.match(pattern) or "**" in pattern:
            raise StackPolicyConfigError("invalid file signal")
        return Signal("file", "", pattern)
    if kind == "source":
        extension = _text(raw.get("extension"), "source signal", limit=11)
        if not _SOURCE_EXTENSION.match(extension):
            raise StackPolicyConfigError("invalid source signal")
        return Signal("source", "", extension)
    if kind == "manifest":
        value = raw.get("value")
        if value not in STACK_CONTRACT["dataStoreKinds"]:
            raise StackPolicyConfigError("invalid manifest signal")
        return Signal("manifest", "", value)
    raise StackPolicyConfigError("invalid stack policy signal kind")


def _parse_rule(raw: Any) -> StackRule:
    if not hasattr(raw, "get"):
        raise StackPolicyConfigError("invalid stack policy rule")
    verdict = raw.get("verdict")
    blocking = raw.get("blocking")
    revision = raw.get("componentRevision")
    if (
        verdict not in _VERDICTS
        or not isinstance(blocking, bool)
        or (blocking and verdict != "forbid")
    ):
        raise StackPolicyConfigError("invalid stack policy verdict")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise StackPolicyConfigError("invalid component revision")
    signals = tuple(
        _parse_signal(signal)
        for signal in _sequence(raw.get("signals"), "rule signals", limit=MAX_SIGNALS_PER_RULE)
    )
    if not signals:
        raise StackPolicyConfigError("a stack policy rule needs at least one signal")
    raw_scopes = raw.get("repoScopes")
    scopes = None
    if raw_scopes is not None:
        scopes = frozenset(
            _text(scope, "repository scope", limit=512).strip().lower()
            for scope in _sequence(raw_scopes, "repository scopes", limit=MAX_STACK_RULES)
        )
        if not scopes:
            raise StackPolicyConfigError("invalid repository scopes")
    return StackRule(
        component_id=_text(raw.get("componentId"), "component id", limit=200),
        component_revision=revision,
        component_name=_text(raw.get("componentName"), "component name", limit=200),
        category_id=_text(raw.get("categoryId"), "category id", limit=64),
        category_name=_text(raw.get("categoryName"), "category name", limit=200),
        verdict=cast("Verdict", verdict),
        blocking=blocking,
        signals=signals,
        guidance=_text(
            raw.get("guidance"), "guidance", limit=MAX_RULE_TEXT_CHARS, allow_empty=True
        ),
        repo_scopes=scopes,
    )


def parse_stack_policy(session_config: Mapping[str, Any]) -> StackPolicy | None:
    """Strict, bounded parse of ``SESSION_CONFIG["stack_policy"]``. Absent means no policy."""
    raw = session_config.get("stack_policy")
    if raw is None:
        return None
    if not hasattr(raw, "get") or raw.get("schemaVersion") != STACK_CONTRACT["schemaVersion"]:
        raise StackPolicyConfigError("unsupported stack policy schema")
    attempts = raw.get("maxRemediationAttempts")
    if (
        isinstance(attempts, bool)
        or not isinstance(attempts, int)
        or not 0 <= attempts <= MAX_REMEDIATION_ATTEMPTS
    ):
        raise StackPolicyConfigError("invalid stack policy remediation attempts")
    return StackPolicy(
        digest=_text(raw.get("digest"), "stack policy digest", limit=200),
        instructions=_text(
            raw.get("instructions"), "stack policy instructions", limit=MAX_INSTRUCTIONS_CHARS
        ),
        max_remediation_attempts=attempts,
        rules=tuple(
            _parse_rule(rule)
            for rule in _sequence(raw.get("rules"), "stack policy rules", limit=MAX_STACK_RULES)
        ),
    )


# ---- Judgment ------------------------------------------------------------------------------------


class Origin(enum.Enum):
    BASELINE = "baseline"  # the hit's (signal, path) exists in the session's baseline
    INTRODUCED = "introduced"  # it does not


@dataclass(frozen=True)
class Baseline:
    """What existed before the session, reduced to what judgment needs."""

    keys: frozenset[HitKey]
    project_dirs: frozenset[PurePosixPath]
    unreadable: frozenset[PurePosixPath]
    truncated: bool

    @classmethod
    def of(cls, policy: StackPolicy, repo_full_name: str | None, facts: TreeFacts) -> Baseline:
        return cls(
            frozenset(hit.key for hit in policy.hits(facts, repo_full_name)),
            facts.project_dirs,
            frozenset(facts.unreadable),
            facts.truncated,
        )

    def __and__(self, other: Baseline) -> Baseline:
        """Pre-existing in both trees. Never more lenient than either."""
        return Baseline(
            self.keys & other.keys,
            self.project_dirs & other.project_dirs,
            self.unreadable & other.unreadable,
            self.truncated and other.truncated,
        )


#: Nothing pre-existed: a scratch workspace, unrelated history, or a baseline that cannot be read.
EMPTY_BASELINE: Final = Baseline(frozenset(), frozenset(), frozenset(), False)


def _project_dir(
    path: PurePosixPath, project_dirs: frozenset[PurePosixPath]
) -> PurePosixPath | None:
    return next(
        (
            directory
            for directory in (path.parent, *path.parent.parents)
            if directory in project_dirs
        ),
        None,
    )


@dataclass(frozen=True)
class StackFinding:
    hit: SignalHit
    origin: Origin
    #: The hit's project directory when the session created that project, else None.
    new_project: PurePosixPath | None
    #: The preferred rule of the hit's category, when one is in scope.
    preferred: StackRule | None

    @property
    def severity(self) -> Severity:
        """The sandbox's whole decision table; verdict already encodes stance, lifecycle and
        enforcement, so only origin and the new-project condition are added here."""
        rule = self.hit.rule
        if rule.verdict == "forbid":
            if self.origin is Origin.BASELINE:
                return "legacy"
            return "violation" if rule.blocking else "advisory"
        if rule.verdict == "prefer":
            return "standard"
        if (
            self.origin is Origin.INTRODUCED
            and self.new_project is not None
            and self.preferred is not None
        ):
            return "deviation"
        return "alternative"


def _evidence(hit: SignalHit) -> str:
    if hit.signal.kind == "package":
        return f"`{hit.subject}` was added to `{hit.path}` ({hit.scope} dependency)"
    if hit.signal.kind == "manifest":
        return f"`{hit.path}` declares a `{hit.subject}` data store"
    return f"`{hit.path}` was added"


@dataclass(frozen=True)
class StackConformanceResult:
    """One repository's evaluation. Satisfies ``security_pipeline.CheckResult``."""

    target: CheckTarget
    #: The commit judged (pre-push); None for the worktree or a scan that failed.
    commit_sha: str | None
    findings: tuple[StackFinding, ...]
    facts: TreeFacts
    any_blocking_rule: bool
    #: Incompleteness the baseline did not already have: a new unreadable manifest, a failed scan.
    new_gaps: tuple[str, ...]

    def _with_severity(self, *severities: Severity) -> list[StackFinding]:
        return [finding for finding in self.findings if finding.severity in severities]

    @property
    def _gaps_block(self) -> bool:
        return bool(self.new_gaps) and self.any_blocking_rule

    @property
    def passed(self) -> bool:
        return not self._with_severity("violation", "advisory") and not self._gaps_block

    @property
    def blocking(self) -> bool:
        return bool(self._with_severity("violation")) or self._gaps_block

    @property
    def deviations(self) -> list[StackFinding]:
        return self._with_severity("deviation")

    def remediation_section(self) -> str:
        """Only introduced denials and new gaps; preferences never prompt here."""
        paragraphs = ["## Organization technology standards"]
        by_rule: dict[StackRule, list[StackFinding]] = {}
        for finding in self._with_severity("violation", "advisory"):
            by_rule.setdefault(finding.hit.rule, []).append(finding)
        for rule, findings in by_rule.items():
            lines = [f"- {_evidence(f.hit)}." for f in findings[:MAX_EVIDENCE_LINES_PER_RULE]]
            if len(findings) > MAX_EVIDENCE_LINES_PER_RULE:
                lines.append(f"- and {len(findings) - MAX_EVIDENCE_LINES_PER_RULE} more.")
            preferred = findings[0].preferred
            verdict = f"{rule.component_name} is not allowed for {rule.category_name} in this organization."
            if rule.guidance.strip():
                verdict += f" {rule.guidance.strip()}"
            if preferred is not None:
                verdict += f"\nUse instead: {preferred.component_name}."
                if preferred.guidance.strip():
                    verdict += f" {preferred.guidance.strip()}"
            action = f"Remove {rule.component_name} and any code that relies on it"
            action += f", then build with {preferred.component_name}." if preferred else "."
            paragraphs.append("\n".join([*lines, verdict, action]))
        if self._gaps_block:
            paragraphs.append(
                "These could not be checked against the standards: "
                + "; ".join(self.new_gaps)
                + ". Make each manifest valid (JSON or TOML) and within size limits."
            )
        return "\n\n".join(paragraphs)

    def summary(self) -> str:
        """Plain language for a member-visible turn or push error."""
        names = sorted(
            {
                f"{f.hit.rule.component_name} ({f.hit.rule.category_name})"
                for f in self._with_severity("violation")
            }
        )
        if names:
            return (
                "This change uses technology your organization does not allow, and it is still "
                f"there after the agent tried to remove it: {', '.join(names)}."
            )
        return (
            "This change could not be checked against your organization's technology standards: "
            + "; ".join(self.new_gaps)
            + "."
        )


def evaluate(
    policy: StackPolicy,
    target: CheckTarget,
    current: TreeFacts,
    baseline: Baseline,
    *,
    commit_sha: str | None = None,
) -> StackConformanceResult:
    """Pure. A hit is pre-existing only when its (signal, path) key is in the baseline."""
    repo_full_name = target.repo_full_name
    rules = policy.rules_for(repo_full_name)
    preferred: dict[str, StackRule] = {}
    for rule in rules:
        if rule.verdict == "prefer":
            preferred.setdefault(rule.category_id, rule)
    findings = []
    for hit in policy.hits(current, repo_full_name):
        project = _project_dir(hit.path, current.project_dirs)
        findings.append(
            StackFinding(
                hit,
                Origin.BASELINE if hit.key in baseline.keys else Origin.INTRODUCED,
                project if project is not None and project not in baseline.project_dirs else None,
                preferred.get(hit.rule.category_id),
            )
        )
    gaps = [
        f"`{path}` could not be read"
        for path in current.unreadable
        if path not in baseline.unreadable
    ]
    if current.truncated and not baseline.truncated:
        gaps.append(f"the tree lists more than {MAX_LISTED_PATHS} files")
    return StackConformanceResult(
        target=target,
        commit_sha=commit_sha,
        findings=tuple(findings),
        facts=current,
        any_blocking_rule=any(rule.blocking for rule in rules),
        new_gaps=tuple(gaps),
    )


# ---- Stage ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class StackNudge:
    """One advisory round for preference deviations in projects the session created."""

    text: str
    keys: frozenset[tuple[str, str, str]]


def render_nudge(findings: Sequence[StackFinding]) -> str:
    """Rendered from rule data. Never counts toward ``blocking`` or ``passed``."""
    lines = ["## Organization technology standards (preference)"]
    for finding in findings:
        preferred = finding.preferred
        assert preferred is not None
        guidance = f" ({preferred.guidance.strip()})" if preferred.guidance.strip() else ""
        lines.append(
            f"You introduced `{finding.hit.path}`; this organization prefers "
            f"{preferred.component_name} for {finding.hit.rule.category_name}. Unless the user "
            f"explicitly asked for {finding.hit.rule.component_name}, switch to "
            f"{preferred.component_name}{guidance} and remove `{finding.hit.path}`. Then continue."
        )
    return "\n\n".join(lines)


async def head_commit(checkout: Path) -> str | None:
    """HEAD's commit, or None when HEAD is unborn."""
    code, out = await run_git(
        checkout, "rev-parse", "--verify", "-q", "HEAD^{commit}", accepted_return_codes=(0, 1)
    )
    return out.decode().strip() if code == 0 else None


async def resolve_commit(checkout: Path, revision: str) -> str:
    _, out = await run_git(
        checkout, "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"
    )
    return out.decode().strip()


async def merge_base(checkout: Path, left: str, right: str) -> str | None:
    """Their best common ancestor, or None for unrelated histories."""
    code, out = await run_git(checkout, "merge-base", left, right, accepted_return_codes=(0, 1))
    return out.decode().strip() if code == 0 else None


class StackConformanceStage:
    """Built-in stage hosted by ``SecurityPipelineRunner``.

    The baseline is the session's ``base_sha`` intersected with the subject's merge-base with it,
    so a finding is pre-existing only when the session started with it and the subject's history
    did too. When the subject descends from ``base_sha`` (the normal case) the two are one commit.
    Baseline facts are memoized per commit: commits are immutable, so the memo never goes stale.
    """

    def __init__(self, policy: StackPolicy, log: Any) -> None:
        self.policy = policy
        self.log = log
        self._facts: dict[tuple[Path, str], asyncio.Task[TreeFacts]] = {}
        self._fallback_bases: dict[Path, str | None] = {}
        self._nudged: set[tuple[str, str, str]] = set()

    @classmethod
    def from_session_config(
        cls, session_config_json: str, log: Any
    ) -> StackConformanceStage | None:
        try:
            document = json.loads(session_config_json or "{}")
        except json.JSONDecodeError as error:
            raise StackPolicyConfigError("SESSION_CONFIG is not valid JSON") from error
        if not isinstance(document, dict):
            raise StackPolicyConfigError("SESSION_CONFIG must be an object")
        policy = parse_stack_policy(document)
        return cls(policy, log) if policy is not None else None

    async def facts_at(self, checkout: Path, commit: str) -> TreeFacts:
        key = (checkout, commit)
        task = self._facts.get(key)
        if task is None:
            task = asyncio.ensure_future(collect_tree_facts(CommitSource(checkout, commit)))
            self._facts[key] = task
        try:
            return await asyncio.shield(task)
        except BaseException:
            if task.done() and (task.cancelled() or task.exception() is not None):
                self._facts.pop(key, None)
            raise

    async def base_commit(self, target: CheckTarget) -> str | None:
        """``base_sha`` from the repo manifest. Without one (sessions that predate it), the first
        HEAD this process sees, which the bridge resolves when it announces readiness."""
        if target.base_sha:
            return target.base_sha.lower()
        if target.checkout not in self._fallback_bases:
            self._fallback_bases[target.checkout] = await head_commit(target.checkout)
            self.log.warn(
                "stack_policy.baseline_fallback",
                repo=target.repo_full_name,
                commit_sha=self._fallback_bases[target.checkout],
            )
        return self._fallback_bases[target.checkout]

    async def baseline(self, target: CheckTarget, subject_commit: str | None) -> Baseline:
        repo_full_name = target.repo_full_name
        try:
            base = await self.base_commit(target)
            if base is None:
                return EMPTY_BASELINE
            at_base = Baseline.of(
                self.policy, repo_full_name, await self.facts_at(target.checkout, base)
            )
            fork = (
                await merge_base(target.checkout, subject_commit, base) if subject_commit else None
            )
            if fork == base:
                return at_base
            if fork is None:
                self.log.warn("stack_policy.baseline_unrelated", repo=repo_full_name)
                return EMPTY_BASELINE
            at_fork = Baseline.of(
                self.policy, repo_full_name, await self.facts_at(target.checkout, fork)
            )
            return at_base & at_fork
        except TreeScanError as error:
            # Fail closed: every denied hit counts as introduced.
            self.log.warn(
                "stack_policy.baseline_unavailable", repo=repo_full_name, error=str(error)
            )
            return EMPTY_BASELINE

    async def check(self, target: CheckTarget) -> StackConformanceResult:
        """Per turn (``revision`` None): the worktree. Pre-push: the pushed commit's tree."""
        is_checkout = (target.checkout / ".git").exists()
        try:
            if target.revision is None:
                subject = await head_commit(target.checkout) if is_checkout else None
                source = (
                    WorktreeSource(target.checkout)
                    if is_checkout
                    else DirectorySource(target.checkout)
                )
                current, commit_sha = await collect_tree_facts(source), None
            else:
                subject = await resolve_commit(target.checkout, target.revision)
                current = await collect_tree_facts(CommitSource(target.checkout, subject))
                commit_sha = subject
        except TreeScanError as error:
            self.log.warn("stack_policy.scan_failed", repo=target.repo_full_name, error=str(error))
            rules = self.policy.rules_for(target.repo_full_name)
            return StackConformanceResult(
                target,
                None,
                (),
                EMPTY_TREE_FACTS,
                any(rule.blocking for rule in rules),
                (f"the repository could not be scanned ({error})",),
            )
        baseline = await self.baseline(target, subject) if is_checkout else EMPTY_BASELINE
        result = evaluate(self.policy, target, current, baseline, commit_sha=commit_sha)
        self.log.info(
            "stack_policy.checked",
            repo=target.repo_full_name,
            revision=target.revision,
            findings=len(result.findings),
            passed=result.passed,
            blocking=result.blocking,
        )
        return result

    def pending_nudge(self, results: Iterable[StackConformanceResult]) -> StackNudge | None:
        """Deviations not yet nudged this session, one per (repository, signal, project)."""
        pending: dict[tuple[str, str, str], StackFinding] = {}
        for result in results:
            for finding in result.deviations:
                key = (
                    result.target.repo_full_name or "",
                    finding.hit.signal.key,
                    str(finding.new_project),
                )
                if key not in self._nudged:
                    pending.setdefault(key, finding)
        if not pending:
            return None
        return StackNudge(render_nudge(list(pending.values())), frozenset(pending))

    def acknowledge(self, nudge: StackNudge) -> None:
        """The nudge reached the agent; never repeat it this session."""
        self._nudged |= nudge.keys
