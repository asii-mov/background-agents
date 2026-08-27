import semver from "semver";
import type { DesiredMcpServer } from "./catalog-schema";

interface NpmPackageDocument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<
    string,
    {
      bin?: string | Record<string, string>;
      dist?: { integrity?: string; shasum?: string; tarball?: string };
    }
  >;
}

const MAX_NPM_METADATA_BYTES = 10 * 1024 * 1024;
const NPM_FETCH_TIMEOUT_MS = 15_000;

export interface ResolvedMcpServer {
  sourcePath: string;
  name: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  repoScopes: string[] | null;
  environmentScopes: string[] | null;
  lifecycle: "approved";
  enabled: boolean;
  updatePolicy?: { automatic: true; channel: string; range?: string };
  resolvedVersion?: string;
  resolvedIntegrity?: string;
  packageName?: string;
  registryUrl?: string;
  tarballUrl?: string;
  executable?: string;
  artifactKey?: string;
  artifactSha256?: string;
}

export interface NpmResolverOptions {
  defaultRegistryUrl?: string;
  registryToken?: string;
  fetchImpl?: typeof fetch;
}

function normalizedRegistryUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("MCP npm registry must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function defaultExecutable(packageName: string): string {
  return packageName.includes("/")
    ? packageName.slice(packageName.lastIndexOf("/") + 1)
    : packageName;
}

function resolveExecutable(
  sourcePath: string,
  packageName: string,
  declared: string | Record<string, string> | undefined,
  requested: string | undefined
): string {
  const names =
    typeof declared === "string"
      ? [defaultExecutable(packageName)]
      : declared && typeof declared === "object"
        ? Object.keys(declared)
        : [];
  if (requested) {
    if (!names.includes(requested)) {
      throw new Error(`${sourcePath}: executable '${requested}' is not declared by ${packageName}`);
    }
    return requested;
  }
  if (names.length !== 1) {
    throw new Error(
      `${sourcePath}: ${packageName} must declare exactly one executable or set executable explicitly`
    );
  }
  return names[0];
}

export async function resolveDesiredMcpServer(
  sourcePath: string,
  desired: DesiredMcpServer,
  options: NpmResolverOptions = {}
): Promise<ResolvedMcpServer> {
  const common = {
    sourcePath,
    name: desired.name,
    repoScopes: desired.repoScopes,
    environmentScopes: desired.environmentScopes,
    lifecycle: desired.lifecycle,
    enabled: desired.enabled,
  };
  if (desired.type === "remote") return { ...common, type: "remote", url: desired.url };

  const registryUrl = normalizedRegistryUrl(
    options.defaultRegistryUrl ?? "https://registry.npmjs.org"
  );
  const headers = new Headers({ Accept: "application/json" });
  if (options.registryToken) headers.set("Authorization", `Bearer ${options.registryToken}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${registryUrl}/${encodeURIComponent(desired.package)}`,
      { headers, redirect: "error", signal: controller.signal }
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(
      `Failed to resolve ${desired.package}: npm registry returned ${response.status}`
    );
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_NPM_METADATA_BYTES) {
    throw new Error(`Failed to resolve ${desired.package}: npm metadata is too large`);
  }
  const responseText = await response.text();
  if (new TextEncoder().encode(responseText).byteLength > MAX_NPM_METADATA_BYTES) {
    throw new Error(`Failed to resolve ${desired.package}: npm metadata is too large`);
  }
  let document: NpmPackageDocument;
  try {
    document = JSON.parse(responseText) as NpmPackageDocument;
  } catch {
    throw new Error(`Failed to resolve ${desired.package}: npm registry returned invalid JSON`);
  }
  const versions = Object.keys(document.versions ?? {}).filter((version) => semver.valid(version));
  const tagged = document["dist-tags"]?.[desired.updatePolicy.channel];
  let resolvedVersion = tagged && semver.valid(tagged) ? tagged : undefined;
  if (desired.updatePolicy.range) {
    if (!semver.validRange(desired.updatePolicy.range)) {
      throw new Error(`${sourcePath}: invalid semver range ${desired.updatePolicy.range}`);
    }
    if (!resolvedVersion || !semver.satisfies(resolvedVersion, desired.updatePolicy.range)) {
      resolvedVersion = semver.maxSatisfying(versions, desired.updatePolicy.range) ?? undefined;
    }
  }
  if (!resolvedVersion || !document.versions?.[resolvedVersion]) {
    throw new Error(
      `${sourcePath}: no package version matches channel ${desired.updatePolicy.channel}${desired.updatePolicy.range ? ` and range ${desired.updatePolicy.range}` : ""}`
    );
  }
  const versionDocument = document.versions[resolvedVersion];
  const dist = versionDocument.dist;
  const resolvedIntegrity = dist?.integrity ?? (dist?.shasum ? `sha1:${dist.shasum}` : undefined);
  if (!resolvedIntegrity)
    throw new Error(`${sourcePath}: npm package version has no integrity hash`);
  if (!dist?.tarball) throw new Error(`${sourcePath}: npm package version has no tarball URL`);
  const tarballUrl = new URL(dist.tarball);
  if (tarballUrl.protocol !== "https:") {
    throw new Error(`${sourcePath}: npm package tarball must use HTTPS`);
  }
  const executable = resolveExecutable(
    sourcePath,
    desired.package,
    versionDocument.bin,
    desired.executable
  );
  return {
    ...common,
    type: "local",
    command: [executable, ...desired.args],
    updatePolicy: desired.updatePolicy,
    resolvedVersion,
    resolvedIntegrity,
    packageName: desired.package,
    registryUrl,
    tarballUrl: tarballUrl.toString(),
    executable,
  };
}
