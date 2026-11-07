import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformRoleStore } from "../db/platform-roles";
import {
  createRepositoryGrantEnv,
  createRepositoryGrantRequest,
  setupRepositoryGrantSpies,
} from "./repository-grants.test-support";
import { governanceCatalogRoutes } from "./governance-catalog";

const { reconcile } = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock("../governance/reconciler", () => ({
  getGovernanceCatalogStatus: vi.fn(async () => ({ enabled: false })),
  reconcileGovernanceCatalog: reconcile,
}));

const request = createRepositoryGrantRequest(governanceCatalogRoutes, () =>
  createRepositoryGrantEnv([])
);

describe("governance admission", () => {
  beforeEach(() => {
    setupRepositoryGrantSpies();
    reconcile.mockResolvedValue({ enabled: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("denies a member before syncing the catalog", async () => {
    vi.spyOn(PlatformRoleStore.prototype, "getEffectiveRole").mockResolvedValue("member");
    reconcile.mockClear();
    const response = await request("/governance/catalog/sync", "POST");
    expect(response.status).toBe(403);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each(["editor", "admin"] as const)("allows an admitted %s to sync", async (role) => {
    vi.spyOn(PlatformRoleStore.prototype, "getEffectiveRole").mockResolvedValue(role);
    reconcile.mockClear();
    const response = await request("/governance/catalog/sync", "POST");
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
