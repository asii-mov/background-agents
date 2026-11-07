"use client";

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { toast } from "sonner";
import {
  createApprovedComponentSchema,
  updateApprovedComponentSchema,
  type ApprovedComponent,
  type ApprovedComponentKind,
  type ApprovedComponentLifecycle,
  type ComponentConsumer,
} from "@open-inspect/shared/types/approved-components";
import {
  componentCategoryInputSchema,
  type CategoryEnforcement,
  type CompiledStackPolicy,
  type ComponentCategory,
  type Stance,
} from "@open-inspect/shared/types/stack-policy";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PlusIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import {
  STANCE_ORDER,
  STANCE_PRESENTATION,
  buildStackLanes,
  formatSignalLines,
  isInEffect,
  parseSignalLines,
  standardPromotion,
  type StackLane,
} from "./approved-components-model";
import { fetchJson, writeJson } from "./governance-api";

const COMPONENTS_KEY = "/api/approved-components";
const CATEGORIES_KEY = "/api/component-categories";
const PREVIEW_KEY_PREFIX = "/api/stack-policy/preview";
const NO_CATEGORY = "none";

const KIND_LABELS = {
  library: "Library",
  service: "Service",
  template: "Template",
  snippet: "Snippet",
  language: "Language",
  tool: "Tool",
  data_store: "Data store",
} as const satisfies Record<ApprovedComponentKind, string>;

const ENFORCEMENT_OPTIONS = [
  { value: "advise", label: "Advise" },
  { value: "block", label: "Block" },
] as const satisfies readonly { value: CategoryEnforcement; label: string }[];

const ENFORCEMENT_EFFECT = {
  advise: "Denied technologies are flagged for the agent to replace. Nothing is blocked.",
  block: "Denied technologies fail the agent's turn and reject the push until replaced.",
} as const satisfies Record<CategoryEnforcement, string>;

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
  categoryId: string;
  stance: Stance;
  signals: string;
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
  categoryId: NO_CATEGORY,
  stance: "allowed",
  signals: "",
};

type Editing = { id: string; revision: number } | "new" | null;

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
    categoryId: component.categoryId ?? NO_CATEGORY,
    stance: component.stance,
    signals: formatSignalLines(component.signals),
  };
}

/** The request body for `form`, or the first reason the shared component schema rejects it. */
function componentRequest(
  form: ComponentForm,
  editing: Exclude<Editing, null>
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (
    !form.name.trim() ||
    !form.description.trim() ||
    !form.owner.trim() ||
    !form.locator.trim() ||
    !form.usage.trim()
  ) {
    return { ok: false, message: "Name, description, owner, locator and usage are required" };
  }
  const signals = parseSignalLines(form.signals);
  if (!signals.ok) return signals;
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
    categoryId: form.categoryId === NO_CATEGORY ? null : form.categoryId,
    stance: form.stance,
    signals: signals.signals,
    ...(editing === "new" ? {} : { revision: editing.revision }),
  };
  const parsed = (
    editing === "new" ? createApprovedComponentSchema : updateApprovedComponentSchema
  ).safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid component" };
  }
  return { ok: true, body };
}

function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor} className="mb-1.5">
        {label}
      </Label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const SELECT_TRIGGER_CLASS =
  "h-9 w-full rounded-sm border border-border bg-background px-3 text-sm";

function ComponentEditor({
  form,
  setForm,
  categories,
  saving,
  onSave,
  onCancel,
}: {
  form: ComponentForm;
  setForm: (value: ComponentForm) => void;
  categories: readonly ComponentCategory[];
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof ComponentForm>(key: K, value: ComponentForm[K]) =>
    setForm({ ...form, [key]: value });
  const text = (key: keyof ComponentForm & string, id: string, placeholder?: string) => (
    <Input
      id={id}
      value={String(form[key])}
      onChange={(event) => set(key, event.target.value as never)}
      placeholder={placeholder}
    />
  );
  return (
    <div className="mb-6 space-y-4 rounded-md border border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" htmlFor="component-name" className="sm:col-span-2">
          {text("name", "component-name", "Corporate authentication")}
        </Field>
        <Field label="Kind" htmlFor="component-kind">
          <Select
            value={form.kind}
            onValueChange={(value) => set("kind", value as ApprovedComponentKind)}
          >
            <SelectTrigger id="component-kind" className={SELECT_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(KIND_LABELS).map(([kind, label]) => (
                <SelectItem key={kind} value={kind}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 rounded-md border border-border-muted bg-background p-3 sm:grid-cols-2">
        <Field label="Category" htmlFor="component-category">
          <Select value={form.categoryId} onValueChange={(value) => set("categoryId", value)}>
            <SelectTrigger id="component-category" className={SELECT_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CATEGORY}>No category</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Grade"
          htmlFor="component-stance"
          hint={STANCE_PRESENTATION[form.stance].description}
        >
          <Select value={form.stance} onValueChange={(value) => set("stance", value as Stance)}>
            <SelectTrigger id="component-stance" className={SELECT_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STANCE_ORDER.map((stance) => (
                <SelectItem key={stance} value={stance}>
                  {STANCE_PRESENTATION[stance].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Detection signals"
          htmlFor="component-signals"
          className="sm:col-span-2"
          hint="One per line: package:npm:react, file:bun.lock, source:.ts or manifest:d1. Graded components need at least one."
        >
          <Textarea
            id="component-signals"
            value={form.signals}
            onChange={(event) => set("signals", event.target.value)}
            className="min-h-20 font-mono text-xs"
            placeholder={"package:npm:svelte\nfile:svelte.config.js"}
          />
        </Field>
      </div>

      <Field label="Description" htmlFor="component-description">
        <Textarea
          id="component-description"
          value={form.description}
          onChange={(event) => set("description", event.target.value)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Owner" htmlFor="component-owner">
          {text("owner", "component-owner", "Product Security")}
        </Field>
        <Field label="Locator" htmlFor="component-locator">
          {text("locator", "component-locator", "@acme/auth or https://service.example.com")}
        </Field>
        <Field label="Exact version" htmlFor="component-version">
          {text("version", "component-version", "1.2.3")}
        </Field>
        <Field label="Integrity" htmlFor="component-integrity">
          {text("integrity", "component-integrity", "sha256:...")}
        </Field>
        <Field label="Source URL" htmlFor="component-source-url">
          {text("sourceUrl", "component-source-url", "https://git.example.com/platform/auth")}
        </Field>
        <Field label="Documentation URL" htmlFor="component-docs-url">
          {text("documentationUrl", "component-docs-url", "https://docs.example.com/auth")}
        </Field>
      </div>
      <Field
        label="Usage instructions"
        htmlFor="component-usage"
        hint="Agents read this. For a denied technology, say what to use instead."
      >
        <Textarea
          id="component-usage"
          value={form.usage}
          onChange={(event) => set("usage", event.target.value)}
          className="min-h-28"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Repository scopes" htmlFor="component-repo-scopes">
          {text("repoScopes", "component-repo-scopes", "acme/api, acme/web")}
        </Field>
        <Field label="Environment scopes" htmlFor="component-environment-scopes">
          {text("environmentScopes", "component-environment-scopes", "production")}
        </Field>
      </div>
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Field label="Lifecycle" htmlFor="component-lifecycle">
          <Select
            value={form.lifecycle}
            onValueChange={(value) => set("lifecycle", value as ApprovedComponentLifecycle)}
          >
            <SelectTrigger id="component-lifecycle" className={SELECT_TRIGGER_CLASS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="development">Development</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="deprecated">Deprecated</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <label className="flex h-9 items-center justify-between text-sm">
          Enabled
          <Switch checked={form.enabled} onCheckedChange={(enabled) => set("enabled", enabled)} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Agents only see enabled components outside development. Approval requires a source or
        documentation URL; uncategorised libraries also need an exact version.
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

function ComponentChip({
  component,
  lane,
  canManage,
  onEdit,
  onMakeStandard,
}: {
  component: ApprovedComponent;
  lane: StackLane;
  canManage: boolean;
  onEdit: (component: ApprovedComponent) => void;
  onMakeStandard: (component: ApprovedComponent, lane: StackLane) => void;
}) {
  const active = isInEffect(component);
  const label = (
    <>
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          active ? STANCE_PRESENTATION[component.stance].fill : "border border-muted-foreground"
        )}
      />
      <span>{component.name}</span>
      {!active && (
        <span className="text-muted-foreground">
          {component.enabled ? "(draft)" : "(disabled)"}
        </span>
      )}
    </>
  );
  const chipClass = cn(
    "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-sm text-foreground",
    active ? "border-border bg-background" : "border-dashed border-border"
  );
  if (!canManage || component.sourceKind === "git") {
    return <span className={chipClass}>{label}</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          chipClass,
          "hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
        aria-label={`${component.name} actions`}
      >
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onEdit(component)}>Edit</DropdownMenuItem>
        {active && component.stance !== "preferred" && (
          <DropdownMenuItem onSelect={() => onMakeStandard(component, lane)}>
            {lane.standard ? `Make standard instead of ${lane.standard.name}` : "Make standard"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CategoryLane({
  lane,
  canManage,
  onEnforcement,
  onEdit,
  onMakeStandard,
}: {
  lane: StackLane;
  canManage: boolean;
  onEnforcement: (category: ComponentCategory, enforcement: CategoryEnforcement) => void;
  onEdit: (component: ApprovedComponent) => void;
  onMakeStandard: (component: ApprovedComponent, lane: StackLane) => void;
}) {
  const { category } = lane;
  const gitManaged = category.sourceKind === "git";
  return (
    <li
      aria-label={category.name}
      className="grid gap-4 py-5 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="min-w-0">
        <h4 className="text-sm font-semibold text-foreground">{category.name}</h4>
        <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">{category.description}</p>
      </div>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <SegmentedControl
          label={`Enforcement for ${category.name}`}
          value={category.enforcement}
          options={ENFORCEMENT_OPTIONS}
          disabled={!canManage || gitManaged}
          onValueChange={(enforcement) => onEnforcement(category, enforcement)}
        />
        {gitManaged && <span className="text-xs text-muted-foreground">Managed in Git</span>}
      </div>
      <dl className="grid gap-2 sm:col-span-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
        {STANCE_ORDER.map((stance) => {
          const components = lane.components[stance];
          if (stance !== "preferred" && components.length === 0) return null;
          return (
            <div key={stance} className="contents">
              <dt className="pt-1 text-xs font-medium text-muted-foreground">
                {STANCE_PRESENTATION[stance].label}
              </dt>
              <dd className="flex flex-wrap gap-1.5">
                {components.length === 0 ? (
                  <span className="pt-1 text-sm text-muted-foreground">
                    No standard yet. Agents choose freely here.
                  </span>
                ) : (
                  components.map((component) => (
                    <ComponentChip
                      key={component.id}
                      component={component}
                      lane={lane}
                      canManage={canManage}
                      onEdit={onEdit}
                      onMakeStandard={onMakeStandard}
                    />
                  ))
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {lane.components.denied.length > 0 && (
        <p className="text-xs text-muted-foreground sm:col-span-2">
          {ENFORCEMENT_EFFECT[category.enforcement]}
        </p>
      )}
    </li>
  );
}

const EMPTY_CATEGORY = { id: "", name: "", description: "" };

function CategoryCreator({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_CATEGORY);
  const [saving, setSaving] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    const parsed = componentCategoryInputSchema.safeParse({ ...draft, enforcement: "advise" });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid category");
      return;
    }
    setSaving(true);
    try {
      await writeJson(CATEGORIES_KEY, "POST", parsed.data);
      await onCreated();
      setDraft(EMPTY_CATEGORY);
      setOpen(false);
      toast.success("Category added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add category");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <span className="inline-flex items-center gap-1">
          <PlusIcon className="h-3.5 w-3.5" /> Add category
        </span>
      </Button>
    );
  }
  return (
    <form
      onSubmit={create}
      className="grid w-full gap-3 rounded-md border border-border bg-card p-4 sm:grid-cols-2"
    >
      <Field label="Name" htmlFor="category-name">
        <Input
          id="category-name"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="Web backend"
        />
      </Field>
      <Field label="Identifier" htmlFor="category-id" hint="Lowercase words joined by hyphens.">
        <Input
          id="category-id"
          value={draft.id}
          onChange={(event) => setDraft({ ...draft, id: event.target.value })}
          placeholder="web-backend"
        />
      </Field>
      <Field
        label="What belongs here"
        htmlFor="category-description"
        hint="Agents read this to decide whether the category applies."
        className="sm:col-span-2"
      >
        <Textarea
          id="category-description"
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </Field>
      <div className="flex gap-2 sm:col-span-2">
        <Button size="sm" type="submit" disabled={saving}>
          {saving ? "Adding..." : "Add category"}
        </Button>
        <Button size="sm" variant="outline" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function previewKey(repository: string): `/api/${string}` {
  return repository
    ? `${PREVIEW_KEY_PREFIX}?repo=${encodeURIComponent(repository)}`
    : PREVIEW_KEY_PREFIX;
}

function exportHref(repository: string): string {
  return repository
    ? `/api/stack-policy/export?repo=${encodeURIComponent(repository)}`
    : "/api/stack-policy/export";
}

function PolicyPreviewPanel() {
  const [draftRepository, setDraftRepository] = useState("");
  const [repository, setRepository] = useState("");
  const { data, error, isLoading } = useSWR(
    previewKey(repository),
    fetchJson<{ policy: CompiledStackPolicy | null }>
  );
  const policy = data?.policy ?? null;
  const denials = policy?.rules.filter((rule) => rule.verdict === "forbid") ?? [];

  return (
    <section aria-labelledby="policy-preview-heading" className="space-y-3">
      <div>
        <h3 id="policy-preview-heading" className="text-base font-semibold text-foreground">
          What agents are told
        </h3>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          The exact instructions a new session receives, ahead of repository files and memory.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setRepository(draftRepository.trim());
        }}
      >
        <Field label="Repository" htmlFor="preview-repository" className="min-w-48 flex-1">
          <Input
            id="preview-repository"
            value={draftRepository}
            onChange={(event) => setDraftRepository(event.target.value)}
            placeholder="owner/name (optional)"
          />
        </Field>
        <Button size="sm" variant="outline" type="submit">
          Preview
        </Button>
      </form>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading preview...</p>
      ) : error ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Preview unavailable"}
        </p>
      ) : !policy ? (
        <p className="text-sm text-muted-foreground">
          No standards apply{repository ? ` to ${repository}` : ""}. Agents receive no technology
          instructions.
        </p>
      ) : (
        <div className="space-y-3">
          <ul aria-label="Denied technologies" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {denials.length === 0 && (
              <li className="text-muted-foreground">Nothing is denied for this repository.</li>
            )}
            {denials.map((rule) => (
              <li key={rule.componentId} className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 rounded-full bg-destructive" />
                <span className="text-foreground">{rule.componentName}</span>
                <span className="text-muted-foreground">
                  {rule.blocking ? "blocks the push" : "flagged, not blocked"}
                </span>
              </li>
            ))}
          </ul>
          <pre
            aria-label="Agent instructions"
            className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-4 text-xs leading-relaxed text-foreground"
          >
            {policy.instructions}
          </pre>
          <p className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
            <span>
              Policy {policy.digest.slice(0, 12)} with {policy.rules.length} rules
            </span>
            <a
              href={exportHref(repository)}
              download="stack-policy.json"
              className="text-foreground underline underline-offset-2 hover:text-accent"
            >
              Download for CI checks
            </a>
          </p>
        </div>
      )}
    </section>
  );
}

function Consumers({ component }: { component: ApprovedComponent }) {
  const { data = [], isLoading } = useSWR(
    `${COMPONENTS_KEY}/${encodeURIComponent(component.id)}/consumers` as const,
    fetchJson<ComponentConsumer[]>
  );
  if (isLoading) return <p className="mt-2 text-xs text-muted-foreground">Loading consumers...</p>;
  if (data.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">No repositories use it yet.</p>;
  }
  return (
    <div className="mt-2 divide-y divide-border rounded border border-border">
      {data.map((consumer) => {
        const repository = `${consumer.repoOwner}/${consumer.repoName}`;
        if (consumer.evidence === "detected") {
          return (
            <div
              key={`detected:${repository}:${consumer.refName}`}
              className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs"
            >
              <span>{repository}</span>
              <span className="truncate text-muted-foreground">
                detected on {consumer.refName} in {consumer.evidencePaths.join(", ")}
              </span>
            </div>
          );
        }
        const outdated = consumer.componentRevision < component.revision;
        return (
          <div
            key={`declared:${repository}`}
            className="flex items-center justify-between px-2 py-1.5 text-xs"
          >
            <span>{repository}</span>
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

/** Stack policy: graded technology lanes, the agents' view of them, and the component catalogue. */
export function ApprovedComponentsSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManage = hasPermission("governance.manage");
  const { mutate: mutateCache } = useSWRConfig();
  const {
    data: components = [],
    isLoading,
    mutate: reloadComponents,
  } = useSWR(COMPONENTS_KEY, fetchJson<ApprovedComponent[]>);
  const { data: categories = [], mutate: reloadCategories } = useSWR(
    CATEGORIES_KEY,
    fetchJson<ComponentCategory[]>
  );
  const [editing, setEditing] = useState<Editing>(null);
  const [form, setForm] = useState<ComponentForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [expandedConsumers, setExpandedConsumers] = useState<string | null>(null);
  const lanes = buildStackLanes(categories, components);
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

  function reloadPolicy() {
    return Promise.all([
      reloadComponents(),
      reloadCategories(),
      mutateCache((key) => typeof key === "string" && key.startsWith(PREVIEW_KEY_PREFIX)),
    ]);
  }

  function start(component?: ApprovedComponent) {
    setEditing(component ? { id: component.id, revision: component.revision } : "new");
    setForm(component ? toForm(component) : EMPTY_FORM);
  }

  async function save() {
    if (editing === null) return;
    const request = componentRequest(form, editing);
    if (!request.ok) {
      toast.error(request.message);
      return;
    }
    setSaving(true);
    try {
      if (editing === "new") await writeJson(COMPONENTS_KEY, "POST", request.body);
      else {
        await writeJson(`${COMPONENTS_KEY}/${encodeURIComponent(editing.id)}`, "PUT", request.body);
      }
      await reloadPolicy();
      setEditing(null);
      toast.success("Component saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save component");
    } finally {
      setSaving(false);
    }
  }

  async function makeStandard(component: ApprovedComponent, lane: StackLane) {
    try {
      await writeJson(
        `${COMPONENTS_KEY}/${encodeURIComponent(component.id)}`,
        "PUT",
        standardPromotion(component, lane)
      );
      await reloadPolicy();
      toast.success(`${component.name} is now the standard for ${lane.category.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change the standard");
    }
  }

  async function setEnforcement(category: ComponentCategory, enforcement: CategoryEnforcement) {
    try {
      await writeJson(`${CATEGORIES_KEY}/${encodeURIComponent(category.id)}`, "PUT", {
        name: category.name,
        description: category.description,
        enforcement,
        revision: category.revision,
      });
      await reloadPolicy();
      toast.success(
        enforcement === "block"
          ? `${category.name} denials now block`
          : `${category.name} denials are now advisory`
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change enforcement");
    }
  }

  async function remove(component: ApprovedComponent) {
    try {
      await writeJson(`${COMPONENTS_KEY}/${encodeURIComponent(component.id)}`, "DELETE");
      await reloadPolicy();
      toast.success("Development component deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete component");
    }
  }

  return (
    <div className="space-y-10">
      <section aria-labelledby="technology-standards-heading">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3
              id="technology-standards-heading"
              className="text-base font-semibold text-foreground"
            >
              Technology standards
            </h3>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              Agents build with the standard, keep acceptable alternatives where a repository
              already uses them, and replace anything not allowed. Members never choose.
            </p>
          </div>
          {canManage && <CategoryCreator onCreated={reloadPolicy} />}
        </div>
        {editing !== null && (
          <ComponentEditor
            form={form}
            setForm={setForm}
            categories={categories}
            saving={saving}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        )}
        {lanes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No categories yet. Add one to start grading technologies.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {lanes.map((lane) => (
              <CategoryLane
                key={lane.category.id}
                lane={lane}
                canManage={canManage}
                onEnforcement={setEnforcement}
                onEdit={start}
                onMakeStandard={makeStandard}
              />
            ))}
          </ul>
        )}
      </section>

      <PolicyPreviewPanel />

      <section aria-labelledby="component-catalogue-heading">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3
              id="component-catalogue-heading"
              className="text-base font-semibold text-foreground"
            >
              Component catalogue
            </h3>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              Every reviewed library, service, template and technology agents may use, with the
              repositories that use each one.
            </p>
          </div>
          {canManage && editing === null && (
            <Button size="sm" variant="outline" onClick={() => start()}>
              <span className="inline-flex items-center gap-1">
                <PlusIcon className="h-3.5 w-3.5" /> Add component
              </span>
            </Button>
          )}
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : components.length === 0 ? (
          <p className="text-sm text-muted-foreground">No components registered.</p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {components.map((component) => {
              const editable = canManage && component.sourceKind !== "git";
              return (
                <div key={component.id} className="p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{component.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {KIND_LABELS[component.kind]}, {component.lifecycle}, revision{" "}
                        {component.revision}
                        {component.version ? `, ${component.version}` : ""}, owner {component.owner}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {component.categoryId
                          ? `${STANCE_PRESENTATION[component.stance].label} in ${categoryNames.get(component.categoryId) ?? component.categoryId}`
                          : "Uncategorised"}
                        {component.sourceKind === "git" ? ". Managed in Git." : ""}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        aria-label={`Consumers of ${component.name}`}
                        aria-expanded={expandedConsumers === component.id}
                        onClick={() =>
                          setExpandedConsumers(
                            expandedConsumers === component.id ? null : component.id
                          )
                        }
                      >
                        Consumers
                      </Button>
                      {editable && (
                        <Button size="xs" variant="outline" onClick={() => start(component)}>
                          Edit
                        </Button>
                      )}
                      {editable && component.lifecycle === "development" && (
                        <Button size="xs" variant="ghost" onClick={() => remove(component)}>
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                  {expandedConsumers === component.id && <Consumers component={component} />}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
