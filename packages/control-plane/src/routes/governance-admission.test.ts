import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { PlatformRoleStore } from "../db/platform-roles";
import {
  createRepositoryGrantEnv,
  createRepositoryGrantRequest,
  setupRepositoryGrantSpies,
} from "./repository-grants.test-support";
import { governanceCatalogRoutes } from "./governance-catalog";

const { reconcile } = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock("../governance/reconciler", () => ({
  getGovernanceCatalogStatus: vi.fn(async () => ({ configured: false })),
  reconcileGovernanceCatalog: reconcile,
}));

const request = createRepositoryGrantRequest(governanceCatalogRoutes, () =>
  createRepositoryGrantEnv([])
);
const withPermissions = (permissions: PermissionId[]) => createRepositoryGrantEnv(permissions);

describe("governance admission", () => {
  beforeEach(() => {
    setupRepositoryGrantSpies();
    reconcile.mockReset();
    reconcile.mockResolvedValue({ configured: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("hides catalogue status without governance.read", async () => {
    expect((await request("/governance/catalog", "GET")).status).toBe(403);
    const allowed = await request(
      "/governance/catalog",
      "GET",
      undefined,
      withPermissions(["governance.read"])
    );
    expect(allowed.status).toBe(200);
  });

  it("denies a sync without governance.manage before reconciling", async () => {
    const response = await request(
      "/governance/catalog/sync",
      "POST",
      undefined,
      withPermissions(["governance.read"])
    );
    expect(response.status).toBe(403);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("syncs for governance.manage whatever the legacy platform role", async () => {
    vi.spyOn(PlatformRoleStore.prototype, "getEffectiveRole").mockResolvedValue("member");
    const response = await request(
      "/governance/catalog/sync",
      "POST",
      undefined,
      withPermissions(["governance.manage"])
    );
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
