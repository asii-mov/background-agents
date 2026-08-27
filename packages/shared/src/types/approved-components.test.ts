import { describe, expect, it } from "vitest";
import { createApprovedComponentSchema } from "./approved-components";

const approvedLibrary = {
  name: "Acme authentication",
  kind: "library",
  description: "Reviewed authentication primitive",
  owner: "Product Security",
  locator: "@acme/auth",
  version: "1.2.3",
  sourceUrl: "https://github.example.com/platform/auth",
  usage: "Install and use createAuthenticatedApp().",
  lifecycle: "approved",
  enabled: true,
} as const;

describe("createApprovedComponentSchema", () => {
  it("accepts a provenance-bearing exact library version", () => {
    expect(createApprovedComponentSchema.parse(approvedLibrary)).toMatchObject({
      version: "1.2.3",
      repoScopes: null,
      environmentScopes: null,
    });
  });

  it("rejects floating library versions and missing provenance", () => {
    expect(
      createApprovedComponentSchema.safeParse({
        ...approvedLibrary,
        version: "^1.2.3",
        sourceUrl: null,
      }).success
    ).toBe(false);
  });

  it("requires immutable integrity for approved templates and snippets", () => {
    for (const kind of ["template", "snippet"] as const) {
      const invalid = createApprovedComponentSchema.safeParse({
        ...approvedLibrary,
        kind,
        locator: "https://templates.example.com/service",
        version: null,
        integrity: null,
      });
      expect(invalid.success).toBe(false);

      expect(
        createApprovedComponentSchema.safeParse({
          ...approvedLibrary,
          kind,
          locator: "https://templates.example.com/service",
          version: null,
          integrity: `sha256:${"a".repeat(64)}`,
        }).success
      ).toBe(true);
    }
  });
});
