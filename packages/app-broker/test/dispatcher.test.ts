import { parseAppName } from "@open-inspect/shared/apps";
import { describe, expect, it } from "vitest";
import dispatcher, { scriptNameForHost, type DispatcherEnv } from "../dispatcher/dispatcher";
import { parseBrokerConfig } from "../src/env";
import { appTarget } from "../src/names";
import { FAKE_OPTIONS, brokerEnv } from "./broker-harness";

const DOMAIN = FAKE_OPTIONS.appsDomain;
const PREFIX = FAKE_OPTIONS.scriptPrefix;

function dispatcherEnv(scripts: Record<string, (request: Request) => Response>): DispatcherEnv {
  return {
    APPS_DOMAIN: DOMAIN,
    APPS_SCRIPT_PREFIX: PREFIX,
    DISPATCHER: {
      get(name) {
        return {
          async fetch(request) {
            const script = scripts[name];
            if (!script) throw new Error(`Worker not found: ${name}`);
            return script(request);
          },
        };
      },
    },
  };
}

describe("scriptNameForHost", () => {
  const config = parseBrokerConfig(brokerEnv("dispatch-namespace"));
  if (!config.ok) throw new Error("test broker config is invalid");

  it.each(["inventory", "a", "team-42-dashboard", "x".repeat(40)])(
    "routes %s.<domain> to the script the broker deploys for that name",
    (name) => {
      const parsed = parseAppName(name);
      if (!parsed.ok) throw new Error(`${name} should be a valid app name`);

      expect(scriptNameForHost(`${name}.${DOMAIN}`, DOMAIN, PREFIX)).toBe(
        appTarget(config.config, parsed.name).script
      );
    }
  );

  it.each([
    DOMAIN,
    `deployer.${DOMAIN}`,
    `dispatcher.${DOMAIN}`,
    `two.labels.${DOMAIN}`,
    `xn--inventory.${DOMAIN}`,
    `double--hyphen.${DOMAIN}`,
    `${"x".repeat(41)}.${DOMAIN}`,
    "inventory.example.test",
    `inventory.${DOMAIN}.evil.test`,
  ])("routes %s nowhere", (host) => {
    expect(scriptNameForHost(host, DOMAIN, PREFIX)).toBeNull();
  });
});

describe("the dispatcher Worker", () => {
  const env = dispatcherEnv({
    "app-inventory": (request) => new Response(`inventory saw ${new URL(request.url).pathname}`),
  });

  it("forwards the request to the app's namespace script", async () => {
    const response = await dispatcher.fetch(new Request(`https://inventory.${DOMAIN}/notes`), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("inventory saw /notes");
  });

  it("answers 404 for a two-label host without consulting the namespace", async () => {
    const response = await dispatcher.fetch(
      new Request(`https://inventory.team.${DOMAIN}/`),
      dispatcherEnv({})
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 for an app with no script", async () => {
    const response = await dispatcher.fetch(new Request(`https://payroll.${DOMAIN}/`), env);

    expect(response.status).toBe(404);
  });

  it("answers 404 when its script prefix is outside the app- grammar", async () => {
    const response = await dispatcher.fetch(new Request(`https://inventory.${DOMAIN}/`), {
      ...env,
      APPS_SCRIPT_PREFIX: "",
    });

    expect(response.status).toBe(404);
  });
});
