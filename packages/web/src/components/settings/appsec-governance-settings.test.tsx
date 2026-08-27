// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { AppSecGovernanceSettings } from "./appsec-governance-settings";

expect.extend(matchers);

const role = vi.hoisted(() => ({ canWriteCatalog: false, canManagePlatform: false }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-platform-role", () => ({ usePlatformRole: () => role }));

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  role.canWriteCatalog = false;
  role.canManagePlatform = false;
});

describe("AppSecGovernanceSettings", () => {
  it("shows centrally assigned policy to members without mutation controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/security-pipelines") return response([pipeline]);
        if (String(input) === "/api/repository-risk") return response([]);
        if (String(input) === "/api/approved-components") return response([]);
        throw new Error(`Unexpected request ${String(input)}`);
      })
    );

    renderSettings();

    expect(await screen.findByText("AppSec baseline")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add pipeline/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Platform ownership")).not.toBeInTheDocument();
  });

  it("lets catalogue editors create an argv-based managed pipeline", async () => {
    role.canWriteCatalog = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/security-pipelines" && method === "GET") return response([]);
      if (path === "/api/repository-risk" && method === "GET") return response([]);
      if (path === "/api/approved-components" && method === "GET") return response([]);
      if (path === "/api/security-pipelines" && method === "POST") return response(pipeline, 201);
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderSettings();

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
