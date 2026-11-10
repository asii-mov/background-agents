#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { openInspectFeatureDirectory } from "./openinspect-feature-directory.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const generatedMapPath = resolve(repositoryRoot, "docs/REPO_MAP.md");
const appRoot = resolve(repositoryRoot, "packages/web/src/app/(app)");
const settingsNavPath = resolve(
  repositoryRoot,
  "packages/web/src/components/settings/settings-registry.ts"
);
const verificationFixturePath = resolve(repositoryRoot, "packages/web/e2e/verification-test.ts");

function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

function collectSourcePaths(owners = {}) {
  return [owners.ui ?? [], owners.bff ?? [], owners.backend ?? []].flat();
}

function repositoryPathExists(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    return false;
  }

  const absolutePath = resolve(repositoryRoot, path);
  return absolutePath.startsWith(`${repositoryRoot}${sep}`) && existsSync(absolutePath);
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function pageRoute(pagePath) {
  const directory = relative(appRoot, dirname(pagePath));
  if (directory === "") return "/";

  const segments = directory
    .split(sep)
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .map((segment) => {
      const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
      if (optionalCatchAll) return `*${optionalCatchAll[1]}?`;
      const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
      if (catchAll) return `*${catchAll[1]}`;
      const dynamic = segment.match(/^\[(.+)\]$/);
      return dynamic ? `:${dynamic[1]}` : segment;
    });

  return `/${segments.join("/")}`;
}

function discoverAppRoutes() {
  return listFiles(appRoot)
    .filter((path) => path.endsWith(`${sep}page.tsx`))
    .map(pageRoute)
    .sort(compareStrings);
}

function discoverSettingsTabs() {
  const source = readFileSync(settingsNavPath, "utf8");
  const start = source.indexOf("export const SETTINGS_GROUPS");
  const end = source.indexOf("] as const", start);
  if (start === -1 || end === -1) {
    throw new Error("Could not find the SETTINGS_GROUPS Settings inventory.");
  }

  const tabs = [];
  const itemPattern = /\bid:\s*["']([^"']+)["']/g;
  for (const match of source.slice(start, end).matchAll(itemPattern)) tabs.push(match[1]);
  if (tabs.length === 0) throw new Error("The SETTINGS_GROUPS Settings inventory is empty.");
  return tabs;
}

function readPlaywrightTitles(testPath) {
  const source = readFileSync(resolve(repositoryRoot, testPath), "utf8");
  const titles = new Set();
  const titlePattern = /\btest(?:\.(?:only|skip|fixme))?\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const match of source.matchAll(titlePattern)) titles.add(match[2]);
  return titles;
}

function usesVerificationFixture(testPath) {
  const source = readFileSync(resolve(repositoryRoot, testPath), "utf8");
  return /from\s+["']\.\/verification-test["']/.test(source);
}

function verificationFixtureIsAutomatic() {
  const source = readFileSync(verificationFixturePath, "utf8");
  return /\{\s*auto:\s*true\s*\}/.test(source);
}

function addDuplicateError(errors, values, kind) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) errors.push(`Duplicate ${kind}: ${value}`);
    seen.add(value);
  }
}

function validateFeatureDirectory(directory = openInspectFeatureDirectory) {
  const errors = [];
  if (!verificationFixtureIsAutomatic()) {
    errors.push("The Playwright verification fixture must remain automatic.");
  }
  if (directory.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (!Array.isArray(directory.features) || directory.features.length === 0) {
    return ["features must be a non-empty array."];
  }

  addDuplicateError(
    errors,
    directory.features.map((feature) => feature.id),
    "feature ID"
  );

  const subfeatures = directory.features.flatMap((feature) => feature.subfeatures ?? []);
  addDuplicateError(
    errors,
    subfeatures.map((subfeature) => subfeature.id),
    "subfeature ID"
  );

  const routeOwners = new Map();
  for (const feature of directory.features) {
    if (!feature.id || !feature.title) errors.push("Every feature needs an ID and title.");
    if (!Array.isArray(feature.aliases)) errors.push(`${feature.id}: aliases must be an array.`);
    if (!Array.isArray(feature.userRoutes) || feature.userRoutes.length === 0) {
      errors.push(`${feature.id}: userRoutes must be a non-empty array.`);
    }
    if (!Array.isArray(feature.subfeatures) || feature.subfeatures.length === 0) {
      errors.push(`${feature.id}: subfeatures must be a non-empty array.`);
    }

    for (const route of feature.userRoutes ?? []) {
      const owner = routeOwners.get(route);
      if (owner) errors.push(`User route ${route} is owned by both ${owner} and ${feature.id}.`);
      routeOwners.set(route, feature.id);
    }

    const featurePaths = collectSourcePaths(feature.owners);
    if (featurePaths.length === 0)
      errors.push(`${feature.id}: at least one source owner is required.`);

    for (const subfeature of feature.subfeatures ?? []) {
      if (!subfeature.id || !subfeature.title) {
        errors.push(`${feature.id}: every subfeature needs an ID and title.`);
      }

      const coverage = subfeature.coverage;
      if (!coverage || !["browser-covered", "backend-only", "uncovered"].includes(coverage.kind)) {
        errors.push(
          `${subfeature.id}: coverage must be browser-covered, backend-only, or uncovered.`
        );
        continue;
      }

      const proofPaths = coverage.proofs ?? [];
      const referencedPaths = [
        ...featurePaths,
        ...collectSourcePaths(subfeature.sources),
        ...proofPaths,
      ];

      if (coverage.kind === "browser-covered") {
        if (!coverage.test?.file || !coverage.test?.title) {
          errors.push(
            `${subfeature.id}: browser-covered entries need an exact test file and title.`
          );
        } else {
          if (
            !coverage.test.file.startsWith("packages/web/e2e/") ||
            !coverage.test.file.endsWith(".spec.ts")
          ) {
            errors.push(
              `${subfeature.id}: browser coverage must reference a packages/web/e2e/*.spec.ts file.`
            );
          }
          referencedPaths.push(coverage.test.file);
          if (repositoryPathExists(coverage.test.file)) {
            const titles = readPlaywrightTitles(coverage.test.file);
            if (!titles.has(coverage.test.title)) {
              errors.push(
                `${subfeature.id}: Playwright title not found in ${coverage.test.file}: ${coverage.test.title}`
              );
            }
            if (!usesVerificationFixture(coverage.test.file)) {
              errors.push(
                `${subfeature.id}: ${coverage.test.file} must use the verification fixture so unexpected API calls and evidence are checked automatically.`
              );
            }
          }
        }
      }

      if (coverage.kind === "backend-only") {
        if (!coverage.reason) errors.push(`${subfeature.id}: backend-only entries need a reason.`);
        if (proofPaths.length === 0) {
          errors.push(
            `${subfeature.id}: backend-only entries need at least one executable proof path.`
          );
        }
      }

      if (coverage.kind === "uncovered" && !coverage.reason) {
        errors.push(`${subfeature.id}: uncovered entries need a reason.`);
      }

      for (const path of referencedPaths) {
        if (!repositoryPathExists(path))
          errors.push(`${subfeature.id}: referenced path does not exist: ${path}`);
      }
    }
  }

  const discoveredRoutes = discoverAppRoutes();
  const mappedRoutes = [...routeOwners.keys()].sort(compareStrings);
  for (const route of discoveredRoutes) {
    if (!routeOwners.has(route))
      errors.push(`User page route is missing from the directory: ${route}`);
  }
  for (const route of mappedRoutes) {
    if (!discoveredRoutes.includes(route)) errors.push(`Mapped user route has no page: ${route}`);
  }

  let discoveredTabs = [];
  try {
    discoveredTabs = discoverSettingsTabs();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const mappedTabs = subfeatures
    .filter((subfeature) => subfeature.settingsTab)
    .map((subfeature) => subfeature.settingsTab);
  addDuplicateError(errors, mappedTabs, "Settings tab");
  for (const tab of discoveredTabs) {
    if (!mappedTabs.includes(tab))
      errors.push(`Settings tab is missing from the directory: ${tab}`);
  }
  for (const tab of mappedTabs) {
    if (!discoveredTabs.includes(tab)) errors.push(`Mapped Settings tab does not exist: ${tab}`);
  }

  return [...new Set(errors)].sort(compareStrings);
}

function markdownPath(path) {
  return `[\`${path}\`](<../${path}>)`;
}

function markdownPaths(paths) {
  return paths.length === 0 ? "None" : paths.map(markdownPath).join("<br>");
}

function markdownCell(value) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdownAnchor(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

function coverageEvidence(coverage) {
  if (coverage.kind === "browser-covered") {
    const test = `${markdownPath(coverage.test.file)}: \`${coverage.test.title}\``;
    const proofs = coverage.proofs?.length
      ? `<br>Lower-level: ${markdownPaths(coverage.proofs)}`
      : "";
    return `${test}${proofs}`;
  }
  if (coverage.kind === "backend-only") {
    return `${coverage.reason}<br>${markdownPaths(coverage.proofs)}`;
  }
  return coverage.reason;
}

function renderRepositoryMapMarkdown(directory = openInspectFeatureDirectory) {
  const lines = [
    "<!-- Generated by `node scripts/openinspect-repo-map.mjs --write`. Do not edit by hand. -->",
    "",
    "# OpenInspect repository map",
    "",
    "Use this map to answer where a user-facing feature lives and how its current behavior is proved.",
    "The coverage labels are deliberately narrow:",
    "",
    "- `browser-covered`: an ordinary Playwright test drives the real Next.js UI against loopback fixtures.",
    "- `backend-only`: executable lower-level evidence exists, but there is no Playwright test for the behavior.",
    "- `uncovered`: the directory has no adequate executable proof.",
    "",
    "Locate an area with `npm run repo-map -- <query>`. Check paths, routes, Settings tabs, exact",
    "Playwright titles, and this generated file with `npm run repo-map:check`.",
    "",
    "Browser coverage does not claim a live Control Plane, Modal sandbox, GitHub, or other external service.",
    "Those boundaries need their listed lower-level tests or a separate credentialed smoke test.",
    "",
    "## Area index",
    "",
    "| Area | User routes | Coverage summary |",
    "| --- | --- | --- |",
  ];

  for (const feature of directory.features) {
    const counts = new Map([
      ["browser-covered", 0],
      ["backend-only", 0],
      ["uncovered", 0],
    ]);
    for (const subfeature of feature.subfeatures) {
      counts.set(subfeature.coverage.kind, counts.get(subfeature.coverage.kind) + 1);
    }
    const summary = [...counts.entries()]
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
    lines.push(
      `| [${feature.title}](#${markdownAnchor(feature.title)}) | ${feature.userRoutes.map((route) => `\`${route}\``).join("<br>")} | ${summary} |`
    );
  }

  for (const feature of directory.features) {
    lines.push("", `## ${feature.title}`, "");
    lines.push(`- ID: \`${feature.id}\``);
    lines.push(`- Aliases: ${feature.aliases.map((alias) => `\`${alias}\``).join(", ")}`);
    lines.push(`- User routes: ${feature.userRoutes.map((route) => `\`${route}\``).join(", ")}`);
    for (const ownerKind of ["ui", "bff", "backend"]) {
      const paths = feature.owners[ownerKind] ?? [];
      if (paths.length > 0) lines.push(`- ${ownerKind.toUpperCase()}: ${markdownPaths(paths)}`);
    }
    lines.push(
      "",
      "| Capability | Status | Specific source owners | Evidence or gap |",
      "| --- | --- | --- | --- |"
    );
    for (const subfeature of feature.subfeatures) {
      const settingsTab = subfeature.settingsTab ? ` (\`?tab=${subfeature.settingsTab}\`)` : "";
      const sources = markdownPaths(collectSourcePaths(subfeature.sources));
      lines.push(
        `| \`${subfeature.id}\`<br>${markdownCell(subfeature.title)}${settingsTab} | \`${subfeature.coverage.kind}\` | ${sources} | ${markdownCell(coverageEvidence(subfeature.coverage))} |`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderRepositoryMap(directory = openInspectFeatureDirectory) {
  return format(renderRepositoryMapMarkdown(directory), {
    parser: "markdown",
    printWidth: 100,
    proseWrap: "always",
  });
}

function searchableText(feature, subfeature) {
  return [
    feature.id,
    feature.title,
    ...feature.userRoutes,
    ...(subfeature ? [] : feature.aliases),
    ...(subfeature ? [] : collectSourcePaths(feature.owners)),
    subfeature?.id,
    subfeature?.title,
    subfeature?.settingsTab,
    ...collectSourcePaths(subfeature?.sources),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function queryScore(text, query, tokens) {
  if (!tokens.every((token) => text.includes(token))) return 0;
  return (
    (text.includes(query) ? 20 : 0) +
    tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0)
  );
}

function locateFeatures(query, directory = openInspectFeatureDirectory) {
  const normalizedQuery = query.trim().toLowerCase();
  const tokens = normalizedQuery.split(/[\s._-]+/).filter(Boolean);
  if (tokens.length === 0) return [];

  return directory.features
    .map((feature, featureIndex) => {
      const featureScore = queryScore(searchableText(feature), normalizedQuery, tokens);
      const matches = feature.subfeatures
        .map((subfeature) => ({
          subfeature,
          score: queryScore(searchableText(feature, subfeature), normalizedQuery, tokens),
        }))
        .filter((match) => match.score > 0);
      return {
        feature,
        featureIndex,
        score: Math.max(featureScore, ...matches.map((match) => match.score), 0),
        subfeatures:
          matches.length > 0 ? matches.map((match) => match.subfeature) : feature.subfeatures,
      };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.featureIndex - right.featureIndex);
}

function printLocateResults(query) {
  const matches = locateFeatures(query);
  if (matches.length === 0) {
    console.error(`No feature matched: ${query}`);
    process.exitCode = 1;
    return;
  }

  for (const [index, match] of matches.entries()) {
    if (index > 0) console.log("");
    console.log(`${match.feature.id}: ${match.feature.title}`);
    console.log(`  routes: ${match.feature.userRoutes.join(", ")}`);
    for (const ownerKind of ["ui", "bff", "backend"]) {
      const paths = match.feature.owners[ownerKind] ?? [];
      if (paths.length > 0) console.log(`  ${ownerKind}: ${paths.join(", ")}`);
    }
    for (const subfeature of match.subfeatures) {
      console.log(`  ${subfeature.id}  ${subfeature.coverage.kind}`);
      for (const ownerKind of ["ui", "bff", "backend"]) {
        const paths = subfeature.sources?.[ownerKind] ?? [];
        if (paths.length > 0) console.log(`    ${ownerKind}: ${paths.join(", ")}`);
      }
      if (subfeature.coverage.kind === "browser-covered") {
        console.log(
          `    test: ${subfeature.coverage.test.file} :: ${subfeature.coverage.test.title}`
        );
      }
      if (subfeature.coverage.proofs?.length) {
        console.log(`    proofs: ${subfeature.coverage.proofs.join(", ")}`);
      }
      if (subfeature.coverage.reason) console.log(`    gap: ${subfeature.coverage.reason}`);
    }
  }
}

function failOnValidationErrors() {
  const errors = validateFeatureDirectory();
  if (errors.length === 0) return;
  console.error("Repository map validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

async function checkGeneratedMap() {
  failOnValidationErrors();
  const expected = await renderRepositoryMap();
  const actual = existsSync(generatedMapPath) ? readFileSync(generatedMapPath, "utf8") : "";
  if (actual !== expected) {
    console.error("docs/REPO_MAP.md is stale. Run `npm run repo-map:write` and commit the result.");
    process.exit(1);
  }
  const tabCount = openInspectFeatureDirectory.features
    .flatMap((feature) => feature.subfeatures)
    .filter((subfeature) => subfeature.settingsTab).length;
  console.log(
    `Repository map is current: ${openInspectFeatureDirectory.features.length} areas, ${tabCount} Settings tabs.`
  );
}

function printHelp() {
  console.log(`Usage:
  node scripts/openinspect-repo-map.mjs <query>   Locate a feature and its proof
  node scripts/openinspect-repo-map.mjs --check   Validate without writing
  node scripts/openinspect-repo-map.mjs --write   Validate and regenerate docs/REPO_MAP.md`);
}

async function main(arguments_) {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    printHelp();
    return;
  }
  if (arguments_.includes("--check")) {
    if (arguments_.length !== 1) throw new Error("--check cannot be combined with a query.");
    await checkGeneratedMap();
    return;
  }
  if (arguments_.includes("--write")) {
    if (arguments_.length !== 1) throw new Error("--write cannot be combined with a query.");
    failOnValidationErrors();
    writeFileSync(generatedMapPath, await renderRepositoryMap(), "utf8");
    console.log("Wrote docs/REPO_MAP.md.");
    return;
  }
  if (arguments_.length === 0) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  failOnValidationErrors();
  printLocateResults(arguments_.join(" "));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
