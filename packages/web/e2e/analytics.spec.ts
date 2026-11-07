import { expect, test } from "./verification-test";

test("analytics.dashboard-range-and-outcomes", async ({ page, api }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("list", { name: "Top repositories by sessions" })).toContainText(
    "web"
  );
  await expect(page.getByRole("region", { name: "Human sessions", exact: true })).toContainText(
    "$12.50"
  );
  await page.getByRole("tab", { name: "Pull requests", exact: true }).click();
  await expect(page.getByText("Merged", { exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "People", exact: true }).click();
  await expect(page.getByText("Zoe", { exact: true }).first()).toBeVisible();
  await page.getByRole("radio", { name: "7d" }).click();
  await expect
    .poll(() =>
      api.requests.some((request) => request.path === "/api/analytics/dashboard?days=7&scope=human")
    )
    .toBe(true);
});
