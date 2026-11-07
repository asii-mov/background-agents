"""Contract tests for the centrally approved component agent tool."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

NODE_BINARY = shutil.which("node")
TOOLS = Path(__file__).resolve().parents[1] / "src" / "sandbox_runtime" / "tools"
pytestmark = pytest.mark.skipif(NODE_BINARY is None, reason="node is required")


def _tool_module(tmp_path: Path) -> Path:
    shutil.copyfile(TOOLS / "approved-components.js", tmp_path / "approved-components.js")
    shutil.copyfile(TOOLS / "_bridge-client.js", tmp_path / "_bridge-client.js")
    (tmp_path / "package.json").write_text('{"type":"module"}')

    plugin = tmp_path / "node_modules" / "@opencode-ai" / "plugin"
    plugin.mkdir(parents=True, exist_ok=True)
    (plugin / "package.json").write_text('{"type":"module","exports":"./index.js"}')
    (plugin / "index.js").write_text("export const tool = (config) => config;")

    zod = tmp_path / "node_modules" / "zod"
    zod.mkdir(parents=True, exist_ok=True)
    (zod / "package.json").write_text('{"type":"module","exports":"./index.js"}')
    (zod / "index.js").write_text(
        "const schema = { describe() { return this; }, optional() { return this; } };"
        "export const z = {"
        " string() { return Object.create(schema); },"
        " enum() { return Object.create(schema); }"
        "};"
    )
    return tmp_path / "approved-components.js"


def _run(tmp_path: Path, script: str, *args: str) -> str:
    env = {
        **os.environ,
        "SANDBOX_AUTH_TOKEN": "test-token",
        "SESSION_CONFIG": '{"sessionId":"session-1"}',
        "CONTROL_PLANE_URL": "https://control.example.com",
    }
    result = subprocess.run(
        [NODE_BINARY, "--input-type=module", "-e", script, _tool_module(tmp_path).as_uri(), *args],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
        env=env,
    )
    return result.stdout


def test_resolves_only_session_members_for_adoption(tmp_path: Path) -> None:
    members = [
        {"owner": "Acme", "name": "Frontend"},
        {"owner": "Acme", "name": "Backend"},
    ]
    script = """
      const { resolveAdoptionRepository } = await import(process.argv[1]);
      process.stdout.write(JSON.stringify(resolveAdoptionRepository(process.argv[2], JSON.parse(process.argv[3]))));
    """

    assert json.loads(_run(tmp_path, script, "acme/backend", json.dumps(members))) == members[1]
    assert _run(tmp_path, script, "other/repo", json.dumps(members)) == "null"


def test_search_calls_the_session_scoped_catalogue(tmp_path: Path) -> None:
    script = """
      globalThis.fetch = async (url, options) => {
        process.stdout.write(JSON.stringify({url, authorization: options.headers.get('Authorization')}));
        return new Response(JSON.stringify([{id:'component-1', name:'Authentication'}]), {status: 200});
      };
      const { default: componentTool } = await import(process.argv[1]);
      const result = await componentTool.execute({action:'search', query:'auth'});
      process.stdout.write(String.fromCharCode(10) + result);
    """

    output = _run(tmp_path, script)
    request, result = output.split("\n", 1)

    assert json.loads(request) == {
        "url": "https://control.example.com/sessions/session-1/approved-components?query=auth",
        "authorization": "Bearer test-token",
    }
    assert json.loads(result)["components"][0]["id"] == "component-1"


def test_search_leads_each_component_with_its_stance_and_category(tmp_path: Path) -> None:
    script = """
      globalThis.fetch = async () => new Response(JSON.stringify([
        {id:'react', name:'React', stance:'denied', categoryId:'web-frontend'},
        {id:'auth', name:'Authentication'},
      ]), {status: 200});
      const { default: componentTool } = await import(process.argv[1]);
      process.stdout.write(await componentTool.execute({action:'search', query:'ui'}));
    """

    result = json.loads(_run(tmp_path, script))

    assert [(c["stance"], c["category"], c["id"]) for c in result["components"]] == [
        ("denied", "web-frontend", "react"),
        ("allowed", None, "auth"),
    ]
    assert "never use it" in result["stances"]["denied"]


def test_adopting_a_detected_component_explains_that_detection_is_automatic(
    tmp_path: Path,
) -> None:
    module = _tool_module(tmp_path)
    manifest = tmp_path / "repo-manifest.json"
    manifest.write_text(json.dumps({"repositories": [{"owner": "acme", "name": "web"}]}))
    # The tool reads the live session manifest; this copy reads a per-test one instead.
    module.write_text(module.read_text().replace("/tmp/oi-repo-manifest.json", str(manifest)))
    script = """
      globalThis.fetch = async () => new Response(
        JSON.stringify({error: 'Component is detected automatically'}), {status: 409});
      const { default: componentTool } = await import(process.argv[1]);
      process.stdout.write(await componentTool.execute({action:'adopt', componentId:'bun'}));
    """

    result = subprocess.run(
        [NODE_BINARY, "--input-type=module", "-e", script, module.as_uri()],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
        env={
            **os.environ,
            "SANDBOX_AUTH_TOKEN": "test-token",
            "SESSION_CONFIG": '{"sessionId":"session-1"}',
            "CONTROL_PLANE_URL": "https://control.example.com",
        },
    ).stdout

    assert result.startswith("Adoption not recorded: Component is detected automatically.")
    assert "recorded automatically from the repository's manifests" in result
