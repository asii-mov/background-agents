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

describe("parseGovernanceCatalog technology catalogue", () => {
  const bun = `schemaVersion: 1
name: Bun
kind: tool
categoryId: js-toolchain
stance: preferred
owner: platform-engineering
locator: https://bun.sh
documentationUrl: https://bun.sh/docs
description: Package manager, script runner and bundler.
usage: Use bun install and commit bun.lock.
lifecycle: approved
signals:
  - { kind: file, pattern: bun.lock }
`;
  const npm = `schemaVersion: 1
name: npm
kind: tool
categoryId: js-toolchain
stance: allowed
owner: platform-engineering
locator: https://www.npmjs.com
documentationUrl: https://docs.npmjs.com
description: The Node.js package manager.
usage: Acceptable in repositories that already use it.
lifecycle: approved
signals:
  - { kind: file, pattern: package-lock.json }
`;
  const categories = `categories:
  - id: js-toolchain
    name: JavaScript toolchain
    description: Installing packages and running scripts.
`;
  const components = `components:
  - path: components/bun.yaml
  - path: components/npm.yaml
`;

  function parse(manifestTail: string, files: Record<string, string> = {}) {
    return parseGovernanceCatalog(
      {
        commitSha: "stack-commit",
        files: [
          { path: ".openinspect/catalog.yaml", content: `schemaVersion: 1\n${manifestTail}` },
          ...Object.entries({
            "components/bun.yaml": bun,
            "components/npm.yaml": npm,
            ...files,
          }).map(([path, content]) => ({ path: `.openinspect/${path}`, content })),
        ],
      },
      ".openinspect"
    );
  }

  it("reads categories inline and components as API bodies from their files", () => {
    const result = parse(categories + components);
    expect(result.stack?.categories).toEqual([
      {
        id: "js-toolchain",
        name: "JavaScript toolchain",
        description: "Installing packages and running scripts.",
        enforcement: "advise",
      },
    ]);
    expect(result.stack?.components.map((component) => component.sourcePath)).toEqual([
      "components/bun.yaml",
      "components/npm.yaml",
    ]);
    expect(result.stack?.components[0].definition).toMatchObject({
      name: "Bun",
      stance: "preferred",
      signals: [{ kind: "file", pattern: "bun.lock" }],
    });
  });

  it("leaves the technology catalogue unmanaged when neither key is present", () => {
    expect(parse("").stack).toBeUndefined();
  });

  it("requires categories and components together", () => {
    expect(() => parse(categories)).toThrow(/declared together/);
    expect(() => parse(components)).toThrow(/declared together/);
  });

  it("rejects a component whose category the catalogue does not declare", () => {
    expect(() =>
      parse(categories + components, {
        "components/npm.yaml": npm.replace(
          "categoryId: js-toolchain",
          "categoryId: python-tooling"
        ),
      })
    ).toThrow("components/npm.yaml: unknown category python-tooling");
  });

  it("rejects a signal that two components claim", () => {
    expect(() =>
      parse(categories + components, {
        "components/npm.yaml": npm.replace("package-lock.json", "bun.lock"),
      })
    ).toThrow("components/npm.yaml: signal file:bun.lock already identifies Bun");
  });

  it("rejects a second standard in one category", () => {
    expect(() =>
      parse(categories + components, {
        "components/npm.yaml": npm.replace("stance: allowed", "stance: preferred"),
      })
    ).toThrow(/js-toolchain already prefers Bun/);
  });

  it("rejects a component file that is not an API body", () => {
    expect(() =>
      parse(categories + components, { "components/npm.yaml": `${npm}token: secret\n` })
    ).toThrow(/unrecognized key/i);
    expect(() =>
      parse(categories + components, {
        "components/npm.yaml": npm.replace("schemaVersion: 1", "schemaVersion: 2"),
      })
    ).toThrow(/components\/npm.yaml/);
  });

  it("rejects a listed component file that does not exist", () => {
    expect(() => parse(`${categories}${components}  - path: components/missing.yaml\n`)).toThrow(
      "Missing .openinspect/components/missing.yaml"
    );
  });
});
