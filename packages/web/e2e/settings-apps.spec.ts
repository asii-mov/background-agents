import { expect, test } from "./verification-test";
import { BLOCKED_MIGRATION_SHA256 } from "./verification-apps";

function localDateTime(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(
    at.getHours()
  )}:${pad(at.getMinutes())}`;
}

test("shows a member their own apps with actions and colleagues' apps read-only", async ({
  page,
  api,
}) => {
  api.role = "member";
  await page.goto("/settings?tab=apps");

  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "AppSec", exact: true })).toHaveCount(0);

  const own = page
    .getByRole("region", { name: "Your apps" })
    .getByRole("listitem", { name: "expense-tracker" });
  await expect(
    own.getByRole("link", { name: "https://expense-tracker.apps.example.test" })
  ).toBeVisible();
  await expect(own.getByRole("button", { name: "Data" })).toBeVisible();
  await expect(own.getByRole("button", { name: "Take down" })).toBeVisible();
  await expect(own.getByText("Owner:", { exact: false })).toContainText(
    "from acme/expense-tracker"
  );

  const others = page.getByRole("region", { name: "Other apps in the workspace" });
  const roster = others.getByRole("listitem", { name: "team-roster" });
  await expect(roster.getByText("Owner: Staff Engineer", { exact: false })).toBeVisible();
  await expect(roster.getByText("Owner:", { exact: false })).not.toContainText("from acme");
  await expect(roster.getByRole("button")).toHaveCount(0);
  const wiki = others.getByRole("listitem", { name: "legacy-wiki" });
  await expect(wiki.getByText(/Taken down by an administrator/)).toBeVisible();
  await expect(wiki.getByRole("button")).toHaveCount(0);

  await own.getByRole("button", { name: "Data" }).click();
  const data = page.getByRole("region", { name: "expense-tracker data" });
  await expect(data.getByText("Confidential", { exact: true })).toBeVisible();
  await expect(data.getByRole("radio")).toHaveCount(0);
  await expect(data.getByRole("table", { name: "Data resources" })).toContainText("DB");
  await expect(data.getByRole("listitem", { name: "API_KEY" })).toContainText("Set");
  expect(api.requests.some(({ path }) => path.startsWith("/api/apps/team-roster"))).toBe(false);
});

test("lets an administrator take down, release, approve, set a secret and restore app data", async ({
  page,
  api,
}) => {
  api.role = "admin";
  await page.goto("/settings?tab=apps");

  const others = page.getByRole("region", { name: "All other apps" });
  const roster = others.getByRole("listitem", { name: "team-roster" });
  await roster.getByRole("button", { name: "Data" }).click();
  const data = page.getByRole("region", { name: "team-roster data" });
  await expect(
    data.getByRole("radiogroup", { name: "Data classification" }).getByRole("radio", {
      name: "Internal",
    })
  ).toBeVisible();

  const blocked = data.getByRole("listitem", { name: "0002_drop-legacy-notes.sql" });
  await expect(blocked.getByText("DROP TABLE legacy_notes")).toBeVisible();
  await blocked.getByRole("button", { name: "Approve 0002_drop-legacy-notes.sql" }).click();
  await expect(blocked.getByText("approved", { exact: true })).toBeVisible();
  expect(
    api.requests.find(
      ({ method, path }) =>
        method === "POST" && path === "/api/apps/team-roster/data/migrations/approve"
    )?.body
  ).toEqual({
    stage: "production",
    binding: "DB",
    name: "0002_drop-legacy-notes.sql",
    sha256: BLOCKED_MIGRATION_SHA256,
  });

  const token = data.getByRole("listitem", { name: "WEBHOOK_TOKEN" });
  await expect(token.getByText("Not set")).toBeVisible();
  const tokenInput = token.getByLabel("New value for WEBHOOK_TOKEN");
  await expect(tokenInput).toHaveAttribute("type", "password");
  await tokenInput.fill("placeholder-value");
  await token.getByRole("button", { name: "Set WEBHOOK_TOKEN" }).click();
  await expect(token.getByText(/^Set (just now|.* ago)$/)).toBeVisible();
  await expect(tokenInput).toHaveValue("");
  expect(await page.content()).not.toContain("placeholder-value");
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("input")).some((input) =>
        input.value.includes("placeholder-value")
      )
    )
  ).toBe(false);

  const restore = data.getByRole("form", { name: "Restore DB" });
  const restoreButton = restore.getByRole("button", { name: "Restore DB" });
  const restoreAt = new Date(Date.now() - 3 * 3_600_000);
  restoreAt.setSeconds(0, 0);
  await restore.getByLabel("Restore DB to").fill(localDateTime(restoreAt));
  await expect(restoreButton).toBeDisabled();
  await restore.getByLabel("Type DB to confirm").fill("db");
  await expect(restoreButton).toBeDisabled();
  await restore.getByLabel("Type DB to confirm").fill("DB");
  await expect(restoreButton).toBeEnabled();
  await restoreButton.click();
  await expect(data.getByRole("table", { name: "Data operations" })).toContainText("Restored");
  expect(
    api.requests.find(
      ({ method, path }) => method === "POST" && path === "/api/apps/team-roster/data/restore"
    )?.body
  ).toEqual({
    stage: "production",
    binding: "DB",
    target: { timestamp: restoreAt.getTime() },
    confirmBinding: "DB",
  });

  await roster.getByRole("button", { name: "Take down" }).click();
  const confirmTakedown = roster.getByRole("button", { name: "Confirm takedown" });
  await expect(confirmTakedown).toBeDisabled();
  await roster.getByLabel("Reason for taking down team-roster").fill("Leaks customer records");
  await confirmTakedown.click();
  await expect(
    roster.getByText(/Taken down by an administrator .*: Leaks customer records/)
  ).toBeVisible();
  expect(
    api.requests.find(
      ({ method, path }) => method === "POST" && path === "/api/apps/team-roster/takedown"
    )?.body
  ).toEqual({ reason: "Leaks customer records" });

  const wiki = others.getByRole("listitem", { name: "legacy-wiki" });
  await wiki.getByRole("button", { name: "Release hold" }).click();
  await expect(wiki.getByText("Live", { exact: true })).toBeVisible();
  await expect(wiki.getByRole("button", { name: "Release hold" })).toHaveCount(0);
});
