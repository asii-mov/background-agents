import { z } from "zod";
import { parse as parseYaml } from "yaml";
import {
  skillAssignmentInputSchema,
  skillContentInputSchema,
  skillNameSchema,
  type SkillAssignmentInput,
  type SkillContentInput,
} from "@open-inspect/shared/types/skills";
import type { RepositorySnapshot } from "../source-control/types";

export const GOVERNANCE_MAX_FILES = 500;
export const GOVERNANCE_MAX_BYTES = 5 * 1024 * 1024;
export const GOVERNANCE_MAX_SKILLS = 100;
export const GOVERNANCE_MAX_MCP_SERVERS = 100;
export const GOVERNANCE_CATALOG_FILE = "catalog.yaml";

const safeRelativePath = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "must be a safe relative POSIX path"
  );

const manifestSkillSchema = z
  .strictObject({
    path: safeRelativePath,
    enabled: z.boolean().optional().default(true),
    required: z.boolean().optional().default(false),
    executableFiles: z.array(safeRelativePath).max(100).optional().default([]),
    assignments: z
      .array(skillAssignmentInputSchema)
      .max(100)
      .optional()
      .default([{ type: "global" }]),
  })
  .superRefine((value, context) => {
    const keys = value.assignments.map((assignment) =>
      assignment.type === "global"
        ? "global"
        : assignment.type === "environment"
          ? `environment:${assignment.environmentId}`
          : `repository:${assignment.repository.repoOwner.toLowerCase()}/${assignment.repository.repoName.toLowerCase()}`
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["assignments"],
        message: "assignments must be unique",
      });
    }
    if (new Set(value.executableFiles).size !== value.executableFiles.length) {
      context.addIssue({
        code: "custom",
        path: ["executableFiles"],
        message: "executable files must be unique",
      });
    }
  });

const manifestMcpSchema = z.strictObject({ path: safeRelativePath });

const catalogManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  skills: z.array(manifestSkillSchema).max(GOVERNANCE_MAX_SKILLS).optional().default([]),
  mcpServers: z.array(manifestMcpSchema).max(GOVERNANCE_MAX_MCP_SERVERS).optional().default([]),
});

const updatePolicySchema = z.strictObject({
  automatic: z.literal(true),
  channel: z.string().trim().min(1).max(100).optional().default("latest"),
  range: z.string().trim().min(1).max(100).optional(),
});

const desiredMcpCommon = {
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(100),
  lifecycle: z.literal("approved").optional().default("approved"),
  enabled: z.boolean().optional().default(true),
  repoScopes: z
    .array(z.string().trim().min(1).max(300))
    .max(100)
    .nullable()
    .optional()
    .default(null),
  environmentScopes: z
    .array(z.string().trim().min(1).max(200))
    .max(100)
    .nullable()
    .optional()
    .default(null),
};

const npmPackageNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(214)
  .regex(
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
    "must be a valid lowercase npm package name"
  );

export const desiredMcpServerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...desiredMcpCommon,
    type: z.literal("local"),
    package: npmPackageNameSchema,
    executable: z.string().trim().min(1).max(214).optional(),
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((argument) => !argument.includes("\0"), "must not contain NUL")
      )
      .max(100)
      .optional()
      .default([]),
    updatePolicy: updatePolicySchema,
  }),
  z.strictObject({
    ...desiredMcpCommon,
    type: z.literal("remote"),
    url: z
      .url()
      .max(2048)
      .refine((url) => new URL(url).protocol === "https:", "must use HTTPS"),
  }),
]);

export type DesiredMcpServer = z.output<typeof desiredMcpServerSchema>;

export interface ParsedGitSkill {
  sourcePath: string;
  name: string;
  enabled: boolean;
  required: boolean;
  assignments: SkillAssignmentInput[];
  content: SkillContentInput;
}

export interface ParsedGitMcpServer {
  sourcePath: string;
  definition: DesiredMcpServer;
}

export interface ParsedGovernanceCatalog {
  commitSha: string;
  skills: ParsedGitSkill[];
  mcpServers: ParsedGitMcpServer[];
}

function joinPath(root: string, child: string): string {
  return [root.replace(/^\/+|\/+$/g, ""), child].filter(Boolean).join("/");
}

function parseYamlObject(content: string, path: string): unknown {
  try {
    return parseYaml(content, { maxAliasCount: 0 });
  } catch (error) {
    throw new Error(
      `${path}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseSkillMarkdown(
  content: string,
  path: string
): { name: string; content: Omit<SkillContentInput, "files"> } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`${path}: SKILL.md requires YAML frontmatter`);
  const frontmatterSchema = z.strictObject({
    name: skillNameSchema,
    description: z.string().trim().min(1),
    license: z.string().trim().min(1).nullable().optional(),
    compatibility: z.string().trim().min(1).nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional().default({}),
  });
  const parsed = frontmatterSchema.safeParse(parseYamlObject(match[1], path));
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  return {
    name: parsed.data.name,
    content: {
      description: parsed.data.description,
      body: match[2],
      license: parsed.data.license,
      compatibility: parsed.data.compatibility,
      metadata: parsed.data.metadata,
    },
  };
}

/** Parse and fully validate one immutable repository snapshot. */
export function parseGovernanceCatalog(
  snapshot: RepositorySnapshot,
  rootPath: string
): ParsedGovernanceCatalog {
  const root = rootPath.replace(/^\/+|\/+$/g, "");
  const files = new Map(snapshot.files.map((file) => [file.path, file.content]));
  const manifestPath = joinPath(root, GOVERNANCE_CATALOG_FILE);
  const manifestContent = files.get(manifestPath);
  if (manifestContent === undefined) throw new Error(`Missing ${manifestPath}`);
  const manifestResult = catalogManifestSchema.safeParse(
    parseYamlObject(manifestContent, manifestPath)
  );
  if (!manifestResult.success) {
    throw new Error(`${manifestPath}: ${z.prettifyError(manifestResult.error)}`);
  }
  const manifest = manifestResult.data;
  const referencedPaths = [...manifest.skills, ...manifest.mcpServers].map((entry) => entry.path);
  if (new Set(referencedPaths).size !== referencedPaths.length) {
    throw new Error("Catalog paths must be unique");
  }

  const skills = manifest.skills.map((entry): ParsedGitSkill => {
    const directory = joinPath(root, entry.path);
    const skillPath = `${directory}/SKILL.md`;
    const skillMarkdown = files.get(skillPath);
    if (skillMarkdown === undefined) throw new Error(`Missing ${skillPath}`);
    const parsed = parseSkillMarkdown(skillMarkdown, skillPath);
    const executableFiles = new Set(entry.executableFiles);
    const supportingFiles = snapshot.files
      .filter((file) => file.path.startsWith(`${directory}/`) && file.path !== skillPath)
      .map((file) => ({
        path: file.path.slice(directory.length + 1),
        content: file.content,
        executable: executableFiles.has(file.path.slice(directory.length + 1)),
      }));
    const supportingPaths = new Set(supportingFiles.map((file) => file.path));
    const missingExecutable = entry.executableFiles.find((path) => !supportingPaths.has(path));
    if (missingExecutable) {
      throw new Error(`${skillPath}: executable file does not exist: ${missingExecutable}`);
    }
    const contentResult = skillContentInputSchema.safeParse({
      ...parsed.content,
      files: supportingFiles,
    });
    if (!contentResult.success)
      throw new Error(`${skillPath}: ${z.prettifyError(contentResult.error)}`);
    return {
      sourcePath: entry.path,
      name: parsed.name,
      enabled: entry.enabled,
      required: entry.required,
      assignments: entry.assignments,
      content: contentResult.data,
    };
  });

  const mcpServers = manifest.mcpServers.map((entry): ParsedGitMcpServer => {
    const path = joinPath(root, entry.path);
    const content = files.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    const result = desiredMcpServerSchema.safeParse(parseYamlObject(content, path));
    if (!result.success) throw new Error(`${path}: ${z.prettifyError(result.error)}`);
    return { sourcePath: entry.path, definition: result.data };
  });

  const skillNames = skills.map((skill) => skill.name.toLowerCase());
  if (new Set(skillNames).size !== skillNames.length) throw new Error("Skill names must be unique");
  const mcpNames = mcpServers.map((server) => server.definition.name.toLowerCase());
  if (new Set(mcpNames).size !== mcpNames.length)
    throw new Error("MCP server names must be unique");
  return { commitSha: snapshot.commitSha, skills, mcpServers };
}
