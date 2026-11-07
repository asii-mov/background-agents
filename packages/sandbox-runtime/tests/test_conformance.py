"""The app-data conformance checker and the app-dev tool, run as the platform runs them."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.security_pipeline import SecurityPipelineRunner, parse_security_pipelines

if TYPE_CHECKING:
    from collections.abc import Callable

SRC = Path(__file__).resolve().parents[1] / "src"
COMMAND = [sys.executable, "-m", "sandbox_runtime.conformance"]
pytestmark = pytest.mark.skipif(
    shutil.which("bun") is None and shutil.which("node") is None, reason="bun or node is required"
)

CLEAN_WORKER = """
const LIST_NOTES: string = `
  SELECT id, body FROM notes WHERE owner_sub = ?
`;
const ADD_NOTE = "INSERT INTO notes (id, owner_sub, body) VALUES (?, ?, ?)";

export default {
  async fetch(request: Request, env: Env) {
    const sub = request.headers.get("x-openinspect-user-sub");
    const words = /'[a-z]+'/.exec(await request.text());
    if (request.method === "POST") {
      await env.DB.prepare(ADD_NOTE).bind(crypto.randomUUID(), sub, words?.[0]).run();
    }
    const notes = await env.DB.prepare(LIST_NOTES).bind(sub).all();
    const mode = process.env.NODE_ENV;
    return Response.json({ notes, mode, key: Boolean(env.API_KEY), site: "https://example.com" });
  },
};
"""
CLEAN_MIGRATION = """-- notes belong to the signed-in user
PRAGMA defer_foreign_keys = true;
CREATE TABLE notes (id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, body TEXT DEFAULT 'a;b');
CREATE TRIGGER notes_body AFTER INSERT ON notes BEGIN
  UPDATE notes SET body = CASE WHEN body IS NULL THEN '' ELSE body END WHERE id = NEW.id;
END;
"""


def _app(root: Path, *, worker: str = CLEAN_WORKER, **manifest: object) -> Path:
    app = root / "apps" / "notes"
    (app / "migrations").mkdir(parents=True)
    (app / "src").mkdir()
    document = {
        "schemaVersion": 1,
        "name": "notes",
        "data": {"DB": {"kind": "d1"}},
        "secrets": ["API_KEY"],
        **manifest,
    }
    (app / "openinspect.app.json").write_text(json.dumps(document))
    (app / "src" / "worker.ts").write_text(worker)
    (app / "migrations" / "0001_create-notes.sql").write_text(CLEAN_MIGRATION)
    (app / "node_modules" / "dep").mkdir(parents=True)
    (app / "node_modules" / "dep" / "index.js").write_text('fetch("https://api.cloudflare.com")')
    return app


def _run(cwd: Path, *args: str, path: str | None = None) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PYTHONPATH": str(SRC)}
    if path is not None:
        env["PATH"] = path
    return subprocess.run(
        [*COMMAND, *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=60
    )


def _findings(result: subprocess.CompletedProcess[str]) -> list[str]:
    return [line.split(" ", 1)[0] for line in result.stdout.splitlines()]


def test_a_checkout_without_an_app_passes_without_starting_a_runtime(tmp_path):
    (tmp_path / "README.md").write_text("no app here")

    result = _run(tmp_path, "app-data", path="")

    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")


def test_a_clean_app_passes(tmp_path):
    _app(tmp_path)

    result = _run(tmp_path, "app-data")

    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout == ""


def _write(relative: str, text: str) -> Callable[[Path], None]:
    def change(app: Path) -> None:
        target = app / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    return change


def _replace_in_worker(old: str, new: str) -> Callable[[Path], None]:
    def change(app: Path) -> None:
        worker = app / "src" / "worker.ts"
        worker.write_text(worker.read_text().replace(old, new))

    return change


RULES = [
    (
        "data/manifest-invalid",
        _write(
            "openinspect.app.json",
            '{"schemaVersion":1,"name":"notes","data":{"DB":{"kind":"d1"}},"secrets":["DATABASE_URL"]}',
        ),
        _write(
            "openinspect.app.json",
            '{"schemaVersion":1,"name":"notes","data":{"DB":{"kind":"d1"}},"secrets":["API_KEY"]}',
        ),
    ),
    (
        "data/no-interpolated-sql",
        _replace_in_worker(
            "prepare(LIST_NOTES)", "prepare(`SELECT * FROM notes WHERE id = ${sub}`)"
        ),
        _replace_in_worker("prepare(LIST_NOTES)", 'prepare("SELECT id FROM notes")'),
    ),
    (
        "data/no-interpolated-sql",
        _replace_in_worker(
            "prepare(LIST_NOTES)", 'prepare("SELECT * FROM notes WHERE id = " + sub)'
        ),
        _replace_in_worker("prepare(LIST_NOTES)", "prepare(ADD_NOTE)"),
    ),
    (
        "data/undeclared-binding",
        _replace_in_worker("Boolean(env.API_KEY)", "Boolean(env.STRIPE_KEY)"),
        _replace_in_worker("Boolean(env.API_KEY)", "Boolean(process.env.STRIPE_KEY)"),
    ),
    (
        "data/forbidden-identity-header",
        _replace_in_worker('"x-openinspect-user-sub"', '"Cf-Access-Authenticated-User-Email"'),
        _replace_in_worker('"x-openinspect-user-sub"', '"x-openinspect-user-email"'),
    ),
    (
        "data/no-connection-string",
        _replace_in_worker('"https://example.com"', '"postgres://reader@db.example.com/notes"'),
        _replace_in_worker('"https://example.com"', '"https://db.example.com/notes"'),
    ),
    (
        "data/no-cloudflare-api",
        _replace_in_worker('"https://example.com"', '"https://api.cloudflare.com/client/v4"'),
        _replace_in_worker('"https://example.com"', '"https://cloudflare.com/learning"'),
    ),
    (
        "data/no-handwritten-config",
        _write("wrangler.jsonc", '{"d1_databases":[]}'),
        _write(".openinspect/dev/wrangler.jsonc", '{"d1_databases":[]}'),
    ),
    (
        "data/migration-file-grammar",
        _write("migrations/2_more.sql", "CREATE TABLE tags (id TEXT);"),
        _write("migrations/0002_more.sql", "CREATE TABLE tags (id TEXT);"),
    ),
    (
        "data/migration-forbidden-statement",
        _write("migrations/0002_more.sql", "CREATE TABLE tags (id TEXT);\nVACUUM;"),
        _write(
            "migrations/0002_more.sql", "CREATE TABLE tags (id TEXT);\nPRAGMA foreign_keys = ON;"
        ),
    ),
    (
        "data/migration-forbidden-statement",
        _write("migrations/0002_more.sql", "DELETE FROM _openinspect_migrations;"),
        _write("migrations/0002_more.sql", "DELETE FROM tags WHERE id = 'x';"),
    ),
]


@pytest.mark.parametrize(("rule", "breaks", "keeps"), RULES)
def test_each_rule_flags_its_violation_and_passes_the_fix(tmp_path, rule, breaks, keeps):
    broken_root = tmp_path / "broken"
    breaks(_app(broken_root))
    fixed_root = tmp_path / "fixed"
    keeps(_app(fixed_root))

    broken = _run(broken_root, "app-data")
    fixed = _run(fixed_root, "app-data")

    assert broken.returncode == 1, broken.stderr
    assert _findings(broken) == [rule]
    assert broken.stdout.startswith(f"{rule} apps/notes/")
    assert (fixed.returncode, fixed.stdout) == (0, ""), fixed.stdout + fixed.stderr


def test_node_runs_the_checker_when_bun_is_absent(tmp_path):
    node = shutil.which("node")
    if node is None or (Path(node).parent / "bun").exists():
        pytest.skip("needs a node directory without bun")
    _replace_in_worker("Boolean(env.API_KEY)", "Boolean(env.STRIPE_KEY)")(_app(tmp_path))

    result = _run(tmp_path, "app-data", path=str(Path(node).parent))

    assert _findings(result) == ["data/undeclared-binding"], result.stderr


async def test_findings_reach_the_agent_through_the_remediation_prompt(tmp_path, monkeypatch):
    _replace_in_worker("prepare(LIST_NOTES)", "prepare(`SELECT * FROM notes WHERE id = ${sub}`)")(
        _app(tmp_path)
    )
    monkeypatch.setenv("PYTHONPATH", str(SRC))
    seeded = {
        "id": "secpipe_platform_app_data_conformance",
        "name": "Platform: app data conformance",
        "commands": [
            {
                "name": "app-data-conformance",
                "command": [*COMMAND, "app-data"],
                "timeoutSeconds": 120,
            }
        ],
        "blocking": True,
        "maxRemediationAttempts": 2,
        "repoScopes": None,
    }
    pipelines = parse_security_pipelines(json.dumps({"security_pipelines": [seeded]}))

    report = await SecurityPipelineRunner(pipelines, tmp_path, MagicMock()).run()

    assert not report.passed
    prompt = report.remediation_prompt()
    assert "data/no-interpolated-sql apps/notes/src/worker.ts:" in prompt
    assert "pass values with .bind(...)" in prompt


def test_app_dev_derives_local_bindings_and_the_platform_identity(tmp_path):
    app = _app(
        tmp_path,
        data={
            "DB": {"kind": "d1", "migrations": "db/migrations"},
            "CACHE": {"kind": "kv"},
            "FILES": {"kind": "r2"},
        },
    )
    (app / "worker.mjs").write_text(
        "export default { fetch: (request) => Response.json(Object.fromEntries(request.headers)) };"
    )
    dev = app / ".openinspect" / "dev"
    dev.mkdir(parents=True)
    (dev / ".dev.vars").write_text("API_KEY=chosen-by-a-person\n")

    result = _run(app, "app-dev", "--entry", "worker.mjs", "--assets", "dist")

    assert result.returncode == 0, result.stderr
    assert "wrangler d1 migrations apply DB --local" in result.stdout
    config = json.loads((dev / "wrangler.jsonc").read_text().split("\n", 1)[1])
    assert config["d1_databases"] == [
        {
            "binding": "DB",
            "database_name": "local-db",
            "database_id": "local-db",
            "migrations_dir": "../../db/migrations",
        }
    ]
    assert config["kv_namespaces"] == [{"binding": "CACHE", "id": "local-cache"}]
    assert config["r2_buckets"] == [{"binding": "FILES", "bucket_name": "local-files"}]
    assert config["assets"] == {
        "directory": "../../dist",
        "binding": "ASSETS",
        "run_worker_first": True,
    }
    assert (dev / ".gitignore").read_text() == "*\n"
    assert (dev / ".dev.vars").read_text() == "API_KEY=chosen-by-a-person\n"
    assert _run(tmp_path, "app-data").returncode == 0


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required")
def test_app_dev_entry_replaces_forged_identity_headers(tmp_path):
    app = _app(tmp_path)
    (app / "worker.mjs").write_text(
        "export default { fetch: (request) => Response.json(Object.fromEntries(request.headers)) };"
    )
    assert _run(app, "app-dev", "--entry", "worker.mjs").returncode == 0
    entry = app / ".openinspect" / "dev" / "dev-entry.mjs"
    probe = (
        f"const {{ default: entry }} = await import({json.dumps(entry.as_uri())});"
        "const response = await entry.fetch(new Request('http://localhost/', { headers: {"
        " 'cf-access-authenticated-user-email': 'forged@example.invalid',"
        " 'x-openinspect-user-sub': 'forged' } }), {}, {});"
        "console.log(JSON.stringify(await response.json()));"
    )

    seen = json.loads(
        subprocess.run(
            [shutil.which("node") or "node", "--input-type=module", "-e", probe],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        ).stdout
    )

    assert seen["x-openinspect-user-sub"] == "dev-user"
    assert seen["x-openinspect-user-email"] == "dev-user@example.invalid"
    assert "cf-access-authenticated-user-email" not in seen
