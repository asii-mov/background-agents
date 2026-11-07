import { z } from "zod";
import { parse as parseYaml } from "yaml";
import {
  skillAssignmentInputSchema,
  skillContentInputSchema,
  skillNameSchema,
  type SkillAssignmentInput,
  type SkillContentInput,
} from "@open-inspect/shared/types/skills";
import {
  createApprovedComponentSchema,
  type ApprovedComponentDefinition,
} from "@open-inspect/shared/types/approved-components";
import {
  componentCategoryInputSchema,
  stackSignalKey,
} from "@open-inspect/shared/types/stack-policy";
import type { RepositorySnapshot } from "../source-control/types";

export const GOVERNANCE_MAX_FILES = 500;
export const GOVERNANCE_MAX_BYTES = 5 * 1024 * 1024;
export const GOVERNANCE_MAX_SKILLS = 100;
export const GOVERNANCE_MAX_MCP_SERVERS = 100;
export const GOVERNANCE_MAX_CATEGORIES = 50;
export const GOVERNANCE_MAX_COMPONENTS = 300;
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
const manifestComponentSchema = z.strictObject({ path: safeRelativePath });

const catalogManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    skills: z.array(manifestSkillSchema).max(GOVERNANCE_MAX_SKILLS).optional().default([]),
    mcpServers: z.array(manifestMcpSchema).max(GOVERNANCE_MAX_MCP_SERVERS).optional().default([]),
    categories: z.array(componentCategoryInputSchema).max(GOVERNANCE_MAX_CATEGORIES).optional(),
    components: z.array(manifestComponentSchema).max(GOVERNANCE_MAX_COMPONENTS).optional(),
  })
  .refine(
    (manifest) => (manifest.categories === undefined) === (manifest.components === undefined),
    {
      path: ["components"],
      message: "categories and components are declared together or not at all",
    }
  );

/** A component file is the API's create body plus `schemaVersion`. */
const componentFileVersionSchema = z.looseObject({ schemaVersion: z.literal(1) });

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

export interface ParsedGitComponent {
  sourcePath: string;
  definition: ApprovedComponentDefinition;
}

/** Categories and components Git owns. Every catalogue row outside it is disabled. */
export interface ParsedStackCatalogue {
  categories: z.output<typeof componentCategoryInputSchema>[];
  components: ParsedGitComponent[];
}

export interface ParsedGovernanceCatalog {
  commitSha: string;
  skills: ParsedGitSkill[];
  mcpServers: ParsedGitMcpServer[];
  /** Absent when catalog.yaml declares neither `categories` nor `components`. */
  stack?: ParsedStackCatalogue;
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

/** Whether a component is its category's standard; the catalogue allows one per category. */
export function holdsPreference(definition: ApprovedComponentDefinition): boolean {
  return (
    definition.stance === "preferred" && definition.enabled && definition.lifecycle === "approved"
  );
}

function parseComponentFile(content: string, path: string): ApprovedComponentDefinition {
  const versioned = componentFileVersionSchema.safeParse(parseYamlObject(content, path));
  if (!versioned.success) throw new Error(`${path}: ${z.prettifyError(versioned.error)}`);
  const { schemaVersion: _schemaVersion, ...definition } = versioned.data;
  const result = createApprovedComponentSchema.safeParse(definition);
  if (!result.success) throw new Error(`${path}: ${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * The whole-catalogue rules one API write cannot see: every category reference resolves inside
 * the catalogue, and names, signals and each category's standard are unique across it.
 */
function assertStackCatalogue(stack: ParsedStackCatalogue): void {
  const categoryIds = new Set<string>();
  const categoryNames = new Set<string>();
  for (const category of stack.categories) {
    if (categoryIds.has(category.id)) throw new Error(`Duplicate category ${category.id}`);
    if (categoryNames.has(category.name.toLowerCase())) {
      throw new Error(`Duplicate category name '${category.name}'`);
    }
    categoryIds.add(category.id);
    categoryNames.add(category.name.toLowerCase());
  }
  const componentNames = new Set<string>();
  const signalOwners = new Map<string, string>();
  const standards = new Map<string, string>();
  for (const { sourcePath, definition } of stack.components) {
    if (componentNames.has(definition.name.toLowerCase())) {
      throw new Error(`${sourcePath}: duplicate component name '${definition.name}'`);
    }
    componentNames.add(definition.name.toLowerCase());
    if (definition.categoryId !== null && !categoryIds.has(definition.categoryId)) {
      throw new Error(`${sourcePath}: unknown category ${definition.categoryId}`);
    }
    for (const signal of definition.signals) {
      const key = stackSignalKey(signal);
      const owner = signalOwners.get(key);
      if (owner) throw new Error(`${sourcePath}: signal ${key} already identifies ${owner}`);
      signalOwners.set(key, definition.name);
    }
    if (definition.categoryId !== null && holdsPreference(definition)) {
      const standard = standards.get(definition.categoryId);
      if (standard) {
        throw new Error(
          `${sourcePath}: ${definition.categoryId} already prefers ${standard}; a category has one standard`
        );
      }
      standards.set(definition.categoryId, definition.name);
    }
  }
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
  const referencedPaths = [
    ...manifest.skills,
    ...manifest.mcpServers,
    ...(manifest.components ?? []),
  ].map((entry) => entry.path);
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
  if (!manifest.categories || !manifest.components) {
    return { commitSha: snapshot.commitSha, skills, mcpServers };
  }
  const stack: ParsedStackCatalogue = {
    categories: manifest.categories,
    components: manifest.components.map((entry): ParsedGitComponent => {
      const path = joinPath(root, entry.path);
      const content = files.get(path);
      if (content === undefined) throw new Error(`Missing ${path}`);
      return { sourcePath: entry.path, definition: parseComponentFile(content, path) };
    }),
  };
  assertStackCatalogue(stack);
  return { commitSha: snapshot.commitSha, skills, mcpServers, stack };
}
