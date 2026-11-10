/**
 * Transport to api.cloudflare.com: bearer auth, the `{ success, errors, result }` envelope, zod
 * parsing of `result`, pagination, and the one retry policy. Endpoint knowledge lives in edge.ts,
 * backends.ts and data.ts. Nothing here logs the token or a request body.
 *
 * Retry policy:
 *   429                    retried for every method (refused, not applied), honouring Retry-After
 *                          up to CLOUDFLARE_MAX_RETRY_AFTER_WAIT_MS; longer waits surface to the caller
 *   5xx or network error   retried only for idempotent calls (GET, PUT, DELETE by default)
 *   other 4xx              never retried
 */

import { z } from "zod";

export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_API_MAX_ATTEMPTS = 3;
const CLOUDFLARE_API_BACKOFF_BASE_MS = 250;
/** The longest Retry-After the broker waits out inside one request. */
const CLOUDFLARE_MAX_RETRY_AFTER_WAIT_MS = 5_000;
const LIST_PAGE_SIZE = 100;

export type FetchLike = (request: Request) => Promise<Response>;
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;
type Method = "GET" | "POST" | "PUT" | "DELETE";

export class CloudflareApiError extends Error {
  constructor(
    /** `METHOD /path` below the account, without the query: safe to log. */
    readonly route: string,
    /** null when the request never got a response. */
    readonly status: number | null,
    /** Cloudflare's error messages. Relayed to the caller for script and SQL errors only. */
    readonly messages: readonly string[],
    readonly retryAfterSeconds: number | null,
    options?: ErrorOptions
  ) {
    super(`${route} failed with ${status ?? "a network error"}`, options);
    this.name = "CloudflareApiError";
  }
}

export function hasStatus(error: unknown, ...statuses: number[]): error is CloudflareApiError {
  return (
    error instanceof CloudflareApiError && error.status !== null && statuses.includes(error.status)
  );
}

interface CallOptions {
  readonly signal: AbortSignal;
  /** Sent as JSON, or as multipart when it is FormData. */
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Replaces the account token, for the assets upload JWT. */
  readonly bearer?: string;
  /** Safe to repeat after a 5xx or network failure. Defaults to true except for POST. */
  readonly idempotent?: boolean;
}

export interface CloudflareApi {
  call<T>(method: Method, path: string, schema: z.ZodType<T>, options: CallOptions): Promise<T>;
  /** Every page of a list endpoint. */
  list<T>(path: string, itemSchema: z.ZodType<T>, options: CallOptions): Promise<T[]>;
}

const envelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ message: z.string() })).catch([]),
  result: z.unknown(),
  result_info: z.object({ total_pages: z.number() }).partial().optional().catch(undefined),
});
type Envelope = z.output<typeof envelopeSchema>;

export function createCloudflareApi(input: {
  baseUrl: string;
  accountId: string;
  token: string;
  fetch: FetchLike;
  sleep: Sleep;
}): CloudflareApi {
  const accountUrl = `${input.baseUrl}/accounts/${encodeURIComponent(input.accountId)}`;

  async function send(method: Method, path: string, options: CallOptions): Promise<Envelope> {
    const route = `${method} ${path}`;
    const url = new URL(`${accountUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${options.bearer ?? input.token}`);
    let body: RequestInit["body"];
    if (options.body instanceof FormData) body = options.body;
    else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("content-type", "application/json");
    }
    const idempotent = options.idempotent ?? method !== "POST";

    for (let attempt = 1; ; attempt += 1) {
      options.signal.throwIfAborted();
      const retry = attempt < CLOUDFLARE_API_MAX_ATTEMPTS;
      let response: Response;
      try {
        response = await input.fetch(
          new Request(url, { method, headers, body, signal: options.signal })
        );
      } catch (error) {
        if (options.signal.aborted) throw options.signal.reason;
        if (idempotent && retry) {
          await input.sleep(backoffMs(attempt), options.signal);
          continue;
        }
        throw new CloudflareApiError(route, null, [], null, { cause: error });
      }

      const envelope = await readEnvelope(response);
      if (response.ok && envelope.success) return envelope;

      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      const messages = envelope.errors.map((error) => error.message);
      if (response.status === 429 && retry) {
        const waitMs = retryAfterSeconds === null ? backoffMs(attempt) : retryAfterSeconds * 1000;
        if (waitMs <= CLOUDFLARE_MAX_RETRY_AFTER_WAIT_MS) {
          await input.sleep(waitMs, options.signal);
          continue;
        }
      } else if (response.status >= 500 && idempotent && retry) {
        await input.sleep(backoffMs(attempt), options.signal);
        continue;
      }
      throw new CloudflareApiError(route, response.status, messages, retryAfterSeconds);
    }
  }

  function parseResult<T>(route: string, schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new CloudflareApiError(route, null, ["Cloudflare returned an unexpected shape"], null);
    }
    return parsed.data;
  }

  return {
    async call(method, path, schema, options) {
      const envelope = await send(method, path, options);
      return parseResult(`${method} ${path}`, schema, envelope.result);
    },
    async list(path, itemSchema, options) {
      const items = [];
      for (let page = 1; ; page += 1) {
        const envelope = await send("GET", path, {
          ...options,
          query: { ...options.query, page: String(page), per_page: String(LIST_PAGE_SIZE) },
        });
        items.push(...parseResult(`GET ${path}`, z.array(itemSchema), envelope.result));
        const totalPages = envelope.result_info?.total_pages;
        if (totalPages === undefined || page >= totalPages) return items;
      }
    },
  };
}

/**
 * Cloudflare has no create-if-absent, and a create that fails ambiguously may have applied. Find
 * by name first, create when absent, and look again when the create fails, so repeating an ensure
 * converges on one resource.
 */
export async function findOrCreate<T>(
  find: () => Promise<T | null>,
  create: () => Promise<T>
): Promise<{ value: T; created: boolean }> {
  const existing = await find();
  if (existing !== null) return { value: existing, created: false };
  try {
    return { value: await create(), created: true };
  } catch (error) {
    const adopted = await find().catch(() => null);
    if (adopted !== null) return { value: adopted, created: false };
    throw error;
  }
}

export function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

function backoffMs(attempt: number): number {
  return CLOUDFLARE_API_BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  return Number(header.trim());
}

/** Some deletes succeed with an empty body (204, or 200 per the docs) instead of an envelope. */
async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text();
  if (response.ok && text === "") return { success: true, errors: [], result: null };
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const parsed = envelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : { success: false, errors: [], result: null };
}
