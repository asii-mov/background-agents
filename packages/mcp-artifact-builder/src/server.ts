import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

interface BuildRequest {
  packageName: string;
  version: string;
  integrity: string;
  registryUrl: string;
  registryToken?: string;
  tarballUrl: string;
  executable: string;
}

type RequiredBuildRequestKey = keyof Omit<BuildRequest, "registryToken">;

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(input: Record<string, unknown>, key: RequiredBuildRequestKey): string {
  const value = input[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} is required`);
  return value;
}

function validateBuildRequest(value: unknown): BuildRequest {
  if (!isRecord(value)) throw new Error("invalid request");
  const packageName = requiredString(value, "packageName");
  const version = requiredString(value, "version");
  const integrity = requiredString(value, "integrity");
  const registryUrl = requiredString(value, "registryUrl");
  const tarballUrl = requiredString(value, "tarballUrl");
  const executable = requiredString(value, "executable");
  const registryToken = value.registryToken;
  if (registryToken !== undefined && typeof registryToken !== "string") {
    throw new Error("registryToken must be a string");
  }
  if (new URL(registryUrl).protocol !== "https:" || new URL(tarballUrl).protocol !== "https:") {
    throw new Error("registry and tarball URLs must use HTTPS");
  }
  if (executable.includes("/") || executable.includes("\\")) {
    throw new Error("executable must be a bin name");
  }
  return {
    packageName,
    version,
    integrity,
    registryUrl,
    ...(registryToken === undefined ? {} : { registryToken }),
    tarballUrl,
    executable,
  };
}

export function npmAuthLine(registryUrl: string, token: string): string {
  const url = new URL(registryUrl);
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `//${url.host}${path}:_authToken=${token}`;
}

export function selectExecutable(
  packageName: string,
  declared: string | Record<string, string> | undefined,
  requested: string
): string {
  const names =
    typeof declared === "string"
      ? [
          packageName.includes("/")
            ? packageName.slice(packageName.lastIndexOf("/") + 1)
            : packageName,
        ]
      : declared
        ? Object.keys(declared)
        : [];
  if (!names.includes(requested))
    throw new Error("requested executable is not declared by package");
  return requested;
}

export function verifyRootLock(
  lock: unknown,
  packageName: string,
  version: string,
  integrity: string
): void {
  if (!lock || typeof lock !== "object") throw new Error("npm did not produce a package lock");
  const packages = (lock as { packages?: Record<string, unknown> }).packages;
  const root = packages?.[`node_modules/${packageName}`];
  if (!root || typeof root !== "object") throw new Error("package lock omits the root package");
  const record = root as { version?: unknown; integrity?: unknown };
  if (record.version !== version || record.integrity !== integrity) {
    throw new Error("installed root package does not match the resolved version and integrity");
  }
}

export async function buildArtifact(input: BuildRequest): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "open-inspect-mcp-"));
  const artifactPath = join(directory, "artifact.tar.gz");
  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true, dependencies: { [input.packageName]: input.tarballUrl } })
    );
    const npmrc = [
      `registry=${input.registryUrl}`,
      "ignore-scripts=true",
      "audit=false",
      "fund=false",
    ];
    if (input.registryToken) npmrc.push(npmAuthLine(input.registryUrl, input.registryToken));
    await writeFile(join(directory, ".npmrc"), `${npmrc.join("\n")}\n`, { mode: 0o600 });
    await execFileAsync(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: directory, timeout: 4 * 60 * 1000, maxBuffer: 1024 * 1024 }
    );
    const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
    verifyRootLock(lock, input.packageName, input.version, input.integrity);
    const packageJson = JSON.parse(
      await readFile(join(directory, "node_modules", input.packageName, "package.json"), "utf8")
    ) as { bin?: string | Record<string, string> };
    selectExecutable(input.packageName, packageJson.bin, input.executable);
    await writeFile(
      join(directory, "artifact.json"),
      JSON.stringify({
        schemaVersion: 1,
        packageName: input.packageName,
        version: input.version,
        integrity: input.integrity,
        executable: input.executable,
      })
    );
    await execFileAsync(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        artifactPath,
        "artifact.json",
        "package.json",
        "package-lock.json",
        "node_modules",
      ],
      { cwd: directory, timeout: 60_000 }
    );
    if ((await stat(artifactPath)).size > MAX_ARTIFACT_BYTES)
      throw new Error("artifact is too large");
    return artifactPath;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendError(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: message }));
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/")
    return sendError(response, 404, "not found");
  const expectedToken = process.env.MCP_ARTIFACT_BUILDER_TOKEN ?? "";
  const actualToken = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  if (!expectedToken || !safeTokenEqual(actualToken, expectedToken)) {
    return sendError(response, 401, "unauthorized");
  }
  let artifactPath: string | null = null;
  try {
    const input = validateBuildRequest(await readJson(request));
    const builtArtifactPath = await buildArtifact(input);
    artifactPath = builtArtifactPath;
    const size = (await stat(builtArtifactPath)).size;
    const digest = createHash("sha256")
      .update(await readFile(builtArtifactPath))
      .digest("hex");
    response.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Length": String(size),
      "X-Artifact-Sha256": digest,
    });
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(builtArtifactPath);
      stream.on("error", reject);
      response.on("finish", resolve);
      stream.pipe(response);
    });
  } catch (error) {
    if (!response.headersSent)
      sendError(response, 400, error instanceof Error ? error.message : "build failed");
  } finally {
    if (artifactPath) await rm(join(artifactPath, ".."), { recursive: true, force: true });
  }
}

if (process.env.NODE_ENV !== "test") {
  createServer((request, response) => void handleRequest(request, response)).listen(
    Number(process.env.PORT ?? 8080)
  );
}
