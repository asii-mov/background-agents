import { z } from "zod";

export const approvedComponentKindSchema = z.enum(["library", "service", "template", "snippet"]);
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
};

function validateApprovedDefinition(
  value: z.output<z.ZodObject<typeof componentDefinitionFields>>,
  context: z.RefinementCtx
): void {
  if (value.lifecycle !== "approved") return;
  if (!value.sourceUrl && !value.documentationUrl) {
    context.addIssue({
      code: "custom",
      path: ["sourceUrl"],
      message: "approved components require a source or documentation URL",
    });
  }
  if (value.kind === "library" && !value.version) {
    context.addIssue({
      code: "custom",
      path: ["version"],
      message: "approved libraries require an exact version",
    });
  }
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
  .superRefine(validateApprovedDefinition);
export const updateApprovedComponentSchema = z
  .strictObject({ ...componentDefinitionFields, revision: z.number().int().positive() })
  .superRefine(validateApprovedDefinition);

export const approvedComponentSchema = createApprovedComponentSchema.extend({
  id: z.string(),
  revision: z.number().int().positive(),
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
