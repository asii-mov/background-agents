import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

function loopbackBaseUrl(value: string | undefined): URL {
  const url = new URL(value ?? "http://127.0.0.1:3300");
  const allowedHosts = new Set(["127.0.0.1", "localhost"]);
  if (
    url.protocol !== "http:" ||
    !allowedHosts.has(url.hostname) ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "OPENINSPECT_VERIFY_BASE_URL must be an http://127.0.0.1:<port> or http://localhost:<port> origin"
    );
  }
  return url;
}

const baseUrl = loopbackBaseUrl(process.env.OPENINSPECT_VERIFY_BASE_URL);
const gatewayUrl = loopbackBaseUrl(
  process.env.OPENINSPECT_VERIFY_GATEWAY_URL ?? "http://127.0.0.1:3301"
);
const browserUse =
  process.env.OPENINSPECT_VERIFY_BROWSER === "chromium"
    ? devices["Desktop Chrome"]
    : { ...devices["Desktop Chrome"], channel: "chrome" as const };

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  outputDir: path.join(repoRoot, ".artifacts/verify-openinspect/test-results"),
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: path.join(repoRoot, ".artifacts/verify-openinspect/report"), open: "never" },
    ],
  ],
  use: {
    baseURL: baseUrl.origin,
    storageState: {
      cookies: [
        {
          name: "openinspect.session_token",
          value: "loopback-verification-session",
          domain: baseUrl.hostname,
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
          expires: -1,
        },
      ],
      origins: [],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: browserUse,
    },
  ],
  webServer: [
    {
      command: "npm run verify:gateway -w @open-inspect/web",
      cwd: repoRoot,
      url: `${gatewayUrl.origin}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        OPENINSPECT_VERIFY_GATEWAY_URL: gatewayUrl.origin,
      },
    },
    {
      command: `npm run dev -w @open-inspect/web -- --hostname ${baseUrl.hostname} --port ${baseUrl.port}`,
      cwd: repoRoot,
      url: `${baseUrl.origin}/settings`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        CONTROL_PLANE_URL: gatewayUrl.origin,
        AUTH_DEV_BYPASS: "1",
        SERVICE_AUTH_SECRET: "openinspect-browser-verification-only",
        NEXT_PUBLIC_WS_URL: `ws://${gatewayUrl.host}`,
        NEXT_PUBLIC_SANDBOX_PROVIDER: "modal",
      },
    },
  ],
});
