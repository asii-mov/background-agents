/**
 * Builds the three Workers this package ships:
 *   dist/index.js       the broker, with the guard modules inlined as __OI_GUARD_BUNDLE__
 *   dist/guard.mjs      the main module of every app script (also dist/guard-core.mjs)
 *   dist/dispatcher.js  the Workers for Platforms dispatcher
 * The bundle functions are exported so tests run the exact artifacts Terraform deploys.
 */

import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const dist = join(packageRoot, "dist");

export const GUARD_MODULE_NAMES = {
  main: "guard.mjs",
  core: "guard-core.mjs",
  user: "app.mjs",
};

const WORKER_BUILD = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  write: false,
  logLevel: "silent",
};

function isPlainData(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isPlainData);
  return (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isPlainData)
  );
}

/**
 * Replaces a shared module with its plain-data exports, so the guard carries the identity and
 * binding names it needs without the zod schemas that live beside them. Importing anything else
 * from that module fails the build.
 */
function plainDataExports(specifier) {
  return {
    name: "plain-data-exports",
    setup(pluginBuild) {
      const filter = new RegExp(`^${specifier.replace(/[/.]/g, "\\$&")}$`);
      pluginBuild.onResolve({ filter }, (args) => ({ path: args.path, namespace: "plain-data" }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "plain-data" }, async (args) => {
        const module = await import(args.path);
        const contents = Object.entries(module)
          .filter(([, value]) => isPlainData(value))
          .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
          .join("\n");
        return { contents, loader: "js" };
      });
    },
  };
}

async function bundle(entry, options = {}) {
  const result = await build({
    ...WORKER_BUILD,
    ...options,
    entryPoints: [join(packageRoot, entry)],
  });
  return result.outputFiles[0].text;
}

/** The guard's modules in upload order: main first. */
export async function bundleGuard() {
  const core = await bundle("guard/guard.ts", {
    plugins: [plainDataExports("@open-inspect/shared/types/app-data")],
  });
  const main =
    `import { createGuard } from "./${GUARD_MODULE_NAMES.core}";\n` +
    `import * as app from "./${GUARD_MODULE_NAMES.user}";\n\n` +
    "export default createGuard(app);\n";
  return {
    modules: [
      { name: GUARD_MODULE_NAMES.main, source: main },
      { name: GUARD_MODULE_NAMES.core, source: core },
    ],
    userModuleName: GUARD_MODULE_NAMES.user,
  };
}

/** The broker Worker with `guard` inlined as the modules it uploads into every app script. */
export async function bundleBroker(guard) {
  return bundle("src/index.ts", { define: { __OI_GUARD_BUNDLE__: JSON.stringify(guard) } });
}

async function main() {
  const guard = await bundleGuard();
  const broker = await bundleBroker(guard);
  const dispatcher = await bundle("dispatcher/dispatcher.ts");
  await mkdir(dist, { recursive: true });
  await Promise.all([
    writeFile(join(dist, "index.js"), broker),
    writeFile(join(dist, "dispatcher.js"), dispatcher),
    ...guard.modules.map((module) => writeFile(join(dist, module.name), module.source)),
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
