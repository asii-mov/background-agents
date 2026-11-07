import { expect, test } from "./verification-test";

test("lets an administrator flip web frontend to block and see what agents are told change", async ({
  page,
  api,
}) => {
  api.role = "admin";
  await page.goto("/settings?tab=appsec");

  await expect(page.getByRole("heading", { name: "Technology standards" })).toBeVisible();
  const lane = page.getByRole("listitem", { name: "Web frontend" });
  await expect(lane.getByRole("button", { name: "Svelte actions" })).toBeVisible();
  await expect(lane.getByRole("button", { name: "React actions" })).toBeVisible();
  await expect(lane.getByRole("button", { name: "Next.js actions" })).toBeVisible();

  const instructions = page.getByLabel("Agent instructions");
  await expect(instructions).toContainText("## Organization technology standards");
  await expect(instructions).toContainText("- Prefer: **Svelte**.");
  await expect(instructions).toContainText("- Do not use: **Next.js**, **React**.");
  const denials = page.getByRole("list", { name: "Denied technologies" });
  await expect(denials.getByText("flagged, not blocked")).toHaveCount(2);
  const advisoryDigest = await page.getByText(/^Policy [0-9a-f]{12} with \d+ rules$/).textContent();

  await lane.getByRole("radio", { name: "Block" }).click();

  await expect(page.getByText("Web frontend denials now block")).toBeVisible();
  await expect(denials.getByText("blocks the push")).toHaveCount(2);
  await expect(
    lane.getByText("Denied technologies fail the agent's turn and reject the push until replaced.")
  ).toBeVisible();
  await expect(page.getByText(/^Policy [0-9a-f]{12} with \d+ rules$/)).not.toHaveText(
    advisoryDigest ?? ""
  );
  expect(api.stackPolicy.webFrontendEnforcement).toBe("block");
  expect(
    api.requests.find(
      ({ method, path }) => method === "PUT" && path === "/api/component-categories/web-frontend"
    )?.body
  ).toMatchObject({ enforcement: "block", revision: 1 });
});

test("shows an administrator how repositories follow the standards", async ({ page, api }) => {
  api.role = "admin";
  await page.goto("/settings?tab=appsec");

  await page.getByRole("tab", { name: "Adoption" }).click();
  await expect(page.getByRole("heading", { name: "Is the standard winning?" })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Web frontend: 1 standard, 1 violating, 1 not used" })
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Stack adoption by repository and category" });
  const identity = table.getByRole("row").filter({ hasText: "acme/identity-service" });
  await expect(identity.getByText("Violating")).toBeVisible();
  await expect(identity.getByText("Mixed")).toBeVisible();
  await expect(identity.getByText("Non-standard")).toBeVisible();
  await identity.getByRole("button", { name: "acme/identity-service" }).click();
  await expect(page.getByText(/React \(web\/package\.json\)/)).toBeVisible();

  await page.getByRole("tab", { name: "App data" }).click();
  await expect(page.getByText("App data is not enabled on this workspace.")).toBeVisible();
});

test("keeps required governance skills out of a member's composer and sidebar", async ({
  page,
  api,
}) => {
  api.role = "member";
  const skill = {
    revisionNumber: 1,
    revisionSha256: "5e".repeat(32),
    totalBytes: 120,
    assignmentSources: [{ id: "assignment_global", type: "global" }],
  };
  api.sessionSkills = [
    {
      ...skill,
      skillId: "skill_review",
      revisionId: "skill_revision_review_1",
      name: "review-pr",
      description: "Review a pull request",
      required: false,
    },
    {
      ...skill,
      skillId: "skill_platform_guard",
      revisionId: "skill_revision_platform_guard_1",
      name: "internal-app-auth",
      description: "Workspace-required app authentication",
      required: true,
    },
  ];
  await page.goto("/session/session-verification");

  await expect(page.getByRole("button", { name: "Managed skills (1)" })).toBeVisible();
  await page.getByRole("button", { name: "Managed skills (1)" }).click();
  await expect(page.getByText("review-pr", { exact: true })).toBeVisible();
  await expect(page.getByText("internal-app-auth")).toHaveCount(0);

  await page.getByRole("textbox").first().fill("$");
  const suggestions = page.getByRole("listbox", { name: "Managed skills" });
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await expect(suggestions.getByRole("option", { name: /review-pr/ })).toBeVisible();
});
