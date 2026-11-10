import type { AppName, AppSummary, RedactedAppSummary } from "@open-inspect/shared/apps";
import type {
  AppDataMigrationView,
  AppDataOperationView,
  AppDataSummary,
  BindingName,
  DataClassification,
} from "@open-inspect/shared/types/app-data";

/** The blocked migration's sha256; the approval must carry exactly these bytes' hash. */
export const BLOCKED_MIGRATION_SHA256 = "5d".repeat(32);

export interface AppsVerificationState {
  apps: AppSummary[];
  data: Record<string, AppDataSummary>;
  operations: Record<string, AppDataOperationView[]>;
}

export type AppsResponse = { status: number; body: unknown } | null;

interface Viewer {
  userId: string;
  manageAny: boolean;
}

const binding = (name: string) => name as BindingName;

function summary(
  appName: string,
  classification: DataClassification,
  migrations: AppDataMigrationView[],
  now: number
): AppDataSummary {
  return {
    appName,
    classification,
    classificationSource: "manifest",
    resources: [
      {
        id: `res_${appName}_db`,
        stage: "production",
        binding: binding("DB"),
        kind: "d1",
        status: "ready",
        providerName: `app-${appName}-db`,
        sizeBytes: 2_400_000,
        retiredAt: null,
        purgeAfter: null,
        createdAt: now - 7 * 86_400_000,
      },
      {
        id: `res_${appName}_files`,
        stage: "production",
        binding: binding("FILES"),
        kind: "r2",
        status: "ready",
        providerName: `app-${appName}-files`,
        sizeBytes: null,
        retiredAt: null,
        purgeAfter: null,
        createdAt: now - 7 * 86_400_000,
      },
    ],
    migrations,
    secrets: [{ name: binding("API_KEY"), stage: "production", updatedAt: now - 86_400_000 }],
    declaredSecrets: [binding("API_KEY"), binding("WEBHOOK_TOKEN")],
    pendingApprovals: migrations.filter((migration) => migration.status === "blocked").length,
    pointInTimeRecoveryDays: 30,
  };
}

function applied(name: string, sha: string, now: number): AppDataMigrationView {
  return {
    binding: binding("DB"),
    name,
    sha256: sha,
    status: "applied",
    classification: "additive",
    statements: [],
    appliedAt: now - 86_400_000,
    approvedBy: null,
    error: null,
  };
}

function app(
  name: string,
  owner: { userId: string; displayName: string },
  now: number,
  overrides: Partial<AppSummary> = {}
): AppSummary {
  return {
    name: name as AppName,
    url: `https://${name}.apps.example.test`,
    status: "live",
    owner: { ...owner, teamId: null },
    backend: "workers",
    hasWorker: true,
    assetCount: 12,
    bundleBytes: 180_000,
    version: 3,
    lastDeployedAt: now - 2 * 3_600_000,
    lastSessionId: "session-verification",
    lastRepo: { owner: "acme", name },
    lastErrorReason: null,
    takedown: null,
    ...overrides,
  };
}

/** Three apps: the viewer's own, a colleague's live app, and a colleague's app under an admin hold. */
export function appsState(
  viewer: { userId: string; displayName: string },
  colleague: { userId: string; displayName: string }
): AppsVerificationState {
  const now = Date.now();
  return {
    apps: [
      app("expense-tracker", viewer, now),
      app("team-roster", colleague, now),
      app("legacy-wiki", colleague, now, {
        status: "taken_down",
        takedown: {
          kind: "admin_takedown",
          at: now - 3 * 86_400_000,
          byUserId: viewer.userId,
          reason: "Shared outside the company",
          cleanupComplete: true,
        },
      }),
    ],
    data: {
      "expense-tracker": summary(
        "expense-tracker",
        "confidential",
        [applied("0001_create-claims.sql", "1a".repeat(32), now)],
        now
      ),
      "team-roster": summary(
        "team-roster",
        "internal",
        [
          applied("0001_create-people.sql", "2b".repeat(32), now),
          {
            binding: binding("DB"),
            name: "0002_drop-legacy-notes.sql",
            sha256: BLOCKED_MIGRATION_SHA256,
            status: "blocked",
            classification: "destructive",
            statements: ["DROP TABLE legacy_notes"],
            appliedAt: null,
            approvedBy: null,
            error: null,
          },
        ],
        now
      ),
    },
    operations: {},
  };
}

function refuse(status: number, error: string, code?: string): AppsResponse {
  return { status, body: code ? { error, code } : { error } };
}

function record(
  state: AppsVerificationState,
  appName: string,
  viewer: Viewer,
  operation: Pick<AppDataOperationView, "kind" | "binding" | "detail">
): void {
  const ledger = (state.operations[appName] ??= []);
  ledger.unshift({
    id: `op_${appName}_${ledger.length + 1}`,
    result: "applied",
    stage: "production",
    actor: { kind: "user", userId: viewer.userId },
    occurredAt: Date.now(),
    ...operation,
  });
}

function dataRoute(
  state: AppsVerificationState,
  appName: string,
  rest: string,
  method: string,
  body: unknown,
  viewer: Viewer
): AppsResponse {
  const summary = state.data[appName];
  if (!summary) return refuse(404, "App not found");
  const input = (body ?? {}) as Record<string, unknown>;
  if (method === "GET" && rest === "") return { status: 200, body: summary };
  if (method === "GET" && rest === "/operations") {
    return { status: 200, body: { operations: state.operations[appName] ?? [], nextCursor: null } };
  }
  if (method === "POST" && rest === "/secrets") {
    const keys = Object.keys((input.secrets ?? {}) as Record<string, string>);
    const set = summary.secrets.filter((secret) => !keys.includes(secret.name));
    state.data[appName] = {
      ...summary,
      secrets: [
        ...set,
        ...keys.map((key) => ({
          name: binding(key),
          stage: "production" as const,
          updatedAt: Date.now(),
        })),
      ],
    };
    for (const key of keys) {
      record(state, appName, viewer, { kind: "secret_set", binding: binding(key), detail: {} });
    }
    return { status: 200, body: { keys } };
  }
  const secretKey = /^\/secrets\/([A-Z0-9_]+)$/.exec(rest)?.[1];
  if (method === "DELETE" && secretKey) {
    state.data[appName] = {
      ...summary,
      secrets: summary.secrets.filter((secret) => secret.name !== secretKey),
    };
    return { status: 200, body: { deleted: true } };
  }
  if (method === "POST" && rest === "/migrations/approve") {
    const migration = summary.migrations.find((candidate) => candidate.name === input.name);
    if (!migration || migration.status !== "blocked") {
      return refuse(409, "Not waiting for approval", "not_blocked");
    }
    if (migration.sha256 !== input.sha256) {
      return refuse(409, "Changed after review", "sha_mismatch");
    }
    const migrations = summary.migrations.map((candidate) =>
      candidate === migration
        ? { ...candidate, status: "approved" as const, approvedBy: viewer.userId }
        : candidate
    );
    state.data[appName] = {
      ...summary,
      migrations,
      pendingApprovals: migrations.filter((candidate) => candidate.status === "blocked").length,
    };
    record(state, appName, viewer, {
      kind: "approve_migration",
      binding: migration.binding,
      detail: { migration: migration.name },
    });
    return { status: 200, body: { status: "approved" } };
  }
  if (method === "POST" && rest === "/restore") {
    if (input.confirmBinding !== input.binding) {
      return refuse(
        400,
        "Type the binding name exactly to confirm the restore.",
        "confirm_mismatch"
      );
    }
    record(state, appName, viewer, {
      kind: "restore",
      binding: binding(String(input.binding)),
      detail: {},
    });
    return {
      status: 200,
      body: { bookmark: "bookmark-after", previousBookmark: "bookmark-before" },
    };
  }
  if (method === "PUT" && rest === "/classification") {
    if (!viewer.manageAny) {
      return refuse(403, "Only an administrator classifies app data", "requires_manage_any");
    }
    state.data[appName] = {
      ...summary,
      classification: input.classification as DataClassification,
      classificationSource: "admin",
    };
    return {
      status: 200,
      body: { classification: input.classification, classificationSource: "admin" },
    };
  }
  return null;
}

/** The control plane shows the session and repo that deployed an app only to those who manage it. */
function redact({
  lastSessionId: _session,
  lastRepo: _repo,
  ...entry
}: AppSummary): RedactedAppSummary {
  return entry;
}

/** The `/api/apps/**` surface; null when the request is not an apps route. */
export function appsRoute(
  state: AppsVerificationState,
  pathname: string,
  method: string,
  body: unknown,
  viewer: Viewer
): AppsResponse {
  if (pathname === "/api/apps" && method === "GET") {
    const apps = state.apps.map((app) =>
      viewer.manageAny || app.owner.userId === viewer.userId ? app : redact(app)
    );
    return { status: 200, body: { apps } };
  }
  const match = /^\/api\/apps\/([a-z0-9-]+)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const [, name, rest = ""] = match;
  const index = state.apps.findIndex((candidate) => candidate.name === name);
  const target = state.apps[index];
  if (!target) return refuse(404, "App not found");
  if (!viewer.manageAny && target.owner.userId !== viewer.userId) return refuse(403, "Forbidden");

  if (method === "POST" && rest === "/takedown") {
    const reason = String((body as { reason?: unknown } | null)?.reason ?? "").trim();
    if (!reason) return refuse(400, "A reason is required");
    const kind =
      viewer.manageAny && target.owner.userId !== viewer.userId
        ? ("admin_takedown" as const)
        : ("owner_unpublished" as const);
    const updated: AppSummary = {
      ...target,
      status: "taken_down",
      takedown: { kind, at: Date.now(), byUserId: viewer.userId, reason, cleanupComplete: true },
    };
    state.apps[index] = updated;
    return { status: 200, body: { app: updated, cleanupComplete: true } };
  }
  if (method === "POST" && rest === "/release-hold") {
    if (!target.takedown) return refuse(409, "The app is not taken down");
    if (target.takedown.kind === "admin_takedown" && !viewer.manageAny) {
      return refuse(403, "Only an administrator can release an administrator's hold");
    }
    const updated: AppSummary = { ...target, status: "live", takedown: null };
    state.apps[index] = updated;
    return { status: 200, body: { app: updated } };
  }
  if (rest === "/data" || rest.startsWith("/data/")) {
    return dataRoute(state, target.name, rest.slice("/data".length), method, body, viewer);
  }
  return null;
}
