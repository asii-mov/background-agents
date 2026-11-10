// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { permissionsForBuiltInRole, type PermissionId } from "@open-inspect/shared/rbac";
import type { AppName, AppSummary, RedactedAppSummary } from "@open-inspect/shared/apps";
import type {
  AppDataOperationView,
  AppDataSummary,
  BindingName,
} from "@open-inspect/shared/types/app-data";
import { AppsSettings } from "./apps-settings";

expect.extend(matchers);

const ALICE = "user_alice";
const BOB = "user_bob";
const SHA = "3f".repeat(32);

const viewer = vi.hoisted(() => ({
  userId: "user_alice",
  permissions: [] as string[],
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    authorization: { userId: viewer.userId, permissions: viewer.permissions },
    hasPermission: (permission: string) => viewer.permissions.includes(permission),
  }),
}));

function app(name: string, owner: string, overrides: Partial<AppSummary> = {}): AppSummary {
  return {
    name: name as AppName,
    url: `https://${name}.apps.example.com`,
    status: "live",
    owner: {
      userId: owner,
      displayName: owner === ALICE ? "Alice Example" : "Bob Example",
      teamId: null,
    },
    backend: "workers",
    hasWorker: true,
    assetCount: 3,
    bundleBytes: 2048,
    version: 2,
    lastDeployedAt: Date.now() - 3_600_000,
    lastSessionId: "session_1",
    lastRepo: { owner: "acme", name: name },
    lastErrorReason: null,
    takedown: null,
    ...overrides,
  };
}

/** Another owner's app as the control plane shows it to someone who cannot manage it. */
function redacted(name: string, owner: string): RedactedAppSummary {
  const { lastSessionId: _session, lastRepo: _repo, ...entry } = app(name, owner);
  return entry;
}

function summary(overrides: Partial<AppDataSummary> = {}): AppDataSummary {
  return {
    appName: "expenses",
    classification: "confidential",
    classificationSource: "manifest",
    resources: [
      {
        id: "res_db",
        stage: "production",
        binding: "DB" as BindingName,
        kind: "d1",
        status: "ready",
        providerName: "app-expenses-db",
        sizeBytes: 1_500_000,
        retiredAt: null,
        purgeAfter: null,
        createdAt: 1,
      },
    ],
    migrations: [
      {
        binding: "DB" as BindingName,
        name: "0001_create-claims.sql",
        sha256: "aa".repeat(32),
        status: "applied",
        classification: "additive",
        statements: [],
        appliedAt: 1,
        approvedBy: null,
        error: null,
      },
      {
        binding: "DB" as BindingName,
        name: "0002_drop-notes.sql",
        sha256: SHA,
        status: "blocked",
        classification: "destructive",
        statements: ["DROP TABLE notes"],
        appliedAt: null,
        approvedBy: null,
        error: null,
      },
    ],
    secrets: [{ name: "API_KEY" as BindingName, stage: "production", updatedAt: Date.now() }],
    declaredSecrets: ["API_KEY", "WEBHOOK_TOKEN"] as BindingName[],
    pendingApprovals: 1,
    pointInTimeRecoveryDays: 30,
    ...overrides,
  };
}

function operation(id: string, kind: AppDataOperationView["kind"]): AppDataOperationView {
  return {
    id,
    kind,
    result: "applied",
    stage: "production",
    binding: "DB" as BindingName,
    actor: { kind: "user", userId: ALICE },
    detail: {},
    occurredAt: Date.now(),
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, () => Response> = {};

function serve(table: Record<string, () => Response>) {
  routes = table;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const handler = routes[`${method} ${path}`];
      if (!handler) throw new Error(`Unexpected request ${method} ${path}`);
      return handler();
    })
  );
}

function grant(role: "member" | "administrator") {
  viewer.permissions = permissionsForBuiltInRole(role) as PermissionId[];
}

function renderPanel() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AppsSettings />
    </SWRConfig>
  );
}

async function appRow(name: string) {
  return screen.findByRole("listitem", { name });
}

const OPERATIONS = "GET /api/apps/expenses/data/operations?limit=20";

beforeEach(() => {
  calls = [];
  viewer.userId = ALICE;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AppsSettings as a member", () => {
  beforeEach(() => grant("member"));

  it("offers actions on the member's own app only", async () => {
    serve({
      "GET /api/apps": () => response({ apps: [app("expenses", ALICE), redacted("roster", BOB)] }),
    });
    renderPanel();

    const own = await appRow("expenses");
    expect(
      within(screen.getByRole("region", { name: "Your apps" })).getByRole("listitem", {
        name: "expenses",
      })
    ).toBe(own);
    expect(
      within(own).getByRole("link", { name: "https://expenses.apps.example.com" })
    ).toHaveAttribute("target", "_blank");
    expect(within(own).getByText(/Owner: Alice Example/)).toHaveTextContent(/from acme\/expenses$/);
    expect(within(own).getByRole("button", { name: "Data" })).toBeInTheDocument();
    expect(within(own).getByRole("button", { name: "Take down" })).toBeInTheDocument();

    const others = screen.getByRole("region", { name: "Other apps in the workspace" });
    const theirs = within(others).getByRole("listitem", { name: "roster" });
    expect(within(theirs).getByText(/Owner: Bob Example/)).toHaveTextContent(/version 2$/);
    expect(within(theirs).queryByRole("button")).not.toBeInTheDocument();
  });

  it("lets the owner release their own unpublish but not an administrator's hold", async () => {
    const hold = { at: Date.now(), byUserId: ALICE, reason: "Paused", cleanupComplete: true };
    serve({
      "GET /api/apps": () =>
        response({
          apps: [
            app("expenses", ALICE, {
              status: "taken_down",
              takedown: { ...hold, kind: "owner_unpublished" },
            }),
            app("ledger", ALICE, {
              status: "taken_down",
              takedown: { ...hold, kind: "admin_takedown", byUserId: BOB, reason: "Leaks PII" },
            }),
          ],
        }),
      "POST /api/apps/expenses/release-hold": () => response({ app: app("expenses", ALICE) }),
    });
    const user = userEvent.setup();
    renderPanel();

    const ledger = await appRow("ledger");
    expect(
      within(ledger).getByText(/Taken down by an administrator .*: Leaks PII/)
    ).toBeInTheDocument();
    expect(
      within(ledger).getByText("Only an administrator can release this hold.")
    ).toBeInTheDocument();
    expect(within(ledger).queryByRole("button", { name: "Release hold" })).not.toBeInTheDocument();
    expect(within(ledger).queryByRole("link")).not.toBeInTheDocument();

    const expenses = await appRow("expenses");
    await user.click(within(expenses).getByRole("button", { name: "Release hold" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/apps/expenses/release-hold",
        body: {},
      })
    );
  });

  it("shows the classification without an editor and leaves restricted restores to administrators", async () => {
    serve({
      "GET /api/apps": () => response({ apps: [app("expenses", ALICE)] }),
      "GET /api/apps/expenses/data": () => response(summary({ classification: "restricted" })),
      [OPERATIONS]: () => response({ operations: [], nextCursor: null }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(within(await appRow("expenses")).getByRole("button", { name: "Data" }));
    const data = await screen.findByRole("region", { name: "expenses data" });
    expect(within(data).getByText("Restricted")).toBeInTheDocument();
    expect(within(data).getByText("Declared by the app")).toBeInTheDocument();
    expect(within(data).queryByRole("radio", { name: "Restricted" })).toBeNull();
    expect(
      within(data).getByText(
        "Restricted data is restored by an administrator who manages every app."
      )
    ).toBeInTheDocument();
    expect(within(data).queryByRole("button", { name: "Restore DB" })).toBeNull();
  });

  it("writes secret values without ever displaying them", async () => {
    serve({
      "GET /api/apps": () => response({ apps: [app("expenses", ALICE)] }),
      "GET /api/apps/expenses/data": () => response(summary()),
      [OPERATIONS]: () => response({ operations: [], nextCursor: null }),
      "POST /api/apps/expenses/data/secrets": () => response({ keys: ["WEBHOOK_TOKEN"] }),
      "DELETE /api/apps/expenses/data/secrets/API_KEY?stage=production": () =>
        response({ deleted: true }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(within(await appRow("expenses")).getByRole("button", { name: "Data" }));
    const secrets = await screen.findByRole("list", { name: "production secrets" });
    const apiKey = within(secrets).getByRole("listitem", { name: "API_KEY" });
    expect(within(apiKey).getByText(/^Set /)).toBeInTheDocument();
    const token = within(secrets).getByRole("listitem", { name: "WEBHOOK_TOKEN" });
    expect(within(token).getByText("Not set")).toBeInTheDocument();

    const input = within(token).getByLabelText("New value for WEBHOOK_TOKEN");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "placeholder-value");
    await user.click(within(token).getByRole("button", { name: "Set WEBHOOK_TOKEN" }));

    await waitFor(() => expect(input).toHaveValue(""));
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/apps/expenses/data/secrets",
      body: { stage: "production", secrets: { WEBHOOK_TOKEN: "placeholder-value" } },
    });
    expect(document.body.innerHTML).not.toContain("placeholder-value");

    await user.click(within(apiKey).getByRole("button", { name: "Delete API_KEY" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "DELETE",
        path: "/api/apps/expenses/data/secrets/API_KEY?stage=production",
        body: undefined,
      })
    );
  });

  it("restores a database only after the binding name is typed", async () => {
    serve({
      "GET /api/apps": () => response({ apps: [app("expenses", ALICE)] }),
      "GET /api/apps/expenses/data": () => response(summary()),
      [OPERATIONS]: () => response({ operations: [], nextCursor: null }),
      "POST /api/apps/expenses/data/restore": () =>
        response({ bookmark: "bookmark-2", previousBookmark: "bookmark-1" }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(within(await appRow("expenses")).getByRole("button", { name: "Data" }));
    const form = await screen.findByRole("form", { name: "Restore DB" });
    const restore = within(form).getByRole("button", { name: "Restore DB" });
    const when = new Date(Date.now() - 2 * 3_600_000);
    when.setSeconds(0, 0);
    const pad = (value: number) => String(value).padStart(2, "0");
    fireEvent.change(within(form).getByLabelText("Restore DB to"), {
      target: {
        value: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(
          when.getHours()
        )}:${pad(when.getMinutes())}`,
      },
    });
    expect(restore).toBeDisabled();
    await user.type(within(form).getByLabelText("Type DB to confirm"), "db");
    expect(restore).toBeDisabled();
    await user.clear(within(form).getByLabelText("Type DB to confirm"));
    await user.type(within(form).getByLabelText("Type DB to confirm"), "DB");
    expect(restore).toBeEnabled();
    await user.click(restore);

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/apps/expenses/data/restore",
        body: {
          stage: "production",
          binding: "DB",
          target: { timestamp: when.getTime() },
          confirmBinding: "DB",
        },
      })
    );
  });

  it("pages through the operations ledger", async () => {
    serve({
      "GET /api/apps": () => response({ apps: [app("expenses", ALICE)] }),
      "GET /api/apps/expenses/data": () => response(summary({ migrations: [] })),
      [OPERATIONS]: () =>
        response({ operations: [operation("op_1", "provision")], nextCursor: "10.op_1" }),
      "GET /api/apps/expenses/data/operations?limit=20&cursor=10.op_1": () =>
        response({ operations: [operation("op_2", "secret_set")], nextCursor: null }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(within(await appRow("expenses")).getByRole("button", { name: "Data" }));
    const ledger = await screen.findByRole("table", { name: "Data operations" });
    expect(within(ledger).getByRole("rowheader", { name: "Provisioned" })).toBeInTheDocument();
    expect(within(ledger).getAllByText("You")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Load more operations" }));
    expect(
      await within(ledger).findByRole("rowheader", { name: "Set secret" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more operations" })).toBeNull();
  });

  it("explains calmly when app hosting is not set up", async () => {
    serve({
      "GET /api/apps": () =>
        response(
          { ok: false, reason: "feature_unavailable", message: "App hosting is not set up" },
          503
        ),
    });
    renderPanel();

    expect(
      await screen.findByText("App hosting is not set up for this workspace.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("AppsSettings as an administrator", () => {
  beforeEach(() => grant("administrator"));

  it("takes down another member's app with a required reason", async () => {
    serve({
      "GET /api/apps": () => response({ apps: [app("expenses", ALICE), app("roster", BOB)] }),
      "POST /api/apps/roster/takedown": () =>
        response({ app: app("roster", BOB, { status: "taken_down" }), cleanupComplete: true }),
    });
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByRole("region", { name: "All other apps" })).toBeInTheDocument();
    const roster = await appRow("roster");
    await user.click(within(roster).getByRole("button", { name: "Take down" }));
    expect(
      within(roster).getByText(/Only an administrator can release the hold afterwards/)
    ).toBeInTheDocument();
    const confirm = within(roster).getByRole("button", { name: "Confirm takedown" });
    expect(confirm).toBeDisabled();
    await user.type(within(roster).getByLabelText("Reason for taking down roster"), "  Leaks PII ");
    await user.click(confirm);

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/apps/roster/takedown",
        body: { reason: "Leaks PII" },
      })
    );
  });

  it("releases an administrator's hold", async () => {
    serve({
      "GET /api/apps": () =>
        response({
          apps: [
            app("roster", BOB, {
              status: "taken_down",
              takedown: {
                kind: "admin_takedown",
                at: Date.now(),
                byUserId: ALICE,
                reason: "Leaks PII",
                cleanupComplete: true,
              },
            }),
          ],
        }),
      "POST /api/apps/roster/release-hold": () => response({ app: app("roster", BOB) }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(within(await appRow("roster")).getByRole("button", { name: "Release hold" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/apps/roster/release-hold",
        body: {},
      })
    );
  });

  it("approves a blocked schema change by its exact sha256", async () => {
    serve({
      "GET /api/apps": () => response({ apps: [app("expenses", BOB)] }),
      "GET /api/apps/expenses/data": () => response(summary()),
      [OPERATIONS]: () => response({ operations: [], nextCursor: null }),
      "POST /api/apps/expenses/data/migrations/approve": () => response({ status: "approved" }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(within(await appRow("expenses")).getByRole("button", { name: "Data" }));
    const change = await screen.findByRole("listitem", { name: "0002_drop-notes.sql" });
    expect(within(change).getByText("DROP TABLE notes")).toBeInTheDocument();
    expect(
      within(screen.getByRole("listitem", { name: "0001_create-claims.sql" })).queryByRole("button")
    ).toBeNull();
    await user.click(within(change).getByRole("button", { name: "Approve 0002_drop-notes.sql" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/apps/expenses/data/migrations/approve",
        body: { stage: "production", binding: "DB", name: "0002_drop-notes.sql", sha256: SHA },
      })
    );
  });

  it("edits the classification", async () => {
    serve({
      "GET /api/apps": () => response({ apps: [app("expenses", BOB)] }),
      "GET /api/apps/expenses/data": () => response(summary()),
      [OPERATIONS]: () => response({ operations: [], nextCursor: null }),
      "PUT /api/apps/expenses/data/classification": () =>
        response({ classification: "restricted", classificationSource: "admin" }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(within(await appRow("expenses")).getByRole("button", { name: "Data" }));
    const editor = await screen.findByRole("radiogroup", { name: "Data classification" });
    await user.click(within(editor).getByRole("radio", { name: "Restricted" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/api/apps/expenses/data/classification",
        body: { classification: "restricted" },
      })
    );
  });
});
