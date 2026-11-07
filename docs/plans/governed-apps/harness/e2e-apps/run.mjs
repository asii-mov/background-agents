// Bundles app-deploy-e2e.ts against a worktree and runs it.
// Usage: node run.mjs <worktree> [workers|dispatch-namespace ...]
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worktree = resolve(process.argv[2] ?? process.cwd());
const { build } = await import(
  pathToFileURL(join(worktree, "node_modules/esbuild/lib/main.js")).href
);
const outfile = join(here, "out", "app-deploy-e2e.mjs");
await build({
  entryPoints: [join(here, "app-deploy-e2e.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  external: ["node:*"],
  nodePaths: [join(worktree, "node_modules")],
  alias: { worktree },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "warning",
});
const backends =
  process.argv.length > 3 ? process.argv.slice(3) : ["workers", "dispatch-namespace"];
for (const backend of backends) {
  const run = spawnSync(process.execPath, ["--no-warnings", outfile, worktree, backend], {
    stdio: "inherit",
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
