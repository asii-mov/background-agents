"""The one implementation of the ``deploy-app`` tool, for both harnesses.

The Claude harness calls :func:`deploy_app` in-process (``harness/claude_tools.py``);
the OpenCode tool ``tools/deploy-app.js`` runs ``python -m sandbox_runtime.app_deploy``
with the same arguments. Name, schema, limits, part names and reason guidance come
from the generated ``app_deploy_contract.json`` (source: ``@open-inspect/shared/apps``).

The tool never holds a Cloudflare credential: it packs build output as multipart and
POSTs ``/sessions/{id}/apps`` with the sandbox token. Local checks only give the agent
faster, clearer errors; the control plane re-validates everything.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final, Protocol
from urllib.parse import quote

import httpx

from .constants import REPO_MANIFEST_FILE_PATH
from .repo_config import load_repo_manifest

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

APP_DEPLOY_CONTRACT: Final[Mapping[str, Any]] = json.loads(
    Path(__file__).with_name("app_deploy_contract.json").read_text(encoding="utf-8")
)

APP_DEPLOY_ENABLED_ENV: Final = "AGENT_APP_DEPLOY_ENABLED"

_DEPLOY_ARG_KEYS: Final = ("projectDir", "name", "assetsDir", "workerFile")
_WELL_KNOWN_DIR: Final = ".well-known"


@dataclass(frozen=True)
class ToolFailure:
    """A failure decided before or instead of the server's answer."""

    reason: str
    message: str


@dataclass(frozen=True)
class DeployRequest:
    project_dir: Path
    name: str | None
    assets_dir: Path | None
    worker_file: Path | None


@dataclass(frozen=True)
class BundlePart:
    """One multipart file part. ``field`` is the part name; paths travel in the manifest."""

    field: str
    file: Path
    content_type: str


@dataclass(frozen=True)
class PackedBundle:
    manifest: Mapping[str, Any]
    """The ``manifest`` part, shaped by ``appDeployManifestSchema``."""
    parts: tuple[BundlePart, ...]
    """``app``, then ``m*``, then ``a*``, then ``worker``."""
    total_bytes: int


class SessionClient(Protocol):
    """A session-scoped, sandbox-authenticated control-plane client."""

    async def request(
        self,
        method: str,
        path: str,
        *,
        files: Sequence[tuple[str, Any]] | None = None,
        timeout_seconds: float,
    ) -> httpx.Response: ...


def project_root(repo_manifest_path: str | Path = REPO_MANIFEST_FILE_PATH) -> Path:
    """The single repository's checkout, else the working directory (the workspace root)."""
    repositories = load_repo_manifest(repo_manifest_path)
    return Path(repositories[0].path) if len(repositories) == 1 else Path.cwd()


def _optional_string(raw: Mapping[str, Any], key: str) -> str | ToolFailure | None:
    value = raw.get(key)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        return ToolFailure("invalid_bundle", f"{key} must be a string path or name.")
    return value


def parse_args(raw: Mapping[str, Any], root: Path) -> DeployRequest | ToolFailure:
    """Resolve paths: ``projectDir`` against ``root``, the others against ``projectDir``."""
    unknown = sorted(set(raw) - set(_DEPLOY_ARG_KEYS))
    if unknown:
        return ToolFailure(
            "invalid_bundle",
            f"Unknown argument(s): {', '.join(unknown)}. Use {', '.join(_DEPLOY_ARG_KEYS)}.",
        )
    values: dict[str, str | None] = {}
    for key in _DEPLOY_ARG_KEYS:
        value = _optional_string(raw, key)
        if isinstance(value, ToolFailure):
            return value
        values[key] = value
    project_dir = root / values["projectDir"] if values["projectDir"] else root
    if not project_dir.is_dir():
        return ToolFailure("invalid_bundle", f"projectDir {project_dir} is not a directory.")
    if values["assetsDir"] is None and values["workerFile"] is None:
        return ToolFailure(
            "invalid_bundle",
            "Pass assetsDir (the build output directory), workerFile (one bundled Worker), or both.",
        )
    assets_dir = project_dir / values["assetsDir"] if values["assetsDir"] else None
    if assets_dir is not None and not assets_dir.is_dir():
        return ToolFailure(
            "invalid_bundle",
            f"assetsDir {assets_dir} is not a directory (it is resolved inside projectDir). "
            "Run the build first.",
        )
    worker_file = project_dir / values["workerFile"] if values["workerFile"] else None
    if worker_file is not None and not worker_file.is_file():
        return ToolFailure(
            "invalid_bundle",
            f"workerFile {worker_file} is not a file (it is resolved inside projectDir). "
            "Bundle the Worker into one ES module first.",
        )
    return DeployRequest(
        project_dir=project_dir,
        name=values["name"],
        assets_dir=assets_dir,
        worker_file=worker_file,
    )


def _walk_assets(root: Path) -> list[tuple[str, Path]] | ToolFailure:
    """``(relative posix path, file)`` pairs in sorted path order.

    Symlinks are followed only while they stay inside ``root`` and never back into
    a directory being walked; dot entries are skipped except ``.well-known``.
    """
    found: list[tuple[str, Path]] = []

    def visit(directory: Path, prefix: str, ancestors: frozenset[Path]) -> ToolFailure | None:
        resolved_dir = directory.resolve()
        if resolved_dir in ancestors:
            return None
        ancestors = ancestors | {resolved_dir}
        for entry in sorted(directory.iterdir(), key=lambda path: path.name):
            relative = f"{prefix}{entry.name}"
            if entry.name.startswith(".") and not (
                entry.name == _WELL_KNOWN_DIR and entry.is_dir()
            ):
                continue
            target = entry.resolve() if entry.is_symlink() else entry
            if entry.is_symlink() and not target.is_relative_to(root):
                return ToolFailure(
                    "invalid_bundle",
                    f"{relative} is a symlink to {target}, outside assetsDir. Copy the file into "
                    "the build output instead.",
                )
            if target.is_dir():
                failure = visit(target, f"{relative}/", ancestors)
                if failure:
                    return failure
            elif target.is_file():
                found.append((relative, target))
        return None

    failure = visit(root, "", frozenset())
    if failure:
        return failure
    return sorted(found, key=lambda pair: pair[0])


def _read_app_manifest(
    project_dir: Path, contract: Mapping[str, Any]
) -> dict[str, Any] | ToolFailure | None:
    """The parsed ``openinspect.app.json``, ``None`` when absent."""
    manifest_file = contract["appManifestFile"]
    path = project_dir / manifest_file
    if not path.is_file():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return ToolFailure("data_manifest_invalid", f"{manifest_file} is not valid JSON: {error}")
    if not isinstance(parsed, dict):
        return ToolFailure("data_manifest_invalid", f"{manifest_file} must be a JSON object.")
    return parsed


def _d1_migration_dirs(
    app_manifest: dict[str, Any] | None, contract: Mapping[str, Any]
) -> list[tuple[str, str]]:
    """``(binding, migrations dir)`` for each D1 declaration, by binding name.

    Malformed declarations are left for the control plane to reject with its message.
    """
    data = app_manifest.get("data") if app_manifest else None
    if not isinstance(data, dict):
        return []
    dirs: list[tuple[str, str]] = []
    for binding, declaration in sorted(data.items()):
        if not isinstance(declaration, dict) or declaration.get("kind") != "d1":
            continue
        directory = declaration.get("migrations", contract["defaultMigrationsDir"])
        if isinstance(directory, str):
            dirs.append((binding, directory))
    return dirs


def _resolve_name(
    request: DeployRequest, app_manifest: dict[str, Any] | None, manifest_file: str
) -> str | ToolFailure | None:
    declared = app_manifest.get("name") if app_manifest else None
    if request.name is None and not isinstance(declared, str):
        return ToolFailure(
            "invalid_name",
            f"Pass name, or set name in {manifest_file}.",
        )
    if request.name is not None and isinstance(declared, str) and declared != request.name:
        return ToolFailure(
            "invalid_bundle",
            f'name "{request.name}" differs from "{declared}" in {manifest_file}. Omit name or '
            "make them agree.",
        )
    return request.name


def pack_bundle(
    request: DeployRequest, contract: Mapping[str, Any] = APP_DEPLOY_CONTRACT
) -> PackedBundle | ToolFailure:
    """Plan the multipart body without reading file contents."""
    limits = contract["limits"]
    parts_spec = contract["parts"]
    manifest_file = contract["appManifestFile"]

    app_manifest = _read_app_manifest(request.project_dir, contract)
    if isinstance(app_manifest, ToolFailure):
        return app_manifest
    name = _resolve_name(request, app_manifest, manifest_file)
    if isinstance(name, ToolFailure):
        return name

    parts: list[BundlePart] = []
    total = 0
    if app_manifest is not None:
        app_path = request.project_dir / manifest_file
        parts.append(BundlePart(parts_spec["app"], app_path, "application/json"))
        total += app_path.stat().st_size

    migration_pattern = re.compile(contract["migrationFilePattern"])
    project_root_resolved = request.project_dir.resolve()
    migrations: list[dict[str, str]] = []
    for binding, directory in _d1_migration_dirs(app_manifest, contract):
        migrations_dir = request.project_dir / directory
        if not migrations_dir.resolve().is_relative_to(project_root_resolved):
            return ToolFailure(
                "data_manifest_invalid",
                f"{binding}.migrations must be a directory inside the project.",
            )
        if not migrations_dir.is_dir():
            continue
        for sql_file in sorted(migrations_dir.glob("*.sql"), key=lambda path: path.name):
            if not migration_pattern.fullmatch(sql_file.name):
                return ToolFailure(
                    "invalid_bundle",
                    f"{directory}/{sql_file.name}: migration files are named like "
                    "0001_create-notes.sql (four digits, an underscore, then lowercase letters, "
                    "digits and hyphens). Rename the file.",
                )
            part = f"{parts_spec['migrationPrefix']}{len(migrations)}"
            migrations.append({"binding": binding, "name": sql_file.name, "part": part})
            parts.append(BundlePart(part, sql_file, "application/sql"))
            total += sql_file.stat().st_size
    if len(migrations) > limits["maxMigrationFiles"]:
        return ToolFailure(
            "invalid_bundle",
            f"{len(migrations)} migration files; at most {limits['maxMigrationFiles']} are allowed.",
        )

    assets: list[dict[str, str]] = []
    if request.assets_dir is not None:
        walked = _walk_assets(request.assets_dir.resolve())
        if isinstance(walked, ToolFailure):
            return walked
        if not walked and request.worker_file is None:
            return ToolFailure(
                "invalid_bundle",
                f"assetsDir {request.assets_dir} has no files to publish. Run the build first.",
            )
        if len(walked) > limits["maxAssetCount"]:
            return ToolFailure(
                "bundle_too_large",
                f"{len(walked)} files in assetsDir; at most {limits['maxAssetCount']} are allowed.",
            )
        for relative, file in walked:
            asset_path = f"/{relative}"
            if len(asset_path) > limits["maxAssetPathLength"]:
                return ToolFailure(
                    "invalid_bundle",
                    f"{asset_path} is longer than {limits['maxAssetPathLength']} characters.",
                )
            size = file.stat().st_size
            if size > limits["maxAssetBytes"]:
                return ToolFailure(
                    "bundle_too_large",
                    f"{asset_path} is {size} bytes; one file may be at most "
                    f"{limits['maxAssetBytes']} bytes.",
                )
            part = f"{parts_spec['assetPrefix']}{len(assets)}"
            assets.append({"path": asset_path, "part": part})
            parts.append(BundlePart(part, file, "application/octet-stream"))
            total += size

    worker: dict[str, str] | None = None
    if request.worker_file is not None:
        size = request.worker_file.stat().st_size
        if size > limits["maxWorkerBytes"]:
            return ToolFailure(
                "bundle_too_large",
                f"workerFile is {size} bytes; the Worker may be at most "
                f"{limits['maxWorkerBytes']} bytes. Minify it and leave out source maps.",
            )
        worker = {"part": parts_spec["worker"]}
        parts.append(BundlePart(parts_spec["worker"], request.worker_file, "text/javascript"))
        total += size

    manifest: dict[str, Any] = {
        "assets": assets,
        "worker": worker,
        "app": {"part": parts_spec["app"]} if app_manifest is not None else None,
        "migrations": migrations,
    }
    if name is not None:
        manifest["name"] = name
    total += len(json.dumps(manifest))
    if total > limits["maxRequestBytes"]:
        return ToolFailure(
            "bundle_too_large",
            f"The bundle is {total} bytes; the limit is {limits['maxRequestBytes']} bytes.",
        )
    return PackedBundle(manifest=manifest, parts=tuple(parts), total_bytes=total)


def multipart_files(
    bundle: PackedBundle, contract: Mapping[str, Any] = APP_DEPLOY_CONTRACT
) -> list[tuple[str, Any]]:
    """httpx ``files`` entries: the manifest first, then every part in bundle order."""
    manifest_bytes = json.dumps(bundle.manifest).encode("utf-8")
    files: list[tuple[str, Any]] = [
        (contract["parts"]["manifest"], (None, manifest_bytes, "application/json"))
    ]
    files.extend(
        (part.field, (part.field, part.file.read_bytes(), part.content_type))
        for part in bundle.parts
    )
    return files


def failure_envelope(
    failure: ToolFailure,
    contract: Mapping[str, Any] = APP_DEPLOY_CONTRACT,
    *,
    retry_after_seconds: Any = None,
    detail: Any = None,
) -> dict[str, Any]:
    guidance = contract["reasons"].get(failure.reason, contract["bridgeErrorGuidance"])
    envelope: dict[str, Any] = {
        "ok": False,
        "reason": failure.reason,
        "agentMessage": f"{guidance} ({failure.message})" if failure.message else guidance,
    }
    if isinstance(retry_after_seconds, int | float) and not isinstance(retry_after_seconds, bool):
        envelope["retryAfterSeconds"] = retry_after_seconds
    if isinstance(detail, dict):
        envelope["detail"] = detail
    return envelope


def _success_envelope(body: Mapping[str, Any]) -> dict[str, Any]:
    note = (
        " A new address can take a minute or two to start working."
        if body.get("firstDeploy")
        else ""
    )
    return {
        **body,
        "ok": True,
        "agentMessage": (
            f"Published at {body['url']}. Give the user this link; visitors sign in with "
            f"company single sign-on.{note}"
        ),
    }


def _response_envelope(response: httpx.Response, contract: Mapping[str, Any]) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        body = None
    if response.is_success:
        if isinstance(body, dict) and isinstance(body.get("url"), str):
            return _success_envelope(body)
        return failure_envelope(
            ToolFailure(
                "hosting_unavailable", "The control plane returned an unexpected response."
            ),
            contract,
        )
    fields = body if isinstance(body, dict) else {}
    reason = fields.get("reason")
    if not isinstance(reason, str) or reason not in contract["reasons"]:
        reason = contract["statusFallback"].get(str(response.status_code)) or (
            "hosting_unavailable" if response.status_code >= 500 else "bridge_error"
        )
    message = fields.get("message") or fields.get("error")
    return failure_envelope(
        ToolFailure(reason, message if isinstance(message, str) else ""),
        contract,
        retry_after_seconds=fields.get("retryAfterSeconds"),
        detail=fields.get("detail"),
    )


async def deploy_app(
    client: SessionClient,
    raw_args: Mapping[str, Any],
    *,
    root: Path,
    contract: Mapping[str, Any] = APP_DEPLOY_CONTRACT,
) -> dict[str, Any]:
    """Pack, POST, and return the envelope the agent sees."""
    request = parse_args(raw_args, root)
    if isinstance(request, ToolFailure):
        return failure_envelope(request, contract)
    try:
        bundle = pack_bundle(request, contract)
        if isinstance(bundle, ToolFailure):
            return failure_envelope(bundle, contract)
        files = multipart_files(bundle, contract)
    except OSError as error:
        return failure_envelope(
            ToolFailure("invalid_bundle", f"Could not read {error.filename}: {error.strerror}"),
            contract,
        )
    timeout_seconds = float(contract["tool"]["timeoutSeconds"])
    try:
        response = await client.request(
            "POST", contract["tool"]["path"], files=files, timeout_seconds=timeout_seconds
        )
    except httpx.TimeoutException:
        return failure_envelope(
            ToolFailure("deadline_exceeded", f"No answer within {timeout_seconds:g} seconds."),
            contract,
        )
    except httpx.HTTPError:
        # Transport details can name internal hosts; the agent only needs the outcome.
        return failure_envelope(ToolFailure("bridge_error", ""), contract)
    return _response_envelope(response, contract)


class EnvSessionClient:
    """The sandbox environment's control-plane credentials, for the OpenCode shim."""

    def __init__(self, control_plane_url: str, session_id: str, auth_token: str) -> None:
        self._base = f"{control_plane_url.rstrip('/')}/sessions/{quote(session_id, safe='')}"
        self._auth_token = auth_token

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> EnvSessionClient | None:
        try:
            session_config = json.loads(environ.get("SESSION_CONFIG") or "{}")
        except ValueError:
            session_config = {}
        session_id = (
            session_config.get("sessionId") or session_config.get("session_id")
            if isinstance(session_config, dict)
            else None
        )
        url = environ.get("CONTROL_PLANE_URL")
        token = environ.get("SANDBOX_AUTH_TOKEN")
        if not (url and token and isinstance(session_id, str) and session_id):
            return None
        return cls(url, session_id, token)

    async def request(
        self,
        method: str,
        path: str,
        *,
        files: Sequence[tuple[str, Any]] | None = None,
        timeout_seconds: float,
    ) -> httpx.Response:
        async with httpx.AsyncClient() as client:
            return await client.request(
                method,
                f"{self._base}{path}",
                headers={"Authorization": f"Bearer {self._auth_token}"},
                files=files,
                timeout=timeout_seconds,
            )


async def _run(raw_args_json: str) -> dict[str, Any]:
    try:
        raw_args = json.loads(raw_args_json)
    except ValueError:
        raw_args = None
    if not isinstance(raw_args, dict):
        return failure_envelope(ToolFailure("invalid_bundle", "Arguments must be a JSON object."))
    client = EnvSessionClient.from_env(os.environ)
    if client is None:
        return failure_envelope(
            ToolFailure("bridge_error", "The sandbox session credentials are not available.")
        )
    return await deploy_app(client, raw_args, root=project_root())


def main(argv: Sequence[str] | None = None) -> int:
    """Print exactly one JSON envelope on stdout; the shim relays it verbatim."""
    parser = argparse.ArgumentParser(prog="python -m sandbox_runtime.app_deploy")
    parser.add_argument("--args-json", required=True)
    options = parser.parse_args(argv)
    try:
        envelope = asyncio.run(_run(options.args_json))
    except Exception:
        envelope = failure_envelope(ToolFailure("bridge_error", "deploy-app failed unexpectedly."))
    sys.stdout.write(json.dumps(envelope) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
