"""Apply one regression at a time and confirm the named tests fail; restores each file after."""
import subprocess, sys
from pathlib import Path

W = Path(sys.argv[1] if len(sys.argv) > 1 else "/home/asiimov/Projects/secure-generation/oi-unit-U4a")
CP = W / "packages/control-plane"
VITEST = "npx vitest run --root packages/control-plane"
PY_SR = "cd packages/sandbox-runtime && uv run --frozen --extra dev pytest -q -p no:cacheprovider"
PY_MI = "cd packages/modal-infra && uv run --frozen --extra dev pytest -q -p no:cacheprovider"
MUTATIONS = [
    ("launch-context still refuses Claude with pipelines",
     "packages/control-plane/src/sandbox/lifecycle/launch-context.ts",
     'session.harness === "claude" && servers?.some((server) => server.artifactSha256)',
     'session.harness === "claude" && (servers?.some((server) => server.artifactSha256) || true)',
     f"{VITEST} src/sandbox/lifecycle/governance.test.ts"),
    ("governance drops the stack policy",
     "packages/control-plane/src/sandbox/sandbox-env.ts",
     "stack_policy: governance?.stackPolicy,", "stack_policy: undefined,",
     f"{VITEST} src/sandbox/sandbox-env.test.ts src/sandbox/providers src/sandbox/client.test.ts"),
    ("Modal create body loses governance",
     "packages/control-plane/src/sandbox/client.ts",
     "          ...governanceWireFields(request.governance),\n", "",
     f"{VITEST} src/sandbox/client.test.ts"),
    ("Modal provider drops governance",
     "packages/control-plane/src/sandbox/providers/modal-provider.ts",
     "          governance: config.governance,\n", "",
     f"{VITEST} src/sandbox/client.test.ts"),
    ("tunnels policy ignored",
     "packages/control-plane/src/sandbox/settings.ts",
     'options.tunnelsPolicy === "disabled"', "false",
     f"{VITEST} src/sandbox/settings.test.ts src/sandbox/lifecycle/governance.test.ts"),
    ("deploy-app gate not set for REST providers",
     "packages/control-plane/src/sandbox/sandbox-env.ts",
     'envVars.AGENT_APP_DEPLOY_ENABLED = "true";', "",
     f"{VITEST} src/sandbox/sandbox-env.test.ts src/sandbox/providers"),
    ("prune not registered",
     "packages/control-plane/src/scheduled-jobs.ts",
     "      backgroundTasks.submit(\n        async () => {\n          const observations",
     "      void (\n        async () => {\n          const observations",
     f"{VITEST} src/scheduled-jobs.test.ts"),
    ("composition root does not wire the stack policy",
     "packages/control-plane/src/session/components.ts",
     "    stackPolicyLookup,\n    sandboxNetworkPolicyLookup,\n    slackAgentNotifyLookup,\n    agentAppDeployEnabled",
     "    sandboxNetworkPolicyLookup,\n    slackAgentNotifyLookup,\n    agentAppDeployEnabled",
     "cd packages/control-plane && npx vitest run --config vitest.integration.config.ts test/integration/stack-policy-launch.test.ts"),
    ("composition root ignores hosting config",
     "packages/control-plane/src/session/components.ts",
     "agentAppDeployEnabled: isAppHostingConfigured(env),", "agentAppDeployEnabled: false,",
     "cd packages/control-plane && npx vitest run --config vitest.integration.config.ts test/integration/stack-policy-launch.test.ts"),
    ("runtime still refuses Claude with pipelines",
     "packages/sandbox-runtime/src/sandbox_runtime/runtime_config.py",
     'if parsed_session_config.get("harness") == "claude" and any(',
     'if parsed_session_config.get("harness") == "claude" and parsed_session_config.get("security_pipelines") or any(',
     f"{PY_SR} tests/test_runtime_config.py tests/test_claude_governance.py"),
    ("bridge push skips the runner",
     "packages/sandbox-runtime/src/sandbox_runtime/bridge.py",
     "            security_pipelines=self.security_pipelines,\n        ).execute", "        ).execute",
     f"{PY_SR} tests/test_claude_governance.py"),
    ("Modal SessionConfig drops stack_policy",
     "packages/sandbox-runtime/src/sandbox_runtime/types.py",
     "    stack_policy: dict[str, Any] | None = None\n", "",
     f"{PY_MI} tests/test_web_api_create_sandbox.py tests/test_governed_launch_env.py"),
    ("Modal launch does not set the deploy-app gate",
     "packages/modal-infra/src/sandbox/launch.py",
     'env_vars["AGENT_APP_DEPLOY_ENABLED"] = "true"', "pass",
     f"{PY_MI} tests/test_governed_launch_env.py"),
    ("Modal web_api drops the deploy-app gate",
     "packages/modal-infra/src/web_api.py",
     "            agent_app_deploy_enabled=parsed_request.agent_app_deploy_enabled,\n", "",
     f"{PY_MI} tests/test_web_api_create_sandbox.py"),
]
failed_to_catch = []
for name, rel, old, new, cmd in MUTATIONS:
    path = W / rel
    original = path.read_text()
    assert original.count(old) >= 1, f"{name}: anchor missing"
    path.write_text(original.replace(old, new, 1))
    try:
        result = subprocess.run(cmd, shell=True, cwd=W, capture_output=True, text=True)
    finally:
        path.write_text(original)
    caught = result.returncode != 0
    print(f"{'CAUGHT ' if caught else 'MISSED '} {name}")
    if not caught:
        failed_to_catch.append(name)
sys.exit(1 if failed_to_catch else 0)
