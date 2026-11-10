"""What a repository tree contains: declared packages, toolchain files, source counts, data stores.

Knows nothing of policy. Platform constants come from ``stack_policy_contract.json``, generated
from ``packages/shared/src/types/stack-policy.ts``; nothing here is hand-copied from TypeScript.
"""

from __future__ import annotations

import asyncio
import json
import os
import posixpath
import re
import stat
import tomllib
from collections import deque
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Final, Literal, Protocol

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

STACK_CONTRACT: Final[dict[str, Any]] = json.loads(
    Path(__file__).with_name("stack_policy_contract.json").read_text(encoding="utf-8")
)
SOURCE_COUNT_EXCLUDED_DIRECTORIES: Final = frozenset(
    STACK_CONTRACT["sourceCountExcludedDirectories"]
)
SOURCE_COUNT_EXCLUDED_BASENAME_GLOBS: Final[tuple[str, ...]] = tuple(
    STACK_CONTRACT["sourceCountExcludedBasenameGlobs"]
)
WELL_KNOWN_TOOLCHAIN_FILES: Final[tuple[str, ...]] = tuple(
    STACK_CONTRACT["wellKnownToolchainFiles"]
)
DATA_STORE_KINDS: Final = frozenset(STACK_CONTRACT["dataStoreKinds"])
APP_MANIFEST_FILE: Final[str] = STACK_CONTRACT["appManifestFile"]

MAX_LISTED_PATHS = 200_000
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_LOCKFILE_BYTES = 32 * 1024 * 1024
GIT_COMMAND_TIMEOUT_SECONDS = 60.0
MAX_GIT_LISTING_BYTES = 256 * 1024 * 1024

SOURCE_EXTENSION_PATTERN: Final = re.compile(r"^\.[a-z0-9]{1,10}$")

DependencyScope = Literal["runtime", "dev", "peer", "optional", "transitive"]


class ManifestParseError(ValueError):
    """A manifest exists but cannot be parsed. Makes the facts incomplete (fail closed)."""


class TreeScanError(RuntimeError):
    """The tree itself could not be listed or read."""


@dataclass(frozen=True)
class DeclaredDependency:
    ecosystem: str
    name: str
    manifest_path: PurePosixPath
    scope: DependencyScope
    declared_range: str | None


@dataclass(frozen=True)
class ResolvedPackage:
    ecosystem: str
    name: str
    version: str
    lockfile_path: PurePosixPath
    direct: bool


@dataclass(frozen=True)
class DataStoreDeclaration:
    """An ``openinspect.app.json`` ``data[*].kind``: the data-store locator (d1|kv|r2)."""

    path: PurePosixPath
    kind: str


@dataclass(frozen=True)
class TreeFacts:
    """Everything signals can match, from one tree. Deterministic: sorted, bounded."""

    paths: tuple[PurePosixPath, ...]
    #: File facts that are generated output of a sibling toolchain file (DERIVED_FILE_RULES).
    derived: frozenset[PurePosixPath]
    #: Extension -> counted source paths, after the platform exclusions.
    sources: Mapping[str, tuple[PurePosixPath, ...]]
    declared: tuple[DeclaredDependency, ...]
    resolved: tuple[ResolvedPackage, ...]
    data_stores: tuple[DataStoreDeclaration, ...]
    #: Directories holding a package manifest, lockfile or well-known toolchain file.
    project_dirs: frozenset[PurePosixPath]
    unreadable: tuple[PurePosixPath, ...] = ()
    truncated: bool = False

    @property
    def complete(self) -> bool:
        return not self.unreadable and not self.truncated


EMPTY_TREE_FACTS: Final = TreeFacts((), frozenset(), {}, (), (), (), frozenset())


# ---- Ecosystems ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class ManifestContents:
    dependencies: tuple[DeclaredDependency, ...]
    #: Other files this manifest pulls in (pip ``-r``), repo-relative and not yet validated.
    includes: tuple[PurePosixPath, ...] = ()


class Ecosystem(Protocol):
    """Package parsing for one ecosystem. Toolchain detection (bun.lock vs package-lock.json) is
    not here: it is data (file signals), so a new toolchain needs no code."""

    id: str

    def normalize(self, name: str) -> str: ...
    def is_manifest(self, path: PurePosixPath) -> bool: ...
    def is_lockfile(self, path: PurePosixPath) -> bool: ...
    def parse_manifest(self, path: PurePosixPath, content: bytes) -> ManifestContents: ...
    def parse_lockfile(self, path: PurePosixPath, content: bytes) -> list[tuple[str, str]]: ...


def _json_document(content: bytes) -> Any:
    try:
        return json.loads(content.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ManifestParseError(str(error)) from error


def _toml_document(content: bytes) -> dict[str, Any]:
    try:
        return tomllib.loads(content.decode("utf-8-sig"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ManifestParseError(str(error)) from error


def _strip_jsonc(text: str) -> str:
    """Drop comments and trailing commas outside strings (bun.lock is JSONC)."""
    out: list[str] = []
    index, length = 0, len(text)
    while index < length:
        char = text[index]
        if char == '"':
            end = index + 1
            while end < length and text[end] != '"':
                end += 2 if text[end] == "\\" else 1
            out.append(text[index : end + 1])
            index = end + 1
        elif text.startswith("//", index):
            newline = text.find("\n", index)
            index = length if newline < 0 else newline
        elif text.startswith("/*", index):
            close = text.find("*/", index + 2)
            index = length if close < 0 else close + 2
        elif char == ",":
            following = index + 1
            while following < length and text[following] in " \t\r\n":
                following += 1
            if following >= length or text[following] not in "}]":
                out.append(char)
            index += 1
        else:
            out.append(char)
            index += 1
    return "".join(out)


def _mapping(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestParseError(f"{context} must be an object")
    return value


def _string_list(value: Any, context: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ManifestParseError(f"{context} must be a list of strings")
    return value


class NpmEcosystem:
    """``package.json`` dependency fields in every directory (workspaces included). Resolved
    versions from ``package-lock.json`` / ``npm-shrinkwrap.json`` (v2/v3) and ``bun.lock``.
    Enforcement reads ``package.json`` and Deno import maps, so it works with every package
    manager; pnpm's ``package.yaml`` / ``package.json5`` are unreadable (fail closed)."""

    id = "npm"
    _FIELDS: Final[dict[str, DependencyScope]] = {
        "dependencies": "runtime",
        "devDependencies": "dev",
        "peerDependencies": "peer",
        "optionalDependencies": "optional",
    }

    def normalize(self, name: str) -> str:
        return name.strip().lower()

    #: pnpm reads these instead of package.json; no YAML or JSON5 parser ships in the sandbox.
    _UNREAD_MANIFESTS: Final = frozenset({"package.yaml", "package.json5"})
    _DENO_CONFIGS: Final = frozenset({"deno.json", "deno.jsonc"})
    _NPM_SPECIFIER: Final = re.compile(r"^npm:/?(@[^/@]+/[^/@]+|[^/@]+)(?:@([^/]+))?")

    def is_manifest(self, path: PurePosixPath) -> bool:
        return (
            path.name == "package.json"
            or path.name in self._UNREAD_MANIFESTS
            or path.name in self._DENO_CONFIGS
        )

    def is_lockfile(self, path: PurePosixPath) -> bool:
        return path.name in ("package-lock.json", "npm-shrinkwrap.json", "bun.lock")

    def parse_manifest(self, path: PurePosixPath, content: bytes) -> ManifestContents:
        if path.name in self._UNREAD_MANIFESTS:
            raise ManifestParseError(
                f"{path.name} is not read; declare dependencies in package.json"
            )
        if path.name in self._DENO_CONFIGS:
            return self._deno_config(path, content)
        document = _mapping(_json_document(content), "package.json")
        dependencies: list[DeclaredDependency] = []
        for field_name, scope in self._FIELDS.items():
            entries = document.get(field_name)
            if entries is None:
                continue
            for name, spec in _mapping(entries, field_name).items():
                declared = spec if isinstance(spec, str) else None
                dependencies.append(
                    DeclaredDependency(
                        self.id,
                        self.normalize(self._installed_name(name, declared)),
                        path,
                        scope,
                        declared,
                    )
                )
        return ManifestContents(tuple(dependencies))

    def _deno_config(self, path: PurePosixPath, content: bytes) -> ManifestContents:
        """``npm:`` specifiers in the import map. A separate ``importMap`` file is not read."""
        try:
            document = json.loads(_strip_jsonc(content.decode("utf-8-sig")))
        except (UnicodeDecodeError, ValueError) as error:
            raise ManifestParseError(str(error)) from error
        document = _mapping(document, path.name)
        if "importMap" in document:
            raise ManifestParseError("a separate importMap file is not read")
        import_maps = [
            document.get("imports") or {},
            *_mapping(document.get("scopes") or {}, "scopes").values(),
        ]
        dependencies: list[DeclaredDependency] = []
        for imports in import_maps:
            for spec in _mapping(imports, "imports").values():
                match = self._NPM_SPECIFIER.match(spec) if isinstance(spec, str) else None
                if match:
                    dependencies.append(
                        DeclaredDependency(
                            self.id, self.normalize(match.group(1)), path, "runtime", match.group(2)
                        )
                    )
        return ManifestContents(tuple(dependencies))

    @staticmethod
    def _installed_name(name: str, spec: str | None) -> str:
        """``"ui": "npm:react@18"`` installs react under another name; match what is installed."""
        if spec is None or not spec.startswith("npm:"):
            return name
        target = spec[len("npm:") :]
        version_at = target.find("@", 1)
        return target[:version_at] if version_at > 0 else target

    def parse_lockfile(self, path: PurePosixPath, content: bytes) -> list[tuple[str, str]]:
        if path.name == "bun.lock":
            try:
                document = json.loads(_strip_jsonc(content.decode("utf-8-sig")))
            except (UnicodeDecodeError, ValueError) as error:
                raise ManifestParseError(str(error)) from error
            packages = _mapping(document, "bun.lock").get("packages") or {}
            resolved: list[tuple[str, str]] = []
            for entry in _mapping(packages, "packages").values():
                if isinstance(entry, list) and entry and isinstance(entry[0], str):
                    name, _, version = entry[0].rpartition("@")
                    if name and version and not version.startswith(("workspace:", "link:")):
                        resolved.append((name, version))
            return resolved
        document = _mapping(_json_document(content), path.name)
        resolved = []
        for key, entry in _mapping(document.get("packages") or {}, "packages").items():
            if not key or not isinstance(entry, dict) or entry.get("link"):
                continue
            package_name: Any = entry.get("name") or key.rpartition("node_modules/")[2]
            package_version: Any = entry.get("version")
            if isinstance(package_name, str) and isinstance(package_version, str) and package_name:
                resolved.append((package_name, package_version))
        return resolved


_REQUIREMENT = re.compile(
    r"^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?(.*)$"
)
_EGG = re.compile(r"[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)")


class PypiEcosystem:
    """``pyproject.toml`` (PEP 621, dependency groups, uv, Poetry), ``requirements*.txt`` (PEP 508
    with ``-r`` includes) and ``Pipfile``. Resolved versions from ``uv.lock``, ``poetry.lock`` and
    ``pylock.toml``."""

    id = "pypi"

    def normalize(self, name: str) -> str:
        return re.sub(r"[-_.]+", "-", name.strip()).lower()

    def is_manifest(self, path: PurePosixPath) -> bool:
        return path.name in ("pyproject.toml", "Pipfile") or fnmatchcase(
            path.name, "requirements*.txt"
        )

    def is_lockfile(self, path: PurePosixPath) -> bool:
        return path.name in ("uv.lock", "poetry.lock", "pylock.toml")

    def parse_manifest(self, path: PurePosixPath, content: bytes) -> ManifestContents:
        if path.name == "pyproject.toml":
            return ManifestContents(tuple(self._pyproject(path, _toml_document(content))))
        if path.name == "Pipfile":
            document = _toml_document(content)
            tables: tuple[tuple[str, DependencyScope], ...] = (
                ("packages", "runtime"),
                ("dev-packages", "dev"),
            )
            return ManifestContents(
                tuple(
                    self._declared(path, name, scope, spec)
                    for table, scope in tables
                    for name, spec in _mapping(document.get(table) or {}, table).items()
                )
            )
        return self._requirements(path, content)

    def _declared(
        self, path: PurePosixPath, name: str, scope: DependencyScope, spec: Any
    ) -> DeclaredDependency:
        declared = spec if isinstance(spec, str) and spec not in ("", "*") else None
        return DeclaredDependency(self.id, self.normalize(name), path, scope, declared)

    def _pep508(
        self, path: PurePosixPath, requirement: str, scope: DependencyScope
    ) -> DeclaredDependency:
        match = _REQUIREMENT.match(requirement)
        if match is None:
            raise ManifestParseError(f"invalid requirement {requirement[:80]!r}")
        specifier = match.group(2).split(";", 1)[0].strip()
        return self._declared(path, match.group(1), scope, specifier or None)

    def _pyproject(self, path: PurePosixPath, document: dict[str, Any]) -> list[DeclaredDependency]:
        dependencies: list[DeclaredDependency] = []
        project = _mapping(document.get("project") or {}, "[project]")
        for requirement in _string_list(project.get("dependencies") or [], "dependencies"):
            dependencies.append(self._pep508(path, requirement, "runtime"))
        optional = _mapping(project.get("optional-dependencies") or {}, "optional-dependencies")
        for extra in optional.values():
            for requirement in _string_list(extra, "optional-dependencies"):
                dependencies.append(self._pep508(path, requirement, "optional"))
        groups = _mapping(document.get("dependency-groups") or {}, "[dependency-groups]")
        for group in groups.values():
            if not isinstance(group, list):
                raise ManifestParseError("dependency groups must be lists")
            for requirement in group:
                if isinstance(requirement, str):
                    dependencies.append(self._pep508(path, requirement, "dev"))
        tool = _mapping(document.get("tool") or {}, "[tool]")
        uv = _mapping(tool.get("uv") or {}, "[tool.uv]")
        for requirement in _string_list(uv.get("dev-dependencies") or [], "dev-dependencies"):
            dependencies.append(self._pep508(path, requirement, "dev"))
        poetry = _mapping(tool.get("poetry") or {}, "[tool.poetry]")
        tables: list[tuple[Any, DependencyScope]] = [
            (poetry.get("dependencies"), "runtime"),
            (poetry.get("dev-dependencies"), "dev"),
            *(
                (_mapping(group, "poetry group").get("dependencies"), "dev")
                for group in _mapping(poetry.get("group") or {}, "poetry groups").values()
            ),
        ]
        for table, scope in tables:
            for name, spec in _mapping(table or {}, "poetry dependencies").items():
                if name.lower() != "python":
                    dependencies.append(self._declared(path, name, scope, spec))
        return dependencies

    def _requirements(self, path: PurePosixPath, content: bytes) -> ManifestContents:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise ManifestParseError(str(error)) from error
        dependencies: list[DeclaredDependency] = []
        includes: list[PurePosixPath] = []
        for raw_line in text.replace("\\\n", " ").splitlines():
            line = re.sub(r"(^|\s)#.*$", "", raw_line).strip()
            if not line:
                continue
            option = re.match(r"^(-r|--requirement)(?:\s+|=)(\S+)", line)
            if option:
                includes.append(path.parent / option.group(2))
                continue
            if line.startswith("-"):
                egg = _EGG.search(line) if line.startswith(("-e", "--editable")) else None
                if egg:
                    dependencies.append(self._declared(path, egg.group(1), "runtime", None))
                continue
            if "://" in line or line.startswith((".", "/")):
                egg = _EGG.search(line)
                if egg:
                    dependencies.append(self._declared(path, egg.group(1), "runtime", None))
                continue
            requirement = re.split(r"\s+--", line, maxsplit=1)[0]
            if _REQUIREMENT.match(requirement):
                dependencies.append(self._pep508(path, requirement, "runtime"))
        return ManifestContents(tuple(dependencies), tuple(includes))

    def parse_lockfile(self, path: PurePosixPath, content: bytes) -> list[tuple[str, str]]:
        document = _toml_document(content)
        entries = document.get("packages" if path.name == "pylock.toml" else "package") or []
        if not isinstance(entries, list):
            raise ManifestParseError(f"{path.name} packages must be a list")
        return [
            (entry["name"], entry["version"])
            for entry in entries
            if isinstance(entry, dict)
            and isinstance(entry.get("name"), str)
            and isinstance(entry.get("version"), str)
        ]


ECOSYSTEMS: Final[Mapping[str, Ecosystem]] = {"npm": NpmEcosystem(), "pypi": PypiEcosystem()}
if set(ECOSYSTEMS) != set(STACK_CONTRACT["ecosystems"]):
    raise RuntimeError("stack_facts ecosystems drifted from stack_policy_contract.json")


# ---- Platform rules ------------------------------------------------------------------------------


def counts_as_source(path: PurePosixPath) -> bool:
    """Contract exclusions: no excluded directory in the path, and a basename matching no
    excluded glob, so ``svelte.config.js`` never makes a TypeScript repository look mixed."""
    if any(part in SOURCE_COUNT_EXCLUDED_DIRECTORIES for part in path.parts[:-1]):
        return False
    return not any(fnmatchcase(path.name, glob) for glob in SOURCE_COUNT_EXCLUDED_BASENAME_GLOBS)


def derived_paths(paths: Iterable[PurePosixPath]) -> frozenset[PurePosixPath]:
    """Paths a DERIVED_FILE_RULES sibling in the same directory generated (``uv export``)."""
    listed = tuple(paths)
    present = {(path.parent, path.name) for path in listed}
    return frozenset(
        path
        for path in listed
        for rule in STACK_CONTRACT["derivedFileRules"]
        if fnmatchcase(path.name, rule["file"])
        and any((path.parent, sibling) in present for sibling in rule["derivedWhenSibling"])
    )


def is_toolchain_file(path: PurePosixPath) -> bool:
    return any(fnmatchcase(path.name, pattern) for pattern in WELL_KNOWN_TOOLCHAIN_FILES)


def _in_excluded_directory(path: PurePosixPath) -> bool:
    return any(part in SOURCE_COUNT_EXCLUDED_DIRECTORIES for part in path.parts[:-1])


# ---- Tree sources --------------------------------------------------------------------------------


class TreeSource(Protocol):
    async def list_paths(self) -> list[PurePosixPath]: ...

    async def read_files(
        self, paths: Sequence[PurePosixPath], max_bytes: int
    ) -> dict[PurePosixPath, bytes | None]:
        """Contents by path; ``None`` for a path that is too large or not a regular file.
        A path that no longer exists is left out."""
        ...


_GIT_ENVIRONMENT: Final = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_LITERAL_PATHSPECS": "1",
    "GIT_NO_REPLACE_OBJECTS": "1",
    "GIT_TERMINAL_PROMPT": "0",
    "LC_ALL": "C",
}


async def run_git(
    checkout: Path,
    *arguments: str,
    stdin: bytes | None = None,
    accepted_return_codes: tuple[int, ...] = (0,),
) -> tuple[int, bytes]:
    """Run git in ``checkout`` without a shell; raise TreeScanError on failure or timeout."""
    try:
        process = await asyncio.create_subprocess_exec(
            "git",
            "-c",
            "core.fsmonitor=false",
            *arguments,
            cwd=checkout,
            env={**os.environ, **_GIT_ENVIRONMENT},
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as error:
        raise TreeScanError(f"git could not start: {error}") from error
    try:
        async with asyncio.timeout(GIT_COMMAND_TIMEOUT_SECONDS):
            stdout, stderr = await process.communicate(stdin)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise TreeScanError(f"git {arguments[0]} timed out") from None
    if process.returncode not in accepted_return_codes:
        detail = stderr.decode("utf-8", errors="replace").strip()[:500]
        raise TreeScanError(f"git {arguments[0]} failed: {detail or process.returncode}")
    if len(stdout) > MAX_GIT_LISTING_BYTES:
        raise TreeScanError(f"git {arguments[0]} output exceeded its bound")
    assert process.returncode is not None
    return process.returncode, stdout


def _decode_paths(raw: bytes) -> list[PurePosixPath]:
    return [
        PurePosixPath(item.decode("utf-8", errors="surrogateescape"))
        for item in raw.split(b"\0")
        if item
    ]


def _read_regular_file(path: Path, max_bytes: int) -> bytes | Literal[False] | None:
    """File bytes, None when too large or not regular, False when missing. Never follows a
    symlink, so a manifest linked to a file outside the checkout is unreadable, not read."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return False
    except OSError:
        return None
    with os.fdopen(descriptor, "rb") as stream:
        status = os.fstat(stream.fileno())
        if not stat.S_ISREG(status.st_mode) or status.st_size > max_bytes:
            return None
        return stream.read(max_bytes + 1)


async def _read_worktree_files(
    root: Path, paths: Sequence[PurePosixPath], max_bytes: int
) -> dict[PurePosixPath, bytes | None]:
    contents: dict[PurePosixPath, bytes | None] = {}
    for path in paths:
        content = await asyncio.to_thread(_read_regular_file, root / path, max_bytes)
        if content is not False:
            contents[path] = content if content is None or len(content) <= max_bytes else None
    return contents


@dataclass(frozen=True)
class WorktreeSource:
    """Per-turn subject: ``git ls-files --cached --others --exclude-standard``, minus deleted
    files. A force-added file under an ignored path is listed; ignored node_modules is not."""

    checkout: Path

    async def list_paths(self) -> list[PurePosixPath]:
        _, listed = await run_git(
            self.checkout, "ls-files", "-z", "--cached", "--others", "--exclude-standard"
        )
        _, deleted = await run_git(self.checkout, "ls-files", "-z", "--deleted")
        return sorted(set(_decode_paths(listed)) - set(_decode_paths(deleted)))

    async def read_files(
        self, paths: Sequence[PurePosixPath], max_bytes: int
    ) -> dict[PurePosixPath, bytes | None]:
        return await _read_worktree_files(self.checkout, paths, max_bytes)


@dataclass(frozen=True)
class DirectorySource:
    """A workspace that is not a git checkout (repository-less sessions): a bounded walk that
    prunes dependency, build and hidden directories (runtime tooling such as ``.opencode``)."""

    root: Path

    async def list_paths(self) -> list[PurePosixPath]:
        return await asyncio.to_thread(self._walk)

    def _walk(self) -> list[PurePosixPath]:
        listed: list[PurePosixPath] = []
        for directory, directories, files in os.walk(self.root):
            directories[:] = sorted(
                name
                for name in directories
                if name not in SOURCE_COUNT_EXCLUDED_DIRECTORIES and not name.startswith(".")
            )
            relative = PurePosixPath(Path(directory).relative_to(self.root).as_posix())
            listed.extend(relative / name for name in files)
            if len(listed) > MAX_LISTED_PATHS:
                break
        return sorted(listed)

    async def read_files(
        self, paths: Sequence[PurePosixPath], max_bytes: int
    ) -> dict[PurePosixPath, bytes | None]:
        return await _read_worktree_files(self.root, paths, max_bytes)


@dataclass(frozen=True)
class _TreeEntry:
    oid: str
    size: int
    readable: bool


@dataclass
class CommitSource:
    """Pre-push and baseline subject: the tree of one commit, read from the object store, so the
    check judges exactly what is pushed and never the worktree."""

    checkout: Path
    revision: str
    _entries: dict[PurePosixPath, _TreeEntry] = field(default_factory=dict, repr=False)

    async def list_paths(self) -> list[PurePosixPath]:
        _, raw = await run_git(
            self.checkout, "ls-tree", "-r", "-z", "-l", "--full-tree", self.revision
        )
        self._entries.clear()
        for record in raw.split(b"\0"):
            if not record:
                continue
            header, _, raw_path = record.partition(b"\t")
            mode, kind, oid, size = header.split()
            if kind != b"blob":
                continue
            path = PurePosixPath(raw_path.decode("utf-8", errors="surrogateescape"))
            self._entries[path] = _TreeEntry(
                oid.decode(), int(size), readable=mode in (b"100644", b"100755")
            )
        return sorted(self._entries)

    async def read_files(
        self, paths: Sequence[PurePosixPath], max_bytes: int
    ) -> dict[PurePosixPath, bytes | None]:
        contents: dict[PurePosixPath, bytes | None] = {}
        wanted: list[tuple[PurePosixPath, str]] = []
        for path in paths:
            entry = self._entries.get(path)
            if entry is None:
                continue
            if not entry.readable or entry.size > max_bytes:
                contents[path] = None
            else:
                wanted.append((path, entry.oid))
        if not wanted:
            return contents
        _, raw = await run_git(
            self.checkout,
            "cat-file",
            "--batch",
            stdin="".join(f"{oid}\n" for _, oid in wanted).encode(),
        )
        offset = 0
        for path, _ in wanted:
            header_end = raw.index(b"\n", offset)
            header = raw[offset:header_end].split()
            if len(header) != 3:
                raise TreeScanError(f"git cat-file could not read {path}")
            size = int(header[2])
            contents[path] = raw[header_end + 1 : header_end + 1 + size]
            offset = header_end + 1 + size + 1
        return contents


# ---- Collection ----------------------------------------------------------------------------------


def _owner(path: PurePosixPath, ecosystems: Mapping[str, Ecosystem]) -> Ecosystem | None:
    return next((eco for eco in ecosystems.values() if eco.is_manifest(path)), None)


def _parse_data_stores(path: PurePosixPath, content: bytes) -> list[DataStoreDeclaration]:
    document = _mapping(_json_document(content), APP_MANIFEST_FILE)
    kinds: set[str] = {
        declaration["kind"]
        for declaration in _mapping(document.get("data") or {}, "data").values()
        if isinstance(declaration, dict) and isinstance(declaration.get("kind"), str)
    }
    return [DataStoreDeclaration(path, kind) for kind in sorted(kinds & DATA_STORE_KINDS)]


async def collect_tree_facts(
    source: TreeSource, ecosystems: Mapping[str, Ecosystem] = ECOSYSTEMS
) -> TreeFacts:
    """One listing; manifests and lockfiles parsed within bounds; sources bucketed by extension.
    An oversize or unparseable manifest makes the facts incomplete. An oversize lockfile only
    loses resolved versions (inventory degrades; enforcement reads manifests)."""
    listed = await source.list_paths()
    truncated = len(listed) > MAX_LISTED_PATHS
    paths = tuple(listed[:MAX_LISTED_PATHS])
    path_set = frozenset(paths)
    derived = derived_paths(paths)

    sources: dict[str, list[PurePosixPath]] = {}
    for path in paths:
        extension = path.suffix.lower()
        if SOURCE_EXTENSION_PATTERN.match(extension) and counts_as_source(path):
            sources.setdefault(extension, []).append(path)

    candidates = [p for p in paths if p not in derived and not _in_excluded_directory(p)]
    unreadable: set[PurePosixPath] = set()
    declared: list[DeclaredDependency] = []
    parsed: set[PurePosixPath] = set()
    pending: deque[tuple[PurePosixPath, Ecosystem]] = deque(
        (path, eco) for path in candidates if (eco := _owner(path, ecosystems)) is not None
    )
    parsed.update(path for path, _ in pending)
    while pending:
        batch = list(pending)
        pending.clear()
        contents = await source.read_files([path for path, _ in batch], MAX_MANIFEST_BYTES)
        for path, ecosystem in batch:
            if path not in contents:
                continue
            content = contents[path]
            try:
                if content is None:
                    raise ManifestParseError("too large or not a regular file")
                manifest = ecosystem.parse_manifest(path, content)
            except ManifestParseError:
                unreadable.add(path)
                continue
            declared.extend(manifest.dependencies)
            for include in manifest.includes:
                normalized = PurePosixPath(posixpath.normpath(include))
                if normalized in path_set and normalized not in parsed:
                    parsed.add(normalized)
                    pending.append((normalized, ecosystem))

    data_stores: list[DataStoreDeclaration] = []
    app_manifests = [p for p in candidates if p.name == APP_MANIFEST_FILE]
    for path, content in (await source.read_files(app_manifests, MAX_MANIFEST_BYTES)).items():
        try:
            if content is None:
                raise ManifestParseError("too large or not a regular file")
            data_stores.extend(_parse_data_stores(path, content))
        except ManifestParseError:
            unreadable.add(path)

    direct_names = {(dep.ecosystem, dep.manifest_path.parent, dep.name) for dep in declared}
    resolved: list[ResolvedPackage] = []
    for ecosystem in ecosystems.values():
        lockfiles = [p for p in candidates if ecosystem.is_lockfile(p)]
        for path, content in (await source.read_files(lockfiles, MAX_LOCKFILE_BYTES)).items():
            if content is None:
                continue
            try:
                packages = ecosystem.parse_lockfile(path, content)
            except ManifestParseError:
                continue
            for name, version in packages:
                normalized_name = ecosystem.normalize(name)
                resolved.append(
                    ResolvedPackage(
                        ecosystem.id,
                        normalized_name,
                        version,
                        path,
                        (ecosystem.id, path.parent, normalized_name) in direct_names,
                    )
                )

    return TreeFacts(
        paths=paths,
        derived=derived,
        sources={extension: tuple(found) for extension, found in sorted(sources.items())},
        declared=tuple(
            sorted(
                set(declared), key=lambda d: (str(d.manifest_path), d.ecosystem, d.name, d.scope)
            )
        ),
        resolved=tuple(
            sorted(
                set(resolved), key=lambda r: (str(r.lockfile_path), r.ecosystem, r.name, r.version)
            )
        ),
        data_stores=tuple(sorted(set(data_stores), key=lambda d: (str(d.path), d.kind))),
        project_dirs=frozenset(path.parent for path in candidates if is_toolchain_file(path)),
        unreadable=tuple(sorted(unreadable)),
        truncated=truncated,
    )
