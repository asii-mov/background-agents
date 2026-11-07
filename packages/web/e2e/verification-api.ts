import type { Page, Request, Route } from "@playwright/test";
import { analyticsDashboard } from "../src/lib/analytics.test-fixture";
import { permissionsForBuiltInRole } from "../../shared/src/rbac";

type PlatformRole = "member" | "editor" | "admin";
type NetworkPolicy =
  | { mode: "unrestricted" }
  | { mode: "blocked" }
  | { mode: "allowlist"; allowedCidrs?: string[]; allowedDomains?: string[] };

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface VerificationAutomationState {
  triggered: boolean;
}

export interface VerificationApiState {
  requests: RecordedRequest[];
  unexpectedRequests: RecordedRequest[];
  role: PlatformRole;
  staffRole: PlatformRole;
  gitGoverned: boolean;
  imported: boolean;
  mcpCredentialWrite: unknown | null;
  pipelines: Array<Record<string, unknown>>;
  riskProfiles: Array<Record<string, unknown>>;
  sandboxNetworkPolicy: NetworkPolicy;
  sandboxWriteError: string | null;
  automation: VerificationAutomationState;
}

const userId = "0123456789abcdef0123456789abcdef";
const commitSha = "49f948faa9258a0c61caceaf225e179651397431";
const sourceSha256 = "4a".repeat(32);
const revisionSha256 = "7b".repeat(32);
const now = 1_787_785_200_000;

const preview = {
  name: "playwright",
  source: {
    provider: "github",
    repoOwner: "openai",
    repoName: "skills",
    requestedRef: "main",
    resolvedRef: "main",
    commitSha,
    subdirectory: "skills/.curated/playwright",
    sourceSha256,
  },
  description: "Use Playwright to drive and inspect a local web application.",
  body: "# Playwright\n\nDrive the browser through accessible user actions.",
  license: "Apache-2.0",
  compatibility: null,
  metadata: {},
  revisionSha256,
  totalBytes: 116,
  files: [
    {
      path: "SKILL.md",
      content:
        "---\nname: playwright\ndescription: Use Playwright to drive a local web application.\n---\n",
      sizeBytes: 89,
      executable: false,
    },
  ],
  warnings: [],
  nameAvailable: true,
};

const importedSkill = {
  id: "skill_playwright",
  name: preview.name,
  description: preview.description,
  enabled: true,
  required: false,
  currentRevisionId: "skill_revision_playwright_1",
  revisionNumber: 1,
  revisionSha256,
  revisionCreatedBy: userId,
  creatorDisplayName: "Verifier Admin",
  lastEditorDisplayName: "Verifier Admin",
  revisionAuthorDisplayName: "Verifier Admin",
  assignments: [{ id: "assignment_global", type: "global" }],
  source: {
    ...preview.source,
    importedAt: now,
    revisionId: "skill_revision_playwright_1",
  },
  createdBy: userId,
  updatedBy: userId,
  sourceKind: "app",
  createdAt: now,
  updatedAt: now,
  body: preview.body,
  license: preview.license,
  compatibility: preview.compatibility,
  metadata: preview.metadata,
  files: [
    {
      path: "SKILL.md",
      content: preview.files[0].content,
      sha256: revisionSha256,
      sizeBytes: preview.files[0].sizeBytes,
      executable: false,
    },
  ],
};

const gitMcpServer = {
  id: "mcp_browser_verifier",
  revision: 7,
  name: "Browser verifier",
  type: "local",
  command: ["playwright-mcp"],
  hasEnv: true,
  hasHeaders: false,
  repoScopes: null,
  environmentScopes: null,
  lifecycle: "approved",
  createdBy: "security-platform",
  updatedBy: "security-platform",
  sourceKind: "git",
  sourcePath: "catalog.yaml",
  sourceCommitSha: commitSha,
  updatePolicy: { automatic: true, channel: "latest", range: "^0.0.1" },
  resolvedVersion: "0.0.42",
  resolvedIntegrity: `sha512-${"a".repeat(88)}`,
  enabled: true,
};

const emptyInbox = {
  categories: Object.fromEntries(
    ["needs_attention", "in_progress", "finished"].map((category) => [
      category,
      { items: [], hasMore: false, nextCursor: null },
    ])
  ),
};

const keyboardShortcuts = {
  shortcuts: {
    "send-prompt": { code: "Enter", primary: true, alt: false, shift: false },
    "open-command-menu": { code: "KeyK", primary: true, alt: false, shift: false },
    "new-session": { code: "KeyO", primary: true, alt: false, shift: true },
    "toggle-sidebar": { code: "Slash", primary: true, alt: false, shift: false },
  },
};

function requestBody(request: Request): unknown {
  const raw = request.postData();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function text(route: Route, body: string, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "text/plain; charset=utf-8", body });
}

function listSkills(state: VerificationApiState) {
  return {
    skills: state.imported ? [importedSkill] : [],
    hasMore: false as const,
    nextCursor: null,
  };
}

function governanceStatus(configured: boolean) {
  return configured
    ? {
        configured: true,
        source: {
          provider: "github",
          owner: "acme-security",
          name: "agent-governance",
          ref: "main",
          path: "catalog.yaml",
        },
        activeCommitSha: commitSha,
        lastAttemptedAt: now,
        lastSucceededAt: now,
        lastStatus: "succeeded",
      }
    : { configured: false, lastStatus: "idle" };
}

async function handleApi(route: Route, state: VerificationApiState): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const body = requestBody(request);
  const record = { method, path: `${url.pathname}${url.search}`, body };
  state.requests.push(record);

  if (method === "GET" && url.pathname === "/api/auth/get-session") {
    await json(route, {
      user: { id: userId, name: "Verifier Admin", email: "verifier@example.test", image: null },
      session: { id: "browser_verification", userId, expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/me/authorization") {
    const key = state.role === "admin" ? "administrator" : "member";
    const authorization =
      state.role === "editor"
        ? {
            userId,
            suspendedAt: null,
            role: { id: "role_fork_catalog_editor", key: null, name: "Catalog editor" },
            permissions: [
              ...permissionsForBuiltInRole("member"),
              "skills.manage",
              "mcp_servers.manage",
            ],
          }
        : {
            userId,
            suspendedAt: null,
            role: { id: `role_builtin_${key}`, key, name: key },
            permissions: permissionsForBuiltInRole(key),
          };
    await json(route, authorization);
    return;
  }
  if (
    method === "GET" &&
    ["/api/me/teams", "/api/teams", "/api/settings/teams"].includes(url.pathname)
  ) {
    await json(route, {
      teams: [],
      capabilities: { canListAllTeams: state.role === "admin" },
      requireTeamOnCreate: false,
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/memory-preferences") {
    await json(route, { includeMemories: true });
    return;
  }
  if (method === "GET" && url.pathname === "/api/keyboard-shortcuts") {
    await json(route, keyboardShortcuts);
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions/inbox") {
    await json(route, emptyInbox);
    return;
  }
  if (method === "GET" && url.pathname === "/api/repos") {
    await json(route, {
      repos: [
        {
          id: 1001,
          fullName: "openai/skills",
          owner: "openai",
          name: "skills",
          description: "Skills repository",
          private: false,
          defaultBranch: "main",
        },
        {
          id: 1002,
          fullName: "acme/identity-service",
          owner: "acme",
          name: "identity-service",
          description: "Identity service",
          private: true,
          defaultBranch: "main",
        },
      ],
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/environments") {
    await json(route, { environments: [], total: 0 });
    return;
  }
  if (method === "GET" && url.pathname === "/api/model-preferences") {
    await json(route, { enabledModels: ["openai/gpt-5.4"] });
    return;
  }
  if (method === "GET" && url.pathname === "/api/model-provider-accounts") {
    await json(route, { accounts: [] });
    return;
  }
  if (method === "GET" && url.pathname === "/api/model-provider-account-defaults") {
    await json(route, { defaults: [] });
    return;
  }
  if (method === "GET" && url.pathname === "/api/image-builds") {
    await json(route, { images: [], units: [], enabledRepos: [] });
    return;
  }
  if (method === "GET" && url.pathname === "/api/repos/openai/skills/branches") {
    await json(route, { branches: [{ name: "main" }] });
    return;
  }
  if (method === "POST" && url.pathname === "/api/skills/resolve-preview") {
    await json(route, { skills: [], totalBytes: 0, ignoredProfileSkillIds: [] });
    return;
  }
  if (method === "POST" && url.pathname === "/api/sessions") {
    await json(route, { sessionId: "session-verification", status: "active" }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/sessions/session-verification/prompt") {
    await json(route, { ok: true });
    return;
  }
  if (method === "POST" && url.pathname === "/api/sessions/session-verification/ws-token") {
    await json(route, { token: "loopback-session-token" });
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions/session-verification/sandbox-access") {
    await json(route, {
      codeServer: null,
      vnc: null,
      ttyd: { url: "http://127.0.0.1:3301/terminal", token: "loopback-terminal-token" },
    });
    return;
  }
  if (
    method === "GET" &&
    url.pathname === "/api/sessions/session-verification/participant-profiles"
  ) {
    await json(route, {
      profiles: {
        [userId]: {
          userId,
          displayName: "Verifier Admin",
          avatarUrl: null,
        },
      },
    });
    return;
  }
  if (
    method === "GET" &&
    url.pathname === "/api/sessions/session-verification/collaborator-candidates"
  ) {
    await json(route, []);
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions/session-verification/memories") {
    await json(route, {
      includePersonalMemories: true,
      directiveChars: 0,
      catalogChars: 0,
      estimatedTokens: 0,
      omittedCount: 0,
      items: [],
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions/session-verification/children") {
    await json(route, { children: [] });
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions/session-verification/skills") {
    await json(route, {
      manifestSha256: "9c".repeat(32),
      resolverVersion: 2,
      selection: { mode: "all" },
      resolvedAt: now,
      skills: [],
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions/session-verification/diff") {
    await json(route, {
      version: 1,
      current: {
        version: 1,
        revisionId: "revision-verification-1",
        triggerMessageId: "message-user-1",
        capturedAt: now + 3_500,
        repositories: [
          {
            status: "ready",
            position: 0,
            repoOwner: "acme",
            repoName: "identity-service",
            baseSha: "1".repeat(40),
            headSha: "2".repeat(40),
            truncated: false,
            omittedFileCount: 0,
            files: [
              {
                id: "identity-validator-ts",
                path: "src/identity/validator.ts",
                status: "modified",
                additions: 4,
                deletions: 1,
                renderState: "renderable",
              },
            ],
          },
        ],
      },
      lastError: null,
      unavailableReason: null,
    });
    return;
  }
  if (
    method === "GET" &&
    url.pathname ===
      "/api/sessions/session-verification/diff/revision-verification-1/files/identity-validator-ts"
  ) {
    await text(
      route,
      "diff --git a/src/identity/validator.ts b/src/identity/validator.ts\n" +
        "index 1111111..2222222 100644\n" +
        "--- a/src/identity/validator.ts\n" +
        "+++ b/src/identity/validator.ts\n" +
        "@@ -1,3 +1,4 @@\n" +
        "-export function validate(input: string) {\n" +
        "+export function validate(input: string): boolean {\n" +
        "+  if (!input.trim()) return false;\n" +
        "   return input.length > 0;\n" +
        " }\n"
    );
    return;
  }
  if (method === "PATCH" && url.pathname === "/api/sessions/session-verification/read-state") {
    await json(route, {
      sessionId: "session-verification",
      outcome: "marked_read",
      unread: false,
      latestMessageId: "message-assistant-live-1",
      version: 1,
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/secrets") {
    await json(route, { secrets: [] });
    return;
  }
  if (
    method === "GET" &&
    url.pathname === "/api/sessions" &&
    url.searchParams.get("status") === "archived"
  ) {
    await json(route, { sessions: [], hasMore: false });
    return;
  }
  if (method === "GET" && url.pathname === "/api/automations") {
    await json(route, {
      automations: [
        {
          id: "automation-security-review",
          harness: "opencode",
          userId,
          ownerTeamId: null,
          capabilities: { canRead: true, canManage: true, canTrigger: true },
          name: "Nightly identity security review",
          instructions: "Review identity changes for security regressions.",
          triggerType: "schedule",
          scheduleCron: "0 2 * * *",
          scheduleTz: "Europe/London",
          model: "openai/gpt-5.4",
          reasoningEffort: "high",
          enabled: true,
          nextRunAt: now + 86_400_000,
          consecutiveFailures: 0,
          createdBy: userId,
          createdAt: now - 86_400_000,
          updatedAt: now,
          deletedAt: null,
          eventType: null,
          triggerConfig: null,
          repositories: [
            {
              repoOwner: "acme",
              repoName: "identity-service",
              repoId: 1002,
              baseBranch: "main",
            },
          ],
          environmentIds: [],
          providerSelections: {},
          recentExecutions: state.automation.triggered
            ? [{ id: "invocation-manual-1", status: "completed", createdAt: now }]
            : [],
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/automations/automation-security-review/trigger") {
    state.automation.triggered = true;
    await json(route, { invocationId: "invocation-manual-1" }, 202);
    return;
  }
  if (method === "GET" && url.pathname === "/api/analytics/dashboard") {
    const snapshot = analyticsDashboard();
    const days = Number(url.searchParams.get("days"));
    if (days !== 7 && days !== 14 && days !== 30 && days !== 90)
      throw new Error("Unexpected analytics range");
    snapshot.window.days = days;
    snapshot.window.startAt = snapshot.window.endAt - days * 86_400_000;
    await json(route, snapshot);
    return;
  }
  if (method === "GET" && url.pathname === "/api/analytics/summary") {
    await json(route, {
      totalSessions: 128,
      activeUsers: 14,
      totalCost: 84.5,
      avgCost: 0.66,
      totalPrs: 37,
      statusBreakdown: {
        created: 2,
        active: 8,
        completed: 110,
        failed: 4,
        archived: 3,
        cancelled: 1,
      },
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/analytics/timeseries") {
    await json(route, { series: [{ date: "2026-08-26", groups: { completed: 12 } }] });
    return;
  }
  if (method === "GET" && url.pathname === "/api/analytics/breakdown") {
    const by = url.searchParams.get("by");
    await json(route, {
      entries: [
        {
          key: by === "user" ? userId : "acme/identity-service",
          displayName: by === "user" ? "Verifier Admin" : undefined,
          sessions: 42,
          completed: 38,
          failed: 2,
          cancelled: 1,
          cost: 24.25,
          prs: 13,
          messageCount: 220,
          avgDuration: 480_000,
          lastActive: now,
        },
      ],
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/analytics/pull-requests") {
    await json(route, {
      funnel: { created: 37, open: 9, draft: 3, merged: 21, closed: 4 },
      prSessionCost: 41.25,
      mergedInWindow: 21,
      avgTimeToMergeMs: 7_200_000,
      openInventory: { total: 9, avgAgeMs: 86_400_000 },
      timeseries: [{ date: "2026-08-26", created: 4, merged: 3 }],
      repos: [
        {
          key: "acme/identity-service",
          created: 15,
          merged: 11,
          closed: 1,
          avgTimeToMergeMs: 5_400_000,
        },
      ],
      sources: [{ source: "user", created: 37, merged: 21 }],
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/integration-settings/slack") {
    await json(route, { settings: null });
    return;
  }
  if (method === "GET" && url.pathname === "/api/integration-settings/slack/repos") {
    await json(route, { repos: [] });
    return;
  }
  if (method === "GET" && url.pathname === "/api/platform/me") {
    await json(route, { userId, role: state.role });
    return;
  }
  if (method === "GET" && url.pathname === "/api/platform/users") {
    await json(route, [
      {
        id: userId,
        displayName: "Verifier Admin",
        email: "verifier@example.test",
        role: state.role,
      },
      {
        id: "fedcba9876543210fedcba9876543210",
        displayName: "Staff Engineer",
        email: "staff@example.test",
        role: state.staffRole,
      },
    ]);
    return;
  }
  if (
    method === "PATCH" &&
    url.pathname === "/api/platform/users/fedcba9876543210fedcba9876543210/role"
  ) {
    const input = body as { role?: PlatformRole };
    if (state.role !== "admin") {
      await json(route, { error: "Platform administrator permission required" }, 403);
      return;
    }
    if (!input.role) {
      await json(route, { error: "Invalid platform role" }, 400);
      return;
    }
    state.staffRole = input.role;
    await json(route, {
      userId: "fedcba9876543210fedcba9876543210",
      role: input.role,
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/governance/catalog") {
    await json(route, governanceStatus(state.gitGoverned));
    return;
  }
  if (method === "GET" && url.pathname === "/api/skills") {
    await json(route, listSkills(state));
    return;
  }
  if (method === "GET" && url.pathname === "/api/skill-profiles") {
    await json(route, { profiles: [] });
    return;
  }
  if (method === "POST" && url.pathname === "/api/skills/import/preview") {
    await json(route, preview);
    return;
  }
  if (method === "POST" && url.pathname === "/api/skills/import") {
    state.imported = true;
    await json(route, { skill: importedSkill });
    return;
  }
  if (method === "GET" && url.pathname === `/api/skills/${importedSkill.id}`) {
    await json(route, { skill: importedSkill });
    return;
  }
  if (method === "GET" && url.pathname === "/api/mcp-servers") {
    await json(route, [gitMcpServer]);
    return;
  }
  if (method === "PUT" && url.pathname === `/api/mcp-servers/${gitMcpServer.id}/credentials`) {
    state.mcpCredentialWrite = body;
    await json(route, { ...gitMcpServer, hasEnv: true });
    return;
  }
  if (method === "GET" && url.pathname === "/api/approved-components") {
    await json(route, []);
    return;
  }
  if (method === "GET" && url.pathname === "/api/security-pipelines") {
    await json(route, state.pipelines);
    return;
  }
  if (method === "POST" && url.pathname === "/api/security-pipelines") {
    const input = body as Record<string, unknown>;
    const created = {
      id: "pipeline_appsec_baseline",
      revision: 1,
      ...input,
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    state.pipelines.push(created);
    await json(route, created, 201);
    return;
  }
  if (method === "GET" && url.pathname === "/api/repository-risk") {
    await json(route, state.riskProfiles);
    return;
  }
  if (method === "PUT" && url.pathname === "/api/repository-risk") {
    const input = body as Record<string, unknown>;
    const saved = { ...input, updatedBy: userId, updatedAt: now };
    state.riskProfiles = [saved];
    await json(route, saved);
    return;
  }
  if (method === "GET" && url.pathname === "/api/integration-settings/sandbox") {
    await json(route, {
      settings: {
        defaults: {
          networkPolicy: state.sandboxNetworkPolicy,
          tunnelPorts: [],
          terminalEnabled: false,
          maxConcurrentChildSessions: 5,
          maxTotalChildSessions: 15,
        },
        enabledRepos: [],
      },
    });
    return;
  }
  if (method === "PUT" && url.pathname === "/api/integration-settings/sandbox") {
    const input = body as { settings?: { defaults?: { networkPolicy?: NetworkPolicy } } };
    const requestedPolicy = input.settings?.defaults?.networkPolicy;
    if (
      state.role === "member" &&
      requestedPolicy !== undefined &&
      JSON.stringify(requestedPolicy) !== JSON.stringify(state.sandboxNetworkPolicy)
    ) {
      await json(route, { error: "Only platform editors and admins can change this policy." }, 403);
      return;
    }
    if (state.sandboxWriteError) {
      await json(route, { error: state.sandboxWriteError }, 422);
      return;
    }
    state.sandboxNetworkPolicy = input.settings?.defaults?.networkPolicy ?? {
      mode: "unrestricted",
    };
    await json(route, { ok: true });
    return;
  }

  state.unexpectedRequests.push(record);
  await json(route, { error: `Unhandled verification route: ${method} ${url.pathname}` }, 501);
}

export async function installVerificationApi(page: Page): Promise<VerificationApiState> {
  const state: VerificationApiState = {
    requests: [],
    unexpectedRequests: [],
    role: "admin",
    staffRole: "member",
    gitGoverned: false,
    imported: false,
    mcpCredentialWrite: null,
    pipelines: [],
    riskProfiles: [],
    sandboxNetworkPolicy: { mode: "unrestricted" },
    sandboxWriteError: null,
    automation: { triggered: false },
  };
  await page.route("**/api/**", (route) => handleApi(route, state));
  return state;
}
