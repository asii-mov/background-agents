import { expect, test } from "./verification-test";

test("sessions.core-workflow-terminal-diff-pr", async ({ page, api }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Welcome to/ })).toBeVisible();

  await page
    .getByPlaceholder("What do you want to build?")
    .fill("Harden the identity validation and open a pull request");
  await page.getByRole("button", { name: /^Send/ }).click();

  await expect(page).toHaveURL(/\/session\/session-verification$/);
  await expect(page.getByRole("button", { name: "Harden identity validation" })).toBeVisible();
  await expect(
    page.getByText("Validation is hardened and pull request #42 is ready for review.")
  ).toBeVisible();
  await expect(page.getByRole("status", { name: "Connection status: Connected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sandbox status: Ready" })).toBeVisible();

  const pullRequestLink = page.getByRole("link", { name: "#42" });
  await expect(pullRequestLink).toHaveAttribute(
    "href",
    "https://github.com/acme/identity-service/pull/42"
  );
  await expect(page.getByText("open", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /validator\.ts modified/ }).click();
  await expect(page.getByRole("region", { name: "Session changes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "src/identity/validator.ts" })).toBeVisible();
  await page.getByRole("button", { name: "Hide file list" }).click();
  await expect(page.getByText("if (!input.trim()) return false;", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Close changes" }).click();
  await page.getByRole("button", { name: "Show", exact: true }).click();
  const terminal = page.frameLocator('iframe[title="Session terminal"]');
  await expect(page.locator('iframe[title="Session terminal"]')).toHaveAttribute(
    "src",
    /[?&]token=loopback-terminal-token(?:&|$)/
  );
  await expect(
    terminal.getByText("verification@openinspect:~/identity-service$ tests passed")
  ).toBeVisible();

  const sessionCreateIndex = api.requests.findIndex(
    ({ method, path }) => method === "POST" && path === "/api/sessions"
  );
  const promptIndex = api.requests.findIndex(
    ({ method, path }) => method === "POST" && path === "/api/sessions/session-verification/prompt"
  );
  expect(sessionCreateIndex).toBeGreaterThanOrEqual(0);
  expect(promptIndex).toBeGreaterThan(sessionCreateIndex);
  expect(
    api.requests.some(
      ({ method, path }) =>
        method === "GET" &&
        path ===
          "/api/sessions/session-verification/diff/revision-verification-1/files/identity-validator-ts"
    )
  ).toBe(true);
});
