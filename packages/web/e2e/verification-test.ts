import { expect, test as base } from "@playwright/test";
import { installVerificationApi, type VerificationApiState } from "./verification-api";
import { redactVerificationEvidence } from "./support/verification-evidence";

type VerificationFixtures = {
  api: VerificationApiState;
};

function evidenceName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const test = base.extend<VerificationFixtures>({
  api: [
    async ({ page }, runFixture, testInfo) => {
      const state = await installVerificationApi(page);
      await runFixture(state);
      expect(state.unexpectedRequests).toEqual([]);

      const name = evidenceName(testInfo.title);
      await testInfo.attach(`${name}-screen`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
      await testInfo.attach(`${name}-api-observations`, {
        body: Buffer.from(JSON.stringify(redactVerificationEvidence(state.requests), null, 2)),
        contentType: "application/json",
      });
    },
    { auto: true },
  ],
});

export { expect };
