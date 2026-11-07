import { describe, expect, it } from "vitest";
import type { AppName } from "@open-inspect/shared/apps";
import { permissionsForBuiltInRole, type PermissionId } from "@open-inspect/shared/rbac";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { RequestContext } from "../http/request-context";
import {
  enforceAppRequirement,
  resolveAppRequirement,
  type AppOwner,
  type AppOwnerLookup,
} from "./app-admission";

const requirement = { kind: "app", operation: "manage", appParam: "name" } as const;

const apps: Record<string, AppOwner> = {
  mine: { userId: "user", teamId: null },
  "team-app": { userId: "teammate", teamId: "team" },
  other: { userId: "stranger", teamId: "other-team" },
};

function lookup(): AppOwnerLookup & { calls: AppName[] } {
  const calls: AppName[] = [];
  return {
    calls,
    findOwner: async (name) => {
      calls.push(name);
      return apps[name] ?? null;
    },
  };
}

function context(permissions: readonly PermissionId[]): RequestContext {
  return {
    db: {
      prepare: () => {
        throw new Error("Unexpected SQL query");
      },
      batch: async () => [],
    },
    request_id: "app-admission",
    trace_id: "app-admission",
    metrics: createRequestMetrics(),
    executionCtx: createTestBackgroundTasks(),
    principal: { kind: "user", userId: "user" },
    authorization: {
      userId: "user",
      role: { id: "custom-role", key: null, name: "Custom" },
      permissions: [...permissions],
      suspendedAt: null,
    },
    sessionMemberships: new Map([["team", "member"]]),
  };
}

const member = permissionsForBuiltInRole("member");
const administrator = permissionsForBuiltInRole("administrator");

describe("app management admission", () => {
  it.each([
    { actor: "member", permissions: member, app: "mine", allowed: "apps.manage.own" },
    { actor: "member", permissions: member, app: "team-app", allowed: "apps.manage.own" },
    { actor: "member", permissions: member, app: "other", allowed: null },
    {
      actor: "administrator",
      permissions: administrator,
      app: "other",
      allowed: "apps.manage.any",
    },
  ])("$actor managing $app -> $allowed", async ({ permissions, app, allowed }) => {
    const outcome = await resolveAppRequirement(
      requirement,
      { name: app },
      context(permissions),
      lookup()
    );
    if (allowed) {
      expect(outcome).toEqual({ kind: "allowed", effectivePermission: allowed, owner: apps[app] });
    } else {
      expect(outcome).toMatchObject({
        kind: "denied",
        status: 403,
        reasonCode: "not_app_owner",
        failedPermission: "apps.manage.any",
      });
    }
  });

  it("refuses an actor without either grant before looking the app up", async () => {
    const owners = lookup();
    const outcome = await resolveAppRequirement(
      requirement,
      { name: "mine" },
      context(permissionsForBuiltInRole("viewer")),
      owners
    );
    expect(outcome).toMatchObject({
      kind: "denied",
      status: 403,
      reasonCode: "permission_required",
      failedPermission: "apps.manage.own",
    });
    expect(owners.calls).toEqual([]);
  });

  it.each(["missing", "Mine", "deployer"])(
    "answers 404 for %s, which names no app",
    async (name) => {
      const outcome = await resolveAppRequirement(
        requirement,
        { name },
        context(administrator),
        lookup()
      );
      expect(outcome).toMatchObject({ kind: "denied", status: 404, reasonCode: "app_not_found" });
    }
  );

  it("refuses services", async () => {
    const ctx: RequestContext = {
      ...context([]),
      principal: { kind: "service", service: "slack-bot", actor: null },
      authorization: undefined,
    };
    const outcome = await resolveAppRequirement(requirement, { name: "mine" }, ctx, lookup());
    expect(outcome).toMatchObject({ kind: "denied", reasonCode: "service_capability_required" });
  });

  it("fails closed while no owner lookup is configured", async () => {
    const evidence = { requirements: [], effectivePermissions: [] };
    const failure = await enforceAppRequirement(
      requirement,
      { name: "mine" },
      context(member),
      evidence
    );
    expect(failure?.response.status).toBe(503);
    expect(await failure?.response.json()).toMatchObject({ code: "authorization_unavailable" });
  });

  it("records the granted scope as audit evidence", async () => {
    const evidence = { requirements: [], effectivePermissions: [] };
    const failure = await enforceAppRequirement(
      requirement,
      { name: "team-app" },
      context(member),
      evidence,
      lookup()
    );
    expect(failure).toBeNull();
    expect(evidence).toEqual({
      requirements: [requirement],
      effectivePermissions: ["apps.manage.own"],
    });
  });
});
