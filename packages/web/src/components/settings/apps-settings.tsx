"use client";

import { useId, useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { toast } from "sonner";
import type { AppDirectoryEntry, AppStatus } from "@open-inspect/shared/apps";
import { resolveScopedPermission } from "@open-inspect/shared/rbac";
import {
  APP_STAGES,
  DATA_CLASSIFICATIONS,
  D1_POINT_IN_TIME_RECOVERY_DAYS,
  type AppDataMigrationView,
  type AppDataOperationView,
  type AppDataResourceView,
  type AppDataSummary,
  type AppStage,
  type DataClassification,
  type DataOperationKind,
} from "@open-inspect/shared/types/app-data";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import type { BrowserApiPath } from "@/lib/browser-api-fetch";
import { formatRelativeTime } from "@/lib/time";
import { GovernanceRequestError, fetchJson, writeJson } from "./governance-api";

const APPS_KEY = "/api/apps";
const OPERATIONS_PAGE_SIZE = 20;
const TAKEDOWN_REASON_MAX_LENGTH = 500;
const DAY_MS = 86_400_000;
/** Stages always offered; v1 deploys production only, so other stages appear only with data. */
const DEFAULT_STAGES: readonly AppStage[] = ["production"];

const DATE_TIME = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const MEGABYTES = new Intl.NumberFormat("en", {
  style: "unit",
  unit: "megabyte",
  maximumFractionDigits: 1,
});

const STATUS_LABEL: Record<AppStatus, string> = {
  pending: "Deploying",
  live: "Live",
  failed: "Failed",
  taken_down: "Taken down",
};

const CLASSIFICATION_LABEL: Record<DataClassification, string> = {
  internal: "Internal",
  confidential: "Confidential",
  restricted: "Restricted",
};

const OPERATION_LABEL: Record<DataOperationKind, string> = {
  provision: "Provisioned",
  reinstate: "Reinstated",
  retire: "Retired",
  purge: "Purged",
  migrate: "Migrated",
  approve_migration: "Approved schema change",
  secret_set: "Set secret",
  secret_delete: "Deleted secret",
  restore: "Restored",
  classify: "Classified",
  policy_block: "Blocked by policy",
};

type AppsResponse = { apps: AppDirectoryEntry[] };
type OperationsPage = { operations: AppDataOperationView[]; nextCursor: string | null };

function appPath(name: string, suffix = ""): BrowserApiPath {
  return `/api/apps/${encodeURIComponent(name)}${suffix}`;
}

function isHostingUnavailable(error: unknown): boolean {
  return error instanceof GovernanceRequestError && error.status === 503;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "Request failed" ? error.message : fallback;
}

function ago(at: number): string {
  const relative = formatRelativeTime(at);
  return relative === "now" ? "just now" : `${relative} ago`;
}

function formatWhen(at: number): string {
  return `${DATE_TIME.format(at)} (${ago(at)})`;
}

/** `YYYY-MM-DDTHH:mm` in local time, the value a datetime-local input reads and writes. */
function toLocalInputValue(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function StatusBadge({ status }: { status: AppStatus }) {
  const variant =
    status === "live"
      ? "pr-merged"
      : status === "taken_down" || status === "failed"
        ? "pr-closed"
        : "pr-draft";
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

/** The apps directory: everyone with `apps.read` browses it; management follows `apps.manage`. */
export function AppsSettings() {
  const { authorization } = useCurrentUserAuthorization();
  const scope = authorization
    ? resolveScopedPermission("apps.manage", authorization.permissions)
    : null;
  const viewerId = authorization?.userId ?? null;
  const { data, error, isLoading } = useSWR(APPS_KEY, fetchJson<AppsResponse>);
  const apps = data?.apps ?? [];
  const own = apps.filter((app) => app.owner.userId === viewerId);
  const others = apps.filter((app) => app.owner.userId !== viewerId);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Apps</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Internal apps that agents published for your workspace. Every app sits behind company
          sign-in. Owners manage their own apps and the data they keep.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : isHostingUnavailable(error) ? (
        <div className="rounded-md border border-border bg-muted/30 p-4">
          <p className="text-sm text-foreground">App hosting is not set up for this workspace.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Once an administrator configures it, apps that agents publish appear here.
          </p>
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{errorMessage(error, "Apps are unavailable")}</p>
      ) : (
        <>
          <AppSection
            title="Your apps"
            empty="You have not published an app yet. Ask an agent to build one."
            apps={own}
            scope={scope}
            viewerId={viewerId}
          />
          <AppSection
            title={scope === "any" ? "All other apps" : "Other apps in the workspace"}
            empty="No one else has published an app yet."
            apps={others}
            scope={scope}
            viewerId={viewerId}
          />
        </>
      )}
    </div>
  );
}

function AppSection({
  title,
  empty,
  apps,
  scope,
  viewerId,
}: {
  title: string;
  empty: string;
  apps: AppDirectoryEntry[];
  scope: "own" | "any" | null;
  viewerId: string | null;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="text-base font-semibold text-foreground">
        {title}
      </h3>
      {apps.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul aria-labelledby={headingId} className="mt-3 space-y-3">
          {apps.map((app) => (
            <AppRow key={app.name} app={app} viewerId={viewerId} scope={scope} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AppRow({
  app,
  viewerId,
  scope,
}: {
  app: AppDirectoryEntry;
  viewerId: string | null;
  scope: "own" | "any" | null;
}) {
  const { mutate } = useSWRConfig();
  const headingId = useId();
  const [takingDown, setTakingDown] = useState(false);
  const [showData, setShowData] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const isOwner = app.owner.userId === viewerId;
  const canManageAny = scope === "any";
  const canManage = canManageAny || (scope === "own" && isOwner);
  const hold = app.takedown;
  const adminHold = hold?.kind === "admin_takedown";
  const canRelease = canManage && hold?.cleanupComplete === true && (!adminHold || canManageAny);
  const canTakeDown = canManage && (app.status !== "taken_down" || hold?.cleanupComplete === false);

  async function release() {
    setReleasing(true);
    try {
      await writeJson(appPath(app.name, "/release-hold"), "POST", {});
      toast.success(`${app.name} can be deployed again`);
      await mutate(APPS_KEY);
    } catch (error) {
      toast.error(errorMessage(error, "Could not release the hold"));
    } finally {
      setReleasing(false);
    }
  }

  return (
    <li aria-labelledby={headingId} className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h4 id={headingId} className="text-sm font-semibold text-foreground">
              {app.name}
            </h4>
            <StatusBadge status={app.status} />
          </div>
          {app.status === "taken_down" ? (
            <p className="break-all text-xs text-muted-foreground">{app.url}</p>
          ) : (
            <a
              href={app.url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-xs text-accent hover:underline"
            >
              {app.url}
            </a>
          )}
          <p className="text-xs text-muted-foreground">
            Owner: {app.owner.displayName ?? app.owner.userId}
            {" · "}
            {app.lastDeployedAt === null
              ? "Never deployed"
              : `Last deployed ${formatWhen(app.lastDeployedAt)}, version ${app.version}`}
            {app.lastRepo ? ` from ${app.lastRepo.owner}/${app.lastRepo.name}` : ""}
          </p>
          {app.lastErrorReason && (
            <p className="text-xs text-destructive">Last deploy failed: {app.lastErrorReason}</p>
          )}
          {hold && (
            <p className="text-xs text-foreground">
              {adminHold ? "Taken down by an administrator" : "Unpublished by its owner"}{" "}
              {ago(hold.at)}: {hold.reason}
            </p>
          )}
          {hold && !hold.cleanupComplete && (
            <p className="text-xs text-muted-foreground">
              Cleanup is incomplete. Take the app down again to finish, then release it.
            </p>
          )}
          {canManage && adminHold && !canManageAny && (
            <p className="text-xs text-muted-foreground">
              Only an administrator can release this hold.
            </p>
          )}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              aria-expanded={showData}
              onClick={() => setShowData(!showData)}
            >
              Data
            </Button>
            {canRelease && (
              <Button size="xs" variant="outline" disabled={releasing} onClick={release}>
                Release hold
              </Button>
            )}
            {canTakeDown && !takingDown && (
              <Button size="xs" variant="destructive" onClick={() => setTakingDown(true)}>
                Take down
              </Button>
            )}
          </div>
        )}
      </div>
      {takingDown && (
        <TakedownForm
          app={app}
          placesAdminHold={canManageAny && !isOwner}
          onDone={() => setTakingDown(false)}
        />
      )}
      {canManage && showData && (
        <AppDataPanel name={app.name} viewerId={viewerId} canManageAny={canManageAny} />
      )}
    </li>
  );
}

function TakedownForm({
  app,
  placesAdminHold,
  onDone,
}: {
  app: AppDirectoryEntry;
  placesAdminHold: boolean;
  onDone: () => void;
}) {
  const { mutate } = useSWRConfig();
  const inputId = useId();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const result = await writeJson<{ cleanupComplete: boolean }>(
        appPath(app.name, "/takedown"),
        "POST",
        { reason: trimmed }
      );
      toast.success(
        result.cleanupComplete
          ? `${app.name} is taken down`
          : `${app.name} is offline; cleanup will need another takedown to finish`
      );
      await mutate(APPS_KEY);
      onDone();
    } catch (error) {
      toast.error(errorMessage(error, "Could not take the app down"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-2 border-t border-border pt-4">
      <Label htmlFor={inputId}>Reason for taking down {app.name}</Label>
      <Textarea
        id={inputId}
        value={reason}
        maxLength={TAKEDOWN_REASON_MAX_LENGTH}
        required
        onChange={(event) => setReason(event.target.value)}
        rows={2}
      />
      <p className="text-xs text-muted-foreground">
        The app goes offline at once and its owner sees this reason.
        {placesAdminHold ? " Only an administrator can release the hold afterwards." : ""}
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={saving || !reason.trim()}>
          Confirm takedown
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AppDataPanel({
  name,
  viewerId,
  canManageAny,
}: {
  name: string;
  viewerId: string | null;
  canManageAny: boolean;
}) {
  const summaryKey = appPath(name, "/data");
  const { data, error, isLoading, mutate } = useSWR(summaryKey, fetchJson<AppDataSummary>);
  const operations = useSWRInfinite<OperationsPage>(
    (index, previous: OperationsPage | null) => {
      if (index > 0 && !previous?.nextCursor) return null;
      const query = new URLSearchParams({ limit: String(OPERATIONS_PAGE_SIZE) });
      if (previous?.nextCursor) query.set("cursor", previous.nextCursor);
      return appPath(name, `/data/operations?${query}`);
    },
    (path: BrowserApiPath) => fetchJson<OperationsPage>(path)
  );

  async function refresh() {
    await Promise.all([mutate(), operations.mutate()]);
  }

  if (isLoading) return <p className="mt-4 text-sm text-muted-foreground">Loading data...</p>;
  if (isHostingUnavailable(error)) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        App data is unavailable while app hosting is not set up.
      </p>
    );
  }
  if (error || !data) {
    return (
      <p className="mt-4 text-sm text-destructive">{errorMessage(error, "App data unavailable")}</p>
    );
  }

  return (
    <section aria-label={`${name} data`} className="mt-4 space-y-6 border-t border-border pt-4">
      <ClassificationControl
        name={name}
        summary={data}
        canManageAny={canManageAny}
        onChanged={refresh}
      />
      <ResourcesTable resources={data.resources} />
      <SchemaChanges name={name} summary={data} onChanged={refresh} />
      <Secrets name={name} summary={data} onChanged={refresh} />
      <Restore name={name} summary={data} canManageAny={canManageAny} onChanged={refresh} />
      <OperationsLedger
        pages={operations.data ?? []}
        loading={operations.isLoading}
        error={operations.error}
        viewerId={viewerId}
        onMore={() => operations.setSize(operations.size + 1)}
      />
    </section>
  );
}

function PanelHeading({ children }: { children: React.ReactNode }) {
  return <h5 className="text-sm font-medium text-foreground">{children}</h5>;
}

function ClassificationControl({
  name,
  summary,
  canManageAny,
  onChanged,
}: {
  name: string;
  summary: AppDataSummary;
  canManageAny: boolean;
  onChanged: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  async function change(classification: DataClassification) {
    if (classification === summary.classification) return;
    setSaving(true);
    try {
      await writeJson(appPath(name, "/data/classification"), "PUT", { classification });
      toast.success(`${name} is now ${CLASSIFICATION_LABEL[classification].toLowerCase()}`);
      await onChanged();
    } catch (error) {
      toast.error(errorMessage(error, "Could not change the classification"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <PanelHeading>Classification</PanelHeading>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="info">{CLASSIFICATION_LABEL[summary.classification]}</Badge>
        {summary.classificationSource === "admin"
          ? "Set by an administrator"
          : "Declared by the app"}
      </p>
      {canManageAny && (
        <SegmentedControl
          label="Data classification"
          value={summary.classification}
          options={DATA_CLASSIFICATIONS.map((value) => ({
            value,
            label: CLASSIFICATION_LABEL[value],
          }))}
          disabled={saving}
          onValueChange={change}
        />
      )}
    </div>
  );
}

function ResourcesTable({ resources }: { resources: readonly AppDataResourceView[] }) {
  return (
    <div className="space-y-2">
      <PanelHeading>Resources</PanelHeading>
      {resources.length === 0 ? (
        <p className="text-xs text-muted-foreground">This app keeps no data.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[32rem] text-left text-xs">
            <caption className="sr-only">Data resources</caption>
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["Binding", "Store", "Stage", "Status", "Size"].map((heading) => (
                  <th key={heading} scope="col" className="px-3 py-2 font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {resources.map((resource) => (
                <tr key={resource.id}>
                  <th scope="row" className="px-3 py-2 font-mono font-normal text-foreground">
                    {resource.binding}
                  </th>
                  <td className="px-3 py-2 uppercase">{resource.kind}</td>
                  <td className="px-3 py-2">{resource.stage}</td>
                  <td className="px-3 py-2">{resource.status}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {resource.sizeBytes === null
                      ? "Unknown"
                      : MEGABYTES.format(resource.sizeBytes / 1_000_000)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** A migration names its binding, not its stage; v1 databases live in one stage per binding. */
function migrationStage(summary: AppDataSummary, migration: AppDataMigrationView): AppStage {
  const stages = summary.resources
    .filter((resource) => resource.kind === "d1" && resource.binding === migration.binding)
    .map((resource) => resource.stage);
  return stages.includes("production") ? "production" : (stages[0] ?? "production");
}

function SchemaChanges({
  name,
  summary,
  onChanged,
}: {
  name: string;
  summary: AppDataSummary;
  onChanged: () => Promise<void>;
}) {
  const [approving, setApproving] = useState<string | null>(null);
  const migrations = [...summary.migrations].sort(
    (left, right) =>
      Number(right.status === "blocked") - Number(left.status === "blocked") ||
      left.name.localeCompare(right.name)
  );

  async function approve(migration: AppDataMigrationView) {
    setApproving(migration.name);
    try {
      await writeJson(appPath(name, "/data/migrations/approve"), "POST", {
        stage: migrationStage(summary, migration),
        binding: migration.binding,
        name: migration.name,
        sha256: migration.sha256,
      });
      toast.success(`Approved ${migration.name}. Deploy the app again to apply it.`);
      await onChanged();
    } catch (error) {
      toast.error(errorMessage(error, "Could not approve the schema change"));
    } finally {
      setApproving(null);
    }
  }

  return (
    <div className="space-y-2">
      <PanelHeading>Schema changes</PanelHeading>
      {summary.pendingApprovals > 0 && (
        <p className="text-xs text-foreground">
          {summary.pendingApprovals} schema change{summary.pendingApprovals === 1 ? "" : "s"} would
          drop or rewrite data and wait for approval. A backup point was recorded first.
        </p>
      )}
      {migrations.length === 0 ? (
        <p className="text-xs text-muted-foreground">No schema changes yet.</p>
      ) : (
        <ul aria-label="Schema changes" className="space-y-2">
          {migrations.map((migration) => (
            <li
              key={`${migration.binding}:${migration.name}`}
              aria-label={migration.name}
              className="rounded-md border border-border p-3 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-foreground">
                  <span className="font-mono">{migration.name}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    on {migration.binding} · {migration.classification} ·{" "}
                    <span title={migration.sha256}>sha256 {migration.sha256.slice(0, 12)}</span>
                  </span>
                </p>
                {migration.status === "blocked" ? (
                  <Button
                    size="xs"
                    disabled={approving !== null}
                    onClick={() => approve(migration)}
                  >
                    Approve {migration.name}
                  </Button>
                ) : (
                  <Badge>{migration.status}</Badge>
                )}
              </div>
              {migration.statements.length > 0 && (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-sm bg-muted p-2 font-mono">
                  {migration.statements.join("\n")}
                </pre>
              )}
              {migration.error && <p className="mt-2 text-destructive">{migration.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function stagesOf(summary: AppDataSummary): AppStage[] {
  const present = new Set<AppStage>([
    ...DEFAULT_STAGES,
    ...summary.secrets.map((secret) => secret.stage),
    ...summary.resources.map((resource) => resource.stage),
  ]);
  return APP_STAGES.filter((stage) => present.has(stage));
}

function Secrets({
  name,
  summary,
  onChanged,
}: {
  name: string;
  summary: AppDataSummary;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="space-y-2">
      <PanelHeading>Secrets</PanelHeading>
      <p className="text-xs text-muted-foreground">
        Values are write-only: nobody, including agents, can read them back.
      </p>
      {stagesOf(summary).map((stage) => {
        const set = new Map(
          summary.secrets
            .filter((secret) => secret.stage === stage)
            .map((secret) => [secret.name as string, secret.updatedAt])
        );
        const declared = new Set<string>(summary.declaredSecrets);
        const names = [...new Set<string>([...declared, ...set.keys()])].sort();
        return (
          <div key={stage} className="space-y-1">
            <p className="text-xs font-medium capitalize text-foreground">{stage}</p>
            {names.length === 0 ? (
              <p className="text-xs text-muted-foreground">This app declares no secrets.</p>
            ) : (
              <ul aria-label={`${stage} secrets`} className="space-y-2">
                {names.map((key) => (
                  <SecretRow
                    key={key}
                    app={name}
                    stage={stage}
                    secretName={key}
                    declared={declared.has(key)}
                    updatedAt={set.get(key) ?? null}
                    onChanged={onChanged}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SecretRow({
  app,
  stage,
  secretName,
  declared,
  updatedAt,
  onChanged,
}: {
  app: string;
  stage: AppStage;
  secretName: string;
  declared: boolean;
  updatedAt: number | null;
  onChanged: () => Promise<void>;
}) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!value) return;
    setSaving(true);
    try {
      await writeJson(appPath(app, "/data/secrets"), "POST", {
        stage,
        secrets: { [secretName]: value },
      });
      toast.success(`${secretName} saved`);
      await onChanged();
    } catch (error) {
      toast.error(errorMessage(error, `Could not save ${secretName}`));
    } finally {
      setValue("");
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await writeJson(
        appPath(
          app,
          `/data/secrets/${encodeURIComponent(secretName)}?${new URLSearchParams({ stage })}`
        ),
        "DELETE"
      );
      toast.success(`${secretName} deleted`);
      await onChanged();
    } catch (error) {
      toast.error(errorMessage(error, `Could not delete ${secretName}`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li aria-label={secretName} className="rounded-md border border-border p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-mono text-foreground">{secretName}</span>{" "}
          <span className="text-muted-foreground">
            {updatedAt === null ? "Not set" : `Set ${ago(updatedAt)}`}
            {declared ? "" : " · no longer declared by the app"}
          </span>
        </p>
        {updatedAt !== null && (
          <Button size="xs" variant="destructive" disabled={saving} onClick={remove}>
            Delete {secretName}
          </Button>
        )}
      </div>
      {declared && (
        <form onSubmit={save} className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1 space-y-1">
            <Label htmlFor={inputId} className="text-xs">
              New value for {secretName}
            </Label>
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={saving || !value}>
            {updatedAt === null ? "Set" : "Replace"} {secretName}
          </Button>
        </form>
      )}
    </li>
  );
}

function Restore({
  name,
  summary,
  canManageAny,
  onChanged,
}: {
  name: string;
  summary: AppDataSummary;
  canManageAny: boolean;
  onChanged: () => Promise<void>;
}) {
  const databases = summary.resources.filter(
    (resource) => resource.kind === "d1" && resource.status === "ready"
  );
  const restricted = summary.classification === "restricted" && !canManageAny;
  return (
    <div className="space-y-2">
      <PanelHeading>Restore a database</PanelHeading>
      {databases.length === 0 ? (
        <p className="text-xs text-muted-foreground">This app has no database to restore.</p>
      ) : restricted ? (
        <p className="text-xs text-muted-foreground">
          Restricted data is restored by an administrator who manages every app.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Roll a database back to any moment in the last {summary.pointInTimeRecoveryDays} days.
            Changes made after that moment are replaced; the current state is bookmarked first.
          </p>
          {databases.map((database) => (
            <RestoreForm key={database.id} app={name} database={database} onChanged={onChanged} />
          ))}
        </>
      )}
    </div>
  );
}

function RestoreForm({
  app,
  database,
  onChanged,
}: {
  app: string;
  database: AppDataResourceView;
  onChanged: () => Promise<void>;
}) {
  const timeId = useId();
  const confirmId = useId();
  const [restoreAt, setRestoreAt] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const binding = database.binding;
  const now = Date.now();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const timestamp = new Date(restoreAt).getTime();
    if (!Number.isFinite(timestamp) || confirm !== binding) return;
    if (
      timestamp > Date.now() ||
      timestamp < Date.now() - D1_POINT_IN_TIME_RECOVERY_DAYS * DAY_MS
    ) {
      toast.error(`Choose a moment in the last ${D1_POINT_IN_TIME_RECOVERY_DAYS} days`);
      return;
    }
    setSaving(true);
    try {
      await writeJson(appPath(app, "/data/restore"), "POST", {
        stage: database.stage,
        binding,
        target: { timestamp },
        confirmBinding: confirm,
      });
      toast.success(`${binding} restored to ${DATE_TIME.format(timestamp)}`);
      setConfirm("");
      setRestoreAt("");
      await onChanged();
    } catch (error) {
      toast.error(errorMessage(error, `Could not restore ${binding}`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-label={`Restore ${binding}`}
      className="grid gap-2 rounded-md border border-border p-3 text-xs sm:grid-cols-[1fr_1fr_auto] sm:items-end"
    >
      <div className="space-y-1">
        <Label htmlFor={timeId} className="text-xs">
          Restore {binding} to
        </Label>
        <Input
          id={timeId}
          type="datetime-local"
          value={restoreAt}
          min={toLocalInputValue(now - D1_POINT_IN_TIME_RECOVERY_DAYS * DAY_MS)}
          max={toLocalInputValue(now)}
          onChange={(event) => setRestoreAt(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={confirmId} className="text-xs">
          Type {binding} to confirm
        </Label>
        <Input
          id={confirmId}
          value={confirm}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="destructive"
        disabled={saving || !restoreAt || confirm !== binding}
      >
        Restore {binding}
      </Button>
    </form>
  );
}

function operationActor(actor: AppDataOperationView["actor"], viewerId: string | null): string {
  if (actor.kind === "user") return actor.userId === viewerId ? "You" : actor.userId;
  if (actor.kind === "session") return `Agent session ${actor.sessionId}`;
  return `System (${actor.job})`;
}

function OperationsLedger({
  pages,
  loading,
  error,
  viewerId,
  onMore,
}: {
  pages: OperationsPage[];
  loading: boolean;
  error: unknown;
  viewerId: string | null;
  onMore: () => void;
}) {
  const rows = pages.flatMap((page) => page.operations);
  const hasMore = pages.length > 0 && pages[pages.length - 1]?.nextCursor !== null;
  return (
    <div className="space-y-2">
      <PanelHeading>Operations</PanelHeading>
      {error ? (
        <p className="text-xs text-destructive">{errorMessage(error, "Operations unavailable")}</p>
      ) : loading && rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing has happened to this data yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[36rem] text-left text-xs">
            <caption className="sr-only">Data operations</caption>
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["When", "Operation", "Result", "Target", "By"].map((heading) => (
                  <th key={heading} scope="col" className="px-3 py-2 font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((operation) => (
                <tr key={operation.id}>
                  <td className="px-3 py-2 text-muted-foreground">
                    {DATE_TIME.format(operation.occurredAt)}
                  </td>
                  <th scope="row" className="px-3 py-2 font-normal text-foreground">
                    {OPERATION_LABEL[operation.kind]}
                  </th>
                  <td className="px-3 py-2">{operation.result}</td>
                  <td className="px-3 py-2 font-mono">
                    {[operation.stage, operation.binding].filter(Boolean).join(" / ") || "App"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {operationActor(operation.actor, viewerId)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <Button size="xs" variant="outline" disabled={loading} onClick={onMore}>
          Load more operations
        </Button>
      )}
    </div>
  );
}
