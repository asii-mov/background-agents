import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

/** A failed governance request; `status` lets a panel tell "not available here" from a fault. */
export class GovernanceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "GovernanceRequestError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data as { error?: unknown }).error;
    throw new GovernanceRequestError(
      typeof message === "string" ? message : "Request failed",
      response.status
    );
  }
  return data as T;
}

export async function fetchJson<T>(path: BrowserApiPath): Promise<T> {
  return readJson<T>(await browserApiFetch(path));
}

export async function writeJson<T>(
  path: BrowserApiPath,
  method: string,
  body?: unknown
): Promise<T> {
  return readJson<T>(
    await browserApiFetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })
  );
}
