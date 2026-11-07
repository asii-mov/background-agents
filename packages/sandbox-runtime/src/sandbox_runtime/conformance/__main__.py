"""``python -m sandbox_runtime.conformance app-data|app-dev [args]``.

``app-data`` runs after every agent turn in every session, so it first looks for app directories
(a directory holding ``openinspect.app.json``) and exits 0 without starting a JavaScript runtime
when there are none. Otherwise it runs the JavaScript checker beside this file on those
directories with Bun, or Node when Bun is absent.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST_FILE = "openinspect.app.json"
SCRIPTS = {"app-data": HERE / "app-data.mjs", "app-dev": HERE / "app-dev.mjs"}
# The checker skips the same directories; generated and vendored trees are never app sources.
SKIPPED_DIRS = frozenset(
    {
        "node_modules",
        ".git",
        ".openinspect",
        ".svelte-kit",
        ".wrangler",
        "dist",
        "build",
        "coverage",
    }
)


def find_app_dirs(root: Path) -> list[Path]:
    """Every directory under ``root`` that holds an app manifest, in path order."""
    found: list[Path] = []
    for directory, subdirectories, files in os.walk(root):
        subdirectories[:] = sorted(name for name in subdirectories if name not in SKIPPED_DIRS)
        if MANIFEST_FILE in files:
            found.append(Path(directory))
    return found


def runtime_command(script: Path) -> list[str] | None:
    bun = shutil.which("bun")
    if bun:
        return [bun, "run", str(script)]
    node = shutil.which("node")
    if node:
        return [node, str(script)]
    return None


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in SCRIPTS:
        print(f"usage: python -m sandbox_runtime.conformance {'|'.join(SCRIPTS)} [args]")
        return 2
    tool, args = argv[0], argv[1:]
    if tool == "app-data":
        args = [str(path) for path in find_app_dirs(Path.cwd())]
        if not args:
            return 0
    command = runtime_command(SCRIPTS[tool])
    if command is None:
        print(f"{tool}: neither bun nor node is installed in this sandbox", file=sys.stderr)
        return 1
    os.execv(command[0], [*command, *args])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
