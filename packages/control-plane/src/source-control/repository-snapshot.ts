import { SourceControlProviderError } from "./errors";
import type {
  ReadRepositorySnapshotConfig,
  RepositoryReader,
  RepositorySnapshot,
  RepositorySnapshotFile,
} from "./types";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export async function readRepositorySnapshot(
  reader: RepositoryReader,
  config: ReadRepositorySnapshotConfig
): Promise<RepositorySnapshot> {
  const commit = await reader.resolveCommit(config);
  if (!commit) {
    throw new SourceControlProviderError(
      `Repository ref ${config.ref} does not exist`,
      "permanent"
    );
  }

  const tree = await reader.listTree({
    owner: config.owner,
    name: config.name,
    commitSha: commit.sha,
    path: config.path,
  });
  if (tree.truncated) {
    throw new SourceControlProviderError("Repository tree was truncated", "permanent");
  }

  const entries = tree.entries
    .filter((entry) => entry.type === "file")
    .sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length > config.maxFiles) {
    throw new SourceControlProviderError(
      `Repository snapshot exceeds ${config.maxFiles} files`,
      "permanent"
    );
  }

  const declaredBytes = entries.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0);
  if (declaredBytes > config.maxBytes) {
    throw new SourceControlProviderError(
      `Repository snapshot exceeds ${config.maxBytes} bytes`,
      "permanent"
    );
  }

  let totalBytes = 0;
  const files: RepositorySnapshotFile[] = [];
  for (const entry of entries) {
    const bytes = await reader.readBlob({
      owner: config.owner,
      name: config.name,
      blobId: entry.blobId,
      maxBytes: config.maxBytes - totalBytes,
    });
    totalBytes += bytes.byteLength;
    if (totalBytes > config.maxBytes) {
      throw new SourceControlProviderError(
        `Repository snapshot exceeds ${config.maxBytes} bytes`,
        "permanent"
      );
    }

    let content: string;
    try {
      content = utf8Decoder.decode(bytes);
    } catch {
      throw new SourceControlProviderError(
        `Repository file ${entry.path} is not valid UTF-8 text`,
        "permanent"
      );
    }
    files.push({ path: entry.path, content, sha: entry.blobId });
  }

  return { commitSha: commit.sha, files };
}
