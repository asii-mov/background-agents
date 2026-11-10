// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedSkillsSection } from "./managed-skills-section";

expect.extend(matchers);

const skill = {
  revisionId: "revision-1",
  description: "A managed skill",
  revisionNumber: 1,
  revisionSha256: "ab".repeat(32),
  totalBytes: 10,
  assignmentSources: [{ id: "assignment-global", type: "global" as const }],
};

vi.mock("@/hooks/use-session-skills", () => ({
  useSessionSkills: () => ({
    loading: false,
    error: undefined,
    provenance: {
      manifestSha256: "9c".repeat(32),
      resolverVersion: 2,
      selection: { mode: "all" },
      resolvedAt: 1,
      skills: [
        { ...skill, skillId: "skill-1", name: "review-pr", required: false },
        { ...skill, skillId: "skill-2", name: "workspace-stack-policy", required: true },
      ],
    },
  }),
}));

afterEach(cleanup);

describe("ManagedSkillsSection", () => {
  it("lists only skills the session member chose, never required governance skills", async () => {
    render(<ManagedSkillsSection sessionId="session-1" />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Managed skills (1)" }));

    expect(screen.getByText("review-pr")).toBeInTheDocument();
    expect(screen.queryByText("workspace-stack-policy")).not.toBeInTheDocument();
  });
});
