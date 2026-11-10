// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { toast } from "sonner";
import type { ApprovedComponent } from "@open-inspect/shared/types/approved-components";
import type {
  CategoryEnforcement,
  ComponentCategory,
} from "@open-inspect/shared/types/stack-policy";
import { ApprovedComponentsSettings } from "./approved-components-settings";

expect.extend(matchers);

const grants = vi.hoisted(() => ({ permissions: new Set<string>(["governance.read"]) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => grants.permissions.has(permission),
  }),
}));

function category(id: string, name: string, enforcement: CategoryEnforcement): ComponentCategory {
  return {
    id,
    name,
    description: `${name} work`,
    enforcement,
    revision: 4,
    sourceKind: "app",
    createdBy: "system",
    updatedBy: "system",
    createdAt: 0,
    updatedAt: 0,
  };
}

function component(overrides: Partial<ApprovedComponent>): ApprovedComponent {
  return {
    id: "component",
    name: "Component",
    kind: "library",
    description: "Component for browser UI",
    owner: "platform-engineering",
    locator: "https://example.com",
    version: null,
    integrity: null,
    sourceUrl: null,
    documentationUrl: "https://example.com/docs",
    usage: "Use it for browser UI.",
    lifecycle: "approved",
    repoScopes: null,
    environmentScopes: null,
    enabled: true,
    categoryId: "web-frontend",
    stance: "allowed",
    signals: [{ kind: "package", ecosystem: "npm", name: "component" }],
    revision: 2,
    sourceKind: "app",
    createdBy: "system",
    updatedBy: "system",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const svelte = component({
  id: "svelte",
  name: "Svelte",
  stance: "preferred",
  signals: [{ kind: "package", ecosystem: "npm", name: "svelte" }],
});
const vue = component({
  id: "vue",
  name: "Vue",
  signals: [{ kind: "package", ecosystem: "npm", name: "vue" }],
});
const react = component({
  id: "react",
  name: "React",
  stance: "denied",
  usage: "Use Svelte instead.",
  signals: [{ kind: "package", ecosystem: "npm", name: "react" }],
});
const draftSolid = component({
  id: "solid",
  name: "Solid",
  lifecycle: "development",
  signals: [{ kind: "package", ecosystem: "npm", name: "solid-js" }],
});
const logger = component({
  id: "logger",
  name: "Approved logger",
  categoryId: null,
  stance: "allowed",
  signals: [],
  locator: "@acme/logger",
  version: "1.3.0",
  revision: 5,
});

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A control plane for this panel: categories are mutable, and the preview follows them. */
function installApi() {
  const state = { enforcement: "advise" as CategoryEnforcement };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/approved-components") {
      return response([logger, react, draftSolid, svelte, vue]);
    }
    if (method === "GET" && path === "/api/component-categories") {
      return response([
        category("web-frontend", "Web frontend", state.enforcement),
        category("js-toolchain", "JavaScript toolchain", "advise"),
      ]);
    }
    if (method === "GET" && path === "/api/stack-policy/preview") {
      return response({
        policy: {
          schemaVersion: 1,
          digest: `${state.enforcement}-digest-0000`,
          instructions: "## Organization technology standards\n- Do not use: **React**.",
          maxRemediationAttempts: 2,
          rules: [
            {
              componentId: "react",
              componentRevision: 2,
              componentName: "React",
              categoryId: "web-frontend",
              categoryName: "Web frontend",
              verdict: "forbid",
              blocking: state.enforcement === "block",
              signals: react.signals,
              guidance: react.usage,
              repoScopes: null,
            },
          ],
        },
      });
    }
    if (method === "GET" && path === "/api/approved-components/logger/consumers") {
      return response([
        {
          evidence: "declared",
          componentId: "logger",
          componentRevision: 4,
          componentVersion: "1.2.3",
          repoOwner: "acme",
          repoName: "web",
          sessionId: "session-1",
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
        {
          evidence: "detected",
          componentId: "logger",
          repoOwner: "acme",
          repoName: "api",
          refName: "main",
          commitSha: "a".repeat(40),
          evidencePaths: ["package.json"],
          observedAt: 1,
        },
      ]);
    }
    if (method === "PUT" && path === "/api/component-categories/web-frontend") {
      state.enforcement = JSON.parse(String(init?.body)).enforcement;
      return response(category("web-frontend", "Web frontend", state.enforcement));
    }
    if (method === "PUT" && path.startsWith("/api/approved-components/")) {
      return response(JSON.parse(String(init?.body)));
    }
    if (method === "POST" && path === "/api/approved-components") {
      return response(JSON.parse(String(init?.body)), 201);
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof installApi>, method: string, path: string) {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => String(input) === path && (init?.method ?? "GET") === method
  );
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}

function renderSettings() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApprovedComponentsSettings />
    </SWRConfig>
  );
}

async function fill(field: HTMLElement, value: string) {
  const user = userEvent.setup();
  await user.click(field);
  await user.paste(value);
}

async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(toast.error).mockClear();
  grants.permissions = new Set(["governance.read"]);
});

describe("ApprovedComponentsSettings", () => {
  it("shows readers each category's grades, the agents' instructions and consumers, read-only", async () => {
    installApi();
    const user = userEvent.setup();
    renderSettings();

    const lane = await screen.findByRole("listitem", { name: "Web frontend" });
    expect(within(lane).getByText("Svelte")).toBeInTheDocument();
    expect(within(lane).getByText("Vue")).toBeInTheDocument();
    expect(within(lane).getByText("React")).toBeInTheDocument();
    expect(within(lane).getByRole("radio", { name: "Block" })).toBeDisabled();
    expect(
      within(screen.getByRole("listitem", { name: "JavaScript toolchain" })).getByText(
        "No standard yet. Agents choose freely here."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Svelte actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add component/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

    expect(await screen.findByLabelText("Agent instructions")).toHaveTextContent(
      "Do not use: **React**."
    );
    expect(screen.getByText("flagged, not blocked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Consumers of Approved logger" }));
    expect(await screen.findByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("upgrade from 1.2.3")).toBeInTheDocument();
    expect(screen.getByText("detected on main in package.json")).toBeInTheDocument();
  });

  it("flips a category to block and shows the preview change", async () => {
    grants.permissions = new Set(["governance.read", "governance.manage"]);
    const fetchMock = installApi();
    const user = userEvent.setup();
    renderSettings();

    expect(await screen.findByText("flagged, not blocked")).toBeInTheDocument();
    const lane = screen.getByRole("listitem", { name: "Web frontend" });
    await user.click(within(lane).getByRole("radio", { name: "Block" }));

    expect(await screen.findByText("blocks the push")).toBeInTheDocument();
    expect(
      within(lane).getByText(
        "Denied technologies fail the agent's turn and reject the push until replaced."
      )
    ).toBeInTheDocument();
    expect(requestBody(fetchMock, "PUT", "/api/component-categories/web-frontend")).toEqual({
      name: "Web frontend",
      description: "Web frontend work",
      enforcement: "block",
      revision: 4,
    });
  });

  it("makes an alternative the standard and demotes the current one in one request", async () => {
    grants.permissions = new Set(["governance.read", "governance.manage"]);
    const fetchMock = installApi();
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Vue actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Make standard instead of Svelte" })
    );

    await waitFor(() =>
      expect(requestBody(fetchMock, "PUT", "/api/approved-components/vue")).toMatchObject({
        name: "Vue",
        stance: "preferred",
        demoteCurrentPreferred: true,
        revision: 2,
        signals: [{ kind: "package", ecosystem: "npm", name: "vue" }],
      })
    );

    await user.click(screen.getByRole("button", { name: "Solid actions" }));
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Make standard/ })).not.toBeInTheDocument();
  });

  it("refuses a grade without a category or detection signals, sending nothing", async () => {
    grants.permissions = new Set(["governance.read", "governance.manage"]);
    const fetchMock = installApi();
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "React actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Detection signals"));
    await user.click(screen.getByRole("button", { name: "Save component" }));
    expect(toast.error).toHaveBeenLastCalledWith(
      "categorised components need at least one signal so they can be detected"
    );

    await choose("Category", "No category");
    await user.click(screen.getByRole("button", { name: "Save component" }));
    expect(toast.error).toHaveBeenLastCalledWith("denied components need a category");

    await user.type(screen.getByLabelText("Detection signals"), "react");
    await user.click(screen.getByRole("button", { name: "Save component" }));
    expect(toast.error).toHaveBeenLastCalledWith(
      "Line 1: start with package:, file:, source: or manifest:"
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("registers a graded component with its category and signals", async () => {
    grants.permissions = new Set(["governance.read", "governance.manage"]);
    const fetchMock = installApi();
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: /Add component/ }));
    await fill(screen.getByLabelText("Name"), "Angular");
    await fill(screen.getByLabelText("Description"), "Browser framework");
    await fill(screen.getByLabelText("Owner"), "Platform Security");
    await fill(screen.getByLabelText("Locator"), "https://angular.dev");
    await fill(screen.getByLabelText("Usage instructions"), "Use Svelte instead.");
    await choose("Category", "Web frontend");
    await choose("Grade", "Not allowed");
    await fill(screen.getByLabelText("Detection signals"), "package:npm:@angular/*");
    await user.click(screen.getByRole("button", { name: "Save component" }));

    await waitFor(() =>
      expect(requestBody(fetchMock, "POST", "/api/approved-components")).toMatchObject({
        name: "Angular",
        categoryId: "web-frontend",
        stance: "denied",
        signals: [{ kind: "package", ecosystem: "npm", name: "@angular/*" }],
        lifecycle: "development",
      })
    );
  });
});
