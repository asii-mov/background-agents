import { expect, test } from "./verification-test";

test("analytics.dashboard-range-and-outcomes", async ({ page, api }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByText("128 sessions in range", { exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByText("Verifier Admin", { exact: true })).toBeVisible();
  await expect(page.getByText("acme/identity-service", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pull Requests", exact: true })).toBeVisible();
  await expect(page.getByText("Total Cost", { exact: true }).first().locator("..")).toContainText(
    "$84.50"
  );
  await expect(page.getByText("Acceptance Rate", { exact: true }).locator("..")).toContainText(
    "84%"
  );

  await page.getByRole("radio", { name: "7d" }).click();
  const sevenDayRequests = [
    "/api/analytics/summary?days=7",
    "/api/analytics/timeseries?days=7",
    "/api/analytics/breakdown?days=7&by=repo",
    "/api/analytics/breakdown?days=7&by=user",
    "/api/analytics/pull-requests?days=7",
  ];
  await expect
    .poll(() =>
      sevenDayRequests.every((path) => api.requests.some((request) => request.path === path))
    )
    .toBe(true);
});
