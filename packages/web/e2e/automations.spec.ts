import { expect, test } from "./verification-test";

test("automations.trigger-seeded-workflow", async ({ page, api }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Automations" }).click();
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Nightly identity security review" })).toBeVisible();
  await expect(page.getByText("No runs")).toBeVisible();

  await page.getByRole("button", { name: "Trigger", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Last 1 executions, oldest to newest" })
  ).toBeVisible();
  await expect(page.getByRole("listitem", { name: /Completed/ })).toBeVisible();
  expect(api.automation.triggered).toBe(true);
});
