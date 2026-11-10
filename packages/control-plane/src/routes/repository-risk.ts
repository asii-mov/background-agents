import { parseJsonBody } from "./body";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { requirePermission } from "./shared";
import { z } from "zod";
import { RepositoryRiskStore } from "../db/repository-risk";
import { assessChangeRisk, RISK_LEVELS } from "../risk/change-risk";
import type { Env } from "../types";
import { error, json, SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, type RequestContext } from "./shared";

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
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  return json(await new RepositoryRiskStore(ctx.db).list());
}

async function upsertProfile(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody(request);
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
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = assessmentSchema.safeParse(body);
  if (!parsed.success) return error("Invalid risk assessment input", 400);
  const criticality = await new RepositoryRiskStore(ctx.db).getCriticality(
    parsed.data.repoOwner,
    parsed.data.repoName
  );
  return json(assessChangeRisk(criticality, parsed.data.paths));
}

const GOVERNANCE_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("governance.read"),
});
const GOVERNANCE_MANAGE = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("governance.manage"),
});

export const repositoryRiskRoutes = new Hono<ControlPlaneHonoEnv>();
repositoryRiskRoutes.get("/repository-risk", GOVERNANCE_READ, (c) => dispatch(c, listProfiles));
repositoryRiskRoutes.put("/repository-risk", GOVERNANCE_MANAGE, (c) => dispatch(c, upsertProfile));
repositoryRiskRoutes.post("/risk/assess", GOVERNANCE_READ, (c) => dispatch(c, assessRisk));
