import { expect, test } from "./verification-test";

test("integrations.open-slack-configuration", async ({ page, api }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Integrations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await page.getByRole("link", { name: /Slack/ }).click();

  await expect(page.getByRole("heading", { name: "Slack", exact: true }).last()).toBeVisible();
  await expect(page.getByText(/Slack token never enters the sandbox/)).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enable agent notifications" })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: "Allow" })).toBeChecked();
  await expect(page.getByText(/No repository overrides yet/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Integrations", exact: true })).toBeVisible();
  expect(api.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: "GET", path: "/api/integration-settings/slack" }),
      expect.objectContaining({ method: "GET", path: "/api/integration-settings/slack/repos" }),
    ])
  );
});
