/**
 * The deterministic half of secure app data: a platform security pipeline, so it runs after every
 * agent turn and before every managed push with the AppSec remediation loop. The control plane is
 * the authority on resources, policy and migrations; this is early feedback on the code.
 *
 * Usage (through `python -m sandbox_runtime.conformance app-data`, which finds the app
 * directories): app-data.mjs <app dir>...
 * Prints one finding per line, `<rule> <file>:<line> <message>`, and exits 1 when there are any.
 *
 * Rules are token-based and conservative: SQL that cannot be shown to be a constant is a finding,
 * with the fix spelled out. Every list comes from app_data_contract.json, generated from
 * @open-inspect/shared, so the checker and the platform share one source.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CONTRACT = JSON.parse(
  readFileSync(new URL("./app_data_contract.json", import.meta.url), "utf8")
);
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|svelte)$/;
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  ".openinspect",
  ".svelte-kit",
  ".wrangler",
  "dist",
  "build",
  "coverage",
]);
const MIGRATION_LEDGER_TABLE = "_openinspect_migrations";
const ALLOWED_PRAGMAS = new Set(["foreign_keys", "defer_foreign_keys"]);
const FORBIDDEN_SQL_HEADS = new Set([
  "attach",
  "detach",
  "vacuum",
  "begin",
  "commit",
  "end",
  "rollback",
  "savepoint",
  "release",
]);

/** `process.env.X` and friends are build-time configuration, not platform bindings. */
const NON_BINDING_ENV_OWNERS = new Set(["process", "meta", "Bun", "Deno"]);

function manifestProblems(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["must be a JSON object"];
  }
  const manifest = raw;
  const problems = [];
  const bindingPattern = new RegExp(CONTRACT.bindingNamePattern);
  const nameProblem = (name) => {
    if (!bindingPattern.test(name)) return `${name} is not an UPPER_SNAKE_CASE binding name`;
    if (CONTRACT.platformBindingNames.includes(name)) return `${name} is set by the platform`;
    const prefix = CONTRACT.reservedBindingPrefixes.find((reserved) => name.startsWith(reserved));
    return prefix ? `${name} uses the reserved prefix ${prefix}` : null;
  };
  if (manifest.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (typeof manifest.name !== "string" || manifest.name === "") {
    problems.push("name must be the app's name");
  }
  const data = manifest.data ?? {};
  if (typeof data !== "object" || Array.isArray(data)) problems.push("data must be an object");
  for (const [name, declaration] of Object.entries(data)) {
    const problem = nameProblem(name);
    if (problem) problems.push(problem);
    const kind = declaration?.kind;
    if (kind === "external") {
      problems.push(`${name}: external databases are not enabled on this platform; tell the user`);
    } else if (typeof kind !== "string" || !CONTRACT.dataStoreKinds.includes(kind)) {
      problems.push(`${name}: kind must be one of ${CONTRACT.dataStoreKinds.join(", ")}`);
    }
  }
  const secrets = manifest.secrets ?? [];
  if (!Array.isArray(secrets)) return [...problems, "secrets must be a list of names"];
  const deniedSecret = new RegExp(CONTRACT.deniedSecretNamePattern);
  const seen = new Set();
  for (const name of secrets) {
    if (typeof name !== "string") {
      problems.push("secrets must be names, never values");
      continue;
    }
    const problem = nameProblem(name);
    if (problem) problems.push(problem);
    if (seen.has(name)) problems.push(`secret ${name} is declared twice`);
    if (Object.hasOwn(data, name)) problems.push(`${name} is both a data binding and a secret`);
    if (deniedSecret.test(name)) {
      problems.push(`${name} would carry a credential; declare the data store under "data"`);
    }
    seen.add(name);
  }
  return problems;
}

/** Strings, words and punctuation, skipping comments and regular expression literals. */
function tokenize(source) {
  const tokens = [];
  let line = 1;
  let index = 0;
  const regexMayFollow = () => {
    const previous = tokens.at(-1);
    if (!previous) return true;
    if (previous.kind === "punct") return !")]}".includes(previous.value);
    return (
      previous.kind === "word" && ["return", "typeof", "case", "in", "of"].includes(previous.value)
    );
  };
  const advance = (end) => {
    for (let at = index; at < end; at += 1) if (source[at] === "\n") line += 1;
    index = end;
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      advance(end === -1 ? source.length : end);
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      advance(end === -1 ? source.length : end + 2);
    } else if (char === "'" || char === '"') {
      const start = line;
      let end = index + 1;
      while (end < source.length && source[end] !== char && source[end] !== "\n") {
        end += source[end] === "\\" ? 2 : 1;
      }
      tokens.push({
        kind: "string",
        value: source.slice(index + 1, end),
        line: start,
        literal: true,
      });
      advance(end + 1);
    } else if (char === "`") {
      const start = line;
      let end = index + 1;
      let substitution = false;
      while (end < source.length && source[end] !== "`") {
        if (source[end] === "\\") end += 2;
        else if (source[end] === "$" && source[end + 1] === "{") {
          substitution = true;
          let depth = 0;
          for (; end < source.length; end += 1) {
            if (source[end] === "{") depth += 1;
            else if (source[end] === "}" && --depth === 0) break;
          }
          end += 1;
        } else end += 1;
      }
      tokens.push({
        kind: "string",
        value: source.slice(index + 1, end),
        line: start,
        literal: !substitution,
      });
      advance(end + 1);
    } else if (char === "/" && regexMayFollow()) {
      let end = index + 1;
      let inClass = false;
      while (end < source.length && source[end] !== "\n") {
        if (source[end] === "\\") end += 1;
        else if (source[end] === "[") inClass = true;
        else if (source[end] === "]") inClass = false;
        else if (source[end] === "/" && !inClass) break;
        end += 1;
      }
      advance(end + 1);
    } else if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      tokens.push({ kind: "word", value: source.slice(index, end), line });
      advance(end);
    } else if (/\s/.test(char)) {
      advance(index + 1);
    } else {
      tokens.push({ kind: "punct", value: char, line });
      advance(index + 1);
    }
  }
  return tokens;
}

/**
 * Names declared `const NAME = "literal"` (a template without substitutions counts), optionally
 * with a type annotation, where the literal is the whole initializer.
 */
function constantSqlNames(tokens) {
  const names = new Set();
  tokens.forEach((token, index) => {
    const name = tokens[index + 1];
    if (token.kind !== "word" || token.value !== "const" || name?.kind !== "word") return;
    const equals = tokens[index + 2]?.value === ":" ? index + 4 : index + 2;
    const value = tokens[equals + 1];
    const after = tokens[equals + 2];
    const wholeInitializer =
      after === undefined ||
      (after.kind === "punct" && (after.value === ";" || after.value === ",")) ||
      (after.kind === "word" && value !== undefined && after.line > value.line);
    if (
      tokens[equals]?.value === "=" &&
      value?.kind === "string" &&
      value.literal &&
      wholeInitializer
    ) {
      names.add(name.value);
    }
  });
  return names;
}

/** True when the call's first argument is a constant: one literal or one constant name. */
function firstArgumentIsConstant(tokens, open, constants) {
  const argument = tokens[open + 1];
  const end = tokens[open + 2];
  const closes = end?.kind === "punct" && (end.value === ")" || end.value === ",");
  if (!argument || !closes) return false;
  if (argument.kind === "string") return argument.literal;
  return argument.kind === "word" && constants.has(argument.value);
}

function checkSource(file, source, manifest) {
  const findings = [];
  const tokens = tokenize(source);
  const constants = constantSqlNames(tokens);
  const bindingPattern = new RegExp(CONTRACT.bindingNamePattern);
  const declared = new Set([
    ...Object.keys(manifest.data),
    ...manifest.secrets,
    ...CONTRACT.platformBindingNames,
  ]);
  const databases = new Set(
    Object.entries(manifest.data)
      .filter(([, declaration]) => declaration.kind === "d1")
      .map(([name]) => name)
  );
  const schemes = new RegExp(
    `^(?:${CONTRACT.forbiddenConnectionSchemes.map((scheme) => scheme.replace("+", "\\+")).join("|")})://`,
    "i"
  );
  const add = (rule, line, message) => findings.push({ rule, file, line, message });
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    const receiver = tokens[index - 2];
    const open = tokens[index + 1];
    const calls = open?.kind === "punct" && open.value === "(";
    if (
      token.kind === "word" &&
      calls &&
      previous?.value === "." &&
      (token.value === "prepare" ||
        (token.value === "exec" && receiver?.kind === "word" && databases.has(receiver.value))) &&
      !firstArgumentIsConstant(tokens, index + 1, constants)
    ) {
      add(
        "data/no-interpolated-sql",
        token.line,
        `${token.value}() must receive constant SQL. Put the SQL in a string constant and pass values with .bind(...).`
      );
    }
    // `env.X`, `c.env.X`, `this.env.X`, `platform.env.X`; never `process.env.X`.
    if (
      token.kind === "word" &&
      token.value === "env" &&
      tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.kind === "word" &&
      !(
        previous?.value === "." &&
        receiver?.kind === "word" &&
        NON_BINDING_ENV_OWNERS.has(receiver.value)
      )
    ) {
      const name = tokens[index + 2].value;
      if (bindingPattern.test(name) && !declared.has(name)) {
        add(
          "data/undeclared-binding",
          token.line,
          `env.${name} is not declared in ${CONTRACT.manifestFile}. Declare it under "data" or "secrets", or remove the reference.`
        );
      }
    }
    if (token.kind !== "string") return;
    const text = token.value.trim();
    if (CONTRACT.forbiddenIdentityHeaders.includes(text.toLowerCase())) {
      add(
        "data/forbidden-identity-header",
        token.line,
        `${text} is not a trusted identity. Read the signed-in user from the x-openinspect-user-sub header the platform sets.`
      );
    }
    if (schemes.test(text)) {
      add(
        "data/no-connection-string",
        token.line,
        `A database connection string does not belong in app code. Declare the store in ${CONTRACT.manifestFile} and use its binding.`
      );
    }
    if (text.includes("api.cloudflare.com")) {
      add(
        "data/no-cloudflare-api",
        token.line,
        "Apps never call the Cloudflare API. The platform provisions and binds every resource."
      );
    }
  });
  return findings;
}

// ---- Migrations ---------------------------------------------------------------------------

const TRIGGER_HEAD = /^create\s+(?:temp\s+|temporary\s+)?trigger\b[\s\S]*\bbegin\b/i;

/**
 * The statements of a SQL file, with comments and string contents removed, split on `;`. A
 * trigger body (`BEGIN ... END`) stays one statement: it ends at the part that is only `END`.
 */
function sqlStatements(sql) {
  const stripped = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/'(?:[^']|'')*'/g, (quoted) => quoted.replace(/[^\n]/g, " "));
  const statements = [];
  let line = 1;
  let trigger = null;
  for (const part of stripped.split(";")) {
    const start = line + (part.match(/^\s*/)[0].match(/\n/g)?.length ?? 0);
    line += part.match(/\n/g)?.length ?? 0;
    const text = part.trim();
    if (trigger) {
      trigger.text += `; ${text}`;
      if (/^end$/i.test(text)) {
        statements.push(trigger);
        trigger = null;
      }
    } else if (TRIGGER_HEAD.test(text)) {
      trigger = { text, line: start };
    } else if (text) {
      statements.push({ text, line: start });
    }
  }
  if (trigger) statements.push(trigger);
  return statements;
}

function forbiddenStatement(text) {
  const lower = text.toLowerCase();
  if (lower.includes(MIGRATION_LEDGER_TABLE)) return "it touches the platform's migration ledger";
  const words = lower.match(/[a-z_]+/g) ?? [];
  const head = words[0] ?? "";
  if (head === "pragma") {
    const name = lower.slice("pragma".length).split(/[=(]/)[0].trim().split(".").at(-1);
    return ALLOWED_PRAGMAS.has(name) ? null : "PRAGMA is not allowed (except foreign_keys)";
  }
  return FORBIDDEN_SQL_HEADS.has(head) ? `${head.toUpperCase()} is not allowed` : null;
}

function checkMigrations(appDir, manifest) {
  const findings = [];
  const pattern = new RegExp(CONTRACT.migrationFilePattern);
  for (const declaration of Object.values(manifest.data)) {
    if (declaration.kind !== "d1") continue;
    const directory = join(appDir, declaration.migrations ?? "migrations");
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).sort()) {
      if (name.startsWith(".")) continue;
      const path = join(directory, name);
      if (!pattern.test(name)) {
        findings.push({
          rule: "data/migration-file-grammar",
          file: path,
          line: 1,
          message: `Migration files are named like 0001_create-notes.sql (four digits, lowercase words, .sql).`,
        });
        continue;
      }
      for (const statement of sqlStatements(readFileSync(path, "utf8"))) {
        const reason = forbiddenStatement(statement.text);
        if (reason) {
          findings.push({
            rule: "data/migration-forbidden-statement",
            file: path,
            line: statement.line,
            message: `${reason}. Migrations hold DDL and data statements only; the platform runs each file as one transaction.`,
          });
        }
      }
    }
  }
  return findings;
}

// ---- Apps ---------------------------------------------------------------------------------

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_EXTENSIONS.test(entry)) files.push(path);
  }
  return files;
}

function checkApp(appDir) {
  const manifestPath = join(appDir, CONTRACT.manifestFile);
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return [
      {
        rule: "data/manifest-invalid",
        file: manifestPath,
        line: 1,
        message: `${CONTRACT.manifestFile} is not valid JSON.`,
      },
    ];
  }
  const problems = manifestProblems(raw);
  const findings = problems.map((message) => ({
    rule: "data/manifest-invalid",
    file: manifestPath,
    line: 1,
    message,
  }));
  if (problems.length > 0) return findings;
  const manifest = raw;
  manifest.data ??= {};
  manifest.secrets ??= [];
  for (const name of CONTRACT.deniedConfigFiles) {
    if (existsSync(join(appDir, name))) {
      findings.push({
        rule: "data/no-handwritten-config",
        file: join(appDir, name),
        line: 1,
        message: `Remove ${name}: the platform derives Worker configuration from ${CONTRACT.manifestFile}. For local development run python -m sandbox_runtime.conformance app-dev.`,
      });
    }
  }
  for (const file of sourceFiles(appDir)) {
    findings.push(...checkSource(file, readFileSync(file, "utf8"), manifest));
  }
  return [...findings, ...checkMigrations(appDir, manifest)];
}

function main(appDirs) {
  const findings = appDirs.flatMap((appDir) => checkApp(appDir));
  for (const finding of findings) {
    console.log(
      `${finding.rule} ${relative(process.cwd(), finding.file)}:${finding.line} ${finding.message}`
    );
  }
  return findings.length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
