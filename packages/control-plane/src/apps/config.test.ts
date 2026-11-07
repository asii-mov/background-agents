import type { AppName } from "@open-inspect/shared/apps";
import { describe, expect, it } from "vitest";
import { appUrl, parseAppsConfig } from "./config";

const COMPLETE = {
  APP_BROKER_URL: "https://deployer.apps.example.test",
  APPS_DOMAIN: "apps.example.test",
  SERVICE_AUTH_SECRET_APP_BROKER: "placeholder-broker-secret",
  APP_BROKER_ACCESS_CLIENT_ID: "placeholder-client-id",
  APP_BROKER_ACCESS_CLIENT_SECRET: "placeholder-client-secret",
};

describe("parseAppsConfig", () => {
  it("is not configured when no hosting field is set", () => {
    expect(parseAppsConfig({})).toEqual({ kind: "not_configured" });
  });

  it("is available when every field is set", () => {
    expect(parseAppsConfig(COMPLETE)).toEqual({
      kind: "available",
      config: {
        brokerOrigin: "https://deployer.apps.example.test",
        appsDomain: "apps.example.test",
        brokerSecret: "placeholder-broker-secret",
        accessClientId: "placeholder-client-id",
        accessClientSecret: "placeholder-client-secret",
      },
    });
  });

  it("names every missing field of a partial configuration", () => {
    expect(parseAppsConfig({ APP_BROKER_URL: COMPLETE.APP_BROKER_URL, APPS_DOMAIN: "" })).toEqual({
      kind: "invalid",
      problems: [
        "APPS_DOMAIN is not set",
        "SERVICE_AUTH_SECRET_APP_BROKER is not set",
        "APP_BROKER_ACCESS_CLIENT_ID is not set",
        "APP_BROKER_ACCESS_CLIENT_SECRET is not set",
      ],
    });
  });

  it.each([
    "http://deployer.apps.example.test",
    "https://deployer.apps.example.test/deploy",
    "https://user:pass@deployer.apps.example.test",
    "deployer.apps.example.test",
  ])("refuses the broker URL %s", (url) => {
    expect(parseAppsConfig({ ...COMPLETE, APP_BROKER_URL: url })).toMatchObject({
      kind: "invalid",
      problems: ["APP_BROKER_URL must be an https:// origin with no path"],
    });
  });

  it("keeps the origin of a broker URL written with a trailing slash", () => {
    expect(
      parseAppsConfig({ ...COMPLETE, APP_BROKER_URL: "https://deployer.apps.example.test/" })
    ).toMatchObject({ config: { brokerOrigin: "https://deployer.apps.example.test" } });
  });

  it.each(["Apps.Example.test", "https://apps.example.test", "localhost", "apps..example.test"])(
    "refuses the apps domain %s",
    (domain) => {
      expect(parseAppsConfig({ ...COMPLETE, APPS_DOMAIN: domain })).toMatchObject({
        kind: "invalid",
      });
    }
  );
});

describe("appUrl", () => {
  it("is the app's own hostname under the apps domain, without a trailing slash", () => {
    expect(appUrl("apps.example.test", "notes" as AppName)).toBe("https://notes.apps.example.test");
  });
});
