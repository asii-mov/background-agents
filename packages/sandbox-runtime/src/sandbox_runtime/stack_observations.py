"""Stack observations: raw facts the sandbox reports to the control plane for adoption tracking.

The control plane matches facts against the current catalogue at read time, so a signal added
later reclassifies every observed repository without a rescan. Reporting is best-effort.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Final, Literal
from urllib.parse import quote

import httpx

from .stack_facts import STACK_CONTRACT, TreeFacts, is_toolchain_file
from .stack_policy import SignalIndex

if TYPE_CHECKING:
    from .security_pipeline import CheckTarget
    from .stack_policy import StackConformanceResult, StackConformanceStage, StackPolicy

OBSERVATION_TIMEOUT_SECONDS = 15.0
_COMMIT_SHA: Final = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")


def _fits(fact: dict[str, Any]) -> bool:
    limits = {
        "name": 214,
        "manifestPath": 1024,
        "path": 1024,
        "declaredRange": 200,
        "resolvedVersion": 200,
    }
    return all(
        not isinstance(fact.get(field), str) or 0 < len(fact[field]) <= limit
        for field, limit in limits.items()
    )


def observation_facts(
    policy: StackPolicy, repo_full_name: str | None, facts: TreeFacts
) -> tuple[list[dict[str, Any]], bool]:
    """Raw facts, so the control plane re-matches them at read time: all direct packages;
    transitive packages matching a rule; file facts for well-known toolchain files plus any path
    matching a compiled file signal; one count per source extension; one fact per declared data
    store. Capped at ``maxObservedFacts``, direct packages dropped last. Returns (facts, complete)."""
    index = SignalIndex(policy.rules_for(repo_full_name))
    versions = {
        (r.ecosystem, r.lockfile_path.parent, r.name): r.version for r in facts.resolved if r.direct
    }
    direct = [
        {
            "kind": "package",
            "ecosystem": d.ecosystem,
            "name": d.name,
            "manifestPath": str(d.manifest_path),
            "scope": d.scope,
            "declaredRange": d.declared_range,
            "resolvedVersion": versions.get((d.ecosystem, d.manifest_path.parent, d.name)),
        }
        for d in facts.declared
    ]
    stores = [{"kind": "manifest", "value": s.kind, "path": str(s.path)} for s in facts.data_stores]
    files = [
        {"kind": "file", "path": str(path), "derived": path in facts.derived}
        for path in facts.paths
        if is_toolchain_file(path) or index.match("file", "", path.name) is not None
    ]
    sources = [
        {"kind": "source", "extension": extension, "fileCount": len(paths)}
        for extension, paths in facts.sources.items()
    ]
    transitive = [
        {
            "kind": "package",
            "ecosystem": r.ecosystem,
            "name": r.name,
            "manifestPath": str(r.lockfile_path),
            "scope": "transitive",
            "declaredRange": None,
            "resolvedVersion": r.version,
        }
        for r in facts.resolved
        if not r.direct and index.match("package", r.ecosystem, r.name) is not None
    ]
    ordered: list[dict[str, Any]] = [*direct, *stores, *files, *sources, *transitive]
    kept = [fact for fact in ordered if _fits(fact)][: STACK_CONTRACT["maxObservedFacts"]]
    return kept, facts.complete and len(kept) == len(ordered)


class StackObservationReporter:
    """``POST /sessions/{id}/stack-observations`` with the sandbox token. Best-effort: a failure is
    logged (``stack_policy.observation_failed``) and never fails a turn or a push."""

    def __init__(
        self,
        stage: StackConformanceStage,
        *,
        control_plane_url: str,
        session_id: str,
        auth_token: str,
        log: Any,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.stage = stage
        self.url = (
            f"{control_plane_url.rstrip('/')}/sessions/{quote(session_id, safe='')}"
            "/stack-observations"
        )
        self.auth_token = auth_token
        self.log = log
        self.transport = transport
        self._baselines_reported: set[tuple[str, str]] = set()

    async def report_baseline(self, target: CheckTarget, ref_name: str) -> None:
        """Once per (repository, base commit) for this process."""
        try:
            commit = await self.stage.base_commit(target)
            reported_key = ((target.repo_full_name or "").lower(), commit or "")
            if commit is None or reported_key in self._baselines_reported:
                return
            self._baselines_reported.add(reported_key)
            facts = await self.stage.facts_at(target.checkout, commit)
            await self._post(target, ref_name, commit, "baseline", facts)
        except Exception as error:
            self.log.warn("stack_policy.observation_failed", kind="baseline", error=str(error))

    async def report_push(self, result: StackConformanceResult, ref_name: str) -> None:
        """Reuses the facts the pre-push gate collected; no rescan."""
        if result.commit_sha is None:
            return
        try:
            await self._post(result.target, ref_name, result.commit_sha, "push", result.facts)
        except Exception as error:
            self.log.warn("stack_policy.observation_failed", kind="push", error=str(error))

    async def _post(
        self,
        target: CheckTarget,
        ref_name: str,
        commit_sha: str,
        kind: Literal["baseline", "push"],
        facts: TreeFacts,
    ) -> None:
        if not (target.repo_owner and target.repo_name and _COMMIT_SHA.match(commit_sha)):
            return
        observed, complete = observation_facts(self.stage.policy, target.repo_full_name, facts)
        body = {
            "repository": {"repoOwner": target.repo_owner, "repoName": target.repo_name},
            "refName": ref_name,
            "commitSha": commit_sha,
            "kind": kind,
            "complete": complete,
            "policyDigest": self.stage.policy.digest,
            "facts": observed,
        }
        async with httpx.AsyncClient(transport=self.transport) as client:
            response = await client.post(
                self.url,
                json=body,
                headers={"Authorization": f"Bearer {self.auth_token}"},
                timeout=OBSERVATION_TIMEOUT_SECONDS,
            )
        if response.status_code >= 400:
            self.log.warn("stack_policy.observation_failed", kind=kind, status=response.status_code)
            return
        self.log.info("stack_policy.observed", kind=kind, facts=len(observed), complete=complete)
