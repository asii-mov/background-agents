// DELTA for packages/shared/src/rbac.ts (upstream file). Six new permission ids; one scoped pair.
//
// PERMISSION_IDS += (kept alphabetical in the const array)
//   "apps.deploy", "apps.manage.any", "apps.manage.own", "apps.read",
//   "governance.manage", "governance.read"
//
// SCOPED_PERMISSION_PAIRS["apps.manage"] = { any: "apps.manage.any", own: "apps.manage.own" }
//
// VIEWER_PERMISSIONS: unchanged (viewers see sessions, not apps or governance)
// MEMBER_PERMISSIONS += "apps.read", "apps.deploy", "apps.manage.own"
// owner / administrator: everything via permissionsForBuiltInRole (code-owned)
//
// Meaning:
//   governance.read    read catalogue, categories, pipelines, repository risk, catalogue status, stack
//                      preview/export, stack inventory, app-data inventory. Gates the Settings "AppSec" tab.
//   governance.manage  write any of the above (replaces the fork's requiredPermission "catalog.write"
//                      on these routes; platform-roles.ts left for other callers, deletion deferred)
//   apps.read          list apps (directory: name, url, owner, status) and read an app's summary
//   apps.deploy        the session owner's grant checked by POST /sessions/:id/apps
//   apps.manage.own    take down / release an owner hold / manage data (secrets, approvals, restore)
//                      for apps the actor owns or whose owner team the actor belongs to
//   apps.manage.any    the same for every app, plus admin takedown/release, classification lock and
//                      restores on `restricted` apps
//
// control-plane routes/shared.ts: AUDITED_ALLOWED_PERMISSIONS += "governance.manage", "apps.manage.any", "apps.manage.own"
// control-plane routes/shared.ts RouteAuthorizationRequirement += { kind: "app"; operation: "manage"; appParam: string }
//   resolved in routing/app-admission.ts: load app by name; resolveScopedPermission("apps.manage");
//   own <=> actor.userId === owner.userId || actor ∈ members(owner.teamId)
// Custom role grants (data, not code): 0104 -> role_fork_catalog_editor gets governance.read, governance.manage;
//                                      0105 -> role_fork_catalog_editor gets apps.read, apps.deploy, apps.manage.own.
export {};
