import { expect, test } from "./verification-test";

test("imports the OpenAI Playwright skill after reviewing moving-ref provenance", async ({
  page,
  api,
}) => {
  api.role = "editor";
  await page.goto("/settings?tab=skills");

  await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import from repository" }).click();
  await page.getByLabel("Repository").click();
  await page.getByRole("option", { name: "openai/skills" }).click();
  await page.getByLabel("Branch, tag, or commit (optional)").fill("main");
  await page.getByLabel("Subdirectory (optional)").fill("skills/.curated/playwright");
  await page.getByRole("button", { name: "Preview import" }).click();

  await expect(page.getByRole("heading", { name: "Source" })).toBeVisible();
  await expect(page.getByText("openai/skills/skills/.curated/playwright")).toBeVisible();
  await expect(page.getByText("49f948faa9258a0c61caceaf225e179651397431")).toBeVisible();
  await expect(page.getByText("4a4a4a4a4a4a")).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "name: playwright" }).getByText("SKILL.md")
  ).toBeVisible();
  await page.getByRole("button", { name: "Import playwright" }).click();
  await expect(page.getByText("Imported playwright")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Imported source" })).toBeVisible();
  await expect(page.getByText("openai/skills/skills/.curated/playwright")).toBeVisible();
  await expect(page.getByText("main", { exact: true })).toBeVisible();
  await expect(page.getByText("49f948faa9258a0c61caceaf225e179651397431")).toBeVisible();
  await expect(page.getByText("4a4a4a4a4a4a")).toBeVisible();

  const importRequest = api.requests.find(
    (request) => request.method === "POST" && request.path === "/api/skills/import"
  );
  expect(importRequest?.body).toMatchObject({
    source: {
      repository: { repoOwner: "openai", repoName: "skills" },
      ref: "main",
      subdirectory: "skills/.curated/playwright",
    },
    expectedCommitSha: "49f948faa9258a0c61caceaf225e179651397431",
    expectedSourceSha256: "4a".repeat(32),
    expectedRevisionSha256: "7b".repeat(32),
  });
});

test("keeps Git-governed MCP metadata read-only and rotates credentials", async ({ page, api }) => {
  api.role = "editor";
  api.gitGoverned = true;
  await page.goto("/settings?tab=mcp-servers");

  await expect(
    page.getByText(/Metadata is managed from acme-security\/agent-governance at main/)
  ).toBeVisible();
  await expect(
    page.getByText(/approved · created by security-platform · resolved 0\.0\.42/)
  ).toBeVisible();
  await expect(page.getByText(/playwright-mcp.*global/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Server" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Disable" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Disable" })).toBeDisabled();
  await page.getByRole("button", { name: /Browser verifier/ }).click();

  await expect(page.getByText(/Metadata and package policy are read-only here/)).toBeVisible();
  await expect(page.getByPlaceholder("e.g. playwright, context7")).toHaveCount(0);
  await page.getByPlaceholder("KEY_NAME").fill("PLAYWRIGHT_TOKEN");
  await page.getByPlaceholder("value").fill("verification-secret");
  await page.getByRole("button", { name: "Save Credentials" }).click();

  await expect(page.getByText("MCP credentials updated")).toBeVisible();
  expect(api.mcpCredentialWrite).toEqual({
    revision: 7,
    env: { PLAYWRIGHT_TOKEN: "verification-secret" },
  });
  expect(
    api.requests.some(
      (request) =>
        request.method === "PUT" && request.path === "/api/mcp-servers/mcp_browser_verifier"
    )
  ).toBe(false);
});

test("shows Git-governed MCP metadata to members without editable row controls", async ({
  page,
  api,
}) => {
  api.role = "member";
  api.gitGoverned = true;
  await page.goto("/settings?tab=mcp-servers");

  await expect(page.getByText(/acme-security\/agent-governance at main/)).toBeVisible();
  await expect(page.getByText(/resolved 0\.0\.42/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Server" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Disable" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Browser verifier/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save Credentials" })).toHaveCount(0);
  await expect(page.getByPlaceholder("KEY_NAME")).toHaveCount(0);
});

test("lets an administrator assign a role, create a pipeline, and save repository criticality", async ({
  page,
  api,
}) => {
  api.role = "admin";
  await page.goto("/settings?tab=appsec");

  await page.getByRole("tab", { name: "Pipelines and risk" }).click();
  await expect(page.getByRole("heading", { name: "Platform ownership" })).toBeVisible();
  const staffRole = page.getByRole("combobox", { name: "Role for Staff Engineer" });
  await expect(staffRole).toContainText("Member");
  await staffRole.click();
  await page.getByRole("option", { name: "Editor", exact: true }).click();
  await expect(page.getByText("Platform role updated")).toBeVisible();
  await expect(staffRole).toContainText("Editor");
  await page.getByRole("button", { name: /Add pipeline/ }).click();
  await page.getByPlaceholder("AppSec baseline").fill("Corporate AppSec baseline");
  await page.getByRole("button", { name: "Save pipeline" }).click();
  await expect(page.getByText("Security pipeline saved")).toBeVisible();
  await expect(page.getByText("Corporate AppSec baseline")).toBeVisible();

  const riskSection = page.getByRole("heading", { name: "Repository criticality" }).locator("..");
  await riskSection.getByPlaceholder("acme").fill("acme");
  await riskSection.getByPlaceholder("identity-service").fill("identity-service");
  await riskSection.getByRole("combobox").click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await riskSection
    .getByPlaceholder("Production identity boundary")
    .fill("Authentication boundary");
  await riskSection.getByRole("button", { name: "Save criticality" }).click();

  await expect(page.getByText("Repository criticality saved")).toBeVisible();
  await expect(page.getByText("acme/identity-service")).toBeVisible();
  expect(api.pipelines).toHaveLength(1);
  expect(api.staffRole).toBe("editor");
  expect(api.riskProfiles).toEqual([
    expect.objectContaining({
      repoOwner: "acme",
      repoName: "identity-service",
      criticality: "high",
      rationale: "Authentication boundary",
    }),
  ]);
});

test("gives members no AppSec entry and no governance data from a direct link", async ({
  page,
  api,
}) => {
  api.role = "member";
  await page.goto("/settings?tab=appsec");

  await expect(page).not.toHaveURL(/tab=appsec/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "AppSec", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "AppSec governance" })).toHaveCount(0);
  const governanceReads = api.requests.filter(({ path }) =>
    /^\/api\/(approved-components|component-categories|stack-policy|stack-inventory|app-data|security-pipelines|repository-risk)/.test(
      path
    )
  );
  expect(governanceReads).toEqual([]);
});

test("saves a supported outbound allowlist", async ({ page, api }) => {
  api.role = "admin";
  await page.goto("/settings?tab=sandbox");

  await page.getByLabel("Egress policy").click();
  await page.getByRole("option", { name: "Allowlist only" }).click();
  await page.getByLabel("TLS domains").fill("api.openai.com\n*.github.com");
  await page.getByLabel("CIDR ranges").fill("10.0.0.0/8");
  await page.getByRole("button", { name: "Save Settings" }).click();

  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(api.sandboxNetworkPolicy).toEqual({
    mode: "allowlist",
    allowedDomains: ["api.openai.com", "*.github.com"],
    allowedCidrs: ["10.0.0.0/8"],
  });
});

test("preserves the existing sandbox policy when a save is rejected", async ({ page, api }) => {
  const rejection = "The control plane rejected this policy update.";
  api.role = "admin";
  api.sandboxWriteError = rejection;
  await page.goto("/settings?tab=sandbox");

  await page.getByLabel("Egress policy").click();
  await page.getByRole("option", { name: "Block all outbound traffic" }).click();
  await page.getByRole("button", { name: "Save Settings" }).click();

  await expect(page.getByText(rejection)).toBeVisible();
  expect(api.sandboxNetworkPolicy).toEqual({ mode: "unrestricted" });
});

test("withholds sandbox management from a member without integration permission", async ({
  page,
  api,
}) => {
  api.role = "member";
  await page.goto("/settings?tab=sandbox");
  await expect(page.getByRole("button", { name: "Sandbox", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Egress policy")).toHaveCount(0);
  expect(api.sandboxNetworkPolicy).toEqual({ mode: "unrestricted" });
  expect(
    api.requests.some(({ method, path }) => method === "PUT" && path.includes("sandbox"))
  ).toBe(false);
});
