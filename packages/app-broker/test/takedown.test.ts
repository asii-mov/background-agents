import { describe, expect, it } from "vitest";
import { CLOUDFLARE_API_MAX_ATTEMPTS } from "../src/cloudflare-api";
import {
  BACKENDS,
  FAKE_OPTIONS,
  createHarness,
  expectGone,
  expectServing,
  hostnameOf,
  type Harness,
} from "./broker-harness";
import type { FakeStep } from "./fake-cloudflare";

const NAME = "inventory";

async function takedownResult(harness: Harness, name = NAME) {
  const response = await harness.takedown(name);
  expect(response.status).toBe(200);
  return response.json();
}

async function floorPolicies(harness: Harness): Promise<string[]> {
  const response = await harness.fake.fetch(
    `https://api.cloudflare.fake.invalid/client/v4/accounts/${FAKE_OPTIONS.accountId}/access/apps/${FAKE_OPTIONS.floorAppId}`,
    { headers: { authorization: `Bearer ${FAKE_OPTIONS.apiToken}` } }
  );
  expect(response.status).toBe(200);
  const { result } = (await response.json()) as { result: { policies: { id: string }[] } };
  return result.policies.map((policy) => policy.id);
}

describe.each(BACKENDS)("takedown on the %s backend", (backend) => {
  const removeStep: FakeStep = backend === "workers" ? "scripts.delete" : "dispatch.delete";

  it("detaches the hostname, removes the script and revokes Access, leaving the floor", async () => {
    const harness = createHarness({ backend });
    expect((await harness.deploy({ name: NAME })).status).toBe(200);
    expectServing(harness, NAME);

    expect(await takedownResult(harness)).toEqual({ cleanupComplete: true });

    expectGone(harness, NAME);
    expect(await floorPolicies(harness)).toEqual([FAKE_OPTIONS.policyId]);
    const order = harness.fake.calls
      .map((call) => call.step)
      .filter((step) => ["domains.delete", removeStep, "access.delete"].includes(step));
    expect(order).toEqual(["domains.delete", removeStep, "access.delete"]);
  });

  it("treats an app that was never deployed as already taken down", async () => {
    const harness = createHarness({ backend });

    expect(await takedownResult(harness)).toEqual({ cleanupComplete: true });
    expectGone(harness, NAME);
  });

  it.each([
    ["domains.delete", "detach"],
    [removeStep, "remove_script"],
    ["access.delete", "revoke_access"],
  ] as const)("reports a failure at %s as %s, and a re-run finishes", async (step, failedStep) => {
    const harness = createHarness({ backend });
    expect((await harness.deploy({ name: NAME })).status).toBe(200);
    harness.fake.inject({ step, status: 500, times: CLOUDFLARE_API_MAX_ATTEMPTS });

    expect(await takedownResult(harness)).toEqual({ cleanupComplete: false, failedStep });
    expect(harness.fake.violations).toEqual([]);

    expect(await takedownResult(harness)).toEqual({ cleanupComplete: true });
    expectGone(harness, NAME);
  });

  it("detaches again before revoking Access, so a hostname re-attached mid-takedown never loses Access", async () => {
    const harness = createHarness({ backend });
    expect((await harness.deploy({ name: NAME })).status).toBe(200);
    harness.fake.onStep(removeStep, async () => {
      await harness.fake.fetch(
        `https://api.cloudflare.fake.invalid/client/v4/accounts/${FAKE_OPTIONS.accountId}/workers/domains`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${FAKE_OPTIONS.apiToken}` },
          body: JSON.stringify({
            hostname: hostnameOf(NAME),
            service: backend === "workers" ? `app-${NAME}` : FAKE_OPTIONS.dispatcherService,
            zone_id: FAKE_OPTIONS.zoneId,
          }),
        }
      );
    });

    expect(await takedownResult(harness)).toEqual({ cleanupComplete: true });

    expectGone(harness, NAME);
  });

  it("refuses an invalid or reserved name", async () => {
    const harness = createHarness({ backend });

    const reserved = await harness.takedown("deployer");
    const invalid = await harness.takedown("../floor");

    expect(reserved.status).toBe(400);
    expect(((await reserved.json()) as { error: string }).error).toBe("reserved_name");
    expect(invalid.status).toBe(400);
    expect(harness.fake.calls).toEqual([]);
  });
});
