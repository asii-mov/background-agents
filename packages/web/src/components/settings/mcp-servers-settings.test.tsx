// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import { McpServersSettings } from "./mcp-servers-settings";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  canManageMcp: true,
  canWriteCatalog: true,
  updateMcpServer: vi.fn(),
  updateMcpServerCredentials: vi.fn(),
  governanceStatus: undefined as
    | undefined
    | {
        configured: true;
        source: { provider: string; owner: string; name: string; ref: string; path: string };
        lastStatus: "succeeded";
      },
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => mocks.canManageMcp }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false }),
}));
vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({ environments: [], loading: false }),
}));
vi.mock("@/hooks/use-platform-role", () => ({
  usePlatformRole: () => ({ canWriteCatalog: mocks.canWriteCatalog }),
}));
vi.mock("@/hooks/use-mcp-servers", () => ({
  useMcpServers: () => ({ servers, loading: false, mutate: mocks.mutate }),
  createMcpServer: vi.fn(),
  updateMcpServer: mocks.updateMcpServer,
  updateMcpServerCredentials: mocks.updateMcpServerCredentials,
  deleteMcpServer: vi.fn(),
}));
vi.mock("@/hooks/use-governance-catalog", () => ({
  useGovernanceCatalog: () => ({ status: mocks.governanceStatus, mutate: vi.fn() }),
  syncGovernanceCatalog: vi.fn(),
}));

const servers: McpServerMetadata[] = [
  {
    id: "server-a",
    revision: 3,
    name: "Server A",
    type: "remote",
    url: "https://a.example.com",
    hasEnv: false,
    hasHeaders: false,
    repoScopes: null,
    environmentScopes: null,
    lifecycle: "approved",
    createdBy: "security-user",
    updatedBy: "security-user",
    enabled: true,
  },
  {
    id: "server-b",
    revision: 7,
    name: "Server B",
    type: "remote",
    url: "https://b.example.com",
    hasEnv: false,
    hasHeaders: false,
    repoScopes: null,
    environmentScopes: ["production"],
    lifecycle: "approved",
    createdBy: "security-user",
    updatedBy: "security-user",
    enabled: true,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.governanceStatus = undefined;
  mocks.canManageMcp = true;
  mocks.canWriteCatalog = true;
  delete servers[0].sourceKind;
});

describe("McpServersSettings", () => {
  it.each(["workspace", "catalog"])("withholds mutation controls without the %s grant", (grant) => {
    mocks.canManageMcp = grant !== "workspace";
    mocks.canWriteCatalog = grant !== "catalog";
    render(<McpServersSettings />);
    expect(screen.getByText("Server A")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Server" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Server A/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    for (const control of screen.getAllByRole("switch")) expect(control).toBeDisabled();
  });

  it("renders environment-only scope instead of calling the server global", () => {
    render(<McpServersSettings />);

    expect(screen.getByText(/environment production/)).toBeInTheDocument();
  });

  it("does not close a newer draft when an older save completes", async () => {
    let resolveSave!: (server: McpServerMetadata) => void;
    mocks.updateMcpServer.mockReturnValue(
      new Promise<McpServerMetadata>((resolve) => {
        resolveSave = resolve;
      })
    );
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server A/ }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mocks.updateMcpServer).toHaveBeenCalledWith(
      "server-a",
      expect.objectContaining({ revision: 3 })
    );

    await user.click(screen.getByRole("button", { name: /Server B/ }));
    expect(screen.getByDisplayValue("https://b.example.com")).toBeInTheDocument();

    resolveSave({ ...servers[0], revision: 4 });

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    expect(screen.getByDisplayValue("https://b.example.com")).toBeInTheDocument();
  });

  it("does not reinterpret entered credentials when the server type changes", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[0], type: "local", revision: 4 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server A/ }));
    await user.type(screen.getByPlaceholderText("Header-Name"), "Authorization");
    await user.type(screen.getByPlaceholderText("value"), "secret");
    await user.click(screen.getByRole("button", { name: "Local" }));
    await user.type(screen.getByPlaceholderText("npx -y @playwright/mcp"), "npx tool");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mocks.updateMcpServer).toHaveBeenCalled());
    expect(mocks.updateMcpServer).toHaveBeenCalledWith("server-a", {
      name: "Server A",
      enabled: true,
      repoScopes: null,
      environmentScopes: null,
      lifecycle: "approved",
      type: "local",
      command: ["npx", "tool"],
      revision: 3,
    });
  });

  it("keeps Git metadata read-only while allowing credential rotation", async () => {
    mocks.governanceStatus = {
      configured: true,
      source: {
        provider: "github",
        owner: "security",
        name: "governance",
        ref: "main",
        path: ".openinspect",
      },
      lastStatus: "succeeded",
    };
    servers[0].sourceKind = "git";
    mocks.updateMcpServerCredentials.mockResolvedValue(servers[0]);
    const user = userEvent.setup();
    render(<McpServersSettings />);

    expect(screen.queryByRole("button", { name: "Add Server" })).not.toBeInTheDocument();
    for (const item of screen.getAllByRole("switch", { name: "Disable" })) {
      expect(item).toBeDisabled();
    }
    await user.click(screen.getByRole("button", { name: /Server A/ }));
    expect(screen.queryByDisplayValue("https://a.example.com")).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Header-Name"), "Authorization");
    await user.type(screen.getByPlaceholderText("value"), "secret");
    await user.click(screen.getByRole("button", { name: "Save Credentials" }));

    await waitFor(() =>
      expect(mocks.updateMcpServerCredentials).toHaveBeenCalledWith("server-a", {
        revision: 3,
        headers: { Authorization: "secret" },
      })
    );
    expect(mocks.updateMcpServer).not.toHaveBeenCalled();
  });
});
