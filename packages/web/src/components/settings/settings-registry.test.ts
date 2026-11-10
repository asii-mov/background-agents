import { describe, expect, it } from "vitest";
import {
  permissionsForBuiltInRole,
  type BuiltInRoleKey,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { getSettingsGroups, resolveSettingsCategory } from "./settings-registry";

function grantsOf(role: BuiltInRoleKey) {
  const permissions = new Set<PermissionId>(permissionsForBuiltInRole(role));
  return (permission: PermissionId) => permissions.has(permission);
}

function visibleIds(hasPermission: (permission: PermissionId) => boolean): string[] {
  return getSettingsGroups({ hasPermission, repoImagesEnabled: true }).flatMap((group) =>
    group.items.map((item) => item.id)
  );
}

describe("governance settings visibility", () => {
  it("hides AppSec from members and viewers", () => {
    expect(visibleIds(grantsOf("member"))).not.toContain("appsec");
    expect(visibleIds(grantsOf("viewer"))).not.toContain("appsec");
  });

  it("shows AppSec to anyone granted governance.read", () => {
    expect(visibleIds(grantsOf("administrator"))).toContain("appsec");
    expect(visibleIds((permission) => permission === "governance.read")).toEqual([
      "appearance",
      "keyboard-shortcuts",
      "appsec",
    ]);
  });

  it("sends a member's direct AppSec link to a page they may see", () => {
    expect(resolveSettingsCategory("appsec", true, grantsOf("member"))).not.toBe("appsec");
    expect(resolveSettingsCategory("appsec", true, grantsOf("administrator"))).toBe("appsec");
  });
});

describe("apps settings visibility", () => {
  it("shows Apps to members and administrators but not viewers", () => {
    expect(visibleIds(grantsOf("member"))).toContain("apps");
    expect(visibleIds(grantsOf("administrator"))).toContain("apps");
    expect(visibleIds(grantsOf("viewer"))).not.toContain("apps");
  });

  it("needs only apps.read to open the Apps tab", () => {
    expect(visibleIds((permission) => permission === "apps.read")).toEqual([
      "appearance",
      "keyboard-shortcuts",
      "apps",
    ]);
    expect(resolveSettingsCategory("apps", true, grantsOf("viewer"))).not.toBe("apps");
    expect(resolveSettingsCategory("apps", true, grantsOf("member"))).toBe("apps");
  });
});
