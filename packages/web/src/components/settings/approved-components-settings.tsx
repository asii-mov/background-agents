"use client";

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import type {
  ApprovedComponent,
  ApprovedComponentConsumer,
  ApprovedComponentKind,
  ApprovedComponentLifecycle,
} from "@open-inspect/shared/types/approved-components";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { usePlatformRole } from "@/hooks/use-platform-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PlusIcon } from "@/components/ui/icons";

interface ComponentForm {
  name: string;
  kind: ApprovedComponentKind;
  description: string;
  owner: string;
  locator: string;
  version: string;
  integrity: string;
  sourceUrl: string;
  documentationUrl: string;
  usage: string;
  lifecycle: ApprovedComponentLifecycle;
  repoScopes: string;
  environmentScopes: string;
  enabled: boolean;
}

const EMPTY_FORM: ComponentForm = {
  name: "",
  kind: "library",
  description: "",
  owner: "",
  locator: "",
  version: "",
  integrity: "",
  sourceUrl: "",
  documentationUrl: "",
  usage: "",
  lifecycle: "development",
  repoScopes: "",
  environmentScopes: "",
  enabled: true,
};

async function fetchJson<T>(path: `/api/${string}`): Promise<T> {
  const response = await browserApiFetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error((data as { error?: string }).error ?? "Request failed");
  return data as T;
}

async function writeJson<T>(path: `/api/${string}`, method: string, body?: unknown): Promise<T> {
  const response = await browserApiFetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error((data as { error?: string }).error ?? "Request failed");
  return data as T;
}

function scopes(value: string): string[] | null {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length ? entries : null;
}

function toForm(component: ApprovedComponent): ComponentForm {
  return {
    name: component.name,
    kind: component.kind,
    description: component.description,
    owner: component.owner,
    locator: component.locator,
    version: component.version ?? "",
    integrity: component.integrity ?? "",
    sourceUrl: component.sourceUrl ?? "",
    documentationUrl: component.documentationUrl ?? "",
    usage: component.usage,
    lifecycle: component.lifecycle,
    repoScopes: component.repoScopes?.join(", ") ?? "",
    environmentScopes: component.environmentScopes?.join(", ") ?? "",
    enabled: component.enabled,
  };
}

function Consumers({ component }: { component: ApprovedComponent }) {
  const { data = [], isLoading } = useSWR(
    `/api/approved-components/${component.id}/consumers`,
    fetchJson<ApprovedComponentConsumer[]>
  );
  if (isLoading) return <p className="mt-2 text-xs text-muted-foreground">Loading consumers...</p>;
  if (data.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">No declared consumers.</p>;
  }
  return (
    <div className="mt-2 divide-y divide-border rounded border border-border">
      {data.map((consumer) => {
        const outdated = consumer.componentRevision < component.revision;
        return (
          <div
            key={`${consumer.repoOwner}/${consumer.repoName}`}
            className="flex items-center justify-between px-2 py-1.5 text-xs"
          >
            <span>
              {consumer.repoOwner}/{consumer.repoName}
            </span>
            <span className={outdated ? "text-destructive" : "text-muted-foreground"}>
              {outdated
                ? `upgrade from ${consumer.componentVersion ?? `revision ${consumer.componentRevision}`}`
                : "current"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ComponentEditor({
  form,
  setForm,
  saving,
  onSave,
  onCancel,
}: {
  form: ComponentForm;
  setForm: (value: ComponentForm) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mb-4 space-y-4 rounded-md border border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Label className="mb-1.5">Name</Label>
          <Input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Corporate authentication"
          />
        </div>
        <div>
          <Label className="mb-1.5">Kind</Label>
          <Select
            value={form.kind}
            onValueChange={(value) => setForm({ ...form, kind: value as ApprovedComponentKind })}
          >
            <SelectTrigger className="h-9 w-full rounded-sm border border-border bg-background px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="library">Library</SelectItem>
              <SelectItem value="service">Service</SelectItem>
              <SelectItem value="template">Template</SelectItem>
              <SelectItem value="snippet">Snippet</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label className="mb-1.5">Description</Label>
        <Textarea
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="mb-1.5">Owner</Label>
          <Input
            value={form.owner}
            onChange={(event) => setForm({ ...form, owner: event.target.value })}
            placeholder="Product Security"
          />
        </div>
        <div>
          <Label className="mb-1.5">Locator</Label>
          <Input
            value={form.locator}
            onChange={(event) => setForm({ ...form, locator: event.target.value })}
            placeholder="@acme/auth or https://service.example.com"
          />
        </div>
        <div>
          <Label className="mb-1.5">Exact version</Label>
          <Input
            value={form.version}
            onChange={(event) => setForm({ ...form, version: event.target.value })}
            placeholder="1.2.3"
          />
        </div>
        <div>
          <Label className="mb-1.5">Integrity</Label>
          <Input
            value={form.integrity}
            onChange={(event) => setForm({ ...form, integrity: event.target.value })}
            placeholder="sha256:..."
          />
        </div>
        <div>
          <Label className="mb-1.5">Source URL</Label>
          <Input
            value={form.sourceUrl}
            onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })}
            placeholder="https://git.example.com/platform/auth"
          />
        </div>
        <div>
          <Label className="mb-1.5">Documentation URL</Label>
          <Input
            value={form.documentationUrl}
            onChange={(event) => setForm({ ...form, documentationUrl: event.target.value })}
            placeholder="https://docs.example.com/auth"
          />
        </div>
      </div>
      <div>
        <Label className="mb-1.5">Usage instructions</Label>
        <Textarea
          value={form.usage}
          onChange={(event) => setForm({ ...form, usage: event.target.value })}
          className="min-h-28"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="mb-1.5">Repository scopes</Label>
          <Input
            value={form.repoScopes}
            onChange={(event) => setForm({ ...form, repoScopes: event.target.value })}
            placeholder="acme/api, acme/web"
          />
        </div>
        <div>
          <Label className="mb-1.5">Environment scopes</Label>
          <Input
            value={form.environmentScopes}
            onChange={(event) => setForm({ ...form, environmentScopes: event.target.value })}
            placeholder="production"
          />
        </div>
      </div>
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <div>
          <Label className="mb-1.5">Lifecycle</Label>
          <Select
            value={form.lifecycle}
            onValueChange={(value) =>
              setForm({ ...form, lifecycle: value as ApprovedComponentLifecycle })
            }
          >
            <SelectTrigger className="h-9 w-full rounded-sm border border-border bg-background px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="development">Development</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="deprecated">Deprecated</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex h-9 items-center justify-between text-sm">
          Enabled
          <Switch
            checked={form.enabled}
            onCheckedChange={(enabled) => setForm({ ...form, enabled })}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Approval requires provenance. Libraries need an exact version; templates and snippets need
        an HTTPS locator and SHA-256 digest; services need an HTTPS locator.
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={saving} onClick={onSave}>
          {saving ? "Saving..." : "Save component"}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ApprovedComponentsSettings() {
  const { canWriteCatalog } = usePlatformRole();
  const {
    data = [],
    isLoading,
    mutate,
  } = useSWR("/api/approved-components", fetchJson<ApprovedComponent[]>);
  const [editing, setEditing] = useState<{ id: string; revision: number } | "new" | null>(null);
  const [form, setForm] = useState<ComponentForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [expandedConsumers, setExpandedConsumers] = useState<string | null>(null);

  function start(component?: ApprovedComponent) {
    setEditing(component ? { id: component.id, revision: component.revision } : "new");
    setForm(component ? toForm(component) : EMPTY_FORM);
  }

  async function save() {
    if (
      !form.name.trim() ||
      !form.description.trim() ||
      !form.owner.trim() ||
      !form.locator.trim()
    ) {
      toast.error("Name, description, owner, and locator are required");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        kind: form.kind,
        description: form.description.trim(),
        owner: form.owner.trim(),
        locator: form.locator.trim(),
        version: form.version.trim() || null,
        integrity: form.integrity.trim() || null,
        sourceUrl: form.sourceUrl.trim() || null,
        documentationUrl: form.documentationUrl.trim() || null,
        usage: form.usage.trim(),
        lifecycle: form.lifecycle,
        repoScopes: scopes(form.repoScopes),
        environmentScopes: scopes(form.environmentScopes),
        enabled: form.enabled,
        ...(editing && editing !== "new" ? { revision: editing.revision } : {}),
      };
      if (editing === "new") await writeJson("/api/approved-components", "POST", body);
      else if (editing) await writeJson(`/api/approved-components/${editing.id}`, "PUT", body);
      await mutate();
      setEditing(null);
      toast.success("Approved component saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save component");
    } finally {
      setSaving(false);
    }
  }

  async function remove(component: ApprovedComponent) {
    try {
      await writeJson(`/api/approved-components/${component.id}`, "DELETE");
      await mutate();
      toast.success("Development component deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete component");
    }
  }

  return (
    <section className="border-t border-border pt-6 first:border-0 first:pt-0">
      <h3 className="text-base font-semibold text-foreground">Approved reusable components</h3>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Publish reviewed libraries, services, templates, and snippets to every applicable agent;
        track consumers by revision for upgrades and deprecation.
      </p>
      {canWriteCatalog && editing === null && (
        <Button size="sm" variant="outline" className="mb-4" onClick={() => start()}>
          <span className="inline-flex items-center gap-1">
            <PlusIcon className="h-3.5 w-3.5" /> Add component
          </span>
        </Button>
      )}
      {editing !== null && (
        <ComponentEditor
          form={form}
          setForm={setForm}
          saving={saving}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reusable components registered.</p>
      ) : (
        <div className="space-y-2">
          {data.map((component) => (
            <div key={component.id} className="rounded-md border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{component.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {component.kind} · {component.lifecycle} · revision {component.revision}
                    {component.version ? ` · ${component.version}` : ""} · owner {component.owner}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{component.locator}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setExpandedConsumers(expandedConsumers === component.id ? null : component.id)
                    }
                  >
                    Consumers
                  </Button>
                  {canWriteCatalog && (
                    <Button size="xs" variant="outline" onClick={() => start(component)}>
                      Edit
                    </Button>
                  )}
                  {canWriteCatalog && component.lifecycle === "development" && (
                    <Button size="xs" variant="ghost" onClick={() => remove(component)}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
              {expandedConsumers === component.id && <Consumers component={component} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
