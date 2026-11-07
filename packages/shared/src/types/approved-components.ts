import { z } from "zod";
import { DATA_STORE_KINDS } from "./app-data";
import {
  approvedComponentStanceSchema,
  catalogSourceKindSchema,
  componentCategoryIdSchema,
  stackSignalKey,
  stackSignalSchema,
} from "./stack-policy";

/** `language` and `tool` are technology choices rather than artifacts (TypeScript, Bun, uv). */
export const approvedComponentKindSchema = z.enum([
  "library",
  "service",
  "template",
  "snippet",
  "language",
  "tool",
  "data_store",
]);
export const approvedComponentLifecycleSchema = z.enum(["development", "approved", "deprecated"]);

const httpsUrl = z
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === "https:", "must use HTTPS");
const scopeList = z.array(z.string().trim().min(1).max(300)).max(500).nullable().default(null);
const exactVersion = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[<>=~^*|\s]/.test(value), "must be an exact immutable version");
const integrity = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const MAX_COMPONENT_SIGNALS = 50;

const componentDefinitionFields = {
  name: z.string().trim().min(1).max(200),
  kind: approvedComponentKindSchema,
  description: z.string().trim().min(1).max(2000),
  owner: z.string().trim().min(1).max(200),
  locator: z.string().trim().min(1).max(2048),
  version: exactVersion.nullable().default(null),
  integrity: integrity.nullable().default(null),
  sourceUrl: httpsUrl.nullable().default(null),
  documentationUrl: httpsUrl.nullable().default(null),
  usage: z
    .string()
    .trim()
    .min(1)
    .max(32 * 1024),
  lifecycle: approvedComponentLifecycleSchema.default("development"),
  repoScopes: scopeList,
  environmentScopes: scopeList,
  enabled: z.boolean().default(true),
  categoryId: componentCategoryIdSchema.nullable().default(null),
  stance: approvedComponentStanceSchema.default("allowed"),
  signals: z.array(stackSignalSchema).max(MAX_COMPONENT_SIGNALS).default([]),
};

type ComponentDefinitionValue = z.output<z.ZodObject<typeof componentDefinitionFields>>;

function validateStackPolicyFields(
  value: ComponentDefinitionValue,
  context: z.RefinementCtx
): void {
  if (value.categoryId !== null && value.signals.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["signals"],
      message: "categorised components need at least one signal so they can be detected",
    });
  }
  if (value.stance !== "allowed") {
    if (value.categoryId === null) {
      context.addIssue({
        code: "custom",
        path: ["categoryId"],
        message: `${value.stance} components need a category`,
      });
    }
    if (value.lifecycle === "deprecated") {
      context.addIssue({
        code: "custom",
        path: ["stance"],
        message: `deprecated components cannot be ${value.stance}`,
      });
    }
  }
  const keys = new Set<string>();
  value.signals.forEach((signal, index) => {
    const key = stackSignalKey(signal);
    if (keys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["signals", index],
        message: `duplicate signal ${key}`,
      });
    }
    keys.add(key);
    if (signal.kind === "manifest" && value.kind !== "data_store") {
      context.addIssue({
        code: "custom",
        path: ["signals", index],
        message: "manifest signals identify data stores only",
      });
    }
  });
}

/** A data store is graded like any component, detected by exactly its own `manifest:<kind>` signal. */
function validateDataStore(value: ComponentDefinitionValue, context: z.RefinementCtx): void {
  const locator = (DATA_STORE_KINDS as readonly string[]).includes(value.locator)
    ? value.locator
    : null;
  if (!locator) {
    context.addIssue({
      code: "custom",
      path: ["locator"],
      message: `data stores are located by kind: ${DATA_STORE_KINDS.join(", ")}`,
    });
  }
  if (value.categoryId === null) {
    context.addIssue({
      code: "custom",
      path: ["categoryId"],
      message: "data stores need a category",
    });
  }
  const [signal, ...rest] = value.signals;
  if (rest.length > 0 || signal?.kind !== "manifest" || (locator && signal.value !== locator)) {
    context.addIssue({
      code: "custom",
      path: ["signals"],
      message: `data stores have exactly one signal, manifest:${locator ?? "<kind>"}`,
    });
  }
  for (const field of ["version", "integrity"] as const) {
    if (value[field] !== null) {
      context.addIssue({ code: "custom", path: [field], message: `data stores have no ${field}` });
    }
  }
}

function validateDefinition(value: ComponentDefinitionValue, context: z.RefinementCtx): void {
  validateStackPolicyFields(value, context);
  if (value.kind === "data_store") validateDataStore(value, context);
  if (value.lifecycle !== "approved") return;
  if (!value.sourceUrl && !value.documentationUrl) {
    context.addIssue({
      code: "custom",
      path: ["sourceUrl"],
      message: "approved components require a source or documentation URL",
    });
  }
  if (value.kind === "library" && !value.version && value.categoryId === null) {
    context.addIssue({
      code: "custom",
      path: ["version"],
      message: "approved libraries require an exact version",
    });
  }
  // A denied entry's usage holds replacement guidance; it is never fetched or installed.
  if (value.stance === "denied") return;
  if (value.kind === "service") {
    const parsed = z.url().safeParse(value.locator);
    if (!parsed.success || new URL(parsed.data).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["locator"],
        message: "approved services require an HTTPS locator",
      });
    }
  }
  if (value.kind === "template" || value.kind === "snippet") {
    const parsed = z.url().safeParse(value.locator);
    if (!parsed.success || new URL(parsed.data).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["locator"],
        message: `approved ${value.kind}s require an HTTPS locator`,
      });
    }
    if (!value.integrity) {
      context.addIssue({
        code: "custom",
        path: ["integrity"],
        message: `approved ${value.kind}s require a SHA-256 integrity digest`,
      });
    }
  }
}

export const createApprovedComponentSchema = z
  .strictObject(componentDefinitionFields)
  .superRefine(validateDefinition);
export const updateApprovedComponentSchema = z
  .strictObject({
    ...componentDefinitionFields,
    revision: z.number().int().positive(),
    /**
     * Moving a category's standard is one request: the batch demotes the current preferred
     * component to allowed before promoting this one.
     */
    demoteCurrentPreferred: z.boolean().default(false),
  })
  .superRefine(validateDefinition);

export const approvedComponentSchema = createApprovedComponentSchema.extend({
  id: z.string(),
  revision: z.number().int().positive(),
  sourceKind: catalogSourceKindSchema,
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const approvedComponentConsumerSchema = z.strictObject({
  componentId: z.string(),
  componentRevision: z.number().int().positive(),
  componentVersion: z.string().nullable(),
  repoOwner: z.string(),
  repoName: z.string(),
  sessionId: z.string(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
});

export const adoptApprovedComponentSchema = z.strictObject({
  repoOwner: z.string().trim().min(1),
  repoName: z.string().trim().min(1),
});

export type ApprovedComponentKind = z.infer<typeof approvedComponentKindSchema>;
export type ApprovedComponentLifecycle = z.infer<typeof approvedComponentLifecycleSchema>;
export type ApprovedComponentDefinition = z.output<typeof createApprovedComponentSchema>;
export type CreateApprovedComponentInput = z.input<typeof createApprovedComponentSchema>;
export type UpdateApprovedComponentInput = z.input<typeof updateApprovedComponentSchema>;
export type ApprovedComponent = z.infer<typeof approvedComponentSchema>;
export type ApprovedComponentConsumer = z.infer<typeof approvedComponentConsumerSchema>;

/**
 * Who uses a component. Components without signals are declared by the adopt tool; components
 * with signals are detected from stack inventory. The read boundary merges both.
 */
export type ComponentConsumer =
  | ({ evidence: "declared" } & ApprovedComponentConsumer)
  | {
      evidence: "detected";
      componentId: string;
      repoOwner: string;
      repoName: string;
      refName: string;
      commitSha: string;
      evidencePaths: string[];
      observedAt: number;
    };
