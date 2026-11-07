// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSummary } from "@open-inspect/shared/types/skills";
import { SkillsCatalog } from "./skills-catalog";
import { SkillsSettings } from "./index";

expect.extend(matchers);

const { useSkillCatalogPageMock, useSkillMock, governance, permissions } = vi.hoisted(() => ({
  useSkillCatalogPageMock: vi.fn(),
  useSkillMock: vi.fn(),
  governance: { configured: false },
  permissions: new Set<string>(),
}));

vi.mock("@/hooks/use-managed-skills", () => ({
  deleteSkill: vi.fn(),
  revalidateSkillCatalogPage: vi.fn(),
  setSkillEnabled: vi.fn(),
  useSkill: useSkillMock,
  useSkillCatalogPage: useSkillCatalogPageMock,
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => permissions.has(permission),
  }),
}));
vi.mock("@/hooks/use-governance-catalog", () => ({
  useGovernanceCatalog: () => ({ status: governance }),
}));

function skill(id: string, name: string): SkillSummary {
  return {
    id,
    name,
    description: `${name} description`,
    enabled: true,
    required: false,
    currentRevisionId: `revision-${id}`,
    revisionNumber: 1,
    revisionSha256: "a".repeat(64),
    revisionCreatedBy: "user-1",
    creatorDisplayName: "User One",
    lastEditorDisplayName: "User One",
    revisionAuthorDisplayName: "User One",
    assignments: [],
    source: null,
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  governance.configured = false;
  permissions.clear();
  useSkillCatalogPageMock.mockReset();
  useSkillCatalogPageMock.mockImplementation((cursor: string | null) =>
    cursor
      ? {
          skills: [skill("2", "second-skill")],
          hasMore: false,
          nextCursor: null,
          loading: false,
          error: undefined,
        }
      : {
          skills: [skill("1", "first-skill")],
          hasMore: true,
          nextCursor: "first-skill",
          loading: false,
          error: undefined,
        }
  );
  useSkillMock.mockReturnValue({
    skill: undefined,
    loading: false,
    error: undefined,
    mutate: vi.fn(),
  });
});

afterEach(cleanup);

describe("SkillsCatalog", () => {
  it("shows catalogue edit controls to a user granted skills.manage", () => {
    permissions.add("skills.read");
    permissions.add("skills.manage");
    render(<SkillsSettings />);

    expect(screen.getByRole("button", { name: "New skill" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import from repository" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Disable first-skill" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("withholds catalogue edit controls without skills.manage", () => {
    permissions.add("skills.read");
    render(<SkillsSettings />);

    expect(screen.getByText("first-skill")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New skill" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import from repository" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Disable first-skill" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("makes the shared catalogue read-only when Git governance is configured", () => {
    governance.configured = true;
    render(<SkillsCatalog canManage />);

    expect(screen.queryByRole("button", { name: "New skill" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Disable first-skill" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByText(/Skills are read-only here/)).toBeInTheDocument();
  });

  it("loads catalog pages on demand and navigates back with cursor history", async () => {
    const user = userEvent.setup();
    render(<SkillsCatalog canManage />);

    expect(screen.getByText("first-skill")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(useSkillCatalogPageMock).toHaveBeenLastCalledWith(null);

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("second-skill")).toBeInTheDocument();
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(useSkillCatalogPageMock).toHaveBeenLastCalledWith("first-skill");

    await user.click(screen.getByRole("button", { name: "Previous" }));

    expect(screen.getByText("first-skill")).toBeInTheDocument();
    expect(useSkillCatalogPageMock).toHaveBeenLastCalledWith(null);
  });

  it("shows the skill creator with an ID fallback", () => {
    const withDisplayName = skill("1", "first-skill");
    const withIdFallback = {
      ...skill("2", "second-skill"),
      creatorDisplayName: "",
      createdBy: "user-2",
    };
    useSkillCatalogPageMock.mockReturnValue({
      skills: [withDisplayName, withIdFallback],
      hasMore: false,
      nextCursor: null,
      loading: false,
      error: undefined,
    });

    render(<SkillsCatalog canManage />);

    expect(screen.getByText("· Created by User One")).toBeInTheDocument();
    expect(screen.getByText("· Created by user-2")).toBeInTheDocument();
  });

  it("opens a complete read-only detail surface for users without manage permission", async () => {
    const summary = skill("1", "first-skill");
    useSkillMock.mockReturnValue({
      skill: {
        ...summary,
        body: "## Workflow\nRun the checks.",
        license: "MIT",
        compatibility: "Open Inspect",
        metadata: { owner: "platform" },
        assignments: [
          { id: "assignment-1", type: "repository", repoOwner: "acme", repoName: "api" },
        ],
        files: [
          {
            path: "SKILL.md",
            content: "generated",
            sha256: "b".repeat(64),
            executable: false,
            sizeBytes: 9,
          },
          {
            path: "scripts/check.sh",
            content: "npm test",
            sha256: "c".repeat(64),
            executable: true,
            sizeBytes: 8,
          },
        ],
      },
      loading: false,
      error: undefined,
      mutate: vi.fn(),
    });
    const user = userEvent.setup();
    render(<SkillsCatalog canManage={false} />);

    await user.click(screen.getByRole("button", { name: /first-skill/i }));

    expect(screen.getByText("Run the checks.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Repository: acme/api")).toBeInTheDocument();
    expect(screen.getByText("scripts/check.sh (executable)")).toBeInTheDocument();
    expect(screen.getByText(/Revision 1 by User One/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save new revision/i })).not.toBeInTheDocument();
  });

  it.each([
    [
      "empty",
      {
        skills: [],
        hasMore: false,
        nextCursor: null,
        loading: false,
        error: undefined,
      },
      "No skills on this page.",
    ],
    [
      "failed",
      {
        skills: [],
        hasMore: false,
        nextCursor: null,
        loading: false,
        error: new Error("request failed"),
      },
      "Failed to load managed skills.",
    ],
  ])("can navigate back when a later page is %s", async (_state, page, message) => {
    useSkillCatalogPageMock.mockImplementation((cursor: string | null) =>
      cursor
        ? page
        : {
            skills: [skill("1", "first-skill")],
            hasMore: true,
            nextCursor: "first-skill",
            loading: false,
            error: undefined,
          }
    );
    const user = userEvent.setup();
    render(<SkillsCatalog canManage />);

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Previous" }));

    expect(screen.getByText("first-skill")).toBeInTheDocument();
    expect(useSkillCatalogPageMock).toHaveBeenLastCalledWith(null);
  });
});
