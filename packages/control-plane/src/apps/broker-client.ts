/**
 * The production adapter for both ports: a sig1-signed client of the app broker, behind the
 * broker hostname's Cloudflare Access service token. Every attempt is signed afresh, because the
 * broker refuses a nonce it has seen. Wire shapes are parsed with the shared broker schemas and
 * never leave this file. Logs carry the route and the outcome, never bodies, SQL or secret values.
 */

import {
  APP_BROKER_ROUTES,
  APP_BROKER_SERVICE,
  BROKER_DEPLOY_REQUEST_PART,
  brokerDataResponseSchema,
  brokerDeployResponseSchema,
  brokerErrorSchema,
  brokerTakedownResponseSchema,
  type brokerBindingSchema,
  type brokerDataRequestSchema,
  type BrokerDataOp,
  type BrokerDataResponse,
} from "@open-inspect/shared/app-broker";
import { APP_DEPLOY_PARTS } from "@open-inspect/shared/apps";
import {
  buildOutboundAuthHeaders,
  type FetchClient,
  type OutboundRequestToSign,
} from "@open-inspect/shared/service-auth";
import type { AppDataBinding } from "@open-inspect/shared/types/app-data";
import type { z } from "zod";
import { createLogger } from "../logger";
import type { AppsConfig } from "./config";
import { AppHostError, type AppHost, type AppHostDeployInput, type DataHost } from "./host";

/** Inside APP_DEPLOY_DEADLINE_MS, so the control plane answers before its own deadline. */
export const BROKER_DEPLOY_TIMEOUT_MS = 110_000;
export const BROKER_DATA_TIMEOUT_MS = 30_000;
export const BROKER_MAX_ATTEMPTS = 3;
const BROKER_RETRY_BASE_DELAY_MS = 1_000;
/** A Retry-After longer than this is handed to the caller instead of waited out. */
const BROKER_RETRY_MAX_DELAY_MS = 10_000;

/** Data ops a lost response makes unsafe to send again: the first send may have applied. */
const NOT_REPLAYABLE: ReadonlySet<BrokerDataOp> = new Set(["d1.execute"]);

const log = createLogger("app-broker-client");

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface BrokerClientInput {
  config: Pick<
    AppsConfig,
    "brokerOrigin" | "brokerSecret" | "accessClientId" | "accessClientSecret"
  >;
  fetch: FetchClient;
  sleep?: Sleep;
}

type SignedBody = NonNullable<OutboundRequestToSign["body"]>;

const sleepFor: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });

function retryAfterHeader(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

async function readResponse(response: Response): Promise<unknown> {
  let json: unknown;
  try {
    json = JSON.parse(await response.text());
  } catch {
    json = undefined;
  }
  if (response.status >= 200 && response.status < 300) {
    if (json === undefined) {
      throw new AppHostError("upstream_unavailable", "The app broker answered without JSON.");
    }
    return json;
  }
  const brokerError = brokerErrorSchema.safeParse(json);
  // 401 is sig1; a 403 or redirect without a broker body is Cloudflare Access in front of it.
  if (
    response.status === 401 ||
    response.status < 200 ||
    (response.status >= 300 && response.status < 400) ||
    (response.status === 403 && !brokerError.success)
  ) {
    throw new AppHostError(
      "unauthorized",
      "The app broker refused the control plane's credentials."
    );
  }
  if (response.status === 413) {
    throw new AppHostError("too_large", "The bundle is over the app broker's size limit.");
  }
  if (brokerError.success) {
    const { error, message, retryAfterSeconds } = brokerError.data;
    throw new AppHostError(error, message, retryAfterSeconds ?? retryAfterHeader(response));
  }
  throw new AppHostError(
    response.status === 429 ? "rate_limited" : "upstream_unavailable",
    `The app broker answered ${response.status}.`,
    retryAfterHeader(response)
  );
}

function toBrokerBinding(binding: AppDataBinding): z.input<typeof brokerBindingSchema> {
  switch (binding.kind) {
    case "d1":
      return { type: "d1", name: binding.name, databaseId: binding.databaseId };
    case "kv":
      return { type: "kv_namespace", name: binding.name, namespaceId: binding.namespaceId };
    case "r2":
      return { type: "r2_bucket", name: binding.name, bucketName: binding.bucketName };
    case "secret":
      return { type: "secret_text", name: binding.name, value: binding.value.reveal() };
  }
}

/** The multipart body the broker's /deploy reads: the request JSON, then asset and Worker parts. */
async function deployBody(input: AppHostDeployInput, url: string): Promise<SignedBody> {
  const { bundle } = input;
  const form = new FormData();
  form.append(
    BROKER_DEPLOY_REQUEST_PART,
    JSON.stringify({
      name: input.name,
      deploymentId: input.deploymentId,
      assets: bundle.assets.map((asset, index) => ({
        path: asset.path,
        part: `${APP_DEPLOY_PARTS.assetPrefix}${index}`,
      })),
      worker: bundle.worker ? { part: APP_DEPLOY_PARTS.worker } : null,
      notFoundHandling: bundle.notFoundHandling,
      bindings: input.bindings.map(toBrokerBinding),
    })
  );
  bundle.assets.forEach((asset, index) => {
    const part = `${APP_DEPLOY_PARTS.assetPrefix}${index}`;
    // The broker types each asset from its path; an octet-stream part tells it to.
    form.append(part, new File([asset.bytes], part, { type: "application/octet-stream" }));
  });
  if (bundle.worker) {
    form.append(
      APP_DEPLOY_PARTS.worker,
      new File([bundle.worker], "worker.mjs", { type: "text/javascript" })
    );
  }
  const encoded = new Request(url, { method: "POST", body: form });
  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    contentType: encoded.headers.get("content-type")!,
  };
}

export function createBrokerClient(input: BrokerClientInput): AppHost & DataHost {
  const { config } = input;
  const sleep = input.sleep ?? sleepFor;
  const credential = { service: APP_BROKER_SERVICE, secret: config.brokerSecret } as const;

  async function attempt(url: string, body: SignedBody, signal: AbortSignal): Promise<unknown> {
    const headers = await buildOutboundAuthHeaders(credential, { method: "POST", url, body });
    let response: Response;
    try {
      response = await input.fetch.fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "CF-Access-Client-Id": config.accessClientId,
          "CF-Access-Client-Secret": config.accessClientSecret,
        },
        body: typeof body === "string" ? body : body.bytes,
        signal,
        redirect: "manual",
      });
    } catch {
      throw signal.aborted
        ? new AppHostError("deadline", "The app broker did not answer in time.")
        : new AppHostError("network", "The app broker could not be reached.");
    }
    return readResponse(response);
  }

  async function call(
    path: string,
    body: (url: string) => Promise<SignedBody> | SignedBody,
    options: { timeoutMs: number; signal?: AbortSignal; replayable: boolean }
  ): Promise<unknown> {
    const url = `${config.brokerOrigin}${path}`;
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const signed = await body(url);
    for (let attemptNumber = 1; ; attemptNumber++) {
      try {
        return await attempt(url, signed, signal);
      } catch (error) {
        if (!(error instanceof AppHostError)) throw error;
        log.warn("App broker call failed", {
          event: "app_broker_client.call_failed",
          path,
          code: error.code,
          attempt: attemptNumber,
        });
        const retry = error.code === "rate_limited" || (error.retryable && options.replayable);
        const delayMs =
          error.retryAfterSeconds !== undefined
            ? error.retryAfterSeconds * 1000
            : BROKER_RETRY_BASE_DELAY_MS * 2 ** (attemptNumber - 1);
        if (!retry || attemptNumber >= BROKER_MAX_ATTEMPTS || delayMs > BROKER_RETRY_MAX_DELAY_MS) {
          throw error;
        }
        try {
          await sleep(delayMs, signal);
        } catch {
          throw new AppHostError("deadline", "The app broker did not answer in time.");
        }
      }
    }
  }

  function parsed<T>(schema: z.ZodType<T>, json: unknown, path: string): T {
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new AppHostError(
        "upstream_unavailable",
        `The app broker's ${path} answer is malformed.`
      );
    }
    return result.data;
  }

  async function data<Request extends z.input<typeof brokerDataRequestSchema>>(
    request: Request
  ): Promise<BrokerDataResponse<Request["op"]>> {
    const json = await call(APP_BROKER_ROUTES.data, () => JSON.stringify(request), {
      timeoutMs: BROKER_DATA_TIMEOUT_MS,
      replayable: !NOT_REPLAYABLE.has(request.op),
    });
    const schema = brokerDataResponseSchema[request.op] as unknown as z.ZodType<
      BrokerDataResponse<Request["op"]>
    >;
    return parsed(schema, json, `${APP_BROKER_ROUTES.data} ${request.op}`);
  }

  return {
    async deploy(deployInput, signal) {
      const json = await call(APP_BROKER_ROUTES.deploy, (url) => deployBody(deployInput, url), {
        timeoutMs: BROKER_DEPLOY_TIMEOUT_MS,
        signal,
        replayable: true,
      });
      return parsed(brokerDeployResponseSchema, json, APP_BROKER_ROUTES.deploy);
    },
    async takedown(name, signal) {
      const json = await call(APP_BROKER_ROUTES.takedown, () => JSON.stringify({ name }), {
        timeoutMs: BROKER_DEPLOY_TIMEOUT_MS,
        signal,
        replayable: true,
      });
      return parsed(brokerTakedownResponseSchema, json, APP_BROKER_ROUTES.takedown);
    },
    ensureD1: (name) => data({ op: "d1.ensure", name }),
    executeD1: async (databaseId, sql) => {
      await data({ op: "d1.execute", databaseId, sql });
    },
    bookmarkD1: async (databaseId) => (await data({ op: "d1.bookmark", databaseId })).bookmark,
    restoreD1: (databaseId, target) => data({ op: "d1.restore", databaseId, target }),
    describeD1: async (databaseId) => {
      const { fileSize, numTables } = await data({ op: "d1.describe", databaseId });
      return { fileSize, numTables };
    },
    deleteD1: async (databaseId) => {
      await data({ op: "d1.delete", databaseId });
    },
    ensureKv: (name) => data({ op: "kv.ensure", name }),
    deleteKv: async (namespaceId) => {
      await data({ op: "kv.delete", namespaceId });
    },
    ensureR2: (name) => data({ op: "r2.ensure", name }),
    purgeR2: (bucketName) => data({ op: "r2.purge", bucketName }),
  };
}
