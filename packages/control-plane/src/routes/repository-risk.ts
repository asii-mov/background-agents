import { z } from "zod";
import { RepositoryRiskStore } from "../db/repository-risk";
import { assessChangeRisk, RISK_LEVELS } from "../risk/change-risk";
import type { Env } from "../types";
import {
  defineRoutes,
  error,
  json,
  parseJsonBody,
  parsePattern,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  type Route,
} from "./shared";

const repositoryProfileSchema = z.strictObject({
  repoOwner: z.string().trim().min(1),
  repoName: z.string().trim().min(1),
  criticality: z.enum(RISK_LEVELS),
  rationale: z.string().trim().max(2000).nullable().default(null),
});
const assessmentSchema = z.strictObject({
  repoOwner: z.string().trim().min(1),
  repoName: z.string().trim().min(1),
  paths: z.array(z.string().min(1)).max(1000),
});

function actorUserId(ctx: RequestContext): string {
  if (ctx.principal?.kind === "user") return ctx.principal.userId;
  if (ctx.principal?.kind === "service") {
    return ctx.principal.actor?.canonicalUserId ?? "system";
  }
  return "system";
}

async function listProfiles(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  return json(await new RepositoryRiskStore(ctx.db).list());
}

async function upsertProfile(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const parsed = repositoryProfileSchema.safeParse(body);
  if (!parsed.success) return error("Invalid repository risk profile", 400);
  return json(
    await new RepositoryRiskStore(ctx.db).upsert({
      ...parsed.data,
      actorUserId: actorUserId(ctx),
    })
  );
}

async function assessRisk(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const parsed = assessmentSchema.safeParse(body);
  if (!parsed.success) return error("Invalid risk assessment input", 400);
  const criticality = await new RepositoryRiskStore(ctx.db).getCriticality(
    parsed.data.repoOwner,
    parsed.data.repoName
  );
  return json(assessChangeRisk(criticality, parsed.data.paths));
}

export const repositoryRiskRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  { method: "GET", pattern: parsePattern("/repository-risk"), handler: listProfiles },
  {
    method: "PUT",
    pattern: parsePattern("/repository-risk"),
    requiredPermission: "catalog.write",
    handler: upsertProfile,
  },
  { method: "POST", pattern: parsePattern("/risk/assess"), handler: assessRisk },
]);
