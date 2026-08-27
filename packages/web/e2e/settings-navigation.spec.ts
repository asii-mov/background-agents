import type { Page } from "@playwright/test";
import { expect, test } from "./verification-test";

const SETTINGS_TABS = [
  ["Secrets", "Secrets"],
  ["Models", "Enabled Models"],
  ["Appearance", "Appearance"],
  ["Keyboard", "Keyboard Shortcuts"],
  ["Data Controls", "Data Controls"],
  ["Sandbox", "Sandbox"],
  ["Integrations", "Integrations"],
  ["Skills", "Skills"],
  ["MCP Servers", "MCP Servers"],
  ["AppSec", "AppSec governance"],
] as const;

async function openSettingsTab(page: Page, label: string, heading: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
}

test("settings.navigation-covers-ten-tabs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  for (const [label, heading] of SETTINGS_TABS) {
    await openSettingsTab(page, label, heading);
  }
});
