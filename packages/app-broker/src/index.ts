/**
 * The app broker: a Hono Worker that Terraform deploys into the apps account. It is the only code
 * that holds the apps-account token. It is reachable at `https://deployer.<apps domain>` behind an
 * exact-hostname Access app with a service-token policy, and every request must also carry a sig1
 * signature from the control plane.
 *
 * Routes (shared/app-broker.ts): POST /deploy (multipart), POST /takedown, POST /data, GET /health.
 * Errors leave as `{ error, message, retryAfterSeconds? }` with BROKER_ERROR_STATUS. Logs carry
 * error codes and Cloudflare routes, never the token, SQL, secret values or asset bytes.
 */

import {
  APP_BROKER_ROUTES,
  APP_BROKER_SERVICE,
  APP_RESOURCE_NAME_PATTERN,
  BROKER_DEPLOY_REQUEST_PART,
  BROKER_ERROR_STATUS,
  brokerDataRequestSchema,
  brokerDeployRequestSchema,
  brokerTakedownRequestSchema,
  type BrokerDataRequest,
  type BrokerError,
} from "@open-inspect/shared/app-broker";
import { APP_BUNDLE_LIMITS, APP_DEPLOY_DEADLINE_MS } from "@open-inspect/shared/apps";
import { TOKEN_VALIDITY_MS } from "@open-inspect/shared/auth";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import { createLogger, type Logger } from "@open-inspect/shared/logger";
import {
  ACTOR_HEADER,
  SERVICE_HEADER,
  SERVICE_REQUEST_MAX_BODY_BYTES,
  SERVICE_SIGNATURE_HEADER,
  parseServiceSignatureHeader,
  sha256Hex,
  verifyServiceSignature,
} from "@open-inspect/shared/service-auth";
import { Hono, type Context } from "hono";
import type { z } from "zod";
import { createHostingBackend, type BundleAsset } from "./backends";
import {
  CLOUDFLARE_API_BASE_URL,
  CloudflareApiError,
  createCloudflareApi,
  sleepFor,
  type FetchLike,
  type Sleep,
} from "./cloudflare-api";
import { handleDataOp } from "./data";
import { createEdge } from "./edge";
import { parseBrokerConfig, type BrokerConfig, type BrokerEnv } from "./env";
import { BrokerRefusal, errorLogFields } from "./errors";
import { parseRequestedAppName } from "./names";
import { publish, type GuardBundle, type PublishInput } from "./publish";
import { takedown } from "./takedown";

export type { BrokerEnv } from "./env";

export interface BrokerDeps {
  readonly guard: GuardBundle;
  /** Tests pass the fake Cloudflare here. */
  readonly fetch?: FetchLike;
  readonly sleep?: Sleep;
  readonly apiBaseUrl?: string;
}

type BrokerContext = Context<{
  Bindings: BrokerEnv;
  Variables: { body: Uint8Array; config: BrokerConfig };
}>;

const SEEN_NONCE_LIMIT = 5000;

/** Signed requests seen in this isolate, so a captured request cannot be replayed to it. */
function createReplayGuard() {
  const seen = new Map<string, number>();
  return (nonce: string): boolean => {
    const now = Date.now();
    const expiresAt = seen.get(nonce);
    if (expiresAt !== undefined && expiresAt > now) return false;
    if (seen.size >= SEEN_NONCE_LIMIT) {
      for (const [candidate, expiry] of seen) {
        if (expiry <= now || seen.size >= SEEN_NONCE_LIMIT) seen.delete(candidate);
      }
    }
    seen.set(nonce, now + TOKEN_VALIDITY_MS);
    return true;
  };
}

function errorBody(error: BrokerError["error"], message: string, retryAfterSeconds?: number) {
  return {
    error,
    message: message.slice(0, 4000),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  } satisfies BrokerError;
}

function invalidRequest(message: string): BrokerRefusal {
  return new BrokerRefusal("invalid_request", message);
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw invalidRequest("The request body is not JSON.");
  }
}

/** Data-op names outside the `app-` grammar are a security event, not a malformed request. */
function refuseForeignResourceNames(body: unknown): void {
  if (!isRecord(body)) return;
  for (const key of ["name", "bucketName"]) {
    const value = body[key];
    if (typeof value === "string" && !APP_RESOURCE_NAME_PATTERN.test(value)) {
      throw new BrokerRefusal("refused", "The broker manages app-owned resources only.");
    }
  }
}

const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
};

function assetContentType(path: string, sent: string): string {
  if (sent && sent !== "application/octet-stream") return sent;
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return ASSET_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

function isServedPath(path: string): boolean {
  const printable = [...path].every((char) => char >= " " && char !== "\x7f" && char !== "\\");
  return (
    printable &&
    path.startsWith("/") &&
    path
      .slice(1)
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

async function parseDeployRequest(
  body: Uint8Array,
  contentType: string | undefined
): Promise<PublishInput> {
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw invalidRequest("A deploy is a multipart/form-data request.");
  }
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw invalidRequest("The multipart body could not be parsed.");
  }
  const parts = new Map<string, string | Blob>();
  for (const [key, value] of form) {
    if (parts.has(key)) throw invalidRequest(`Part ${key} is sent twice.`);
    parts.set(key, value);
  }

  const requestPart = parts.get(BROKER_DEPLOY_REQUEST_PART);
  if (requestPart === undefined) throw invalidRequest("The request part is missing.");
  const json = parseJson(
    typeof requestPart === "string"
      ? new TextEncoder().encode(requestPart)
      : new Uint8Array(await requestPart.arrayBuffer())
  );
  parseRequestedAppName(isRecord(json) ? json.name : undefined);
  const parsed = brokerDeployRequestSchema.safeParse(json);
  if (!parsed.success) throw invalidRequest(zodMessage(parsed.error));
  const request = parsed.data;

  const expected = new Set<string>([
    BROKER_DEPLOY_REQUEST_PART,
    ...request.assets.map((asset) => asset.part),
    ...(request.worker ? [request.worker.part] : []),
  ]);
  for (const key of parts.keys()) {
    if (!expected.has(key)) throw invalidRequest(`Part ${key} is not named by the request.`);
  }

  const paths = new Set<string>();
  const assets: BundleAsset[] = [];
  for (const entry of request.assets) {
    if (!isServedPath(entry.path)) throw invalidRequest(`Asset path ${entry.path} is not valid.`);
    if (paths.has(entry.path)) throw invalidRequest(`Asset path ${entry.path} is sent twice.`);
    paths.add(entry.path);
    const file = parts.get(entry.part);
    if (!(file instanceof Blob)) throw invalidRequest(`Asset part ${entry.part} is missing.`);
    assets.push({
      path: entry.path,
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: assetContentType(entry.path, file.type),
    });
  }

  let userModule: Uint8Array | null = null;
  if (request.worker) {
    const file = parts.get(request.worker.part);
    if (!(file instanceof Blob)) throw invalidRequest("The worker part is missing.");
    if (file.size > APP_BUNDLE_LIMITS.maxWorkerBytes) {
      throw invalidRequest("The worker module is over the size limit.");
    }
    userModule = new Uint8Array(await file.arrayBuffer());
  }
  return { request, assets, userModule };
}

function toErrorResponse(c: BrokerContext, error: unknown, log: Logger): Response {
  const fields = { path: c.req.path, ...errorLogFields(error) };
  if (error instanceof BrokerRefusal) {
    if (error.code === "refused" || error.code === "access_guard_failed") {
      log.error("Broker refused a request", { event: `app_broker.${error.code}`, ...fields });
    } else {
      log.warn("Broker request failed", { event: "app_broker.request_failed", ...fields });
    }
    return c.json(
      errorBody(error.code, error.message, error.retryAfterSeconds),
      BROKER_ERROR_STATUS[error.code]
    );
  }
  if (error instanceof CloudflareApiError && error.status === 429) {
    log.warn("Cloudflare rate limited the broker", { event: "app_broker.rate_limited", ...fields });
    const retryAfterSeconds = Math.max(1, error.retryAfterSeconds ?? 1);
    c.header("retry-after", String(retryAfterSeconds));
    return c.json(
      errorBody("rate_limited", "Cloudflare is rate limiting the apps account.", retryAfterSeconds),
      BROKER_ERROR_STATUS.rate_limited
    );
  }
  log.error("Cloudflare call failed", { event: "app_broker.upstream_failed", ...fields });
  return c.json(
    errorBody("upstream_unavailable", "Cloudflare did not complete the request. Retry it."),
    BROKER_ERROR_STATUS.upstream_unavailable
  );
}

export function createBrokerApp(deps: BrokerDeps) {
  const log = createLogger("broker", {}, "info", "app-broker");
  const firstUse = createReplayGuard();
  const app = new Hono<{
    Bindings: BrokerEnv;
    Variables: { body: Uint8Array; config: BrokerConfig };
  }>();

  const unauthorized = (c: BrokerContext, failure: string) => {
    log.warn("Broker rejected a request", { event: "app_broker.auth_failed", failure });
    return c.json(errorBody("invalid_request", "Unauthorized"), 401);
  };

  app.use("*", async (c, next) => {
    const secret = c.env.SERVICE_AUTH_SECRET_CONTROL_PLANE;
    if (!secret) {
      log.error("Broker is not configured", { event: "app_broker.misconfigured" });
      return c.json(errorBody("upstream_unavailable", "The app broker is not configured."), 502);
    }
    if (c.req.header(SERVICE_HEADER) !== APP_BROKER_SERVICE) {
      return unauthorized(c, "service");
    }
    const signatureHeader = c.req.header(SERVICE_SIGNATURE_HEADER) ?? "";
    const parsedSignature = parseServiceSignatureHeader(signatureHeader);
    if (!parsedSignature.ok) return unauthorized(c, parsedSignature.reason);

    const body = await readBodyCapped(c.req.raw.body, SERVICE_REQUEST_MAX_BODY_BYTES);
    if (body === null) return c.json(errorBody("invalid_request", "Request body too large"), 413);
    const verification = await verifyServiceSignature({
      signatureHeader,
      service: APP_BROKER_SERVICE,
      secret,
      method: c.req.method,
      url: c.req.url,
      bodySha256Hex: await sha256Hex(body),
      actor: c.req.header(ACTOR_HEADER) ?? "",
    });
    if (!verification.ok) return unauthorized(c, verification.reason);
    if (!firstUse(verification.nonce)) return unauthorized(c, "replayed");

    const config = parseBrokerConfig(c.env);
    if (!config.ok) {
      log.error("Broker is not configured", {
        event: "app_broker.misconfigured",
        invalid: config.invalid,
      });
      return c.json(errorBody("upstream_unavailable", "The app broker is not configured."), 502);
    }
    c.set("body", body);
    c.set("config", config.config);
    await next();
  });

  app.onError((error, c) => toErrorResponse(c, error, log));

  const services = (config: BrokerConfig) => {
    const sleep = deps.sleep ?? sleepFor;
    const api = createCloudflareApi({
      baseUrl: deps.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL,
      accountId: config.accountId,
      token: config.apiToken,
      fetch: deps.fetch ?? ((request) => fetch(request)),
      sleep,
    });
    return {
      api,
      config,
      edge: createEdge(api, config),
      backend: createHostingBackend(api, config),
      guard: deps.guard,
      sleep,
      log,
    };
  };

  app.get(APP_BROKER_ROUTES.health, (c) => c.json({ ok: true }));

  app.post(APP_BROKER_ROUTES.deploy, async (c) => {
    const input = await parseDeployRequest(c.get("body"), c.req.header("content-type"));
    const result = await publish(
      services(c.get("config")),
      input,
      AbortSignal.timeout(APP_DEPLOY_DEADLINE_MS)
    );
    log.info("App published", {
      event: "app_broker.published",
      app: input.request.name,
      backend: result.backend,
      first_deploy: result.firstDeploy,
    });
    return c.json(result);
  });

  app.post(APP_BROKER_ROUTES.takedown, async (c) => {
    const json = parseJson(c.get("body"));
    parseRequestedAppName(isRecord(json) ? json.name : undefined);
    const parsed = brokerTakedownRequestSchema.safeParse(json);
    if (!parsed.success) throw invalidRequest(zodMessage(parsed.error));
    const result = await takedown(
      services(c.get("config")),
      parsed.data.name,
      AbortSignal.timeout(APP_DEPLOY_DEADLINE_MS)
    );
    return c.json(result);
  });

  app.post(APP_BROKER_ROUTES.data, async (c) => {
    const json = parseJson(c.get("body"));
    refuseForeignResourceNames(json);
    const parsed = brokerDataRequestSchema.safeParse(json);
    if (!parsed.success) throw invalidRequest(zodMessage(parsed.error));
    const request: BrokerDataRequest = parsed.data;
    const result = await handleDataOp(
      services(c.get("config")),
      request,
      AbortSignal.timeout(APP_DEPLOY_DEADLINE_MS)
    );
    return c.json(result);
  });

  return app;
}

/** Inlined by build.mjs: the platform guard's modules, embedded in every app script. */
declare const __OI_GUARD_BUNDLE__: GuardBundle;

let worker: ReturnType<typeof createBrokerApp> | undefined;

export default {
  fetch(request: Request, env: BrokerEnv, ctx: unknown): Response | Promise<Response> {
    worker ??= createBrokerApp({ guard: __OI_GUARD_BUNDLE__ });
    return worker.fetch(request, env, ctx as never);
  },
};
