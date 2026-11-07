/**
 * @typedef {{ file: string, title: string }} BrowserTest
 * @typedef {{ ui?: string[], bff?: string[], backend?: string[] }} SourceOwners
 * @typedef {{ kind: "browser-covered", test: BrowserTest, proofs?: string[] }} BrowserCoverage
 * @typedef {{ kind: "backend-only", proofs: string[], reason: string }} BackendCoverage
 * @typedef {{ kind: "uncovered", reason: string }} UncoveredCoverage
 * @typedef {BrowserCoverage | BackendCoverage | UncoveredCoverage} Coverage
 * @typedef {{
 *   id: string,
 *   title: string,
 *   settingsTab?: string,
 *   sources?: SourceOwners,
 *   coverage: Coverage,
 * }} Subfeature
 * @typedef {{
 *   id: string,
 *   title: string,
 *   aliases: string[],
 *   userRoutes: string[],
 *   owners: SourceOwners,
 *   subfeatures: Subfeature[],
 * }} Feature
 * @typedef {{ schemaVersion: 1, features: Feature[] }} FeatureDirectory
 */

const settingsNavigationTest = {
  file: "packages/web/e2e/settings-navigation.spec.ts",
  title: "settings.navigation-covers-ten-tabs",
};

/** @type {FeatureDirectory} */
export const openInspectFeatureDirectory = {
  schemaVersion: 1,
  features: [
    {
      id: "upstream-workspace",
      title: "Workspace discovery and administration",
      aliases: ["teams", "roles", "memories", "audit"],
      userRoutes: ["/sessions", "/teams", "/teams/:slug", "/settings/teams/:id"],
      owners: { ui: ["packages/web/src/components/settings/settings-registry.ts"] },
      subfeatures: [
        ...["audit-log", "memories", "shared-memories", "teams", "workspace"].map(
          (settingsTab) => ({
            id: `upstream-workspace.${settingsTab}`,
            title: settingsTab,
            settingsTab,
            coverage: {
              kind: "uncovered",
              reason:
                "New upstream surface. The retained fork browser suite does not exercise it yet.",
            },
          })
        ),
      ],
    },
    {
      id: "sessions",
      title: "Core sessions",
      aliases: ["home", "prompt", "agent", "websocket", "terminal", "diff", "pull request", "pr"],
      userRoutes: ["/", "/session/:id"],
      owners: {
        ui: [
          "packages/web/src/app/(app)/(sidebar)/page.tsx",
          "packages/web/src/app/(app)/(sidebar)/session/[id]/layout.tsx",
          "packages/web/src/app/(app)/(sidebar)/session/[id]/page.tsx",
          "packages/web/src/components/session-desktop-layout.tsx",
          "packages/web/src/components/session-timeline.tsx",
        ],
        bff: [
          "packages/web/src/app/api/sessions/route.ts",
          "packages/web/src/app/api/sessions/[id]/prompt/route.ts",
          "packages/web/src/app/api/sessions/[id]/ws-token/route.ts",
        ],
        backend: [
          "packages/control-plane/src/routes/sessions.ts",
          "packages/control-plane/src/routes/session-prompt.ts",
          "packages/control-plane/src/session/components.ts",
        ],
      },
      subfeatures: [
        {
          id: "sessions.core-workflow",
          title: "Create a session, send a prompt, and receive live output",
          sources: {
            ui: [
              "packages/web/src/hooks/use-warm-draft-session.ts",
              "packages/web/src/hooks/use-session-transport.ts",
            ],
            backend: [
              "packages/control-plane/src/routes/session-create.ts",
              "packages/control-plane/src/session/websocket-manager.ts",
            ],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/sessions.spec.ts",
              title: "sessions.core-workflow-terminal-diff-pr",
            },
            proofs: [
              "packages/control-plane/test/integration/session-lifecycle.test.ts",
              "packages/control-plane/test/integration/websocket-client.test.ts",
            ],
          },
        },
        {
          id: "sessions.terminal",
          title: "Open the sandbox terminal",
          sources: {
            ui: [
              "packages/web/src/components/terminal-panel.tsx",
              "packages/web/src/hooks/use-sandbox-access.ts",
            ],
            bff: ["packages/web/src/app/api/sessions/[id]/sandbox-access/route.ts"],
            backend: ["packages/control-plane/src/session/sandbox-access-reader.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/sessions.spec.ts",
              title: "sessions.core-workflow-terminal-diff-pr",
            },
            proofs: [
              "packages/control-plane/test/integration/session-snapshot.test.ts",
              "packages/control-plane/test/integration/websocket-sandbox.test.ts",
            ],
          },
        },
        {
          id: "sessions.diff",
          title: "Inspect changed files and patches",
          sources: {
            ui: [
              "packages/web/src/components/session-changes-panel.tsx",
              "packages/web/src/hooks/use-session-diffs.ts",
            ],
            bff: [
              "packages/web/src/app/api/sessions/[id]/diff/route.ts",
              "packages/web/src/app/api/sessions/[id]/diff/[revisionId]/files/[fileId]/route.ts",
            ],
            backend: ["packages/control-plane/src/routes/session-diffs.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/sessions.spec.ts",
              title: "sessions.core-workflow-terminal-diff-pr",
            },
            proofs: ["packages/control-plane/test/integration/session-diffs.test.ts"],
          },
        },
        {
          id: "sessions.pull-request",
          title: "Show the pull request created by the agent",
          sources: {
            ui: ["packages/web/src/components/session-right-sidebar.tsx"],
            bff: ["packages/web/src/app/api/sessions/[id]/pull-requests/refresh/route.ts"],
            backend: ["packages/control-plane/src/routes/session-pull-requests.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/sessions.spec.ts",
              title: "sessions.core-workflow-terminal-diff-pr",
            },
            proofs: [
              "packages/control-plane/test/integration/create-pr.test.ts",
              "packages/control-plane/test/integration/session-pull-requests.test.ts",
            ],
          },
        },
        {
          id: "sessions.follow-up-prompt",
          title: "Send a follow-up prompt from the session composer",
          sources: {
            ui: [
              "packages/web/src/components/session-prompt-composer.tsx",
              "packages/web/src/hooks/use-prompt-input.ts",
              "packages/web/src/hooks/use-session-socket.ts",
            ],
          },
          coverage: {
            kind: "uncovered",
            reason:
              "The loopback gateway does not yet acknowledge WebSocket prompts, queue changes, cancellation, or stop requests.",
          },
        },
        {
          id: "sessions.launch-transition",
          title: "Observe the sandbox warming, spawning, and ready transition",
          coverage: {
            kind: "uncovered",
            reason:
              "The deterministic snapshot starts with an already-ready sandbox and does not launch an external provider.",
          },
        },
      ],
    },
    {
      id: "automations",
      title: "Automations",
      aliases: ["scheduled agents", "cron", "trigger", "run history", "templates"],
      userRoutes: [
        "/automations",
        "/automations/:id",
        "/automations/:id/edit",
        "/automations/new",
        "/automations/templates",
      ],
      owners: {
        ui: [
          "packages/web/src/app/(app)/(sidebar)/automations/page.tsx",
          "packages/web/src/components/automations/automations-list.tsx",
        ],
        bff: ["packages/web/src/app/api/automations/route.ts"],
        backend: ["packages/control-plane/src/routes/automations.ts"],
      },
      subfeatures: [
        {
          id: "automations.trigger-and-history",
          title: "Trigger an automation and show its completed run",
          sources: {
            ui: [
              "packages/web/src/app/(app)/(sidebar)/automations/page.tsx",
              "packages/web/src/components/automations/automations-list.tsx",
              "packages/web/src/components/automations/execution-activity.tsx",
            ],
            bff: ["packages/web/src/app/api/automations/[id]/trigger/route.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/automations.spec.ts",
              title: "automations.trigger-seeded-workflow",
            },
            proofs: ["packages/control-plane/test/integration/automation-invocations.test.ts"],
          },
        },
        {
          id: "automations.create-and-edit",
          title: "Create and edit an automation",
          sources: {
            ui: [
              "packages/web/src/app/(app)/(sidebar)/automations/new/page.tsx",
              "packages/web/src/app/(app)/(sidebar)/automations/[id]/edit/page.tsx",
              "packages/web/src/components/automations/automation-form.tsx",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason: "The form has component and control-plane tests but no Playwright test.",
            proofs: [
              "packages/web/src/components/automations/automation-form.test.tsx",
              "packages/control-plane/test/integration/automation-authorization.test.ts",
            ],
          },
        },
        {
          id: "automations.templates",
          title: "Choose an automation template",
          sources: {
            ui: [
              "packages/web/src/app/(app)/(sidebar)/automations/templates/page.tsx",
              "packages/web/src/components/automations/template-gallery.tsx",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason: "The gallery has a component test but no Playwright test.",
            proofs: ["packages/web/src/components/automations/template-gallery.test.tsx"],
          },
        },
        {
          id: "automations.list-management",
          title: "Search, paginate, pause, resume, and delete automations",
          sources: {
            ui: [
              "packages/web/src/app/(app)/(sidebar)/automations/page.tsx",
              "packages/web/src/components/automations/automations-list.tsx",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason: "Component tests cover list management, but Playwright does not.",
            proofs: [
              "packages/web/src/app/(app)/(sidebar)/automations/page.test.tsx",
              "packages/web/src/components/automations/automations-list.test.tsx",
            ],
          },
        },
        {
          id: "automations.detail-history",
          title: "Inspect automation detail and invocation history",
          sources: {
            ui: [
              "packages/web/src/app/(app)/(sidebar)/automations/[id]/page.tsx",
              "packages/web/src/components/automations/run-history.tsx",
            ],
            bff: ["packages/web/src/app/api/automations/[id]/invocations/route.ts"],
          },
          coverage: {
            kind: "backend-only",
            reason: "Run history has component and integration proof but no Playwright test.",
            proofs: [
              "packages/web/src/components/automations/run-history.test.tsx",
              "packages/control-plane/test/integration/automation-invocations.test.ts",
            ],
          },
        },
        {
          id: "automations.orchestration",
          title: "Schedule, deliver events, and fan out automation runs",
          coverage: {
            kind: "backend-only",
            reason:
              "Control-plane integration tests use an injected session submitter, not Playwright.",
            proofs: [
              "packages/control-plane/test/integration/scheduler.test.ts",
              "packages/control-plane/test/integration/scheduler-events.test.ts",
            ],
          },
        },
        {
          id: "automations.sandbox-execution",
          title: "Execute an automation in a real sandbox",
          coverage: {
            kind: "uncovered",
            reason: "The deterministic verifier never launches an external sandbox provider.",
          },
        },
      ],
    },
    {
      id: "analytics",
      title: "Analytics",
      aliases: ["usage", "metrics", "outcomes", "cost", "pull request analytics"],
      userRoutes: ["/analytics"],
      owners: {
        ui: [
          "packages/web/src/app/(app)/(sidebar)/analytics/page.tsx",
          "packages/web/src/components/session-sidebar.tsx",
          "packages/web/src/hooks/use-analytics.ts",
          "packages/web/src/components/analytics",
        ],
        bff: [
          "packages/web/src/app/api/analytics/dashboard/route.ts",
          "packages/web/src/app/api/analytics/summary/route.ts",
          "packages/web/src/app/api/analytics/timeseries/route.ts",
          "packages/web/src/app/api/analytics/breakdown/route.ts",
          "packages/web/src/app/api/analytics/pull-requests/route.ts",
        ],
        backend: ["packages/control-plane/src/routes/analytics.ts"],
      },
      subfeatures: [
        {
          id: "analytics.dashboard",
          title: "Change range and inspect session and pull request outcomes",
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/analytics.spec.ts",
              title: "analytics.dashboard-range-and-outcomes",
            },
            proofs: [
              "packages/control-plane/test/integration/analytics.test.ts",
              "packages/control-plane/test/integration/pull-request-analytics.test.ts",
            ],
          },
        },
        {
          id: "analytics.user-table-sorting",
          title: "Sort the per-user analytics table",
          coverage: {
            kind: "backend-only",
            reason: "The page component proves sorting, but Playwright does not click a header.",
            proofs: ["packages/web/src/app/(app)/(sidebar)/analytics/page.test.tsx"],
          },
        },
        {
          id: "analytics.failed-load",
          title: "Show the analytics failed-load state",
          coverage: {
            kind: "backend-only",
            reason:
              "The page component proves the error state; Playwright uses successful fixtures.",
            proofs: ["packages/web/src/app/(app)/(sidebar)/analytics/page.test.tsx"],
          },
        },
      ],
    },
    {
      id: "integrations",
      title: "Integration configuration",
      aliases: ["Slack", "GitHub", "Linear", "code server", "VNC", "commit signing"],
      userRoutes: ["/settings/integrations/:id"],
      owners: {
        ui: [
          "packages/web/src/app/(app)/settings/integrations/[id]/page.tsx",
          "packages/web/src/components/settings/integrations/integration-settings-registry.tsx",
        ],
        bff: [
          "packages/web/src/app/api/integration-settings/[id]/route.ts",
          "packages/web/src/app/api/integration-settings/[id]/repos/route.ts",
          "packages/web/src/app/api/integration-settings/[id]/repos/[owner]/[name]/route.ts",
        ],
        backend: ["packages/control-plane/src/routes/integration-settings.ts"],
      },
      subfeatures: [
        {
          id: "integrations.slack-load",
          title: "Open Slack configuration and load empty global and repository settings",
          sources: {
            ui: [
              "packages/web/src/components/settings/integrations-settings.tsx",
              "packages/web/src/components/settings/integrations/slack-integration-settings.tsx",
            ],
            bff: [
              "packages/web/src/app/api/integration-settings/[id]/route.ts",
              "packages/web/src/app/api/integration-settings/[id]/repos/route.ts",
              "packages/web/src/app/api/integration-settings/[id]/repos/[owner]/[name]/route.ts",
            ],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/integrations.spec.ts",
              title: "integrations.open-slack-configuration",
            },
            proofs: [
              "packages/web/src/components/settings/integrations/slack-integration-settings.test.tsx",
              "packages/control-plane/src/db/integration-settings.test.ts",
            ],
          },
        },
        {
          id: "integrations.slack-management",
          title: "Save Slack defaults, routing rules, and repository overrides",
          sources: {
            ui: [
              "packages/web/src/components/settings/integrations/slack-integration-settings.tsx",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "Component and storage tests cover mutations and validation; Playwright only loads the empty configuration.",
            proofs: [
              "packages/web/src/components/settings/integrations/slack-integration-settings.test.tsx",
              "packages/control-plane/src/db/integration-settings.test.ts",
            ],
          },
        },
        {
          id: "integrations.slack-runtime-notification",
          title: "Apply Slack notification policy at runtime",
          coverage: {
            kind: "backend-only",
            reason:
              "Runtime notification delivery is not exercised by the loopback browser fixture.",
            proofs: [
              "packages/control-plane/src/routes/slack-notify.test.ts",
              "packages/control-plane/test/integration/slack-notify.test.ts",
            ],
          },
        },
        {
          id: "integrations.github",
          title: "Configure GitHub defaults, scope, repository overrides, and connection state",
          sources: {
            ui: [
              "packages/web/src/components/settings/integrations/github-integration-settings.tsx",
            ],
            bff: [
              "packages/web/src/app/api/integration-settings/[id]/route.ts",
              "packages/web/src/app/api/integration-settings/[id]/repos/route.ts",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason: "GitHub has component and control-plane tests but no Playwright test.",
            proofs: [
              "packages/web/src/components/settings/integrations/github-integration-settings.test.tsx",
              "packages/control-plane/test/integration/integration-settings.test.ts",
            ],
          },
        },
        {
          id: "integrations.linear",
          title: "Configure Linear defaults, scope, repository overrides, and connection state",
          sources: {
            ui: [
              "packages/web/src/components/settings/integrations/linear-integration-settings.tsx",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "Control-plane integration tests cover Linear settings; there is no component or browser test for its settings UI.",
            proofs: ["packages/control-plane/test/integration/integration-settings.test.ts"],
          },
        },
        {
          id: "integrations.remote-desktop",
          title: "Configure code-server and VNC defaults, scope, and repository overrides",
          sources: {
            ui: [
              "packages/web/src/components/settings/integrations/code-server-integration-settings.tsx",
              "packages/web/src/components/settings/integrations/vnc-integration-settings.tsx",
              "packages/web/src/components/settings/integrations/enablement-integration-settings.tsx",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "The shared enablement UI and control plane are tested, but Playwright opens neither provider.",
            proofs: [
              "packages/web/src/components/settings/integrations/enablement-integration-settings.test.tsx",
              "packages/control-plane/test/integration/integration-settings.test.ts",
            ],
          },
        },
        {
          id: "integrations.commit-signing",
          title: "Load, validate, enable, and disable Git commit signing",
          sources: {
            ui: ["packages/web/src/components/settings/integrations/commit-signing-settings.tsx"],
            bff: ["packages/web/src/app/api/commit-signing/route.ts"],
            backend: ["packages/control-plane/src/routes/commit-signing.ts"],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "Commit signing has component, BFF, and control-plane tests but no Playwright test.",
            proofs: [
              "packages/web/src/components/settings/integrations/commit-signing-settings.test.tsx",
              "packages/web/src/app/api/commit-signing/route.test.ts",
              "packages/control-plane/test/integration/commit-signing.test.ts",
            ],
          },
        },
        {
          id: "integrations.sandbox-detail",
          title: "Open the Sandbox integration detail route",
          coverage: {
            kind: "uncovered",
            reason:
              "The shared catalog exposes Sandbox, but the detail registry has no Sandbox component and renders a blank body.",
          },
        },
      ],
    },
    {
      id: "settings",
      title: "Settings",
      aliases: ["preferences", "governance", "configuration", "tabs"],
      userRoutes: ["/settings"],
      owners: {
        ui: [
          "packages/web/src/app/(app)/settings/page.tsx",
          "packages/web/src/components/settings/settings-nav.tsx",
        ],
      },
      subfeatures: [
        {
          id: "settings.secrets",
          title: "Open the Secrets tab and render its heading",
          settingsTab: "secrets",
          sources: {
            ui: ["packages/web/src/components/settings/secrets-settings.tsx"],
            bff: [
              "packages/web/src/app/api/secrets/route.ts",
              "packages/web/src/app/api/repos/[owner]/[name]/secrets/route.ts",
              "packages/web/src/app/api/repos/[owner]/[name]/secrets/[key]/route.ts",
            ],
            backend: ["packages/control-plane/src/routes/secrets.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: settingsNavigationTest,
            proofs: ["packages/control-plane/test/integration/global-secrets.test.ts"],
          },
        },
        {
          id: "settings.secrets-crud",
          title: "Create, update, and delete global and scoped secrets",
          coverage: {
            kind: "backend-only",
            reason: "Secret storage has integration proof; Playwright only opens the tab.",
            proofs: [
              "packages/control-plane/test/integration/global-secrets.test.ts",
              "packages/control-plane/test/integration/environment-secrets.test.ts",
            ],
          },
        },
        {
          id: "settings.environments",
          title: "Environments",
          settingsTab: "environments",
          sources: {
            ui: ["packages/web/src/components/settings/environments-settings.tsx"],
            bff: ["packages/web/src/app/api/environments/route.ts"],
            backend: ["packages/control-plane/src/routes/environments.ts"],
          },
          coverage: {
            kind: "backend-only",
            reason: "Environment behavior has lower-level coverage but no Playwright test.",
            proofs: ["packages/control-plane/test/integration/environments-routes.test.ts"],
          },
        },
        {
          id: "settings.models",
          title: "Open the Models tab and render its heading",
          settingsTab: "models",
          sources: {
            ui: ["packages/web/src/components/settings/models-settings.tsx"],
            bff: ["packages/web/src/app/api/model-preferences/route.ts"],
            backend: ["packages/control-plane/src/routes/model-preferences.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: settingsNavigationTest,
            proofs: ["packages/control-plane/test/integration/model-preferences.test.ts"],
          },
        },
        {
          id: "settings.model-preferences",
          title: "Change enabled model preferences",
          coverage: {
            kind: "backend-only",
            reason: "Model preferences have integration proof; Playwright only opens the tab.",
            proofs: ["packages/control-plane/test/integration/model-preferences.test.ts"],
          },
        },
        {
          id: "settings.provider-accounts",
          title: "Accounts",
          settingsTab: "provider-accounts",
          sources: {
            ui: ["packages/web/src/components/settings/provider-accounts-settings.tsx"],
            bff: ["packages/web/src/app/api/model-provider-accounts/route.ts"],
            backend: ["packages/control-plane/src/routes/model-provider-accounts.ts"],
          },
          coverage: {
            kind: "backend-only",
            reason: "Provider account behavior has lower-level coverage but no Playwright test.",
            proofs: ["packages/control-plane/test/integration/provider-account-routes.test.ts"],
          },
        },
        {
          id: "settings.images",
          title: "Images",
          settingsTab: "images",
          sources: {
            ui: ["packages/web/src/components/settings/images-settings.tsx"],
            bff: [
              "packages/web/src/app/api/image-builds/route.ts",
              "packages/web/src/app/api/image-builds/repo/[owner]/[name]/toggle/route.ts",
              "packages/web/src/app/api/image-builds/repo/[owner]/[name]/trigger/route.ts",
            ],
            backend: ["packages/control-plane/src/routes/image-builds.ts"],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "Image behavior is visible only for providers with repository-image support and has no Playwright test.",
            proofs: [
              "packages/web/src/components/settings/images-settings.test.tsx",
              "packages/control-plane/test/integration/image-builds.test.ts",
            ],
          },
        },
        {
          id: "settings.appearance",
          title: "Open the Appearance tab and render its heading",
          settingsTab: "appearance",
          sources: {
            ui: ["packages/web/src/components/settings/appearance-settings.tsx"],
          },
          coverage: { kind: "browser-covered", test: settingsNavigationTest },
        },
        {
          id: "settings.appearance-selection",
          title: "Change and persist the appearance selection",
          coverage: {
            kind: "uncovered",
            reason: "No executable test changes or reloads the selected appearance.",
          },
        },
        {
          id: "settings.keyboard-shortcuts",
          title: "Open the Keyboard tab and render its heading",
          settingsTab: "keyboard-shortcuts",
          sources: {
            ui: ["packages/web/src/components/settings/keyboard-shortcuts-settings.tsx"],
            bff: ["packages/web/src/app/api/keyboard-shortcuts/route.ts"],
            backend: ["packages/control-plane/src/routes/keyboard-shortcuts.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: settingsNavigationTest,
            proofs: ["packages/control-plane/test/integration/keyboard-shortcuts.test.ts"],
          },
        },
        {
          id: "settings.keyboard-shortcut-updates",
          title: "Change and persist keyboard shortcuts",
          coverage: {
            kind: "backend-only",
            reason:
              "Keyboard shortcut persistence has integration proof; Playwright only opens the tab.",
            proofs: ["packages/control-plane/test/integration/keyboard-shortcuts.test.ts"],
          },
        },
        {
          id: "settings.data-controls",
          title: "Open the Data Controls tab and render its heading",
          settingsTab: "data-controls",
          sources: {
            ui: ["packages/web/src/components/settings/data-controls-settings.tsx"],
            bff: [
              "packages/web/src/app/api/sessions/route.ts",
              "packages/web/src/app/api/sessions/[id]/unarchive/route.ts",
            ],
            backend: ["packages/control-plane/src/routes/session-index.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: settingsNavigationTest,
            proofs: ["packages/web/src/components/settings/data-controls-settings.test.tsx"],
          },
        },
        {
          id: "settings.data-controls-unarchive",
          title: "List, paginate, and unarchive archived sessions",
          coverage: {
            kind: "backend-only",
            reason:
              "The component and session-index tests cover the lifecycle; Playwright only opens the tab.",
            proofs: [
              "packages/web/src/components/settings/data-controls-settings.test.tsx",
              "packages/control-plane/src/routes/session-index.test.ts",
            ],
          },
        },
        {
          id: "settings.sandbox",
          title: "Save a global TLS-domain and CIDR egress allowlist",
          settingsTab: "sandbox",
          sources: {
            ui: ["packages/web/src/components/settings/sandbox-settings.tsx"],
            bff: ["packages/web/src/app/api/integration-settings/[id]/route.ts"],
            backend: ["packages/control-plane/src/routes/integration-settings.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-governance.spec.ts",
              title: "saves a supported outbound allowlist",
            },
            proofs: ["packages/web/src/components/settings/sandbox-settings.test.tsx"],
          },
        },
        {
          id: "settings.sandbox-save-rejection",
          title: "Show a rejected policy save without weakening the stored policy",
          sources: {
            ui: ["packages/web/src/components/settings/sandbox-settings.tsx"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-governance.spec.ts",
              title: "preserves the existing sandbox policy when a save is rejected",
            },
          },
        },
        {
          id: "settings.sandbox-member-denial",
          title: "Withhold network controls from members without integration permission",
          sources: {
            ui: ["packages/web/src/components/settings/sandbox-settings.tsx"],
            backend: ["packages/control-plane/src/routes/integration-settings.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-governance.spec.ts",
              title: "withholds sandbox management from a member without integration permission",
            },
            proofs: ["packages/control-plane/test/integration/integration-settings.test.ts"],
          },
        },
        {
          id: "settings.sandbox-validation",
          title: "Normalize policies and fail closed on corrupt persisted policy",
          sources: {
            backend: ["packages/control-plane/src/sandbox/settings.ts"],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "Validation and fail-closed parsing are control-plane boundaries, not browser behavior.",
            proofs: ["packages/control-plane/src/sandbox/settings.test.ts"],
          },
        },
        {
          id: "settings.sandbox-runtime-enforcement",
          title: "Resolve network policy and reject unsupported providers at sandbox launch",
          sources: {
            backend: [
              "packages/control-plane/src/sandbox/lifecycle/launch-context.ts",
              "packages/control-plane/src/sandbox/providers/modal-provider.ts",
              "packages/modal-infra/src/sandbox/launch_policy.py",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "The loopback verifier never launches Modal or another external sandbox provider.",
            proofs: [
              "packages/control-plane/src/sandbox/lifecycle/governance.test.ts",
              "packages/modal-infra/tests/test_launch_policy.py",
              "packages/modal-infra/tests/test_sandbox_launch.py",
            ],
          },
        },
        {
          id: "settings.sandbox-scoped-network-policy",
          title: "Persist repository and environment network-policy overrides",
          sources: {
            bff: [
              "packages/web/src/app/api/integration-settings/[id]/repos/[owner]/[name]/route.ts",
              "packages/web/src/app/api/integration-settings/[id]/environments/[environmentId]/route.ts",
            ],
            backend: ["packages/control-plane/src/db/integration-settings.ts"],
          },
          coverage: {
            kind: "uncovered",
            reason: "No test round-trips repository- or environment-scoped network policy.",
          },
        },
        {
          id: "settings.sandbox-other-controls",
          title: "Configure ports, terminal, child limits, resources, and timeouts",
          sources: {
            ui: ["packages/web/src/components/settings/sandbox-settings.tsx"],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "The component test covers these controls; Playwright edits only network policy.",
            proofs: ["packages/web/src/components/settings/sandbox-settings.test.tsx"],
          },
        },
        {
          id: "settings.scm",
          title: "SCM Settings",
          settingsTab: "scm",
          sources: {
            ui: ["packages/web/src/components/settings/scm-settings.tsx"],
            bff: [
              "packages/web/src/app/api/scm-settings/route.ts",
              "packages/web/src/app/api/scm-settings/repos/route.ts",
              "packages/web/src/app/api/scm-settings/repos/[owner]/[name]/route.ts",
            ],
            backend: ["packages/control-plane/src/routes/scm-settings.ts"],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "SCM settings have component and control-plane coverage but no Playwright test.",
            proofs: [
              "packages/web/src/components/settings/scm-settings.test.tsx",
              "packages/control-plane/src/routes/scm-settings.test.ts",
            ],
          },
        },
        {
          id: "settings.integrations",
          title: "Open the Integrations tab and render its heading",
          settingsTab: "integrations",
          sources: {
            ui: ["packages/web/src/components/settings/integrations-settings.tsx"],
          },
          coverage: { kind: "browser-covered", test: settingsNavigationTest },
        },
        {
          id: "settings.skills",
          title: "Import a repository Skill after reviewing immutable provenance",
          settingsTab: "skills",
          sources: {
            ui: [
              "packages/web/src/components/settings/skills-settings/skills-catalog.tsx",
              "packages/web/src/components/settings/skills-settings/skill-import.tsx",
              "packages/web/src/components/settings/skills-settings/skill-import-review.tsx",
              "packages/web/src/components/settings/skills-settings/skill-editor.tsx",
            ],
            bff: [
              "packages/web/src/app/api/skills/route.ts",
              "packages/web/src/app/api/skills/[id]/route.ts",
              "packages/web/src/app/api/skills/import/preview/route.ts",
              "packages/web/src/app/api/skills/import/route.ts",
            ],
            backend: [
              "packages/control-plane/src/routes/skills.ts",
              "packages/control-plane/src/skills/git-import.ts",
            ],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-governance.spec.ts",
              title: "imports the OpenAI Playwright skill after reviewing moving-ref provenance",
            },
            proofs: [
              "packages/control-plane/test/integration/skill-imports.test.ts",
              "packages/control-plane/src/skills/git-import.test.ts",
            ],
          },
        },
        {
          id: "settings.skills-manual-management",
          title: "Create, validate, edit, enable, disable, and delete shared Skills",
          sources: {
            ui: [
              "packages/web/src/components/settings/skills-settings/skills-catalog.tsx",
              "packages/web/src/components/settings/skills-settings/skill-editor.tsx",
              "packages/web/src/components/settings/skills-settings/skill-files.tsx",
              "packages/web/src/components/settings/skills-settings/skill-assignments.tsx",
            ],
            bff: [
              "packages/web/src/app/api/skills/preview/route.ts",
              "packages/web/src/app/api/skills/[id]/route.ts",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "Component and integration tests cover manual catalog management; Playwright imports one repository Skill.",
            proofs: [
              "packages/web/src/components/settings/skills-settings/skills-catalog.test.tsx",
              "packages/control-plane/test/integration/managed-skills.test.ts",
            ],
          },
        },
        {
          id: "settings.skills-reimport",
          title: "Preview and confirm a new revision from recorded repository provenance",
          sources: {
            ui: ["packages/web/src/components/settings/skills-settings/skill-reimport.tsx"],
            bff: [
              "packages/web/src/app/api/skills/[id]/reimport/preview/route.ts",
              "packages/web/src/app/api/skills/[id]/reimport/route.ts",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason: "Reimport and preview-race behavior are not driven in the browser suite.",
            proofs: [
              "packages/web/src/components/settings/skills-settings/skill-import-preview-race.test.tsx",
              "packages/control-plane/test/integration/skill-imports.test.ts",
            ],
          },
        },
        {
          id: "settings.skills-git-read-only",
          title: "Reject app-managed catalog writes while Git governance is configured",
          coverage: {
            kind: "backend-only",
            reason: "The control plane enforces this boundary before parsing or storage.",
            proofs: ["packages/control-plane/src/routes/skills.git-governance.test.ts"],
          },
        },
        {
          id: "settings.skill-profiles",
          title: "Create and maintain personal Skill profiles",
          sources: {
            ui: ["packages/web/src/components/settings/skills-settings/profiles.tsx"],
            bff: [
              "packages/web/src/app/api/skill-profiles/route.ts",
              "packages/web/src/app/api/skill-profiles/[id]/route.ts",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason: "Profiles have component and integration tests but no Playwright test.",
            proofs: [
              "packages/web/src/components/settings/skills-settings/profiles.test.tsx",
              "packages/control-plane/test/integration/managed-skills.test.ts",
            ],
          },
        },
        {
          id: "settings.mcp-servers",
          title: "Inspect Git-governed MCP metadata and rotate local credentials as an editor",
          settingsTab: "mcp-servers",
          sources: {
            ui: [
              "packages/web/src/components/settings/mcp-servers-settings.tsx",
              "packages/web/src/hooks/use-mcp-servers.ts",
            ],
            bff: [
              "packages/web/src/app/api/mcp-servers/route.ts",
              "packages/web/src/app/api/mcp-servers/[id]/route.ts",
              "packages/web/src/app/api/mcp-servers/[id]/credentials/route.ts",
            ],
            backend: ["packages/control-plane/src/routes/mcp-servers.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-governance.spec.ts",
              title: "keeps Git-governed MCP metadata read-only and rotates credentials",
            },
            proofs: [
              "packages/web/src/components/settings/mcp-servers-settings.test.tsx",
              "packages/control-plane/test/integration/git-governance-catalog.test.ts",
            ],
          },
        },
        {
          id: "settings.mcp-member-read-only",
          title: "Show Git-governed MCP metadata to members without editable row controls",
          sources: {
            ui: ["packages/web/src/components/settings/mcp-servers-settings.tsx"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-governance.spec.ts",
              title: "shows Git-governed MCP metadata to members without editable row controls",
            },
            proofs: ["packages/control-plane/src/router.policy.test.ts"],
          },
        },
        {
          id: "settings.mcp-app-managed",
          title:
            "Create, edit, scope by repository or environment, enable, disable, and delete app-managed MCP entries",
          sources: {
            ui: ["packages/web/src/components/settings/mcp-servers-settings.tsx"],
            bff: [
              "packages/web/src/app/api/mcp-servers/route.ts",
              "packages/web/src/app/api/mcp-servers/[id]/route.ts",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "App-managed forms and routes have lower-level tests but no Playwright test. Manual local entries remain development-only without a Git-built artifact.",
            proofs: [
              "packages/web/src/components/settings/mcp-servers-settings.test.tsx",
              "packages/control-plane/test/integration/mcp-servers.test.ts",
            ],
          },
        },
        {
          id: "settings.mcp-git-artifacts",
          title: "Resolve and materialize exact artifacts for Git-governed local npm MCPs",
          sources: {
            backend: [
              "packages/control-plane/src/governance/reconciler.ts",
              "packages/control-plane/src/governance/npm-resolver.ts",
              "packages/control-plane/src/governance/mcp-artifact-builder.ts",
              "packages/control-plane/src/db/mcp-servers.ts",
              "packages/control-plane/src/routes/session-mcp-artifacts.ts",
              "packages/sandbox-runtime/src/sandbox_runtime/opencode_server.py",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "The browser fixture does not resolve npm metadata, build an artifact, pin a real session manifest, or materialize a sandbox runtime.",
            proofs: [
              "packages/control-plane/src/governance/npm-resolver.test.ts",
              "packages/control-plane/src/governance/mcp-artifact-builder.test.ts",
              "packages/control-plane/test/integration/git-governance-catalog.test.ts",
              "packages/control-plane/src/routes/session-mcp-artifacts.test.ts",
              "packages/sandbox-runtime/tests/test_mcp.py",
            ],
          },
        },
        {
          id: "settings.mcp-remote",
          title: "Configure approved remote HTTPS MCPs and rotate header credentials",
          coverage: {
            kind: "backend-only",
            reason:
              "Remote MCPs use URL and header configuration without local artifacts; only the component and control-plane tiers exercise that branch.",
            proofs: [
              "packages/web/src/components/settings/mcp-servers-settings.test.tsx",
              "packages/control-plane/test/integration/mcp-servers.test.ts",
            ],
          },
        },
        {
          id: "settings.mcp-sync-failure",
          title: "Retain the last-good MCP catalog when Git reconciliation fails",
          coverage: {
            kind: "backend-only",
            reason:
              "Last-good retention is integration-tested, but its Settings banner is not browser-tested.",
            proofs: ["packages/control-plane/test/integration/git-governance-catalog.test.ts"],
          },
        },
        {
          id: "settings.appsec",
          title:
            "Role assignment, pipeline creation, and repository criticality for administrators",
          settingsTab: "appsec",
          sources: {
            ui: [
              "packages/web/src/components/settings/appsec-governance-settings.tsx",
              "packages/web/src/components/settings/approved-components-settings.tsx",
              "packages/web/src/components/settings/governance-api.ts",
            ],
            bff: [
              "packages/web/src/app/api/security-pipelines/route.ts",
              "packages/web/src/app/api/security-pipelines/[id]/route.ts",
              "packages/web/src/app/api/repository-risk/route.ts",
              "packages/web/src/app/api/approved-components/route.ts",
              "packages/web/src/app/api/approved-components/[id]/route.ts",
              "packages/web/src/app/api/approved-components/[id]/consumers/route.ts",
              "packages/web/src/app/api/platform/me/route.ts",
              "packages/web/src/app/api/platform/users/route.ts",
              "packages/web/src/app/api/platform/users/[userId]/role/route.ts",
            ],
            backend: [
              "packages/control-plane/src/routes/security-pipelines.ts",
              "packages/control-plane/src/routes/repository-risk.ts",
              "packages/control-plane/src/routes/approved-components.ts",
              "packages/control-plane/src/routes/platform-users.ts",
            ],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-governance.spec.ts",
              title:
                "lets an administrator assign a role, create a pipeline, and save repository criticality",
            },
            proofs: [
              "packages/control-plane/src/router.policy.test.ts",
              "packages/control-plane/src/db/platform-roles.test.ts",
              "packages/control-plane/test/integration/security-pipelines.test.ts",
            ],
          },
        },
        {
          id: "settings.appsec-member-visibility",
          title: "Hide the AppSec tab and every governance read from members",
          sources: {
            ui: ["packages/web/src/components/settings/settings-registry.ts"],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-governance.spec.ts",
              title: "gives members no AppSec entry and no governance data from a direct link",
            },
            proofs: [
              "packages/web/src/components/settings/settings-registry.test.ts",
              "packages/control-plane/test/integration/governance-routes.test.ts",
            ],
          },
        },
        {
          id: "settings.appsec-stack-policy",
          title:
            "Grade technologies per category, switch advise or block, and preview what agents are told",
          sources: {
            ui: [
              "packages/web/src/components/settings/approved-components-settings.tsx",
              "packages/web/src/components/settings/approved-components-model.ts",
            ],
            bff: [
              "packages/web/src/app/api/component-categories/route.ts",
              "packages/web/src/app/api/component-categories/[id]/route.ts",
              "packages/web/src/app/api/stack-policy/preview/route.ts",
              "packages/web/src/app/api/stack-policy/export/route.ts",
            ],
            backend: [
              "packages/control-plane/src/routes/approved-components.ts",
              "packages/control-plane/src/routes/stack-policy.ts",
              "packages/control-plane/src/stack-policy/compile.ts",
            ],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-stack-policy.spec.ts",
              title:
                "lets an administrator flip web frontend to block and see what agents are told change",
            },
            proofs: [
              "packages/web/src/components/settings/approved-components-settings.test.tsx",
              "packages/web/src/components/settings/approved-components-model.test.ts",
              "packages/web/src/app/api/stack-policy/routes.test.ts",
              "packages/control-plane/test/integration/governance-routes.test.ts",
            ],
          },
        },
        {
          id: "settings.appsec-stack-adoption",
          title: "Track stack adoption per category and repository, and inventory app data",
          sources: {
            ui: ["packages/web/src/components/settings/stack-adoption-settings.tsx"],
            bff: [
              "packages/web/src/app/api/stack-inventory/route.ts",
              "packages/web/src/app/api/stack-inventory/rollup/route.ts",
              "packages/web/src/app/api/app-data/inventory/route.ts",
            ],
            backend: [
              "packages/control-plane/src/routes/stack-policy.ts",
              "packages/control-plane/src/routes/app-data.ts",
            ],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-stack-policy.spec.ts",
              title: "shows an administrator how repositories follow the standards",
            },
            proofs: ["packages/web/src/components/settings/stack-adoption-settings.test.tsx"],
          },
        },
        {
          id: "sessions.required-skills-hidden",
          title: "Keep required governance skills out of the composer, selector and sidebar",
          sources: {
            ui: [
              "packages/web/src/components/prompt-skill-autocomplete.tsx",
              "packages/web/src/components/session-skill-selector.tsx",
              "packages/web/src/components/sidebar/managed-skills-section.tsx",
            ],
          },
          coverage: {
            kind: "browser-covered",
            test: {
              file: "packages/web/e2e/settings-stack-policy.spec.ts",
              title: "keeps required governance skills out of a member's composer and sidebar",
            },
            proofs: [
              "packages/web/src/components/prompt-skill-autocomplete.test.tsx",
              "packages/web/src/components/session-skill-selector.test.tsx",
              "packages/web/src/components/sidebar/managed-skills-section.test.tsx",
            ],
          },
        },
        {
          id: "settings.appsec-pipeline-management",
          title: "Edit, scope, enable, and configure blocking or report-only pipelines",
          sources: {
            ui: ["packages/web/src/components/settings/appsec-governance-settings.tsx"],
            bff: ["packages/web/src/app/api/security-pipelines/[id]/route.ts"],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "Playwright creates only a global pipeline; the integration test covers updates and scope resolution.",
            proofs: ["packages/control-plane/test/integration/security-pipelines.test.ts"],
          },
        },
        {
          id: "settings.appsec-pipeline-delete",
          title: "Delete a managed verification pipeline",
          coverage: {
            kind: "uncovered",
            reason:
              "The UI and route exist, but no executable test was found for pipeline deletion.",
          },
        },
        {
          id: "settings.appsec-runtime-pipelines",
          title: "Run post-generation checks, remediate failures, and block completion or pushes",
          sources: {
            backend: [
              "packages/control-plane/src/sandbox/lifecycle/manager.ts",
              "packages/sandbox-runtime/src/sandbox_runtime/security_pipeline.py",
              "packages/sandbox-runtime/src/sandbox_runtime/bridge.py",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "The browser fixture records pipeline definitions but never executes a sandbox.",
            proofs: [
              "packages/control-plane/src/sandbox/lifecycle/governance.test.ts",
              "packages/sandbox-runtime/tests/test_security_pipeline.py",
              "packages/sandbox-runtime/tests/test_bridge_sse.py",
              "packages/sandbox-runtime/tests/test_push_operation.py",
            ],
          },
        },
        {
          id: "settings.appsec-approved-components",
          title: "Manage approved components and track their consumers",
          sources: {
            ui: ["packages/web/src/components/settings/approved-components-settings.tsx"],
            backend: [
              "packages/control-plane/src/routes/approved-components.ts",
              "packages/sandbox-runtime/src/sandbox_runtime/tools/approved-components.js",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "Playwright renders the seeded catalogue, but creating and editing components is covered only by component and control-plane tests.",
            proofs: [
              "packages/web/src/components/settings/approved-components-settings.test.tsx",
              "packages/control-plane/test/integration/approved-components.test.ts",
              "packages/sandbox-runtime/tests/test_approved_components_tool.py",
            ],
          },
        },
        {
          id: "settings.appsec-risk-enforcement",
          title: "Force high-risk GitHub changes to a draft pull request",
          sources: {
            backend: [
              "packages/control-plane/src/risk/change-risk.ts",
              "packages/control-plane/src/session/http/handlers/pull-request.handler.ts",
              "packages/control-plane/src/session/pull-request-service.ts",
            ],
          },
          coverage: {
            kind: "backend-only",
            reason:
              "Playwright saves criticality but does not exercise the GitHub-only PR risk gate.",
            proofs: [
              "packages/control-plane/src/risk/change-risk.test.ts",
              "packages/control-plane/src/session/http/handlers/pull-request.handler.test.ts",
              "packages/control-plane/src/session/pull-request-service.per-branch.test.ts",
            ],
          },
        },
        {
          id: "settings.appsec-editor-visibility",
          title: "Show catalog controls to editors while hiding role management",
          coverage: {
            kind: "uncovered",
            reason: "No browser or component test renders AppSec as an editor.",
          },
        },
        {
          id: "settings.appsec-bootstrap-roles",
          title: "Apply configured role overrides to verified identities",
          coverage: {
            kind: "backend-only",
            reason: "Configured role overrides are covered only by the role-store test.",
            proofs: ["packages/control-plane/src/db/platform-roles.test.ts"],
          },
        },
      ],
    },
  ],
};
