import assert from "node:assert/strict";
import test from "node:test";

const { deployAppArgs, deployAppDefinition, runDeployApp } =
  await import("../src/sandbox_runtime/tools/_deploy-app.js");
const { APP_DEPLOY_CONTRACT } =
  await import("../src/sandbox_runtime/tools/_app-deploy-contract.js");

function fakeExecFile(result) {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
  };
  return { calls, execFile };
}

test("forwards the arguments to the Python implementation as one JSON argument", async () => {
  const { calls, execFile } = fakeExecFile({ stdout: '{"ok":true}\n' });
  const args = { name: "notes", assetsDir: "dist", projectDir: "web" };

  await runDeployApp(args, execFile);

  assert.equal(calls[0].command, "python");
  assert.deepEqual(calls[0].args, [
    "-m",
    "sandbox_runtime.app_deploy",
    "--args-json",
    JSON.stringify(args),
  ]);
});

test("waits longer than the request timeout the Python side applies", async () => {
  const { calls, execFile } = fakeExecFile({ stdout: "{}" });

  await runDeployApp({}, execFile);

  assert.ok(calls[0].options.timeout > APP_DEPLOY_CONTRACT.tool.timeoutSeconds * 1000);
});

test("relays the Python envelope verbatim", async () => {
  const envelope = JSON.stringify({
    ok: false,
    reason: "name_taken",
    agentMessage: "pick another",
  });
  const { execFile } = fakeExecFile({ stdout: `${envelope}\n`, error: new Error("exit 1") });

  assert.equal(await runDeployApp({ name: "notes" }, execFile), envelope);
});

test("reports bridge_error when Python produced no output", async () => {
  const { execFile } = fakeExecFile({ stdout: "", error: new Error("spawn python ENOENT") });

  const result = JSON.parse(await runDeployApp({ name: "notes" }, execFile));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "bridge_error");
  assert.match(result.agentMessage, /Call deploy-app once more/);
  assert.doesNotMatch(result.agentMessage, /ENOENT/);
});

/** Records the zod builder calls; the plugin's zod is not installed here. */
function recordingSchema() {
  const node = (calls) =>
    new Proxy(
      { calls },
      {
        get: (target, method) =>
          method === "calls"
            ? target.calls
            : (...args) => node([...target.calls, [method, ...args]]),
      }
    );
  return { string: () => node([["string"]]) };
}

test("declares every contract input as an optional described string", () => {
  const args = deployAppArgs(recordingSchema());
  const properties = APP_DEPLOY_CONTRACT.tool.inputSchema.properties;

  assert.deepEqual(Object.keys(args), Object.keys(properties));
  for (const [key, property] of Object.entries(properties)) {
    assert.deepEqual(args[key].calls, [
      ["string"],
      ["optional"],
      ["describe", property.description],
    ]);
  }
});

test("the tool definition uses the contract description and runs the shim", async () => {
  const { calls, execFile } = fakeExecFile({ stdout: '{"ok":true}' });
  const definition = deployAppDefinition(recordingSchema(), execFile);

  assert.equal(definition.description, APP_DEPLOY_CONTRACT.tool.description);
  assert.equal(await definition.execute({ assetsDir: "dist" }), '{"ok":true}');
  assert.equal(calls.length, 1);
});
