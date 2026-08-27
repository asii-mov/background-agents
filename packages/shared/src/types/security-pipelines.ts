import { z } from "zod";

export const MAX_SECURITY_PIPELINE_COMMANDS = 20;
export const MAX_SECURITY_PIPELINE_OUTPUT_BYTES = 64 * 1024;

export const securityPipelineCommandSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  command: z.array(z.string().max(1000)).min(1).max(50),
  timeoutSeconds: z.number().int().min(1).max(900).default(300),
});

const securityPipelineCommonSchema = {
  name: z.string().trim().min(1).max(200),
  commands: z.array(securityPipelineCommandSchema).min(1).max(MAX_SECURITY_PIPELINE_COMMANDS),
  repoScopes: z.array(z.string().trim().min(1)).nullable().optional(),
  environmentScopes: z.array(z.string().trim().min(1)).nullable().optional(),
  enabled: z.boolean().default(true),
  blocking: z.boolean().default(true),
  maxRemediationAttempts: z.number().int().min(0).max(5).default(2),
};

export const createSecurityPipelineSchema = z.strictObject(securityPipelineCommonSchema);
export const updateSecurityPipelineSchema = z.strictObject({
  revision: z.number().int().positive(),
  name: securityPipelineCommonSchema.name.optional(),
  commands: securityPipelineCommonSchema.commands.optional(),
  repoScopes: securityPipelineCommonSchema.repoScopes,
  environmentScopes: securityPipelineCommonSchema.environmentScopes,
  enabled: z.boolean().optional(),
  blocking: z.boolean().optional(),
  maxRemediationAttempts: z.number().int().min(0).max(5).optional(),
});

export interface SecurityPipelineConfig {
  id: string;
  name: string;
  commands: SecurityPipelineCommand[];
  blocking: boolean;
  maxRemediationAttempts: number;
  /** Effective repository scope after the control plane resolves environment scope. */
  repoScopes: string[] | null;
}

export interface SecurityPipelineMetadata extends SecurityPipelineConfig {
  revision: number;
  repoScopes: string[] | null;
  environmentScopes: string[] | null;
  enabled: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export type SecurityPipelineCommand = z.infer<typeof securityPipelineCommandSchema>;
export type CreateSecurityPipelineInput = z.input<typeof createSecurityPipelineSchema>;
export type ValidatedCreateSecurityPipelineInput = z.output<typeof createSecurityPipelineSchema>;
export type UpdateSecurityPipelineInput = z.input<typeof updateSecurityPipelineSchema>;
export type ValidatedUpdateSecurityPipelineInput = Omit<
  z.output<typeof updateSecurityPipelineSchema>,
  "revision"
>;
