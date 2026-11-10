/**
 * deploy-app for OpenCode. Not a tool (no default tool() export).
 *
 * All behavior lives in sandbox_runtime/app_deploy.py, which the Claude harness
 * calls in-process, so the two harnesses cannot drift. This module declares the
 * tool from the generated contract and relays the Python envelope.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { APP_DEPLOY_CONTRACT } from "./_app-deploy-contract.js";

/** Python startup and packing time on top of the request timeout app_deploy.py applies. */
const PYTHON_STARTUP_MARGIN_MS = 15_000;
const TIMEOUT_MS = APP_DEPLOY_CONTRACT.tool.timeoutSeconds * 1000 + PYTHON_STARTUP_MARGIN_MS;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** OpenCode `args`; every input is an optional string. `z` is the plugin's `tool.schema`. */
export function deployAppArgs(z) {
  return Object.fromEntries(
    Object.entries(APP_DEPLOY_CONTRACT.tool.inputSchema.properties).map(([key, property]) => [
      key,
      z.string().optional().describe(property.description),
    ])
  );
}

/** Run the Python implementation and return its stdout, or a bridge_error envelope. */
export function runDeployApp(args, execFile = nodeExecFile) {
  return new Promise((resolve) => {
    execFile(
      "python",
      ["-m", "sandbox_runtime.app_deploy", "--args-json", JSON.stringify(args ?? {})],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (_error, stdout) => {
        const output = typeof stdout === "string" ? stdout.trim() : "";
        if (output) {
          resolve(output);
          return;
        }
        resolve(
          JSON.stringify({
            ok: false,
            reason: "bridge_error",
            agentMessage: APP_DEPLOY_CONTRACT.bridgeErrorGuidance,
          })
        );
      }
    );
  });
}

export function deployAppDefinition(z, execFile = nodeExecFile) {
  return {
    description: APP_DEPLOY_CONTRACT.tool.description,
    args: deployAppArgs(z),
    execute: (args) => runDeployApp(args, execFile),
  };
}
