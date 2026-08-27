import { describe, expect, it } from "vitest";
import { redactVerificationEvidence } from "./verification-evidence";

describe("verification evidence redaction", () => {
  it("preserves request structure while redacting credential values", () => {
    expect(
      redactVerificationEvidence({
        method: "PUT",
        path: "/api/mcp-servers/server-1/credentials",
        body: {
          revision: 7,
          env: { PLAYWRIGHT_TOKEN: "local-secret" },
          headers: { Authorization: "Bearer local-secret" },
          access_token: "local-token",
          expectedRevisionSha256: "a".repeat(64),
        },
      })
    ).toEqual({
      method: "PUT",
      path: "/api/mcp-servers/server-1/credentials",
      body: {
        revision: 7,
        env: { PLAYWRIGHT_TOKEN: "[REDACTED]" },
        headers: { Authorization: "[REDACTED]" },
        access_token: "[REDACTED]",
        expectedRevisionSha256: "a".repeat(64),
      },
    });
  });

  it.each(["accessToken", "refreshToken", "clientSecret", "apiKey", "privateKey"])(
    "redacts the camel-case %s field",
    (key) => {
      expect(redactVerificationEvidence({ [key]: "credential" })).toEqual({
        [key]: "[REDACTED]",
      });
    }
  );
});
