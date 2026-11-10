"use client";

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useState, useCallback, type ClipboardEvent } from "react";
import { toast } from "sonner";
import type {
  CreateMcpServerRequest,
  McpServerLifecycle,
  McpServerMetadata,
} from "@open-inspect/shared/types/integrations";
import {
  DEFAULT_MCP_SERVER_ENABLED,
  DEFAULT_MCP_SERVER_LIFECYCLE,
} from "@open-inspect/shared/types/integrations";
import {
  useMcpServers,
  createMcpServer,
  updateMcpServer,
  updateMcpServerCredentials,
  deleteMcpServer,
} from "@/hooks/use-mcp-servers";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { syncGovernanceCatalog, useGovernanceCatalog } from "@/hooks/use-governance-catalog";
import { parseMaybeEnvContent } from "@/lib/env-paste";
import { PlusIcon, TerminalIcon, GlobeIcon, ChevronRightIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioCard } from "@/components/ui/form-controls";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

type ScopeMode = "global" | "selected";
type Editor =
  | { kind: "new"; draftId: string }
  | { kind: "existing"; draftId: string; id: string; revision: number };

type EnvRow = { id: string; key: string; value: string };

function createEnvRow(init?: { key: string; value: string }): EnvRow {
  return { id: crypto.randomUUID(), key: init?.key ?? "", value: init?.value ?? "" };
}

function envRowsToRecord(rows: EnvRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (k && row.value) result[k] = row.value;
  }
  return result;
}

type FormState = {
  name: string;
  type: "local" | "remote";
  command: string;
  url: string;
  envRows: EnvRow[];
  repoScopes: string[];
  environmentScopes: string[];
  scopeMode: ScopeMode;
  lifecycle: McpServerLifecycle;
  enabled: boolean;
};

const emptyForm: FormState = {
  name: "",
  type: "local",
  command: "",
  url: "",
  envRows: [createEnvRow()],
  repoScopes: [],
  environmentScopes: [],
  scopeMode: "global",
  lifecycle: DEFAULT_MCP_SERVER_LIFECYCLE,
  enabled: DEFAULT_MCP_SERVER_ENABLED,
};

function metadataToForm(metadata: McpServerMetadata): FormState {
  return {
    name: metadata.name,
    type: metadata.type,
    command:
      metadata.command
        ?.map((t) =>
          /[\s$`#!&|;<>(){}\\"]/.test(t) ? `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : t
        )
        .join(" ") ?? "",
    url: metadata.url ?? "",
    envRows: [createEnvRow()],
    repoScopes: metadata.repoScopes ?? [],
    environmentScopes: metadata.environmentScopes ?? [],
    scopeMode:
      metadata.repoScopes?.length || metadata.environmentScopes?.length ? "selected" : "global",
    lifecycle: metadata.lifecycle,
    enabled: metadata.enabled,
  };
}

function scopeSummary(server: McpServerMetadata): string {
  const scopes: string[] = [];
  if (server.repoScopes?.length) {
    scopes.push(
      server.repoScopes.length === 1 ? server.repoScopes[0] : `${server.repoScopes.length} repos`
    );
  }
  if (server.environmentScopes?.length) {
    scopes.push(
      server.environmentScopes.length === 1
        ? `environment ${server.environmentScopes[0]}`
        : `${server.environmentScopes.length} environments`
    );
  }
  return scopes.length > 0 ? scopes.join(" · ") : "global";
}

/** Minimal shell-quote aware parser: respects "..." and '...' grouping. */
function parseCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function EnvRowsEditor({
  form,
  setForm,
  hasExistingCredentials,
}: {
  form: FormState;
  setForm: (form: FormState) => void;
  hasExistingCredentials?: boolean;
}) {
  const isRemote = form.type === "remote";
  const label = isRemote ? "HTTP Headers" : "Environment Variables";
  const keyPlaceholder = isRemote ? "Header-Name" : "KEY_NAME";
  const valuePlaceholder = isRemote ? "value" : "value";

  const updateRow = useCallback(
    (id: string, field: "key" | "value", val: string) => {
      setForm({
        ...form,
        envRows: form.envRows.map((r) => (r.id === id ? { ...r, [field]: val } : r)),
      });
    },
    [form, setForm]
  );

  const removeRow = useCallback(
    (id: string) => {
      const next = form.envRows.filter((r) => r.id !== id);
      setForm({ ...form, envRows: next.length > 0 ? next : [createEnvRow()] });
    },
    [form, setForm]
  );

  const addRow = useCallback(() => {
    setForm({ ...form, envRows: [...form.envRows, createEnvRow()] });
  }, [form, setForm]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      const text = event.clipboardData.getData("text");
      const parsed = parseMaybeEnvContent(text);
      if (parsed.length === 0) return;

      event.preventDefault();

      const next = [...form.envRows];
      const keyToIndex = new Map<string, number>();
      next.forEach((row, i) => {
        if (row.key.trim()) keyToIndex.set(row.key.trim(), i);
      });

      for (const entry of parsed) {
        const existing = keyToIndex.get(entry.key);
        if (existing !== undefined) {
          next[existing] = { ...next[existing], key: entry.key, value: entry.value };
          continue;
        }
        const emptyIdx = next.findIndex(
          (r) => !keyToIndex.has(r.key.trim()) && !r.key.trim() && !r.value.trim()
        );
        if (emptyIdx >= 0) {
          next[emptyIdx] = { ...next[emptyIdx], key: entry.key, value: entry.value };
          keyToIndex.set(entry.key, emptyIdx);
        } else {
          next.push(createEnvRow({ key: entry.key, value: entry.value }));
          keyToIndex.set(entry.key, next.length - 1);
        }
      }

      setForm({ ...form, envRows: next });
      toast.success(
        `Imported ${parsed.length} entr${parsed.length === 1 ? "y" : "ies"} from paste`
      );
    },
    [form, setForm]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label>
          {label} <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Button type="button" variant="subtle" size="xs" onClick={addRow}>
          + Add
        </Button>
      </div>
      {hasExistingCredentials && form.envRows.every((r) => !r.value.trim()) && (
        <p className="text-xs text-muted-foreground mb-1">
          Credentials are configured. Enter new values to replace them, or leave empty to keep
          existing.
        </p>
      )}
      <div className="space-y-1.5">
        {form.envRows.map((row) => (
          <div key={row.id} className="flex gap-1.5">
            <Input
              value={row.key}
              onChange={(e) => updateRow(row.id, "key", e.target.value)}
              onPaste={handlePaste}
              placeholder={keyPlaceholder}
              className="flex-1 min-w-[140px] font-mono text-xs h-8"
            />
            <Input
              type="password"
              value={row.value}
              onChange={(e) => updateRow(row.id, "value", e.target.value)}
              onPaste={handlePaste}
              placeholder={valuePlaceholder}
              className="flex-1 min-w-[180px] font-mono text-xs h-8"
            />
            <button
              type="button"
              onClick={() => removeRow(row.id)}
              className="px-1.5 text-muted-foreground hover:text-destructive transition"
              aria-label="Remove"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        Paste a <code className="text-xs">.env</code> block into any field to import multiple
        entries.
      </p>
    </div>
  );
}

interface McpServerFormProps {
  form: FormState;
  setForm: (form: FormState) => void;
  repos: { fullName: string; private?: boolean }[];
  environments: { id: string; name: string }[];
  loadingRepos: boolean;
  loadingEnvironments: boolean;
  radioPrefix: string;
  hasExistingCredentials?: boolean;
}

function McpServerForm({
  form,
  setForm,
  repos,
  environments,
  loadingRepos,
  loadingEnvironments,
  radioPrefix,
  hasExistingCredentials,
}: McpServerFormProps) {
  const selectedRepoScopes = new Set(form.repoScopes);
  const selectedEnvironmentScopes = new Set(form.environmentScopes);

  return (
    <>
      <div>
        <Label className="mb-1.5">Name</Label>
        <Input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. playwright, context7"
        />
      </div>

      <div>
        <Label className="mb-1.5">Type</Label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              setForm({
                ...form,
                type: "local",
                envRows: form.type === "local" ? form.envRows : [createEnvRow()],
              })
            }
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border transition ${
              form.type === "local"
                ? "border-foreground/30 text-foreground bg-muted"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <TerminalIcon className="w-3.5 h-3.5" />
            Local
          </button>
          <button
            type="button"
            onClick={() =>
              setForm({
                ...form,
                type: "remote",
                envRows: form.type === "remote" ? form.envRows : [createEnvRow()],
              })
            }
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border transition ${
              form.type === "remote"
                ? "border-foreground/30 text-foreground bg-muted"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <GlobeIcon className="w-3.5 h-3.5" />
            Remote
          </button>
        </div>
      </div>

      {form.type === "remote" ? (
        <div>
          <Label className="mb-1.5">URL</Label>
          <Input
            type="url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://mcp.example.com/sse"
          />
        </div>
      ) : (
        <div>
          <Label className="mb-1.5">Command</Label>
          <Input
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            placeholder="npx -y @playwright/mcp"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Space-separated command and arguments. Use quotes for arguments with spaces.
          </p>
        </div>
      )}

      <EnvRowsEditor
        form={form}
        setForm={setForm}
        hasExistingCredentials={hasExistingCredentials}
      />

      <div>
        <Label className="mb-1.5" htmlFor={`mcp-lifecycle-${radioPrefix}`}>
          Lifecycle
        </Label>
        <Select
          value={form.lifecycle}
          onValueChange={(value) => setForm({ ...form, lifecycle: value as McpServerLifecycle })}
        >
          <SelectTrigger
            id={`mcp-lifecycle-${radioPrefix}`}
            className="h-9 w-full rounded-sm border border-border bg-background px-3 text-sm text-foreground"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {" "}
            <SelectItem value="development">Development — catalogued but not installed</SelectItem>
            <SelectItem value="approved">Approved — installed in matching sessions</SelectItem>
            <SelectItem value="deprecated">Deprecated — retained but not installed</SelectItem>
          </SelectContent>
        </Select>
        {form.lifecycle === "approved" && form.type === "local" && (
          <p className="mt-1 text-xs text-muted-foreground">
            npx package names must use an exact version such as @scope/server@1.2.3.
          </p>
        )}
      </div>

      <div>
        <Label className="mb-1.5">Availability</Label>
        <div className="space-y-2 mb-2">
          <RadioCard
            name={`scope-mode-${radioPrefix}`}
            checked={form.scopeMode === "global"}
            onChange={() =>
              setForm({ ...form, scopeMode: "global", repoScopes: [], environmentScopes: [] })
            }
            label="All sessions"
            description="Available in every agent session"
          />
          <RadioCard
            name={`scope-mode-${radioPrefix}`}
            checked={form.scopeMode === "selected"}
            onChange={() => setForm({ ...form, scopeMode: "selected" })}
            label="Selected targets only"
            description="Only available in sessions for chosen repositories or environments"
          />
        </div>

        {form.scopeMode === "selected" && (
          <>
            {loadingRepos ? (
              <p className="text-sm text-muted-foreground px-3 py-2">Loading repositories...</p>
            ) : repos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-3 py-2 border border-border rounded-sm">
                No repositories available. Connect a GitHub integration first.
              </p>
            ) : (
              <div className="border border-border max-h-40 overflow-y-auto rounded-sm">
                {repos.map((repo) => {
                  const fullName = repo.fullName.toLowerCase();
                  const isChecked = selectedRepoScopes.has(fullName);
                  return (
                    <label
                      key={repo.fullName}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => {
                          const next = isChecked
                            ? form.repoScopes.filter((r) => r !== fullName)
                            : [...form.repoScopes, fullName];
                          setForm({ ...form, repoScopes: next });
                        }}
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                      {repo.private && (
                        <span className="text-xs text-muted-foreground">private</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
            <p className="mt-3 mb-1 text-xs font-medium text-muted-foreground">Environments</p>
            {loadingEnvironments ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">Loading environments...</p>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-sm border border-border">
                {environments.map((environment) => {
                  const isChecked = selectedEnvironmentScopes.has(environment.id);
                  return (
                    <label
                      key={environment.id}
                      className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() =>
                          setForm({
                            ...form,
                            environmentScopes: isChecked
                              ? form.environmentScopes.filter((id) => id !== environment.id)
                              : [...form.environmentScopes, environment.id],
                          })
                        }
                      />
                      <span className="text-foreground">{environment.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {form.repoScopes.length === 0 && form.environmentScopes.length === 0 && (
              <p className="mt-1 text-xs text-warning">
                Select a repository or environment, or switch to &quot;All sessions&quot;.
              </p>
            )}
          </>
        )}
      </div>

      <label
        htmlFor={`mcp-enabled-${radioPrefix}`}
        className="flex items-center justify-between cursor-pointer"
      >
        <span className="text-sm text-foreground">Enabled</span>
        <Switch
          id={`mcp-enabled-${radioPrefix}`}
          checked={form.enabled}
          onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
        />
      </label>
    </>
  );
}

/**
 * Lists workspace MCP servers and exposes create, edit, and delete controls only to authorized users.
 */
export function McpServersSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManage = hasPermission("mcp_servers.manage");
  const { servers, loading, mutate } = useMcpServers();
  const { repos, loading: loadingRepos } = useRepos();
  const { environments, loading: loadingEnvironments } = useEnvironments();
  const { status: governance, mutate: mutateGovernance } = useGovernanceCatalog();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const gitManaged = governance?.configured === true;

  async function syncGitCatalog() {
    try {
      await syncGovernanceCatalog();
      await Promise.all([mutate(), mutateGovernance()]);
      toast.success("Git governance catalog synced");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to sync catalog");
    }
  }

  function startNew() {
    setForm(emptyForm);
    setEditor({ kind: "new", draftId: crypto.randomUUID() });
  }

  function startEdit(server: McpServerMetadata) {
    if (editor?.kind === "existing" && editor.id === server.id) {
      setEditor(null);
    } else {
      setForm(metadataToForm(server));
      setEditor({
        kind: "existing",
        draftId: crypto.randomUUID(),
        id: server.id,
        revision: server.revision,
      });
    }
  }

  function cancel() {
    setEditor(null);
  }

  async function save() {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (form.type === "remote" && !form.url.trim()) {
      toast.error("URL is required for remote servers");
      return;
    }
    if (form.type === "local" && !form.command.trim()) {
      toast.error("Command is required for local servers");
      return;
    }
    if (
      form.scopeMode === "selected" &&
      form.repoScopes.length === 0 &&
      form.environmentScopes.length === 0
    ) {
      toast.error("Select at least one repository or environment, or switch to All sessions");
      return;
    }

    const saveOwner = editor;
    if (!saveOwner) return;
    setSaving(true);

    try {
      if (saveOwner.kind === "existing") {
        const existing = servers.find((server) => server.id === saveOwner.id);
        if (existing?.sourceKind === "git") {
          const credentials = envRowsToRecord(form.envRows);
          await updateMcpServerCredentials(existing.id, {
            revision: saveOwner.revision,
            ...(existing.type === "remote" ? { headers: credentials } : { env: credentials }),
          });
          toast.success("MCP credentials updated");
          setEditor((current) => (current?.draftId === saveOwner.draftId ? null : current));
          await mutate();
          return;
        }
      }
      const common = {
        name: form.name.trim(),
        enabled: form.enabled,
        repoScopes:
          form.scopeMode === "selected" && form.repoScopes.length > 0 ? form.repoScopes : null,
        environmentScopes:
          form.scopeMode === "selected" && form.environmentScopes.length > 0
            ? form.environmentScopes
            : null,
        lifecycle: form.lifecycle,
      };

      const envRecord = envRowsToRecord(form.envRows);
      const hasEnvValues = Object.keys(envRecord).length > 0;
      const includeCredentials = hasEnvValues || saveOwner.kind === "new";
      const payload: CreateMcpServerRequest =
        form.type === "remote"
          ? {
              ...common,
              type: "remote",
              url: form.url.trim(),
              ...(includeCredentials ? { headers: envRecord } : {}),
            }
          : {
              ...common,
              type: "local",
              command: parseCommand(form.command),
              ...(includeCredentials ? { env: envRecord } : {}),
            };

      if (saveOwner.kind === "new") {
        await createMcpServer(payload);
        toast.success("MCP server created");
      } else {
        await updateMcpServer(saveOwner.id, { ...payload, revision: saveOwner.revision });
        toast.success("MCP server updated");
      }

      setEditor((current) => (current?.draftId === saveOwner.draftId ? null : current));
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMcpServer(id);
      mutate();
      if (editor?.kind === "existing" && editor.id === id) {
        setEditor(null);
      }
      toast.success("MCP server deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
    setDeleteTarget(null);
  }

  async function handleToggle(server: McpServerMetadata) {
    try {
      await updateMcpServer(server.id, {
        enabled: !server.enabled,
        revision: server.revision,
      });
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-semibold text-foreground">MCP Servers</h2>
        {canManage && !gitManaged && (
          <Button onClick={startNew} variant="outline" size="sm">
            <span className="inline-flex items-center gap-1">
              <PlusIcon className="w-3.5 h-3.5" />
              Add Server
            </span>
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Configure Model Context Protocol servers that are available to agent sessions.
      </p>
      {gitManaged && (
        <div className="mb-6 flex items-start justify-between gap-4 rounded border border-border bg-muted/30 p-3">
          <p className="text-sm text-muted-foreground">
            Metadata is managed from {governance.source?.owner}/{governance.source?.name} at{" "}
            {governance.source?.ref}. Runtime package versions shown below are exact resolutions of
            the automatic Git policy.
            {governance.lastStatus === "failed" && governance.lastError
              ? ` The latest sync failed; the last good catalog remains active: ${governance.lastError}`
              : ""}
          </p>
          {canManage && (
            <Button variant="outline" size="sm" onClick={syncGitCatalog}>
              Sync now
            </Button>
          )}
        </div>
      )}

      {/* New server form */}
      {editor?.kind === "new" && (
        <div className="border border-border rounded-md p-4 mb-6 space-y-4">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-medium text-foreground">New MCP Server</h3>
            <Button variant="ghost" size="icon" onClick={cancel} aria-label="Close">
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>
          <McpServerForm
            form={form}
            setForm={setForm}
            repos={repos}
            environments={environments}
            loadingRepos={loadingRepos}
            loadingEnvironments={loadingEnvironments}
            radioPrefix="new"
          />
          <div className="flex gap-2 pt-2">
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Saving..." : "Add Server"}
            </Button>
            <Button onClick={cancel} variant="outline" size="sm">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Server list */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : servers.length === 0 && editor?.kind !== "new" ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          No MCP servers configured. Add one to extend agent capabilities.
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => {
            const isExpanded = editor?.kind === "existing" && editor.id === server.id;
            return (
              <div
                key={server.id}
                className={`border rounded-md transition ${
                  server.enabled
                    ? "border-border bg-card"
                    : "border-border/50 bg-card/50 opacity-60"
                }`}
              >
                {/* Header row */}
                <div className="flex items-center justify-between px-4 py-3">
                  <button
                    type="button"
                    className="flex items-center gap-3 min-w-0 cursor-pointer text-left"
                    disabled={!canManage}
                    onClick={() => {
                      if (canManage) startEdit(server);
                    }}
                  >
                    <ChevronRightIcon
                      className={`w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                    />
                    {server.type === "remote" ? (
                      <GlobeIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    ) : (
                      <TerminalIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {server.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {server.type === "remote" ? server.url : server.command?.join(" ")}
                        <span
                          className={`ml-2 ${
                            server.repoScopes?.length || server.environmentScopes?.length
                              ? "text-accent"
                              : "text-muted-foreground/60"
                          }`}
                        >
                          • {scopeSummary(server)}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {server.lifecycle} · created by {server.createdBy}
                        {server.sourceKind === "git" && server.resolvedVersion
                          ? ` · resolved ${server.resolvedVersion}`
                          : ""}
                      </div>
                    </div>
                  </button>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={() => handleToggle(server)}
                      disabled={!canManage || gitManaged}
                      aria-label={server.enabled ? "Disable" : "Enable"}
                    />
                    {canManage && !gitManaged && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(server.id)}
                        className="px-2 py-1 text-xs text-destructive hover:text-destructive/80 transition"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded edit form */}
                {isExpanded && (
                  <div className="px-4 pb-4 pt-3 border-t border-border-muted space-y-4">
                    {server.sourceKind === "git" ? (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Metadata and package policy are read-only here. Credentials stay in the
                          platform and can be rotated without changing the Git definition or the
                          session&apos;s pinned runtime revision.
                        </p>
                        <EnvRowsEditor
                          form={form}
                          setForm={setForm}
                          hasExistingCredentials={server.hasEnv || server.hasHeaders}
                        />
                      </>
                    ) : (
                      <McpServerForm
                        form={form}
                        setForm={setForm}
                        repos={repos}
                        environments={environments}
                        loadingRepos={loadingRepos}
                        loadingEnvironments={loadingEnvironments}
                        radioPrefix={server.id}
                        hasExistingCredentials={
                          server.type === form.type && (server.hasEnv || server.hasHeaders)
                        }
                      />
                    )}
                    <div className="flex gap-2 pt-2">
                      <Button onClick={save} disabled={saving} size="sm">
                        {saving
                          ? "Saving..."
                          : server.sourceKind === "git"
                            ? "Save Credentials"
                            : "Save Changes"}
                      </Button>
                      <Button onClick={cancel} variant="outline" size="sm">
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={canManage && !!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete MCP server</AlertDialogTitle>
            <AlertDialogDescription>Are you sure? This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
