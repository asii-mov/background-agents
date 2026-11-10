import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CloudflareApiError, createCloudflareApi } from "../src/cloudflare-api";

function apiAnswering(status: number, body: string | null) {
  return createCloudflareApi({
    baseUrl: "https://api.cloudflare.fake.invalid/client/v4",
    accountId: "acct",
    token: "test-token",
    fetch: async () => new Response(body, { status }),
    sleep: async () => {},
  });
}

const signal = new AbortController().signal;

describe("an empty response body", () => {
  it.each([204, 200])("is a successful call with a null result on HTTP %i", async (status) => {
    const api = apiAnswering(status, null);

    await expect(api.call("DELETE", "/workers/domains/d1", z.unknown(), { signal })).resolves.toBe(
      null
    );
  });

  it.each([404, 403, 409])("is still a failure on HTTP %i", async (status) => {
    const api = apiAnswering(status, null);

    const failure = api.call("DELETE", "/workers/domains/d1", z.unknown(), { signal });

    await expect(failure).rejects.toBeInstanceOf(CloudflareApiError);
    await expect(failure).rejects.toMatchObject({ status });
  });
});
