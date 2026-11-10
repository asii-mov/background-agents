import {
  Miniflare,
  Response as MiniflareResponse,
  type Request as MiniflareRequest,
} from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleBroker, bundleGuard } from "../build.mjs";
import { APP_SCRIPT_COMPATIBILITY_DATE } from "../src/backends";
import { APP_DOMAIN_DNS_PUBLISH_WAIT_MS } from "../src/publish";
import {
  FAKE_OPTIONS,
  brokerEnv,
  deployForm,
  expectGone,
  expectServing,
  signedRequest,
  type Harness,
} from "./broker-harness";
import { createFakeCloudflare } from "./fake-cloudflare";

/** The built broker running in workerd, with api.cloudflare.com answered by the fake. */
describe("the built broker Worker", () => {
  const fake = createFakeCloudflare(FAKE_OPTIONS);
  afterAll(() => expect(fake.violations).toEqual([]));
  let miniflare: Miniflare;
  let guardModules: string[];

  async function send(request: Request): Promise<Response> {
    const response = await miniflare.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  }

  const harness = { fake, backend: "workers" } as Harness;

  beforeAll(async () => {
    const guard = await bundleGuard();
    guardModules = guard.modules.map((module) => module.name);
    miniflare = new Miniflare({
      modules: [{ type: "ESModule", path: "index.js", contents: await bundleBroker(guard) }],
      compatibilityDate: APP_SCRIPT_COMPATIBILITY_DATE,
      bindings: { ...brokerEnv("workers") },
      outboundService: async (request: MiniflareRequest) => {
        const body = ["GET", "HEAD"].includes(request.method)
          ? undefined
          : await request.arrayBuffer();
        const response = await fake.fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body,
        });
        return new MiniflareResponse(await response.arrayBuffer(), {
          status: response.status,
          headers: Object.fromEntries(response.headers),
        });
      },
    });
    await miniflare.ready;
  });
  afterAll(() => miniflare?.dispose());

  it(
    "publishes an app with the inlined guard as its main module",
    { timeout: APP_DOMAIN_DNS_PUBLISH_WAIT_MS + 10_000 },
    async () => {
      const startedAt = Date.now();
      const response = await send(
        await signedRequest("/deploy", {
          form: deployForm({ name: "inventory", worker: "export default {};" }),
        })
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(APP_DOMAIN_DNS_PUBLISH_WAIT_MS);
      expect(fake.script("app-inventory")?.activeVersion?.moduleNames).toEqual([
        ...guardModules,
        "app.mjs",
      ]);
      expectServing(harness, "inventory");
    }
  );

  it("runs a data op and a takedown", async () => {
    const ensured = await send(
      await signedRequest("/data", { json: { op: "d1.ensure", name: "app-inventory-db" } })
    );
    const takenDown = await send(await signedRequest("/takedown", { json: { name: "inventory" } }));

    expect(ensured.status).toBe(200);
    expect(fake.d1("app-inventory-db")).not.toBeNull();
    expect(await takenDown.json()).toEqual({ cleanupComplete: true });
    expectGone(harness, "inventory");
  });

  it("refuses an unsigned request", async () => {
    const response = await send(new Request("https://deployer.apps.example.test/health"));

    expect(response.status).toBe(401);
  });
});
