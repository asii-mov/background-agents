"""The deploy-app tool: bundle packing, the control-plane exchange, and Claude registration."""

from __future__ import annotations

import copy
import email
import email.policy
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime import app_deploy
from sandbox_runtime.app_deploy import (
    APP_DEPLOY_CONTRACT,
    APP_DEPLOY_ENABLED_ENV,
    BRIDGE_ERROR_GUIDANCE,
    DeployRequest,
    EnvSessionClient,
    ToolFailure,
    deploy_app,
    pack_bundle,
    parse_args,
)
from sandbox_runtime.harness.claude_tools import (
    ControlPlaneToolClient,
    OpenInspectTools,
    ToolServerConfig,
    build_tools,
)

REASONS: dict[str, str] = APP_DEPLOY_CONTRACT["reasons"]


def _write(path: Path, content: str | bytes = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content)
    return path


def _request(project: Path, **overrides: Any) -> DeployRequest:
    values: dict[str, Any] = {
        "project_dir": project,
        "name": "budget-tracker",
        "assets_dir": project / "dist",
        "worker_file": None,
    }
    values.update(overrides)
    return DeployRequest(**values)


def _app_manifest(project: Path, manifest: dict[str, Any]) -> None:
    _write(project / "openinspect.app.json", json.dumps(manifest))


def _limits(**limits: int) -> dict[str, Any]:
    contract = copy.deepcopy(dict(APP_DEPLOY_CONTRACT))
    contract["limits"].update(limits)
    return contract


class _FakeSession:
    """A SessionClient that records the request and answers through ``respond``."""

    def __init__(self, respond: Any) -> None:
        self.respond = respond
        self.calls: list[dict[str, Any]] = []

    async def request(self, method: str, path: str, *, files=None, timeout_seconds: float):
        self.calls.append(
            {"method": method, "path": path, "files": files, "timeout": timeout_seconds}
        )
        outcome = self.respond()
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _parts(request: httpx.Request) -> list[tuple[str, str | None, bytes]]:
    """``(part name, filename, body)`` of a multipart request, in wire order."""
    raw = f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode() + request.content
    message = email.message_from_bytes(raw, policy=email.policy.HTTP)
    return [
        (
            part.get_param("name", header="content-disposition"),
            part.get_filename(),
            part.get_payload(decode=True),
        )
        for part in message.iter_parts()
    ]


# --- pack_bundle -------------------------------------------------------------


def test_assets_are_numbered_in_sorted_path_order(tmp_path: Path) -> None:
    for relative in ("index.html", "b.js", "a/x.html", "a-b.txt"):
        _write(tmp_path / "dist" / relative)

    bundle = pack_bundle(_request(tmp_path))

    assert not isinstance(bundle, ToolFailure)
    assert bundle.manifest["assets"] == [
        {"path": "/a-b.txt", "part": "a0"},
        {"path": "/a/x.html", "part": "a1"},
        {"path": "/b.js", "part": "a2"},
        {"path": "/index.html", "part": "a3"},
    ]
    assert bundle.manifest["name"] == "budget-tracker"
    assert bundle.manifest["worker"] is None
    assert bundle.manifest["app"] is None
    assert bundle.manifest["migrations"] == []


def test_dotfiles_are_skipped_except_well_known(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    _write(dist / "index.html")
    _write(dist / ".env", "SECRET=placeholder")
    _write(dist / ".git" / "config")
    _write(dist / ".well-known" / "security.txt")
    _write(dist / ".well-known" / ".hidden")

    bundle = pack_bundle(_request(tmp_path))

    assert not isinstance(bundle, ToolFailure)
    assert [asset["path"] for asset in bundle.manifest["assets"]] == [
        "/.well-known/security.txt",
        "/index.html",
    ]


def test_a_symlink_escaping_the_assets_dir_is_refused(tmp_path: Path) -> None:
    outside = _write(tmp_path / "secrets.txt", "placeholder")
    _write(tmp_path / "dist" / "index.html")
    (tmp_path / "dist" / "leak.txt").symlink_to(outside)

    failure = pack_bundle(_request(tmp_path))

    assert isinstance(failure, ToolFailure)
    assert failure.reason == "invalid_bundle"
    assert "leak.txt" in failure.message and "outside assetsDir" in failure.message


def test_a_symlink_inside_the_assets_dir_is_followed(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    _write(dist / "real" / "app.js")
    (dist / "alias").symlink_to(dist / "real")
    (dist / "loop").symlink_to(dist)

    bundle = pack_bundle(_request(tmp_path))

    assert not isinstance(bundle, ToolFailure)
    assert [asset["path"] for asset in bundle.manifest["assets"]] == [
        "/alias/app.js",
        "/real/app.js",
    ]


@pytest.mark.parametrize(
    ("limits", "files", "reason", "fragment"),
    [
        ({"maxAssetCount": 1}, {"a.txt": "x", "b.txt": "x"}, "bundle_too_large", "at most 1"),
        ({"maxAssetBytes": 3}, {"big.txt": "xxxx"}, "bundle_too_large", "/big.txt"),
        ({"maxAssetPathLength": 5}, {"long-name.txt": "x"}, "invalid_bundle", "longer than 5"),
        ({"maxRequestBytes": 200}, {"a.txt": "x" * 150}, "bundle_too_large", "limit is 200"),
    ],
)
def test_contract_limits_are_enforced_before_upload(
    tmp_path: Path, limits: dict[str, int], files: dict[str, str], reason: str, fragment: str
) -> None:
    for relative, content in files.items():
        _write(tmp_path / "dist" / relative, content)

    failure = pack_bundle(_request(tmp_path), _limits(**limits))

    assert failure == ToolFailure(reason, failure.message)
    assert fragment in failure.message


def test_the_worker_size_limit_comes_from_the_contract(tmp_path: Path) -> None:
    worker = _write(tmp_path / "worker.js", "export default {};")

    failure = pack_bundle(
        _request(tmp_path, assets_dir=None, worker_file=worker), _limits(maxWorkerBytes=4)
    )

    assert isinstance(failure, ToolFailure)
    assert failure.reason == "bundle_too_large"
    assert "workerFile" in failure.message


def test_app_manifest_and_migrations_travel_with_the_bundle(tmp_path: Path) -> None:
    _write(tmp_path / "dist" / "index.html")
    worker = _write(tmp_path / "worker.js", "export default {};")
    _app_manifest(
        tmp_path,
        {
            "schemaVersion": 1,
            "name": "budget-tracker",
            "data": {
                "NOTES": {"kind": "d1"},
                "AUDIT": {"kind": "d1", "migrations": "db/audit"},
                "CACHE": {"kind": "kv"},
            },
        },
    )
    _write(tmp_path / "migrations" / "0002_add-tags.sql", "ALTER TABLE notes ADD tags TEXT;")
    _write(tmp_path / "migrations" / "0001_create-notes.sql", "CREATE TABLE notes (id TEXT);")
    _write(tmp_path / "migrations" / "README.md", "not a migration")
    _write(tmp_path / "db" / "audit" / "0001_create-log.sql", "CREATE TABLE log (id TEXT);")

    bundle = pack_bundle(_request(tmp_path, worker_file=worker))

    assert not isinstance(bundle, ToolFailure)
    assert bundle.manifest["app"] == {"part": "app"}
    assert bundle.manifest["worker"] == {"part": "worker"}
    assert bundle.manifest["migrations"] == [
        {"binding": "AUDIT", "name": "0001_create-log.sql", "part": "m0"},
        {"binding": "NOTES", "name": "0001_create-notes.sql", "part": "m1"},
        {"binding": "NOTES", "name": "0002_add-tags.sql", "part": "m2"},
    ]
    assert [part.field for part in bundle.parts] == ["app", "m0", "m1", "m2", "a0", "worker"]


def test_a_misnamed_migration_is_an_agent_facing_error(tmp_path: Path) -> None:
    _write(tmp_path / "dist" / "index.html")
    _app_manifest(tmp_path, {"schemaVersion": 1, "name": "notes", "data": {"DB": {"kind": "d1"}}})
    _write(tmp_path / "migrations" / "init.sql", "CREATE TABLE t (id TEXT);")

    failure = pack_bundle(_request(tmp_path, name=None))

    assert isinstance(failure, ToolFailure)
    assert failure.reason == "invalid_bundle"
    assert "migrations/init.sql" in failure.message and "Rename the file" in failure.message


def test_a_migrations_dir_outside_the_project_is_refused(tmp_path: Path) -> None:
    project = tmp_path / "app"
    _write(project / "dist" / "index.html")
    _app_manifest(
        project,
        {"schemaVersion": 1, "name": "notes", "data": {"DB": {"kind": "d1", "migrations": ".."}}},
    )

    failure = pack_bundle(_request(project, name=None))

    assert isinstance(failure, ToolFailure)
    assert failure.reason == "data_manifest_invalid"


def test_name_may_come_from_the_app_manifest_alone(tmp_path: Path) -> None:
    _write(tmp_path / "dist" / "index.html")
    _app_manifest(tmp_path, {"schemaVersion": 1, "name": "notes"})

    bundle = pack_bundle(_request(tmp_path, name=None))

    assert not isinstance(bundle, ToolFailure)
    assert "name" not in bundle.manifest
    assert bundle.manifest["app"] == {"part": "app"}


@pytest.mark.parametrize(
    ("manifest", "name", "reason"),
    [
        (None, None, "invalid_name"),
        ({"schemaVersion": 1, "name": "notes"}, "other", "invalid_bundle"),
        ("{not json", None, "data_manifest_invalid"),
        ("[]", None, "data_manifest_invalid"),
    ],
)
def test_name_and_app_manifest_problems_are_reported(
    tmp_path: Path, manifest: Any, name: str | None, reason: str
) -> None:
    _write(tmp_path / "dist" / "index.html")
    if isinstance(manifest, str):
        _write(tmp_path / "openinspect.app.json", manifest)
    elif manifest is not None:
        _app_manifest(tmp_path, manifest)

    failure = pack_bundle(_request(tmp_path, name=name))

    assert isinstance(failure, ToolFailure)
    assert failure.reason == reason


# --- parse_args --------------------------------------------------------------


def test_paths_resolve_inside_project_dir(tmp_path: Path) -> None:
    _write(tmp_path / "web" / "dist" / "index.html")
    _write(tmp_path / "web" / "worker" / "index.js")

    request = parse_args(
        {"projectDir": "web", "assetsDir": "dist", "workerFile": "worker/index.js"}, tmp_path
    )

    assert request == DeployRequest(
        project_dir=tmp_path / "web",
        name=None,
        assets_dir=tmp_path / "web" / "dist",
        worker_file=tmp_path / "web" / "worker" / "index.js",
    )


@pytest.mark.parametrize(
    ("raw", "fragment"),
    [
        ({"name": "notes"}, "Pass assetsDir"),
        ({"assetsDir": "missing"}, "Run the build first"),
        ({"workerFile": "missing.js"}, "Bundle the Worker"),
        ({"assetsDir": "dist", "token": "x"}, "Unknown argument"),
        ({"assetsDir": 3}, "must be a string"),
    ],
)
def test_bad_arguments_are_explained(tmp_path: Path, raw: dict[str, Any], fragment: str) -> None:
    (tmp_path / "dist").mkdir()

    failure = parse_args(raw, tmp_path)

    assert isinstance(failure, ToolFailure)
    assert fragment in failure.message


# --- deploy_app --------------------------------------------------------------


def _static_site(tmp_path: Path) -> Path:
    _write(tmp_path / "dist" / "index.html", "<h1>hi</h1>")
    return tmp_path


async def test_deploy_posts_the_bundle_and_returns_the_url(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "ok": True,
                "name": "notes",
                "url": "https://notes.apps.example",
                "firstDeploy": True,
                "version": 1,
                "hasWorker": False,
                "assetCount": 1,
                "bindings": [],
                "advisories": [],
            },
        )

    client = EnvSessionClient("https://cp.example/", "s/1", "sandbox-token")
    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    def patched(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        return original(*args, transport=transport, **kwargs)

    _app_manifest(tmp_path, {"schemaVersion": 1, "name": "notes"})
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(app_deploy.httpx, "AsyncClient", patched)
        envelope = await deploy_app(client, {"assetsDir": "dist"}, root=_static_site(tmp_path))

    assert envelope["ok"] is True
    assert envelope["url"] == "https://notes.apps.example"
    assert "https://notes.apps.example" in envelope["agentMessage"]
    assert "minute" in envelope["agentMessage"]
    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == "https://cp.example/sessions/s%2F1/apps"
    assert request.headers["Authorization"] == "Bearer sandbox-token"
    assert request.extensions["timeout"]["read"] == APP_DEPLOY_CONTRACT["tool"]["timeoutSeconds"]
    parts = _parts(request)
    assert [name for name, _filename, _body in parts] == ["manifest", "app", "a0"]
    _manifest_name, manifest_filename, manifest_body = parts[0]
    assert manifest_filename is None
    assert json.loads(manifest_body) == {
        "assets": [{"path": "/index.html", "part": "a0"}],
        "worker": None,
        "app": {"part": "app"},
        "migrations": [],
    }
    assert parts[2] == ("a0", "a0", b"<h1>hi</h1>")


@pytest.mark.parametrize("reason", sorted(REASONS))
async def test_every_server_reason_maps_to_its_guidance(tmp_path: Path, reason: str) -> None:
    session = _FakeSession(
        lambda: httpx.Response(
            409, json={"ok": False, "reason": reason, "message": "server says why"}
        )
    )

    envelope = await deploy_app(
        session, {"name": "notes", "assetsDir": "dist"}, root=_static_site(tmp_path)
    )

    assert envelope == {
        "ok": False,
        "reason": reason,
        "agentMessage": f"{REASONS[reason]} (server says why)",
    }


@pytest.mark.parametrize(
    ("status", "reason"), sorted(APP_DEPLOY_CONTRACT["statusFallback"].items())
)
async def test_an_unknown_reason_falls_back_by_status(
    tmp_path: Path, status: str, reason: str
) -> None:
    session = _FakeSession(lambda: httpx.Response(int(status), json={"error": "Nope"}))

    envelope = await deploy_app(
        session, {"name": "notes", "assetsDir": "dist"}, root=_static_site(tmp_path)
    )

    assert envelope["reason"] == reason
    assert envelope["agentMessage"] == f"{REASONS[reason]} (Nope)"


@pytest.mark.parametrize(
    ("status", "reason"), [(500, "hosting_unavailable"), (401, "bridge_error")]
)
async def test_an_unmapped_status_still_gets_guidance(
    tmp_path: Path, status: int, reason: str
) -> None:
    session = _FakeSession(lambda: httpx.Response(status, text="<html>oops</html>"))

    envelope = await deploy_app(
        session, {"name": "notes", "assetsDir": "dist"}, root=_static_site(tmp_path)
    )

    assert envelope["reason"] == reason
    assert envelope["agentMessage"]


async def test_data_block_detail_and_retry_hint_reach_the_agent(tmp_path: Path) -> None:
    session = _FakeSession(
        lambda: httpx.Response(
            424,
            json={
                "ok": False,
                "reason": "secret_missing",
                "message": "1 secret has no value",
                "detail": {"missing": ["PLACEHOLDER_KEY"]},
                "retryAfterSeconds": 5,
            },
        )
    )

    envelope = await deploy_app(
        session, {"name": "notes", "assetsDir": "dist"}, root=_static_site(tmp_path)
    )

    assert envelope["detail"] == {"missing": ["PLACEHOLDER_KEY"]}
    assert envelope["retryAfterSeconds"] == 5
    assert "Never ask the user to paste the value" in envelope["agentMessage"]


async def test_a_timeout_says_to_call_once_more(tmp_path: Path) -> None:
    session = _FakeSession(lambda: httpx.ReadTimeout("slow"))

    envelope = await deploy_app(
        session, {"name": "notes", "assetsDir": "dist"}, root=_static_site(tmp_path)
    )

    assert envelope["ok"] is False
    assert envelope["reason"] == "deadline_exceeded"
    assert envelope["agentMessage"].startswith(REASONS["deadline_exceeded"])
    assert session.calls[0]["timeout"] == APP_DEPLOY_CONTRACT["tool"]["timeoutSeconds"]


async def test_a_transport_error_hides_internal_hosts(tmp_path: Path) -> None:
    session = _FakeSession(lambda: httpx.ConnectError("connect to internal.cp.local failed"))

    envelope = await deploy_app(
        session, {"name": "notes", "assetsDir": "dist"}, root=_static_site(tmp_path)
    )

    assert envelope == {
        "ok": False,
        "reason": "bridge_error",
        "agentMessage": BRIDGE_ERROR_GUIDANCE,
    }


async def test_a_local_failure_sends_nothing(tmp_path: Path) -> None:
    _app_manifest(tmp_path, {"schemaVersion": 1, "name": "notes", "data": {"DB": {"kind": "d1"}}})
    _write(tmp_path / "migrations" / "Init.sql", "CREATE TABLE t (id TEXT);")
    session = _FakeSession(lambda: httpx.Response(200))

    envelope = await deploy_app(session, {"assetsDir": "dist"}, root=_static_site(tmp_path))

    assert envelope["reason"] == "invalid_bundle"
    assert envelope["agentMessage"].startswith(REASONS["invalid_bundle"])
    assert "Init.sql" in envelope["agentMessage"]
    assert session.calls == []


# --- OpenCode entry point ----------------------------------------------------


def test_cli_prints_one_envelope_without_session_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name in ("CONTROL_PLANE_URL", "SANDBOX_AUTH_TOKEN", "SESSION_CONFIG"):
        monkeypatch.delenv(name, raising=False)

    assert app_deploy.main(["--args-json", json.dumps({"assetsDir": "dist"})]) == 0

    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["reason"] == "bridge_error"


def test_cli_rejects_arguments_that_are_not_an_object(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert app_deploy.main(["--args-json", "[1]"]) == 0
    assert json.loads(capsys.readouterr().out)["reason"] == "invalid_bundle"


def test_env_client_reads_the_session_from_session_config() -> None:
    client = EnvSessionClient.from_env(
        {
            "CONTROL_PLANE_URL": "https://cp.example",
            "SANDBOX_AUTH_TOKEN": "sandbox-token",
            "SESSION_CONFIG": json.dumps({"session_id": "s1"}),
        }
    )
    assert client is not None
    assert EnvSessionClient.from_env({"CONTROL_PLANE_URL": "https://cp.example"}) is None


# --- Claude harness ----------------------------------------------------------


def _claude_tools(tmp_path: Path, handler: Any, *, app_deploy_enabled: bool) -> OpenInspectTools:
    manifest = tmp_path / "repos.json"
    manifest.write_text(
        json.dumps({"repositories": [{"owner": "acme", "name": "web", "path": str(tmp_path)}]})
    )
    config = ToolServerConfig(
        control_plane_url="https://cp.example",
        session_id="s1",
        auth_token="tok",
        repo_manifest_path=manifest,
        has_repository=True,
        slack_notify_enabled=False,
        app_deploy_enabled=app_deploy_enabled,
    )
    return OpenInspectTools(
        ControlPlaneToolClient(
            config, MagicMock(), httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )
    )


def test_claude_registers_deploy_app_only_when_enabled(tmp_path: Path) -> None:
    def names(enabled: bool) -> set[str]:
        tools = _claude_tools(tmp_path, lambda _r: httpx.Response(200), app_deploy_enabled=enabled)
        return {tool.name for tool in build_tools(tools.client)}

    assert "deploy-app" in names(True)
    assert "deploy-app" not in names(False)


def test_the_enable_flag_defaults_from_the_sandbox_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def config() -> ToolServerConfig:
        return ToolServerConfig(
            control_plane_url="https://cp.example",
            session_id="s1",
            auth_token="tok",
            repo_manifest_path=Path("/nonexistent"),
            has_repository=False,
            slack_notify_enabled=False,
        )

    monkeypatch.delenv(APP_DEPLOY_ENABLED_ENV, raising=False)
    assert config().app_deploy_enabled is False
    monkeypatch.setenv(APP_DEPLOY_ENABLED_ENV, "true")
    assert config().app_deploy_enabled is True


async def test_claude_deploys_from_the_repository_checkout(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True, "url": "https://notes.apps.example"})

    _static_site(tmp_path)
    tools = _claude_tools(tmp_path, handler, app_deploy_enabled=True)

    result = await tools.deploy_app({"name": "notes", "assetsDir": "dist"})

    envelope = json.loads(result["content"][0]["text"])
    assert envelope["ok"] is True
    assert str(seen[0].url) == "https://cp.example/sessions/s1/apps"
    assert seen[0].headers["Authorization"] == "Bearer tok"
