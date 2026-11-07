/**
 * Route admission for `{ kind: "app", operation: "manage" }`. The scoped `apps.manage` pair
 * decides: `any` manages every app; `own` manages apps the actor owns or whose owner team the
 * actor belongs to. Ownership comes from an injected lookup, so routing never imports the apps
 * module.
 */

import { parseAppName, type AppName } from "@open-inspect/shared/apps";
import {
  SCOPED_PERMISSION_PAIRS,
  resolveScopedPermission,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { resourceViewer } from "../authorization/resource-viewer";
import type { RequestContext } from "../http/request-context";
import { json } from "../http/responses";
import type { RouteAuthorizationRequirement, RouteParams } from "../routes/shared";
import {
  authorizationDenial,
  authorizationUnavailable,
  type AuthorizationEvidence,
  type AuthorizationFailure,
} from "./authorization-evidence";

export interface AppOwner {
  userId: string;
  teamId: string | null;
}

/** Who owns an app; null when no app has the name. */
export interface AppOwnerLookup {
  findOwner(name: AppName): Promise<AppOwner | null>;
}

/** App routes fail closed (authorization unavailable) until a real lookup is injected. */
export const UNCONFIGURED_APP_OWNER_LOOKUP: AppOwnerLookup = {
  findOwner: () => Promise.reject(new Error("App owner lookup is not configured")),
};

type AppRequirement = Extract<RouteAuthorizationRequirement, { kind: "app" }>;

export type AppAdmissionOutcome =
  | { kind: "allowed"; effectivePermission: PermissionId; owner: AppOwner }
  | {
      kind: "denied";
      status: 403 | 404;
      response: { error: string; code?: string; permission?: PermissionId };
      reasonCode: string;
      reason: string;
      failedPermission?: PermissionId;
    }
  | { kind: "error"; status: 400; response: { error: string } };

const APP_NOT_FOUND: AppAdmissionOutcome = {
  kind: "denied",
  status: 404,
  response: { error: "App not found" },
  reasonCode: "app_not_found",
  reason: "App not found",
};

/** Infrastructure failures, including an unconfigured lookup, propagate to the caller. */
export async function resolveAppRequirement(
  requirement: AppRequirement,
  params: RouteParams,
  ctx: RequestContext,
  lookup: AppOwnerLookup = UNCONFIGURED_APP_OWNER_LOOKUP
): Promise<AppAdmissionOutcome> {
  const raw = params[requirement.appParam];
  if (!raw) return { kind: "error", status: 400, response: { error: "Invalid app route" } };

  const viewer = await resourceViewer(ctx);
  if (viewer.kind === "service") {
    return {
      kind: "denied",
      status: 403,
      response: { error: "Forbidden", code: "service_capability_required" },
      reasonCode: "service_capability_required",
      reason: "Forbidden",
    };
  }
  const pair = SCOPED_PERMISSION_PAIRS["apps.manage"];
  // Checked before the lookup, so an actor without the grant cannot probe which names exist.
  const scope = resolveScopedPermission("apps.manage", viewer.permissions);
  if (!scope) {
    return {
      kind: "denied",
      status: 403,
      response: { error: "Forbidden", code: "permission_required", permission: pair.own },
      reasonCode: "permission_required",
      reason: "Forbidden",
      failedPermission: pair.own,
    };
  }

  const name = parseAppName(raw);
  if (!name.ok) return APP_NOT_FOUND;
  const owner = await lookup.findOwner(name.name);
  if (!owner) return APP_NOT_FOUND;

  const owns =
    owner.userId === viewer.userId ||
    (owner.teamId !== null && viewer.memberships.has(owner.teamId));
  if (scope === "own" && !owns) {
    return {
      kind: "denied",
      status: 403,
      response: { error: "Forbidden", code: "not_app_owner" },
      reasonCode: "not_app_owner",
      reason: "Forbidden",
      failedPermission: pair.any,
    };
  }
  return { kind: "allowed", effectivePermission: pair[scope], owner };
}

/** The router's adapter: the outcome as an HTTP denial plus audit evidence. */
export async function enforceAppRequirement(
  requirement: AppRequirement,
  params: RouteParams,
  ctx: RequestContext,
  evidence: AuthorizationEvidence,
  lookup: AppOwnerLookup = UNCONFIGURED_APP_OWNER_LOOKUP
): Promise<AuthorizationFailure | null> {
  let outcome: AppAdmissionOutcome;
  try {
    outcome = await resolveAppRequirement(requirement, params, ctx, lookup);
  } catch {
    return authorizationUnavailable();
  }
  if (outcome.kind === "error") return { response: json(outcome.response, outcome.status) };
  if (outcome.kind === "denied") {
    return authorizationDenial(
      json(outcome.response, outcome.status),
      evidence,
      requirement,
      outcome.reasonCode,
      outcome.reason,
      outcome.failedPermission
    );
  }
  evidence.requirements.push(requirement);
  evidence.effectivePermissions.push(outcome.effectivePermission);
  return null;
}
