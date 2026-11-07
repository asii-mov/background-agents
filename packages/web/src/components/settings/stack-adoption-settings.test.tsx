// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import {
  CATEGORY_ADOPTION_STATUSES,
  type CategoryAdoptionStatus,
  type RepositoryStackInventory,
} from "@open-inspect/shared/types/stack-policy";
import { AppDataInventorySettings, StackAdoptionSettings } from "./stack-adoption-settings";

expect.extend(matchers);

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function categoryRow(id: string, name: string) {
  return {
    id,
    name,
    description: name,
    enforcement: "advise",
    revision: 1,
    sourceKind: "app",
    createdBy: "system",
    updatedBy: "system",
    createdAt: 0,
    updatedAt: 0,
  };
}

function repository(name: string, status: CategoryAdoptionStatus): RepositoryStackInventory {
  return {
    repository: { repoOwner: "acme", repoName: name },
    current: {
      refName: "main",
      commitSha: "b".repeat(40),
      observedAt: 1,
      complete: true,
      categories: [
        {
          categoryId: "web-frontend",
          status,
          components:
            status === "violating"
              ? [
                  {
                    componentId: "react",
                    name: "React",
                    verdict: "forbid",
                    evidence: ["web/package.json"],
                  },
                ]
              : [],
        },
      ],
      uncataloguedDirectCount: 3,
    },
    pending: status === "violating" ? [{ ...placeholderSummary, refName: "agent/fix-ui" }] : [],
  };
}

const placeholderSummary = {
  refName: "",
  commitSha: "c".repeat(40),
  observedAt: 2,
  complete: true,
  categories: [],
  uncataloguedDirectCount: 0,
};

function renderWithSwr(node: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StackAdoptionSettings", () => {
  it("renders every adoption status, the roll-up and a repository's evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/component-categories") {
          return response([categoryRow("web-frontend", "Web frontend")]);
        }
        if (path === "/api/stack-inventory/rollup") {
          return response([
            {
              categoryId: "web-frontend",
              counts: { violating: 1, standard: 1, mixed: 1, nonstandard: 1, absent: 1 },
            },
          ]);
        }
        if (path === "/api/stack-inventory") {
          return response([
            ...CATEGORY_ADOPTION_STATUSES.map((status) => repository(status, status)),
            { repository: { repoOwner: "acme", repoName: "new" }, current: null, pending: [] },
          ]);
        }
        throw new Error(`Unexpected request ${path}`);
      })
    );
    const user = userEvent.setup();
    renderWithSwr(<StackAdoptionSettings />);

    const table = await screen.findByRole("table", {
      name: "Stack adoption by repository and category",
    });
    const cell = (name: string) =>
      within(table)
        .getByRole("rowheader", { name: `acme/${name}` })
        .closest("tr")!;
    expect(within(cell("violating")).getByText("Violating")).toBeInTheDocument();
    expect(within(cell("standard")).getByText("Standard")).toBeInTheDocument();
    expect(within(cell("mixed")).getByText("Mixed")).toBeInTheDocument();
    expect(within(cell("nonstandard")).getByText("Non-standard")).toBeInTheDocument();
    expect(within(cell("absent")).getByText("Not used")).toBeInTheDocument();
    expect(within(cell("new")).getByText("Not scanned")).toBeInTheDocument();

    expect(
      screen.getByRole("img", {
        name: "Web frontend: 1 standard, 1 mixed, 1 non-standard, 1 violating, 1 not used",
      })
    ).toBeInTheDocument();

    await user.click(within(table).getByRole("button", { name: "acme/violating" }));
    expect(screen.getByText(/React \(web\/package\.json\)/)).toBeInTheDocument();
    expect(screen.getByText(/3 direct dependencies match no catalogue entry/)).toBeInTheDocument();
    expect(screen.getByText(/1 agent branch in flight: agent\/fix-ui/)).toBeInTheDocument();
  });
});

describe("AppDataInventorySettings", () => {
  it("lists each app's data resources with classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          rows: [
            {
              appName: "expenses",
              ownerUserId: "user-1",
              classification: "confidential",
              stage: "production",
              binding: "DB",
              kind: "d1",
              status: "ready",
              sizeBytes: 2_500_000,
              purgeAfter: null,
              lastMigrationAt: 1,
            },
          ],
          nextCursor: null,
        })
      )
    );
    renderWithSwr(<AppDataInventorySettings />);

    const row = (await screen.findByRole("rowheader", { name: "expenses" })).closest("tr")!;
    expect(within(row).getByText("confidential")).toBeInTheDocument();
    expect(within(row).getByText("2.5 MB")).toBeInTheDocument();
  });

  it("says app data is not enabled when the control plane has no inventory route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "Not found" }, 404))
    );
    renderWithSwr(<AppDataInventorySettings />);

    expect(
      await screen.findByText("App data is not enabled on this workspace.")
    ).toBeInTheDocument();
  });
});
