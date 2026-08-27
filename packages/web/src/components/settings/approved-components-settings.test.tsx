// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { ApprovedComponentsSettings } from "./approved-components-settings";

expect.extend(matchers);

const role = vi.hoisted(() => ({ canWriteCatalog: false }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-platform-role", () => ({ usePlatformRole: () => role }));

const component = {
  id: "component-1",
  revision: 2,
  name: "Corporate authentication",
  kind: "library",
  description: "Reviewed authentication primitive",
  owner: "Product Security",
  locator: "@acme/auth",
  version: "1.3.0",
  integrity: null,
  sourceUrl: "https://git.example.com/auth",
  documentationUrl: "https://docs.example.com/auth",
  usage: "Use createAuthenticatedApp().",
  lifecycle: "approved",
  repoScopes: null,
  environmentScopes: null,
  enabled: true,
  createdBy: "security-user",
  updatedBy: "security-user",
  createdAt: 1,
  updatedAt: 2,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderSettings() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApprovedComponentsSettings />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  role.canWriteCatalog = false;
});

describe("ApprovedComponentsSettings", () => {
  it("shows members the catalogue and stale consumer inventory without edit controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/approved-components") return response([component]);
        if (String(input) === "/api/approved-components/component-1/consumers") {
          return response([
            {
              componentId: "component-1",
              componentRevision: 1,
              componentVersion: "1.2.3",
              repoOwner: "acme",
              repoName: "web",
              sessionId: "session-1",
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ]);
        }
        throw new Error(`Unexpected request ${String(input)}`);
      })
    );
    const user = userEvent.setup();
    renderSettings();

    expect(await screen.findByText("Corporate authentication")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add component/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Consumers" }));
    expect(await screen.findByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("upgrade from 1.2.3")).toBeInTheDocument();
  });

  it("lets catalogue editors register a development component", async () => {
    role.canWriteCatalog = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/approved-components" && method === "GET") return response([]);
      if (path === "/api/approved-components" && method === "POST") {
        return response(component, 201);
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: /Add component/i }));
    await user.type(screen.getByPlaceholderText("Corporate authentication"), "Approved logger");
    await user.type(
      screen.getByText("Description").parentElement!.querySelector("textarea")!,
      "Reviewed logs"
    );
    await user.type(screen.getByPlaceholderText("Product Security"), "Platform Security");
    await user.type(
      screen.getByPlaceholderText("@acme/auth or https://service.example.com"),
      "@acme/logger"
    );
    await user.type(
      screen.getByText("Usage instructions").parentElement!.querySelector("textarea")!,
      "Install it."
    );
    await user.click(screen.getByRole("button", { name: "Save component" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/approved-components",
        expect.objectContaining({ method: "POST" })
      )
    );
    const call = fetchMock.mock.calls.find(
      ([path, init]) => path === "/api/approved-components" && init?.method === "POST"
    );
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      name: "Approved logger",
      owner: "Platform Security",
      lifecycle: "development",
    });
  });
});
