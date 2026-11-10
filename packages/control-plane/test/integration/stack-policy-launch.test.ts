import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledStackPolicy } from "@open-inspect/shared/types/stack-policy";
import { ApprovedComponentStore } from "../../src/db/approved-components";
import type { Env } from "../../src/types";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, serviceFetch } from "./helpers";
import { runInSessionDO, type SessionDOInternals } from "./session-do-access";

const REPOSITORY = { repoOwner: "acme/platform", repoName: "web" };

const APP_HOSTING: Partial<Env> = {
  APP_BROKER_URL: "https://deployer.apps.example.com",
  APPS_DOMAIN: "apps.example.com",
  SERVICE_AUTH_SECRET_APP_BROKER: "test-app-broker-secret",
  APP_BROKER_ACCESS_CLIENT_ID: "test-access-client-id",
  APP_BROKER_ACCESS_CLIENT_SECRET: "test-access-client-secret",
};

/** The shipped default policy; cleanup empties the catalogue between tests. */
async function reseedDefaultPolicy(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0104"));
  const seed = (migration?.queries ?? []).filter((query) =>
    /INSERT INTO (component_categories|approved_components|approved_component_signals) \(/.test(
      query
    )
  );
  expect(seed).toHaveLength(3);
  await env.DB.batch(seed.map((query) => env.DB.prepare(query)));
}

/** Answers the Modal create endpoint and records each request body the control plane sent. */
function captureModalLaunches(): Array<Record<string, unknown>> {
  const launches: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.hostname.endsWith(".modal.run")) {
      throw new Error(`Unexpected outbound request: ${url.href}`);
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    launches.push(body);
    return Response.json({
      success: true,
      data: { sandbox_id: body.sandbox_id, status: "warming", created_at: Date.now() },
    });
  });
  return launches;
}

async function launchSession(
  options: { harness?: "claude"; appHosting?: Partial<Env> } = {}
): Promise<Record<string, unknown>> {
  const launches = captureModalLaunches();
  // initNamedSession forwards every key to the DO init request, which reads `harness`.
  const init = {
    ...REPOSITORY,
    repoId: 4242,
    ...(options.harness ? { harness: options.harness } : {}),
  };
  await initNamedSession(`stack-policy-launch-${crypto.randomUUID()}`, init, (stub) =>
    runInSessionDO(stub, (instance) => {
      if (options.appHosting) {
        Object.assign((instance as unknown as SessionDOInternals).appEnv, options.appHosting);
      }
    })
  );
  await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: 5_000 });
  return launches[0]!;
}

beforeEach(async () => {
  await cleanD1Tables();
  await reseedDefaultPolicy();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanD1Tables();
});

describe("stack policy at launch", () => {
  it("delivers byte for byte the policy the preview route shows, data rules included", async () => {
    const launch = await launchSession();
    vi.restoreAllMocks();

    const url = `https://test.local/stack-policy/preview?repo=${REPOSITORY.repoOwner}/${REPOSITORY.repoName}`;
    const response = await serviceFetch(url, {
      as: { userId: "ad".repeat(16), role: "administrator" },
    });
    expect(response.status).toBe(200);
    const { policy: preview } = (await response.json()) as { policy: CompiledStackPolicy };

    expect(preview.rules.some((rule) => rule.signals.some((s) => s.kind === "manifest"))).toBe(
      true
    );
    expect(preview.instructions).toContain("### Data for internal apps");
    expect(preview.instructions).toContain("React");
    expect(launch.stack_policy).toEqual(preview);
    expect((launch.stack_policy as { instructions: string }).instructions).toBe(
      preview.instructions
    );
  });

  it("launches a Claude session with the stack policy", async () => {
    const launch = await launchSession({ harness: "claude" });

    expect(launch.harness).toBe("claude");
    expect(launch.stack_policy).toEqual(
      await new ApprovedComponentStore(env.DB).compileForSession([REPOSITORY], null)
    );
  });

  it("omits the stack policy when the catalogue governs nothing", async () => {
    await cleanD1Tables();

    const launch = await launchSession();

    expect(launch).not.toHaveProperty("stack_policy");
  });

  it("asks for the deploy-app tool only when app hosting is configured", async () => {
    expect((await launchSession({ appHosting: APP_HOSTING })).agent_app_deploy_enabled).toBe(true);
    vi.restoreAllMocks();
    expect((await launchSession()).agent_app_deploy_enabled).toBe(false);
  });

  it.each<[string, Partial<Env>]>([
    ...Object.keys(APP_HOSTING).map((field): [string, Partial<Env>] => [
      `without ${field}`,
      { [field]: "" },
    ]),
    ["with a broker URL that has a path", { APP_BROKER_URL: "https://deployer.example.com/x" }],
    ["with an apps domain that is a URL", { APPS_DOMAIN: "https://apps.example.com" }],
  ])("leaves the deploy-app tool off %s", async (_case, override) => {
    const launch = await launchSession({ appHosting: { ...APP_HOSTING, ...override } });
    expect(launch.agent_app_deploy_enabled).toBe(false);
  });
});
