import type { SkillImportResult } from "./git-import";

export interface ExpectedSkillImportSnapshot {
  expectedCommitSha: string;
  expectedSourceSha256: string;
  expectedRevisionSha256: string;
}

export function skillImportSnapshotMismatch(
  result: SkillImportResult,
  expected: ExpectedSkillImportSnapshot
): string | null {
  if (result.source.commitSha !== expected.expectedCommitSha) {
    return `The source moved to commit ${result.source.commitSha} since it was previewed. Preview the import again.`;
  }
  if (result.source.sourceSha256 !== expected.expectedSourceSha256) {
    return "The source content changed since it was previewed. Preview again.";
  }
  if (result.revisionSha256 !== expected.expectedRevisionSha256) {
    return "The imported skill changed since it was previewed. Preview again.";
  }
  return null;
}
