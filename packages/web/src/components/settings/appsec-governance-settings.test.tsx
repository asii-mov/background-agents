// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { AppSecGovernanceSettings } from "./appsec-governance-settings";

expect.extend(matchers);

const grants = vi.hoisted(() => ({ permissions: new Set<string>(["governance.read"]) }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => grants.permissions.has(permission),
  }),
}));

const pipeline = {
  id: "pipeline-1",
  revision: 1,
  name: "AppSec baseline",
  commands: [{ name: "tests", command: ["npm", "test"], timeoutSeconds: 300 }],
  repoScopes: null,
  environmentScopes: null,
  enabled: true,
  blocking: true,
  maxRemediationAttempts: 2,
  createdBy: "security-user",
  updatedBy: "security-user",
  createdAt: 1,
  updatedAt: 1,
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
      <AppSecGovernanceSettings />
    </SWRConfig>
  );
}

const EMPTY_GOVERNANCE_READS = new Set([
  "/api/repository-risk",
  "/api/approved-components",
  "/api/component-categories",
]);

function governanceRead(path: string): Response | null {
  if (EMPTY_GOVERNANCE_READS.has(path)) return response([]);
  if (path === "/api/stack-policy/preview") return response({ policy: null });
  return null;
}

async function openPipelines() {
  await userEvent.setup().click(await screen.findByRole("tab", { name: "Pipelines and risk" }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  grants.permissions = new Set(["governance.read"]);
});

describe("AppSecGovernanceSettings", () => {
  it("opens on the stack policy and offers every governance view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/security-pipelines") return response([]);
        const read = governanceRead(String(input));
        if (read) return read;
        throw new Error(`Unexpected request ${String(input)}`);
      })
    );

    renderSettings();

    expect(
      await screen.findByRole("heading", { name: "Technology standards" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Stack policy",
      "Adoption",
      "App data",
      "Pipelines and risk",
    ]);
  });

  it("shows read-only governance without mutation controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/security-pipelines") return response([pipeline]);
        const read = governanceRead(String(input));
        if (read) return read;
        throw new Error(`Unexpected request ${String(input)}`);
      })
    );

    renderSettings();
    await openPipelines();

    expect(await screen.findByText("AppSec baseline")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add pipeline/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Platform ownership")).not.toBeInTheDocument();
  });

  it("lets governance managers create an argv-based managed pipeline", async () => {
    grants.permissions = new Set(["governance.read", "governance.manage"]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/security-pipelines" && method === "GET") return response([]);
      const read = method === "GET" ? governanceRead(path) : null;
      if (read) return read;
      if (path === "/api/security-pipelines" && method === "POST") return response(pipeline, 201);
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderSettings();
    await openPipelines();

    await user.click(await screen.findByRole("button", { name: /Add pipeline/i }));
    await user.clear(screen.getByPlaceholderText("AppSec baseline"));
    await user.type(screen.getByPlaceholderText("AppSec baseline"), "Corporate baseline");
    await user.click(screen.getByRole("button", { name: "Save pipeline" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/security-pipelines",
        expect.objectContaining({ method: "POST" })
      )
    );
    const request = fetchMock.mock.calls.find(
      ([path, init]) => path === "/api/security-pipelines" && init?.method === "POST"
    );
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      name: "Corporate baseline",
      commands: [{ command: ["npm", "test"] }],
      blocking: true,
    });
  });
});
