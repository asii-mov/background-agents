"""A Claude session's pull-request push runs the session's pipelines and stack policy.

Claude's create-pull-request tool calls the control plane's ``POST /pr``, which sends this bridge a
``push`` command. Nothing on that path depends on the harness, so a Claude session is governed
exactly like an OpenCode one.
"""

import json
import sys
from pathlib import Path

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness import HarnessId
from sandbox_runtime.runtime_config import RuntimeConfig
from tests.conftest import ScriptedHarness
from tests.stack_fixtures import commit, git, init_repo, package_json, policy_payload


class ClaudeScriptedHarness(ScriptedHarness):
    id = HarnessId.CLAUDE


def _pipeline(exit_code: int) -> dict:
    return {
        "id": "appsec",
        "name": "AppSec",
        "blocking": True,
        "maxRemediationAttempts": 0,
        "repoScopes": None,
        "commands": [
            {
                "name": "scan",
                "command": [sys.executable, "-c", f"raise SystemExit({exit_code})"],
                "timeoutSeconds": 30,
            }
        ],
    }


class ClaudeSession:
    def __init__(self, tmp_path: Path, monkeypatch, *, pipeline_exit_code: int = 0) -> None:
        self.repo = tmp_path / "workspace" / "web"
        base = init_repo(self.repo, {"package.json": package_json(svelte="^5")})
        self.remote = tmp_path / "remote.git"
        git(tmp_path, "init", "-q", "--bare", str(self.remote))
        session_config = json.dumps(
            {
                "harness": "claude",
                "security_pipelines": [_pipeline(pipeline_exit_code)],
                "stack_policy": policy_payload(),
            }
        )
        monkeypatch.setenv("SESSION_CONFIG", session_config)
        RuntimeConfig.from_env({"SESSION_CONFIG": session_config})
        self.bridge = AgentBridge(
            sandbox_id="sandbox-1",
            session_id="session-1",
            control_plane_url="https://control.example.com",
            auth_token="sandbox-token",
            harness_id=HarnessId.CLAUDE,
            harness=ClaudeScriptedHarness(),
        )
        self.bridge.stack_observations = None
        self.bridge.repo_manifest_path.write_text(
            json.dumps(
                {
                    "repositories": [
                        {
                            "owner": "acme",
                            "name": "web",
                            "branch": "main",
                            "path": str(self.repo),
                            "baseSha": base,
                        }
                    ]
                }
            )
        )

    async def push(self) -> dict:
        return await self.bridge._handle_push(
            {
                "pushSpec": {
                    "targetBranch": "feature",
                    "refspec": "HEAD:refs/heads/feature",
                    "remoteUrl": str(self.remote),
                    "redactedRemoteUrl": str(self.remote),
                    "force": False,
                    "repoOwner": "acme",
                    "repoName": "web",
                }
            }
        )

    def pushed_branches(self) -> str:
        return git(self.remote, "for-each-ref", "refs/heads")


async def test_a_conforming_claude_push_reaches_the_remote(tmp_path, monkeypatch):
    session = ClaudeSession(tmp_path, monkeypatch)
    commit(session.repo, {"bun.lock": "{}"})

    event = await session.push()

    assert event["type"] == "push_complete"
    assert "refs/heads/feature" in session.pushed_branches()


async def test_the_stack_policy_rejects_a_claude_push_before_git_push(tmp_path, monkeypatch):
    session = ClaudeSession(tmp_path, monkeypatch)
    commit(session.repo, {"package.json": package_json(react="^18")})

    event = await session.push()

    assert event["type"] == "push_error"
    assert "React" in event["error"]
    assert session.pushed_branches() == ""


async def test_a_failing_pipeline_rejects_a_claude_push_before_git_push(tmp_path, monkeypatch):
    session = ClaudeSession(tmp_path, monkeypatch, pipeline_exit_code=1)
    commit(session.repo, {"bun.lock": "{}"})

    event = await session.push()

    assert event["type"] == "push_error"
    assert session.pushed_branches() == ""
