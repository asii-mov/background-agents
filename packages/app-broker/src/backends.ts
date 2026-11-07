/**
 * Where an app's code and assets live: one account Worker per app, or one script per app in a
 * Workers for Platforms dispatch namespace. Hostnames and Access are edge.ts's job and the same
 * for both.
 *
 * Contract of `put`, for both kinds: when it resolves, the script runs the new bundle with the
 * platform guard as its main module and is reachable by no hostname: no workers.dev, no preview
 * URL, no route. Ingress is added only by Edge.attach afterwards.
 */

import type { BrokerBinding, BrokerDeployRequest } from "@open-inspect/shared/app-broker";
import type { HostingBackendKind } from "@open-inspect/shared/apps";
import { APP_PLATFORM_BINDINGS } from "@open-inspect/shared/types/app-data";
import { z } from "zod";
import { findOrCreate, hasStatus, type CloudflareApi } from "./cloudflare-api";
import type { BrokerConfig, DataJurisdiction } from "./env";
import type { AccessGrant } from "./edge";
import { BrokerRefusal } from "./errors";
import type { ScriptName } from "./names";

export const APP_SCRIPT_COMPATIBILITY_DATE = "2026-06-01";
const MODULE_CONTENT_TYPE = "application/javascript+module";
const CLOSED_SUBDOMAIN = { enabled: false, previews_enabled: false } as const;

export interface ScriptModule {
  readonly name: string;
  readonly source: string | Uint8Array;
}

export interface BundleAsset {
  /** The served path, starting with `/`. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** A binding in Cloudflare's script metadata shape. */
export type WireBinding = Readonly<Record<string, string>> & {
  readonly type: string;
  readonly name: string;
};

export interface ScriptSpec {
  readonly script: ScriptName;
  readonly deploymentId: string;
  /** The first module is the main module. */
  readonly modules: readonly ScriptModule[];
  readonly assets: readonly BundleAsset[];
  readonly notFoundHandling: BrokerDeployRequest["notFoundHandling"];
  readonly bindings: readonly WireBinding[];
}

/** workers.dev or preview URLs read back as on after a publish. */
export class PublicIngressError extends Error {}

export interface HostingBackend {
  readonly kind: HostingBackendKind;
  /** Upload assets, modules and bindings and make that version serve 100%. Idempotent. */
  put(spec: ScriptSpec, signal: AbortSignal): Promise<{ versionId: string }>;
  /** Delete the script. Absent = done. Callers detach the hostname first. */
  remove(script: ScriptName, signal: AbortSignal): Promise<void>;
  /** The Worker service a Custom Domain targets to reach `script`. */
  ingressService(script: ScriptName): string;
}

/**
 * The platform bindings plus the requested ones, and nothing else. CF_ACCESS_AUD comes only from
 * a grant, so a script can only carry an AUD that ensureAccess returned.
 */
export function scriptBindings(
  config: BrokerConfig,
  grant: AccessGrant,
  requested: readonly BrokerBinding[]
): WireBinding[] {
  return [
    { type: "assets", name: APP_PLATFORM_BINDINGS.assets },
    { type: "plain_text", name: APP_PLATFORM_BINDINGS.teamDomain, text: config.access.teamDomain },
    { type: "plain_text", name: APP_PLATFORM_BINDINGS.aud, text: grant.aud },
    { type: "plain_text", name: APP_PLATFORM_BINDINGS.hostname, text: grant.target.hostname },
    { type: "plain_text", name: APP_PLATFORM_BINDINGS.appName, text: grant.target.name },
    ...requested.map((binding) => wireBinding(binding, config.jurisdiction)),
  ];
}

function wireBinding(binding: BrokerBinding, jurisdiction: DataJurisdiction | null): WireBinding {
  switch (binding.type) {
    case "d1":
      return { type: "d1", name: binding.name, id: binding.databaseId };
    case "kv_namespace":
      return { type: "kv_namespace", name: binding.name, namespace_id: binding.namespaceId };
    case "r2_bucket":
      return {
        type: "r2_bucket",
        name: binding.name,
        bucket_name: binding.bucketName,
        ...(jurisdiction ? { jurisdiction } : {}),
      };
    case "secret_text":
      return { type: "secret_text", name: binding.name, text: binding.value };
  }
}

export function createHostingBackend(api: CloudflareApi, config: BrokerConfig): HostingBackend {
  const { hosting } = config;
  return hosting.kind === "workers"
    ? createWorkersBackend(api)
    : createDispatchNamespaceBackend(api, hosting.namespace, hosting.dispatcherService);
}

const subdomainSchema = z.object({ enabled: z.boolean(), previews_enabled: z.boolean() });
const workerSchema = z.object({ id: z.string().min(1), subdomain: subdomainSchema.optional() });

/** One account Worker per app, created with workers.dev and previews off before any code exists. */
function createWorkersBackend(api: CloudflareApi): HostingBackend {
  const subdomainPath = (script: ScriptName) => `/workers/scripts/${segment(script)}/subdomain`;

  async function ensureClosedWorker(script: ScriptName, signal: AbortSignal): Promise<string> {
    const { value: worker } = await findOrCreate(
      async () => {
        try {
          return await api.call("GET", `/workers/workers/${segment(script)}`, workerSchema, {
            signal,
          });
        } catch (error) {
          if (hasStatus(error, 404)) return null;
          throw error;
        }
      },
      () =>
        api.call("POST", "/workers/workers", workerSchema, {
          signal,
          body: { name: script, subdomain: CLOSED_SUBDOMAIN },
        })
    );
    const subdomain =
      worker.subdomain ??
      (await api.call("GET", subdomainPath(script), subdomainSchema, { signal }));
    if (subdomain.enabled || subdomain.previews_enabled) {
      await api.call("POST", subdomainPath(script), z.unknown(), {
        signal,
        idempotent: true,
        body: CLOSED_SUBDOMAIN,
      });
    }
    return worker.id;
  }

  return {
    kind: "workers",
    ingressService: (script) => script,

    async put(spec, signal) {
      const workerId = await ensureClosedWorker(spec.script, signal);
      const assetsJwt = await uploadAssets(
        api,
        `/workers/scripts/${segment(spec.script)}/assets-upload-session`,
        spec.assets,
        signal
      );
      const version = await api
        .call(
          "POST",
          `/workers/workers/${segment(workerId)}/versions`,
          z.object({ id: z.string() }),
          {
            signal,
            body: {
              ...scriptMetadata(spec, assetsJwt),
              modules: spec.modules.map((module) => ({
                name: module.name,
                content_type: MODULE_CONTENT_TYPE,
                content_base64: toBase64(moduleBytes(module)),
              })),
            },
          }
        )
        .catch(rejectedScript);
      await api.call("POST", `/workers/scripts/${segment(spec.script)}/deployments`, z.unknown(), {
        signal,
        idempotent: true,
        body: { strategy: "percentage", versions: [{ version_id: version.id, percentage: 100 }] },
      });
      const subdomain = await api.call("GET", subdomainPath(spec.script), subdomainSchema, {
        signal,
      });
      if (subdomain.enabled || subdomain.previews_enabled) {
        throw new PublicIngressError(`workers.dev or preview URLs are on for ${spec.script}`);
      }
      return { versionId: version.id };
    },

    async remove(script, signal) {
      await deleteAbsentOk(api, `/workers/scripts/${segment(script)}`, signal);
    },
  };
}

/** Scripts in a dispatch namespace have no workers.dev URL; the dispatcher is the only way in. */
function createDispatchNamespaceBackend(
  api: CloudflareApi,
  namespace: string,
  dispatcherService: string
): HostingBackend {
  const scriptPath = (script: ScriptName) =>
    `/workers/dispatch/namespaces/${segment(namespace)}/scripts/${segment(script)}`;

  return {
    kind: "dispatch-namespace",
    ingressService: () => dispatcherService,

    async put(spec, signal) {
      const assetsJwt = await uploadAssets(
        api,
        `${scriptPath(spec.script)}/assets-upload-session`,
        spec.assets,
        signal
      );
      const form = new FormData();
      form.append(
        "metadata",
        new Blob([JSON.stringify(scriptMetadata(spec, assetsJwt))], { type: "application/json" })
      );
      for (const module of spec.modules) {
        form.append(
          module.name,
          new File([moduleBytes(module)], module.name, { type: MODULE_CONTENT_TYPE })
        );
      }
      const uploaded = await api
        .call("PUT", scriptPath(spec.script), z.object({ etag: z.string().min(1) }), {
          signal,
          body: form,
        })
        .catch(rejectedScript);
      return { versionId: uploaded.etag };
    },

    async remove(script, signal) {
      await deleteAbsentOk(api, scriptPath(script), signal);
    },
  };
}

function scriptMetadata(spec: ScriptSpec, assetsJwt: string) {
  return {
    main_module: spec.modules[0]?.name,
    compatibility_date: APP_SCRIPT_COMPATIBILITY_DATE,
    bindings: spec.bindings,
    assets: {
      jwt: assetsJwt,
      config: { not_found_handling: spec.notFoundHandling, run_worker_first: true },
    },
    annotations: { "workers/message": `oi-deployment:${spec.deploymentId}` },
  };
}

/** Cloudflare refused the script itself; its message is safe to relay to the agent. */
function rejectedScript(error: unknown): never {
  if (error instanceof Error && hasStatus(error, 400, 413, 415, 422)) {
    throw new BrokerRefusal(
      "script_rejected",
      error.messages.join("; ") || "Cloudflare rejected the Worker script."
    );
  }
  throw error;
}

async function deleteAbsentOk(api: CloudflareApi, path: string, signal: AbortSignal) {
  try {
    await api.call("DELETE", path, z.unknown(), { signal, query: { force: "true" } });
  } catch (error) {
    if (!hasStatus(error, 404)) throw error;
  }
}

const uploadSessionSchema = z.object({
  jwt: z.string().min(1),
  buckets: z.array(z.array(z.string())).nullish(),
});
const uploadResultSchema = z.object({ jwt: z.string().nullish() }).nullish();

/**
 * Start an assets upload session, upload only the buckets Cloudflare asks for (one bucket of
 * base64 in memory at a time), and return the completion token: the session token itself when
 * Cloudflare already has every file.
 */
async function uploadAssets(
  api: CloudflareApi,
  sessionPath: string,
  assets: readonly BundleAsset[],
  signal: AbortSignal
): Promise<string> {
  const byHash = new Map<string, BundleAsset>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const asset of assets) {
    const hash = await assetHash(toBase64(asset.bytes), asset.path);
    byHash.set(hash, asset);
    manifest[asset.path] = { hash, size: asset.bytes.byteLength };
  }
  const session = await api.call("POST", sessionPath, uploadSessionSchema, {
    signal,
    idempotent: true,
    body: { manifest },
  });
  const buckets = session.buckets ?? [];
  if (buckets.length === 0) return session.jwt;

  let completionJwt: string | null = null;
  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const asset = byHash.get(hash);
      if (!asset) throw new Error(`Cloudflare asked for asset ${hash}, which the bundle lacks`);
      form.append(hash, new File([toBase64(asset.bytes)], hash, { type: asset.contentType }));
    }
    const result = await api.call("POST", "/workers/assets/upload", uploadResultSchema, {
      signal,
      idempotent: true,
      bearer: session.jwt,
      query: { base64: "true" },
      body: form,
    });
    completionJwt = result?.jwt ?? completionJwt;
  }
  if (completionJwt === null) throw new Error("Cloudflare did not complete the assets upload");
  return completionJwt;
}

/** Wrangler's asset key, with SHA-256 in place of BLAKE3 (the live smoke checks Cloudflare accepts it). */
async function assetHash(base64: string, path: string): Promise<string> {
  const extension = /\.([^./]+)$/.exec(path)?.[1] ?? "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(base64 + extension)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function moduleBytes(module: ScriptModule): Uint8Array {
  return typeof module.source === "string"
    ? new TextEncoder().encode(module.source)
    : module.source;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}
