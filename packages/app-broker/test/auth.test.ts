import { SERVICE_REQUEST_MAX_BODY_BYTES } from "@open-inspect/shared/service-auth";
import { describe, expect, it } from "vitest";
import { BROKER_ORIGIN, createHarness, deployForm, signedRequest } from "./broker-harness";

describe("request authentication", () => {
  it("answers a request signed by the control plane", async () => {
    const harness = createHarness();

    const response = await harness.call(await signedRequest("/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("refuses an unsigned request before touching Cloudflare", async () => {
    const harness = createHarness();

    const response = await harness.call(
      new Request("https://deployer.apps.example.test/takedown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "inventory" }),
      })
    );

    expect(response.status).toBe(401);
    expect(harness.fake.calls).toEqual([]);
  });

  it("refuses a request signed as another service, even with the right secret", async () => {
    const harness = createHarness();

    const response = await harness.call(
      await signedRequest("/takedown", { json: { name: "inventory" } }, { service: "web" })
    );

    expect(response.status).toBe(401);
    expect(harness.fake.calls).toEqual([]);
  });

  it("refuses a request signed with another secret", async () => {
    const harness = createHarness();

    const response = await harness.call(
      await signedRequest(
        "/takedown",
        { json: { name: "inventory" } },
        { secret: "placeholder-other-secret" }
      )
    );

    expect(response.status).toBe(401);
  });

  it("refuses an expired signature", async () => {
    const harness = createHarness();

    const response = await harness.call(
      await signedRequest(
        "/takedown",
        { json: { name: "inventory" } },
        { signedAgoMs: 10 * 60_000 }
      )
    );

    expect(response.status).toBe(401);
    expect(harness.fake.calls).toEqual([]);
  });

  it("refuses a signature a minute old, well inside the shared sig1 window", async () => {
    const harness = createHarness();

    const response = await harness.call(
      await signedRequest("/takedown", { json: { name: "inventory" } }, { signedAgoMs: 60_000 })
    );

    expect(response.status).toBe(401);
    expect(harness.fake.calls).toEqual([]);
  });

  it("answers a signature a few seconds old", async () => {
    const harness = createHarness();

    const response = await harness.call(
      await signedRequest("/takedown", { json: { name: "inventory" } }, { signedAgoMs: 5_000 })
    );

    expect(response.status).toBe(200);
  });

  it("refuses a signature replayed onto another path", async () => {
    const harness = createHarness();
    const signed = await signedRequest("/takedown", { json: { name: "inventory" } });

    const moved = new Request(`${BROKER_ORIGIN}/data`, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify({ name: "inventory" }),
    });

    expect((await harness.call(moved)).status).toBe(401);
    expect(harness.fake.calls).toEqual([]);
  });

  it("refuses a replay of a request it already accepted", async () => {
    const harness = createHarness();
    const original = await signedRequest("/takedown", { json: { name: "inventory" } });
    const replay = original.clone();

    expect((await harness.call(original)).status).toBe(200);
    const callsAfterFirst = harness.fake.calls.length;

    expect((await harness.call(replay)).status).toBe(401);
    expect(harness.fake.calls).toHaveLength(callsAfterFirst);
  });

  it("refuses a body that does not match the signature", async () => {
    const harness = createHarness();
    const signed = await signedRequest("/takedown", { json: { name: "inventory" } });

    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify({ name: "payroll" }),
    });

    expect((await harness.call(tampered)).status).toBe(401);
    expect(harness.fake.calls).toEqual([]);
  });

  it("refuses a body over the signed-request cap with 413", async () => {
    const harness = createHarness();
    const bytes = new Uint8Array(SERVICE_REQUEST_MAX_BODY_BYTES + 1);

    const response = await harness.call(
      await signedRequest("/deploy", { bytes, contentType: "multipart/form-data; boundary=x" })
    );

    expect(response.status).toBe(413);
    expect(harness.fake.calls).toEqual([]);
  });

  it("fails closed when the broker's own configuration is incomplete", async () => {
    const harness = createHarness({ env: { APPS_ACCESS_POLICY_ID: "" } });

    const response = await harness.call(
      await signedRequest("/deploy", { form: deployForm({ name: "inventory" }) })
    );

    expect(response.status).toBe(502);
    expect(harness.fake.calls).toEqual([]);
  });

  it("refuses to run with a script prefix outside the app- grammar", async () => {
    const harness = createHarness({ env: { APPS_SCRIPT_PREFIX: "open-inspect-" } });

    const response = await harness.deploy({ name: "inventory" });

    expect(response.status).toBe(502);
    expect(harness.fake.calls).toEqual([]);
  });
});
