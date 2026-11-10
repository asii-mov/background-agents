"use client";

import { Fragment, useState } from "react";
import useSWR from "swr";
import type { AppDataInventoryRow } from "@open-inspect/shared/types/app-data";
import { formatRepositoryFullName } from "@open-inspect/shared/types/repositories";
import type {
  CategoryAdoptionRollup,
  CategoryAdoptionStatus,
  ComponentCategory,
  RepositoryStackInventory,
} from "@open-inspect/shared/types/stack-policy";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ADOPTION_STATUS_ORDER, ADOPTION_STATUS_PRESENTATION } from "./approved-components-model";
import { GovernanceRequestError, fetchJson } from "./governance-api";

const MEGABYTES = new Intl.NumberFormat("en", {
  style: "unit",
  unit: "megabyte",
  maximumFractionDigits: 1,
});

function StatusMark({ status }: { status: CategoryAdoptionStatus }) {
  const presentation = ADOPTION_STATUS_PRESENTATION[status];
  return (
    <span className="inline-flex items-center gap-1.5" title={presentation.description}>
      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", presentation.fill)} />
      <span className={status === "absent" ? "text-muted-foreground" : "text-foreground"}>
        {presentation.label}
      </span>
    </span>
  );
}

function RollupBar({ rollup, name }: { rollup: CategoryAdoptionRollup; name: string }) {
  const total = ADOPTION_STATUS_ORDER.reduce((sum, status) => sum + rollup.counts[status], 0);
  const counted = ADOPTION_STATUS_ORDER.filter((status) => rollup.counts[status] > 0);
  return (
    <li className="grid gap-1.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <span className="text-sm text-foreground">{name}</span>
      <div className="min-w-0 space-y-1">
        <div
          role="img"
          aria-label={`${name}: ${
            counted
              .map(
                (status) =>
                  `${rollup.counts[status]} ${ADOPTION_STATUS_PRESENTATION[status].label.toLowerCase()}`
              )
              .join(", ") || "no repositories scanned"
          }`}
          className="flex h-2.5 gap-0.5 overflow-hidden rounded-sm bg-muted"
        >
          {counted.map((status) => (
            <span
              key={status}
              title={`${ADOPTION_STATUS_PRESENTATION[status].label}: ${rollup.counts[status]}`}
              className={cn(
                "h-full first:rounded-l-sm last:rounded-r-sm",
                ADOPTION_STATUS_PRESENTATION[status].fill
              )}
              style={{ width: `${(rollup.counts[status] / total) * 100}%` }}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {total === 0
            ? "No repositories scanned"
            : counted
                .map(
                  (status) =>
                    `${rollup.counts[status]} ${ADOPTION_STATUS_PRESENTATION[status].label.toLowerCase()}`
                )
                .join(", ")}
        </p>
      </div>
    </li>
  );
}

function RepositoryEvidence({
  inventory,
  categoryNames,
}: {
  inventory: RepositoryStackInventory;
  categoryNames: ReadonlyMap<string, string>;
}) {
  const current = inventory.current;
  if (!current) return null;
  return (
    <div className="space-y-2 bg-card px-3 py-3 text-xs">
      <p className="text-muted-foreground">
        Scanned {current.refName} at {current.commitSha.slice(0, 12)}
        {current.complete
          ? ""
          : ", partially (a manifest was unreadable or the scan was capped)"}.{" "}
        {current.uncataloguedDirectCount} direct dependencies match no catalogue entry.
      </p>
      <ul className="space-y-1">
        {current.categories
          .filter((category) => category.components.length > 0)
          .map((category) => (
            <li key={category.categoryId}>
              <span className="text-foreground">
                {categoryNames.get(category.categoryId) ?? category.categoryId}
              </span>
              <span className="text-muted-foreground">
                {": "}
                {category.components
                  .map((component) => `${component.name} (${component.evidence.join(", ")})`)
                  .join("; ")}
              </span>
            </li>
          ))}
      </ul>
      {inventory.pending.length > 0 && (
        <p className="text-muted-foreground">
          {inventory.pending.length} agent branch{inventory.pending.length === 1 ? "" : "es"} in
          flight: {inventory.pending.map((pending) => pending.refName).join(", ")}
        </p>
      )}
    </div>
  );
}

/** Workspace roll-up per category, then each repository's status per category. */
export function StackAdoptionSettings() {
  const { data: categories = [] } = useSWR(
    "/api/component-categories",
    fetchJson<ComponentCategory[]>
  );
  const { data: rollups = [], isLoading: loadingRollup } = useSWR(
    "/api/stack-inventory/rollup",
    fetchJson<CategoryAdoptionRollup[]>
  );
  const { data: repositories = [], isLoading: loadingRepositories } = useSWR(
    "/api/stack-inventory",
    fetchJson<RepositoryStackInventory[]>
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

  return (
    <div className="space-y-10">
      <section aria-labelledby="adoption-rollup-heading">
        <h3 id="adoption-rollup-heading" className="text-base font-semibold text-foreground">
          Is the standard winning?
        </h3>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Each repository&apos;s base branch as of its most recent session, counted per category.
        </p>
        <ul aria-label="Status legend" className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {ADOPTION_STATUS_ORDER.map((status) => (
            <li key={status}>
              <StatusMark status={status} />
            </li>
          ))}
        </ul>
        {loadingRollup ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading...</p>
        ) : rollups.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Nothing to count yet. Repositories appear after their first session.
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {rollups.map((rollup) => (
              <RollupBar
                key={rollup.categoryId}
                rollup={rollup}
                name={categoryNames.get(rollup.categoryId) ?? rollup.categoryId}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="adoption-repositories-heading">
        <h3 id="adoption-repositories-heading" className="text-base font-semibold text-foreground">
          Repositories
        </h3>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Open a repository to see the files and packages behind each status.
        </p>
        {loadingRepositories ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading...</p>
        ) : repositories.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No repositories scanned yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">Stack adoption by repository and category</caption>
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Repository
                  </th>
                  {categories.map((category) => (
                    <th key={category.id} scope="col" className="px-3 py-2 font-medium">
                      {category.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {repositories.map((inventory) => {
                  const name = formatRepositoryFullName(inventory.repository);
                  const statuses = new Map(
                    inventory.current?.categories.map((category) => [
                      category.categoryId,
                      category.status,
                    ]) ?? []
                  );
                  return (
                    <Fragment key={name}>
                      <tr>
                        <th scope="row" className="px-3 py-2 font-normal">
                          {inventory.current ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              aria-expanded={expanded === name}
                              onClick={() => setExpanded(expanded === name ? null : name)}
                              className="-ml-2 font-normal"
                            >
                              {name}
                            </Button>
                          ) : (
                            <span className="text-foreground">{name}</span>
                          )}
                        </th>
                        {categories.map((category) => (
                          <td key={category.id} className="px-3 py-2 text-xs">
                            {inventory.current ? (
                              <StatusMark status={statuses.get(category.id) ?? "absent"} />
                            ) : (
                              <span className="text-muted-foreground">Not scanned</span>
                            )}
                          </td>
                        ))}
                      </tr>
                      {expanded === name && (
                        <tr>
                          <td colSpan={categories.length + 1} className="p-0">
                            <RepositoryEvidence
                              inventory={inventory}
                              categoryNames={categoryNames}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Every data resource internal apps keep, for the people who answer "where is our data?". */
export function AppDataInventorySettings() {
  const { data, error, isLoading } = useSWR(
    "/api/app-data/inventory",
    fetchJson<{ rows: AppDataInventoryRow[]; nextCursor: string | null }>
  );
  const rows = data?.rows ?? [];
  const unavailable = error instanceof GovernanceRequestError && error.status === 404;

  return (
    <section aria-labelledby="app-data-inventory-heading">
      <h3 id="app-data-inventory-heading" className="text-base font-semibold text-foreground">
        App data
      </h3>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Databases, key-value stores and buckets that internal apps keep, with their classification.
      </p>
      {isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading...</p>
      ) : unavailable ? (
        <p className="mt-4 text-sm text-muted-foreground">
          App data is not enabled on this workspace.
        </p>
      ) : error ? (
        <p className="mt-4 text-sm text-destructive">
          {error instanceof Error ? error.message : "App data inventory unavailable"}
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No internal app keeps data yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">App data resources</caption>
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                {["App", "Stage", "Binding", "Store", "Classification", "Status", "Size"].map(
                  (heading) => (
                    <th key={heading} scope="col" className="px-3 py-2 font-medium">
                      {heading}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={`${row.appName}:${row.stage}:${row.binding}`}>
                  <th scope="row" className="px-3 py-2 font-normal text-foreground">
                    {row.appName}
                  </th>
                  <td className="px-3 py-2">{row.stage}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.binding}</td>
                  <td className="px-3 py-2 uppercase">{row.kind}</td>
                  <td className="px-3 py-2">{row.classification}</td>
                  <td className="px-3 py-2">{row.status}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.sizeBytes === null
                      ? "Unknown"
                      : MEGABYTES.format(row.sizeBytes / 1_000_000)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
