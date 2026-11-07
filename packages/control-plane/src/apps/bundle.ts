/**
 * The boundary parser for the sandbox's multipart deploy body. Everything after it works on a
 * {@link DeployRequestBody} whose invariants hold by construction: a validated name, normalized
 * unique asset paths within limits, at least one asset or a Worker, a parsed data manifest, and
 * migration files with server-computed hashes grouped by their declared D1 binding.
 */

import {
  APP_BUNDLE_LIMITS,
  APP_DEPLOY_PARTS,
  appDeployManifestSchema,
  parseAppName,
  type AppDeployFailureReason,
  type AppName,
} from "@open-inspect/shared/apps";
import type { APP_NOT_FOUND_HANDLING } from "@open-inspect/shared/app-broker";
import { sha256Hex } from "@open-inspect/shared/service-auth";
import {
  APP_DATA_LIMITS,
  APP_DATA_MANIFEST_FILE,
  appDataManifestSchema,
  type AppDataManifest,
  type BindingName,
  type MigrationFile,
} from "@open-inspect/shared/types/app-data";
import type { z } from "zod";
import { readBoundedBytes } from "../http/bounded-body";

/** `/a/b.html`: a leading slash, no empty, `.` or `..` segment, and URL-safe characters only. */
export type AssetPath = string & { readonly __brand: "AssetPath" };

export interface AssetFile {
  readonly path: AssetPath;
  readonly bytes: Uint8Array;
}

export interface AppBundle {
  /** Sorted by path. */
  readonly assets: readonly AssetFile[];
  /** The agent's bundled ES module; null for a static-only app. */
  readonly worker: Uint8Array | null;
  /** `/404.html` present: 404-page; else `/index.html` present: single-page-application; else none. */
  readonly notFoundHandling: (typeof APP_NOT_FOUND_HANDLING)[number];
  /** Assets plus the Worker. */
  readonly bytes: number;
  /** sha256 over every asset path and content hash, and the Worker's hash. */
  readonly sha256: string;
}

export interface AppDataRequest {
  /** `openinspect.app.json`, when the agent sent one. */
  readonly manifest: AppDataManifest | null;
  /** Per declared D1 binding, its migration files sorted by name. */
  readonly migrations: ReadonlyMap<BindingName, readonly MigrationFile[]>;
}

export interface DeployRequestBody {
  readonly name: AppName;
  readonly bundle: AppBundle;
  readonly data: AppDataRequest;
}

export interface BundleRejection {
  ok: false;
  reason: Extract<
    AppDeployFailureReason,
    | "invalid_bundle"
    | "bundle_too_large"
    | "invalid_name"
    | "reserved_name"
    | "data_manifest_invalid"
  >;
  message: string;
}

/**
 * Files Workers static assets reads as configuration in wrangler deploys. Over direct upload they
 * would be served as ordinary files, so the bundle refuses them instead.
 */
const RESERVED_ASSET_PATHS: ReadonlySet<string> = new Set([
  "/_headers",
  "/_redirects",
  "/_routes.json",
  "/.assetsignore",
]);

const ASSET_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=@ -]+$/;

/** Pure. Rejects rather than repairs: `dist/a.html`, `/a//b`, `/../x`, `/a\b` and `/%2e` are invalid. */
export function parseAssetPath(raw: string): AssetPath | null {
  if (!raw.startsWith("/") || raw.length > APP_BUNDLE_LIMITS.maxAssetPathLength) return null;
  const segments = raw.slice(1).split("/");
  const valid = segments.every(
    (segment) => segment !== "." && segment !== ".." && ASSET_SEGMENT.test(segment)
  );
  return valid ? (raw as AssetPath) : null;
}

type Part = string | File;
type BytesOf = (part: string) => Promise<Uint8Array>;
type DeployManifest = z.output<typeof appDeployManifestSchema>;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Thrown by the step parsers below and turned into the {@link BundleRejection} at the boundary. */
class Rejected extends Error {
  constructor(readonly rejection: BundleRejection) {
    super(rejection.message);
  }
}

function reject(reason: BundleRejection["reason"], message: string): never {
  throw new Rejected({ ok: false, reason, message });
}

function issueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

async function partBytes(part: Part): Promise<Uint8Array> {
  return typeof part === "string"
    ? new TextEncoder().encode(part)
    : new Uint8Array(await part.arrayBuffer());
}

function parseJson(bytes: Uint8Array, reason: BundleRejection["reason"], what: string): unknown {
  try {
    return JSON.parse(STRICT_UTF8.decode(bytes));
  } catch {
    return reject(reason, `${what} is not JSON.`);
  }
}

/**
 * Read and validate the multipart body. A declared length over the cap is refused before any
 * byte is buffered, and no more than the cap is ever held. Every part the manifest names must be
 * sent exactly once, and nothing else may be.
 */
export async function readDeployRequest(
  request: Request
): Promise<{ ok: true; value: DeployRequestBody } | BundleRejection> {
  try {
    return { ok: true, value: await parseParts(await readParts(request)) };
  } catch (error) {
    if (error instanceof Rejected) return error.rejection;
    throw error;
  }
}

async function readParts(request: Request): Promise<ReadonlyMap<string, Part>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    reject("invalid_bundle", "The deploy body must be multipart/form-data.");
  }
  const body = await readBoundedBytes(
    request.body,
    APP_BUNDLE_LIMITS.maxRequestBytes,
    request.headers.get("content-length")
  );
  if (!body.ok) {
    reject("bundle_too_large", `The bundle is over ${APP_BUNDLE_LIMITS.maxRequestBytes} bytes.`);
  }
  let form: FormData;
  try {
    form = await new Response(body.bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return reject("invalid_bundle", "The multipart body could not be parsed.");
  }
  const parts = new Map<string, Part>();
  for (const [key, value] of form) {
    if (parts.has(key)) reject("invalid_bundle", `Part ${key} is sent twice.`);
    parts.set(key, value);
  }
  return parts;
}

async function parseParts(parts: ReadonlyMap<string, Part>): Promise<DeployRequestBody> {
  const manifest = await readManifest(parts);
  const bytesOf: BytesOf = (part) => partBytes(parts.get(part)!);
  const dataManifest = manifest.app ? readDataManifest(await bytesOf(manifest.app.part)) : null;
  const name = resolveName(manifest.name, dataManifest);
  const migrations = await readMigrations(manifest.migrations, dataManifest, bytesOf);
  const assets = await readAssets(manifest.assets, bytesOf);
  const worker = manifest.worker ? readWorker(await bytesOf(manifest.worker.part)) : null;
  if (assets.length === 0 && worker === null) {
    reject("invalid_bundle", "Nothing to publish: send built assets, a Worker, or both.");
  }
  const paths = new Set<string>(assets.map((asset) => asset.path));
  return {
    name,
    bundle: {
      assets,
      worker,
      notFoundHandling: paths.has("/404.html")
        ? "404-page"
        : paths.has("/index.html")
          ? "single-page-application"
          : "none",
      bytes: assets.reduce((sum, asset) => sum + asset.bytes.byteLength, worker?.byteLength ?? 0),
      sha256: await bundleSha256(assets, worker),
    },
    data: { manifest: dataManifest, migrations },
  };
}

/** The deploy manifest, checked against the parts actually sent. */
async function readManifest(parts: ReadonlyMap<string, Part>): Promise<DeployManifest> {
  const manifestPart = parts.get(APP_DEPLOY_PARTS.manifest);
  if (manifestPart === undefined) reject("invalid_bundle", "The manifest part is missing.");
  const json = parseJson(await partBytes(manifestPart), "invalid_bundle", "The manifest part");
  const parsed = appDeployManifestSchema.safeParse(json);
  if (!parsed.success) reject("invalid_bundle", `manifest ${issueMessage(parsed.error)}`);
  const manifest = parsed.data;

  const named = [
    APP_DEPLOY_PARTS.manifest,
    ...(manifest.app ? [manifest.app.part] : []),
    ...manifest.migrations.map((entry) => entry.part),
    ...manifest.assets.map((entry) => entry.part),
    ...(manifest.worker ? [manifest.worker.part] : []),
  ];
  const expected = new Set<string>(named);
  if (expected.size !== named.length) {
    reject("invalid_bundle", "The manifest names one part for two entries.");
  }
  for (const key of parts.keys()) {
    if (!expected.has(key)) reject("invalid_bundle", `Part ${key} is not in the manifest.`);
  }
  for (const key of expected) {
    if (!parts.has(key)) reject("invalid_bundle", `Part ${key} is missing.`);
  }
  return manifest;
}

function readDataManifest(bytes: Uint8Array): AppDataManifest {
  if (bytes.byteLength > APP_DATA_LIMITS.maxManifestBytes) {
    reject(
      "data_manifest_invalid",
      `${APP_DATA_MANIFEST_FILE} is over ${APP_DATA_LIMITS.maxManifestBytes} bytes.`
    );
  }
  const json = parseJson(bytes, "data_manifest_invalid", APP_DATA_MANIFEST_FILE);
  const parsed = appDataManifestSchema.safeParse(json);
  if (!parsed.success) {
    reject("data_manifest_invalid", `${APP_DATA_MANIFEST_FILE} ${issueMessage(parsed.error)}`);
  }
  return parsed.data;
}

/** The request's name, else the manifest's; both present must agree. */
function resolveName(requested: string | undefined, dataManifest: AppDataManifest | null): AppName {
  if (requested !== undefined && dataManifest && requested !== dataManifest.name) {
    reject(
      "invalid_bundle",
      `name "${requested}" differs from "${dataManifest.name}" in ${APP_DATA_MANIFEST_FILE}.`
    );
  }
  const raw = requested ?? dataManifest?.name;
  if (raw === undefined) {
    reject("invalid_name", `Pass a name, or set name in ${APP_DATA_MANIFEST_FILE}.`);
  }
  const name = parseAppName(raw);
  if (!name.ok) reject(name.reason, name.message);
  return name.name;
}

/** Per declared D1 binding, its migration files in name order with server-computed hashes. */
async function readMigrations(
  entries: DeployManifest["migrations"],
  dataManifest: AppDataManifest | null,
  bytesOf: BytesOf
): Promise<Map<BindingName, MigrationFile[]>> {
  const migrations = new Map<BindingName, MigrationFile[]>();
  for (const entry of entries) {
    if (dataManifest?.data[entry.binding]?.kind !== "d1") {
      reject(
        "data_manifest_invalid",
        `Migration ${entry.name} is for ${entry.binding}, which is not a d1 binding in ${APP_DATA_MANIFEST_FILE}.`
      );
    }
    const files = migrations.get(entry.binding) ?? [];
    if (files.some((file) => file.name === entry.name)) {
      reject("invalid_bundle", `Migration ${entry.binding}/${entry.name} is sent twice.`);
    }
    const bytes = await bytesOf(entry.part);
    if (bytes.byteLength > APP_DATA_LIMITS.maxMigrationBytes) {
      reject(
        "invalid_bundle",
        `Migration ${entry.name} is over ${APP_DATA_LIMITS.maxMigrationBytes} bytes.`
      );
    }
    let sql: string;
    try {
      sql = STRICT_UTF8.decode(bytes);
    } catch {
      return reject("invalid_bundle", `Migration ${entry.name} is not UTF-8 text.`);
    }
    files.push({ name: entry.name, sql, sha256: await sha256Hex(bytes) });
    migrations.set(entry.binding, files);
  }
  for (const files of migrations.values()) files.sort((a, b) => (a.name < b.name ? -1 : 1));
  return migrations;
}

/** Assets sorted by path, each path valid, published and unique. */
async function readAssets(
  entries: DeployManifest["assets"],
  bytesOf: BytesOf
): Promise<AssetFile[]> {
  const assets: AssetFile[] = [];
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = parseAssetPath(entry.path);
    if (!path) {
      reject(
        "invalid_bundle",
        `Asset path ${JSON.stringify(entry.path)} is not valid: it must start with "/" and have no empty, "." or ".." segment and no characters such as %, ?, # or \\.`
      );
    }
    if (RESERVED_ASSET_PATHS.has(path)) {
      reject(
        "invalid_bundle",
        `${path} is configuration for other hosts and is not published. Remove it from the build output.`
      );
    }
    if (paths.has(path)) reject("invalid_bundle", `Asset path ${path} is sent twice.`);
    paths.add(path);
    const bytes = await bytesOf(entry.part);
    if (bytes.byteLength > APP_BUNDLE_LIMITS.maxAssetBytes) {
      reject("bundle_too_large", `${path} is over ${APP_BUNDLE_LIMITS.maxAssetBytes} bytes.`);
    }
    assets.push({ path, bytes });
  }
  return assets.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function readWorker(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > APP_BUNDLE_LIMITS.maxWorkerBytes) {
    reject(
      "bundle_too_large",
      `The Worker is over ${APP_BUNDLE_LIMITS.maxWorkerBytes} bytes. Minify it and leave out source maps.`
    );
  }
  return bytes;
}

async function bundleSha256(assets: readonly AssetFile[], worker: Uint8Array | null) {
  const entries = await Promise.all(
    assets.map(async (asset) => [asset.path, await sha256Hex(asset.bytes)])
  );
  return sha256Hex(
    JSON.stringify({ assets: entries, worker: worker ? await sha256Hex(worker) : null })
  );
}
