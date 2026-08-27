import { describe, expect, it } from "vitest";
import type { SkillImportResult } from "./git-import";
import { skillImportSnapshotMismatch } from "./import-confirmation";

const fetchedImport: SkillImportResult = {
  name: "playwright",
  content: {
    description: "Browser verification",
    body: "# Playwright\n",
    license: null,
    compatibility: null,
    metadata: {},
    files: [],
  },
  source: {
    provider: "github",
    repoOwner: "openai",
    repoName: "skills",
    requestedRef: "main",
    resolvedRef: "main",
    commitSha: "a".repeat(40),
    subdirectory: "skills/.curated/playwright",
    sourceSha256: "b".repeat(64),
  },
  warnings: [],
  revisionSha256: "c".repeat(64),
  totalBytes: 13,
  files: [],
};

describe("skill import snapshot confirmation", () => {
  const expected = {
    expectedCommitSha: fetchedImport.source.commitSha,
    expectedSourceSha256: fetchedImport.source.sourceSha256,
    expectedRevisionSha256: fetchedImport.revisionSha256,
  };

  it("accepts the exact previewed snapshot", () => {
    expect(skillImportSnapshotMismatch(fetchedImport, expected)).toBeNull();
  });

  it.each([
    ["expectedCommitSha", "d".repeat(40), "The source moved to commit"],
    ["expectedSourceSha256", "e".repeat(64), "The source content changed"],
    ["expectedRevisionSha256", "f".repeat(64), "The imported skill changed"],
  ] as const)("rejects a mismatched %s", (field, value, message) => {
    expect(skillImportSnapshotMismatch(fetchedImport, { ...expected, [field]: value })).toContain(
      message
    );
  });
});
