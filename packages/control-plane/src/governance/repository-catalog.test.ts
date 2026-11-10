import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGovernanceCatalog } from "./catalog-schema";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const catalogRoot = path.join(repositoryRoot, ".openinspect");

function readFiles(directory: string): Array<{ path: string; content: string }> {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return readFiles(entryPath);
    return [
      {
        path: path.relative(repositoryRoot, entryPath).split(path.sep).join("/"),
        content: fs.readFileSync(entryPath, "utf8"),
      },
    ];
  });
}

describe("the repository governance catalog", () => {
  it("loads the required internal app auth skill", () => {
    const result = parseGovernanceCatalog(
      { commitSha: "local-validation", files: readFiles(catalogRoot) },
      ".openinspect"
    );
    const skill = result.skills.find(({ name }) => name === "internal-app-auth");

    expect(skill).toMatchObject({
      required: true,
      enabled: true,
      assignments: [{ type: "global" }],
    });
    expect(skill?.content.files.map((file) => file.path)).toEqual([
      "agents/openai.yaml",
      "references/cloudflare-access.md",
    ]);
  });
});
