import { describe, expect, it } from "vitest";
import { parseGovernanceCatalog } from "./catalog-schema";

describe("parseGovernanceCatalog", () => {
  it("loads Skills and unpinned MCP update policy from one immutable snapshot", () => {
    const result = parseGovernanceCatalog(
      {
        commitSha: "abc123",
        files: [
          {
            path: ".openinspect/catalog.yaml",
            content: `schemaVersion: 1
skills:
  - path: skills/secure-auth
    required: true
mcpServers:
  - path: mcps/context/mcp.yaml
`,
          },
          {
            path: ".openinspect/skills/secure-auth/SKILL.md",
            content: `---
name: secure-auth
description: Use the approved authentication component.
metadata:
  owner: appsec
---
Follow the approved authentication workflow.
`,
          },
          {
            path: ".openinspect/skills/secure-auth/references/example.md",
            content: "Example",
          },
          {
            path: ".openinspect/mcps/context/mcp.yaml",
            content: `schemaVersion: 1
name: context
type: local
package: "@company/context-mcp"
updatePolicy:
  automatic: true
  channel: latest
  range: "^3"
`,
          },
        ],
      },
      ".openinspect"
    );

    expect(result.commitSha).toBe("abc123");
    expect(result.skills[0]).toMatchObject({
      name: "secure-auth",
      required: true,
      assignments: [{ type: "global" }],
    });
    expect(result.skills[0].content.files[0].path).toBe("references/example.md");
    expect(result.mcpServers[0].definition).toMatchObject({
      package: "@company/context-mcp",
      updatePolicy: { automatic: true, channel: "latest", range: "^3" },
    });
  });

  it("rejects credentials and runtime pins in Git MCP definitions", () => {
    expect(() =>
      parseGovernanceCatalog(
        {
          commitSha: "bad",
          files: [
            {
              path: ".openinspect/catalog.yaml",
              content: "schemaVersion: 1\nmcpServers:\n  - path: mcp.yaml\n",
            },
            {
              path: ".openinspect/mcp.yaml",
              content:
                "schemaVersion: 1\nname: bad\ntype: local\npackage: bad\nenv:\n  TOKEN: secret\nupdatePolicy:\n  automatic: true\n",
            },
          ],
        },
        ".openinspect"
      )
    ).toThrow(/unrecognized key/i);
  });
});
