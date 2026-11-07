"""The bridge enforces the stack policy after each turn and reports observations, silently."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.stack_policy import StackPolicyConfigError
from tests.conftest import ScriptedHarness
from tests.stack_fixtures import (
    commit,
    git,
    init_repo,
    package_json,
    policy_payload,
    seed_rules,
    write,
)

REACT = package_json(react="^18")


class Workspace:
    """A session with one real repository and a scripted agent."""

    def __init__(self, tmp_path: Path, monkeypatch, *, attempts: int = 1, rules=None) -> None:
        self.repo = tmp_path / "workspace" / "web"
        self.base = init_repo(self.repo, {"package.json": package_json(svelte="^5")})
        monkeypatch.setenv(
            "SESSION_CONFIG",
            json.dumps({"stack_policy": policy_payload(rules, attempts=attempts)}),
        )
        self.on_prompt: list[dict[str, str | None]] = []
        self.harness = ScriptedHarness(self._stream)
        self.bridge = AgentBridge(
            sandbox_id="sandbox-1",
            session_id="session-1",
            control_plane_url="https://control.example.com",
            auth_token="sandbox-token",
            harness=self.harness,
        )
        self.bridge._configure_git_identity = AsyncMock()
        self.bridge._send_event = AsyncMock(return_value=True)
        self.bridge.session_id_file = tmp_path / "agent-session-id"
        self.bridge.repo_manifest_path.write_text(
            json.dumps(
                {
                    "repositories": [
                        {
                            "owner": "acme",
                            "name": "web",
                            "branch": "main",
                            "path": str(self.repo),
                            "baseSha": self.base,
                        }
                    ]
                }
            )
        )
        self.posted: list[dict] = []
        self.observation_status = 200
        assert self.bridge.stack_observations is not None
        self.bridge.stack_observations.transport = httpx.MockTransport(self._observe)

    async def _stream(self, message_id: str, _text: str):
        write(self.repo, self.on_prompt.pop(0) if self.on_prompt else {})
        yield {"type": "token", "messageId": message_id, "content": "done"}

    def _observe(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/sessions/session-1/stack-observations"
        assert request.headers["Authorization"] == "Bearer sandbox-token"
        self.posted.append(json.loads(request.content))
        return httpx.Response(self.observation_status, json={})

    async def turn(self, *changes: dict[str, str | None]) -> dict:
        self.on_prompt = list(changes)
        return await self.bridge._handle_prompt(
            {
                "messageId": "msg-1",
                "content": "Build the tracker",
                "author": {"gitIdentity": {"mode": "agent-only"}},
            }
        )

    @property
    def prompts(self) -> list[str]:
        return [prompt.text for prompt in self.harness.prompts]

    @property
    def warnings(self) -> list[dict]:
        events = [call.args[0] for call in self.bridge._send_event.await_args_list]
        return [event for event in events if event.get("type") == "warning"]

    async def settle_observations(self) -> None:
        await asyncio.gather(*list(self.bridge._observation_tasks))


@pytest.fixture
def workspace(tmp_path, monkeypatch) -> Workspace:
    return Workspace(tmp_path, monkeypatch)


async def test_a_violation_the_agent_cannot_remove_fails_the_turn_silently(workspace):
    complete = await workspace.turn({"package.json": REACT}, {})

    assert len(workspace.prompts) == 2
    assert "`react` was added to `package.json`" in workspace.prompts[1]
    assert "Use instead: Svelte." in workspace.prompts[1]
    assert complete == {
        "type": "execution_complete",
        "messageId": "msg-1",
        "success": False,
        "error": (
            "This change uses technology your organization does not allow, and it is still there "
            "after the agent tried to remove it: React (Web frontend)."
        ),
    }
    assert workspace.warnings == []


async def test_a_violation_the_agent_removes_ends_the_turn_successfully(workspace):
    complete = await workspace.turn(
        {"package.json": REACT}, {"package.json": package_json(svelte="^5")}
    )

    assert len(workspace.prompts) == 2
    assert complete["success"] is True
    assert workspace.warnings == []


async def test_legacy_react_never_prompts_or_fails_a_turn(tmp_path, monkeypatch):
    workspace = Workspace(tmp_path, monkeypatch)
    workspace.base = commit(workspace.repo, {"legacy/package.json": REACT}, "legacy")
    manifest = json.loads(workspace.bridge.repo_manifest_path.read_text())
    manifest["repositories"][0]["baseSha"] = workspace.base
    workspace.bridge.repo_manifest_path.write_text(json.dumps(manifest))

    complete = await workspace.turn({"src/app.ts": "export {}\n"})

    assert workspace.prompts == ["Build the tracker"]
    assert complete["success"] is True


async def test_a_new_npm_project_gets_one_nudge_per_session_and_no_events(workspace):
    first = await workspace.turn(
        {"tracker/package.json": package_json(svelte="^5"), "tracker/package-lock.json": "{}"}
    )
    second = await workspace.turn({"tracker/src/app.ts": "export {}\n"})

    assert first["success"] is True
    assert second["success"] is True
    nudges = [text for text in workspace.prompts if "prefers Bun" in text]
    assert len(nudges) == 1
    assert "You introduced `tracker/package-lock.json`" in nudges[0]
    assert workspace.prompts.count("Build the tracker") == 2
    assert len(workspace.prompts) == 3
    assert workspace.warnings == []


async def test_command_pipelines_still_announce_their_results(tmp_path, monkeypatch):
    import sys

    workspace = Workspace(tmp_path, monkeypatch)
    from sandbox_runtime.security_pipeline import parse_security_pipelines

    workspace.bridge.security_pipelines.pipelines = parse_security_pipelines(
        json.dumps(
            {
                "security_pipelines": [
                    {
                        "id": "p",
                        "name": "AppSec",
                        "blocking": True,
                        "maxRemediationAttempts": 1,
                        "repoScopes": None,
                        "commands": [
                            {
                                "name": "ok",
                                "command": [sys.executable, "-c", "pass"],
                                "timeoutSeconds": 10,
                            }
                        ],
                    }
                ]
            }
        )
    )

    complete = await workspace.turn({"package.json": REACT}, {"package.json": package_json()})

    assert complete["success"] is True
    assert [event["message"] for event in workspace.warnings] == [
        "Centrally managed application-security checks passed."
    ]


async def test_the_baseline_is_reported_once_per_repository_and_base(workspace):
    workspace.bridge._build_ready_event()
    workspace.bridge._build_ready_event()
    await workspace.settle_observations()

    (observation,) = workspace.posted
    assert observation["kind"] == "baseline"
    assert observation["repository"] == {"repoOwner": "acme", "repoName": "web"}
    assert observation["refName"] == "main"
    assert observation["commitSha"] == workspace.base
    assert observation["policyDigest"] == "digest-1"
    assert observation["complete"] is True
    assert {
        "kind": "package",
        "ecosystem": "npm",
        "name": "svelte",
        "manifestPath": "package.json",
        "scope": "runtime",
        "declaredRange": "^5",
        "resolvedVersion": None,
    } in observation["facts"]


async def test_a_successful_push_reports_the_pushed_commit(tmp_path, workspace):
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    pushed = commit(workspace.repo, {"bun.lock": "{}"})

    event = await workspace.bridge._handle_push({"pushSpec": _push_spec(remote)})
    await workspace.settle_observations()

    assert event["type"] == "push_complete"
    (observation,) = workspace.posted
    assert observation["kind"] == "push"
    assert observation["refName"] == "feature"
    assert observation["commitSha"] == pushed
    assert {"kind": "file", "path": "bun.lock", "derived": False} in observation["facts"]


async def test_an_observation_failure_never_fails_the_push(tmp_path, workspace):
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    commit(workspace.repo, {"src/app.ts": "export {}\n"})
    workspace.observation_status = 500

    event = await workspace.bridge._handle_push({"pushSpec": _push_spec(remote)})
    await workspace.settle_observations()

    assert event["type"] == "push_complete"
    assert len(workspace.posted) == 1


async def test_a_blocked_push_reports_nothing(tmp_path, workspace):
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    commit(workspace.repo, {"package.json": REACT})

    event = await workspace.bridge._handle_push({"pushSpec": _push_spec(remote)})
    await workspace.settle_observations()

    assert event["type"] == "push_error"
    assert workspace.posted == []


def test_the_bridge_refuses_a_malformed_policy(monkeypatch):
    payload = policy_payload(seed_rules())
    payload["schemaVersion"] = 99
    monkeypatch.setenv("SESSION_CONFIG", json.dumps({"stack_policy": payload}))

    with pytest.raises(StackPolicyConfigError):
        AgentBridge(
            sandbox_id="sandbox-1",
            session_id="session-1",
            control_plane_url="https://control.example.com",
            auth_token="sandbox-token",
            harness=MagicMock(),
        )


def _push_spec(remote: Path) -> dict:
    return {
        "targetBranch": "feature",
        "refspec": "HEAD:refs/heads/feature",
        "remoteUrl": str(remote),
        "redactedRemoteUrl": str(remote),
        "force": False,
        "repoOwner": "acme",
        "repoName": "web",
    }
