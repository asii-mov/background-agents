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
import {
  securityPipelineCommandSchema,
  type SecurityPipelineMetadata,
} from "@open-inspect/shared/types/security-pipelines";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PlusIcon } from "@/components/ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApprovedComponentsSettings } from "./approved-components-settings";
import { fetchJson, writeJson } from "./governance-api";
import { AppDataInventorySettings, StackAdoptionSettings } from "./stack-adoption-settings";

type RiskLevel = "low" | "medium" | "high" | "critical";
type PlatformRole = "member" | "editor" | "admin";

interface RepositoryRiskProfile {
  repoOwner: string;
  repoName: string;
  criticality: RiskLevel;
  rationale: string | null;
  updatedBy: string;
  updatedAt: number;
}

interface PlatformUser {
  id: string;
  displayName: string | null;
  email: string | null;
  role: PlatformRole;
}

interface PipelineForm {
  name: string;
  commandsJson: string;
  repoScopes: string;
  environmentScopes: string;
  enabled: boolean;
  blocking: boolean;
  maxRemediationAttempts: number;
}

const GOVERNANCE_VIEWS = [
  { value: "stack-policy", label: "Stack policy" },
  { value: "adoption", label: "Adoption" },
  { value: "app-data", label: "App data" },
  { value: "verification", label: "Pipelines and risk" },
] as const;

const DEFAULT_COMMANDS = [{ name: "tests", command: ["npm", "test"], timeoutSeconds: 300 }];

const EMPTY_PIPELINE: PipelineForm = {
  name: "",
  commandsJson: JSON.stringify(DEFAULT_COMMANDS, null, 2),
  repoScopes: "",
  environmentScopes: "",
  enabled: true,
  blocking: true,
  maxRemediationAttempts: 2,
};

function parseScopes(value: string): string[] | null {
  const values = value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return values.length ? values : null;
}

function pipelineToForm(pipeline: SecurityPipelineMetadata): PipelineForm {
  return {
    name: pipeline.name,
    commandsJson: JSON.stringify(pipeline.commands, null, 2),
    repoScopes: pipeline.repoScopes?.join(", ") ?? "",
    environmentScopes: pipeline.environmentScopes?.join(", ") ?? "",
    enabled: pipeline.enabled,
    blocking: pipeline.blocking,
    maxRemediationAttempts: pipeline.maxRemediationAttempts,
  };
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border pt-6 first:border-0 first:pt-0">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

function PipelineEditor({
  form,
  setForm,
  saving,
  onSave,
  onCancel,
}: {
  form: PipelineForm;
  setForm: (next: PipelineForm) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mb-4 space-y-4 rounded-md border border-border bg-card p-4">
      <div>
        <Label className="mb-1.5">Name</Label>
        <Input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="AppSec baseline"
        />
      </div>
      <div>
        <Label className="mb-1.5">Commands (JSON argv)</Label>
        <Textarea
          value={form.commandsJson}
          onChange={(event) => setForm({ ...form, commandsJson: event.target.value })}
          className="min-h-44 font-mono text-xs"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Commands execute directly without a shell. Each entry needs name, command array, and
          timeoutSeconds.
        </p>
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
      <p className="-mt-2 text-xs text-muted-foreground">
        Leave both scope fields empty to assign this pipeline to every sandbox.
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex items-center justify-between gap-3 text-sm">
          Enabled
          <Switch
            checked={form.enabled}
            onCheckedChange={(enabled) => setForm({ ...form, enabled })}
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          Blocking
          <Switch
            checked={form.blocking}
            onCheckedChange={(blocking) => setForm({ ...form, blocking })}
          />
        </label>
        <div>
          <Label className="mb-1.5">Remediation attempts</Label>
          <Input
            type="number"
            min={0}
            max={5}
            value={form.maxRemediationAttempts}
            onChange={(event) =>
              setForm({ ...form, maxRemediationAttempts: Number(event.target.value) })
            }
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? "Saving..." : "Save pipeline"}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function AppSecGovernanceSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManageGovernance = hasPermission("governance.manage");
  const canAssignPlatformRoles = hasPermission("workspace.members.manage");
  const {
    data: pipelines = [],
    isLoading: loadingPipelines,
    mutate: reloadPipelines,
  } = useSWR("/api/security-pipelines", fetchJson<SecurityPipelineMetadata[]>);
  const {
    data: riskProfiles = [],
    isLoading: loadingRisk,
    mutate: reloadRisk,
  } = useSWR("/api/repository-risk", fetchJson<RepositoryRiskProfile[]>);
  const { data: users = [], mutate: reloadUsers } = useSWR(
    canAssignPlatformRoles ? "/api/platform/users" : null,
    fetchJson<PlatformUser[]>
  );
  const [editingPipeline, setEditingPipeline] = useState<
    { id: string; revision: number } | "new" | null
  >(null);
  const [pipelineForm, setPipelineForm] = useState<PipelineForm>(EMPTY_PIPELINE);
  const [savingPipeline, setSavingPipeline] = useState(false);
  const [riskOwner, setRiskOwner] = useState("");
  const [riskName, setRiskName] = useState("");
  const [riskLevel, setRiskLevel] = useState<RiskLevel>("medium");
  const [riskRationale, setRiskRationale] = useState("");

  function startPipeline(pipeline?: SecurityPipelineMetadata) {
    if (pipeline) {
      setEditingPipeline({ id: pipeline.id, revision: pipeline.revision });
      setPipelineForm(pipelineToForm(pipeline));
      return;
    }
    setEditingPipeline("new");
    setPipelineForm(EMPTY_PIPELINE);
  }

  async function savePipeline() {
    let rawCommands: unknown;
    try {
      rawCommands = JSON.parse(pipelineForm.commandsJson);
    } catch {
      toast.error("Commands must be valid JSON");
      return;
    }
    const commands = securityPipelineCommandSchema.array().safeParse(rawCommands);
    if (!commands.success || !pipelineForm.name.trim()) {
      toast.error("Enter a name and valid command entries");
      return;
    }
    setSavingPipeline(true);
    try {
      const body = {
        name: pipelineForm.name.trim(),
        commands: commands.data,
        repoScopes: parseScopes(pipelineForm.repoScopes),
        environmentScopes: parseScopes(pipelineForm.environmentScopes),
        enabled: pipelineForm.enabled,
        blocking: pipelineForm.blocking,
        maxRemediationAttempts: pipelineForm.maxRemediationAttempts,
        ...(editingPipeline && editingPipeline !== "new"
          ? { revision: editingPipeline.revision }
          : {}),
      };
      if (editingPipeline === "new") {
        await writeJson("/api/security-pipelines", "POST", body);
      } else if (editingPipeline) {
        await writeJson(`/api/security-pipelines/${editingPipeline.id}`, "PUT", body);
      }
      await reloadPipelines();
      setEditingPipeline(null);
      toast.success("Security pipeline saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save pipeline");
    } finally {
      setSavingPipeline(false);
    }
  }

  async function deletePipeline(id: string) {
    try {
      await writeJson(`/api/security-pipelines/${id}`, "DELETE");
      await reloadPipelines();
      if (editingPipeline !== "new" && editingPipeline?.id === id) setEditingPipeline(null);
      toast.success("Security pipeline deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete pipeline");
    }
  }

  async function saveRiskProfile() {
    if (!riskOwner.trim() || !riskName.trim()) {
      toast.error("Repository owner and name are required");
      return;
    }
    try {
      await writeJson("/api/repository-risk", "PUT", {
        repoOwner: riskOwner.trim(),
        repoName: riskName.trim(),
        criticality: riskLevel,
        rationale: riskRationale.trim() || null,
      });
      await reloadRisk();
      setRiskOwner("");
      setRiskName("");
      setRiskRationale("");
      toast.success("Repository criticality saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save repository risk");
    }
  }

  async function updateRole(userId: string, role: PlatformRole) {
    try {
      await writeJson(`/api/platform/users/${encodeURIComponent(userId)}/role`, "PATCH", { role });
      await reloadUsers();
      toast.success("Platform role updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update role");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">AppSec governance</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Decide what agents build with, see how repositories follow it, and verify what they
          generate. Members never see this page; agents apply it without asking them.
        </p>
      </div>

      <Tabs defaultValue="stack-policy">
        <TabsList className="mb-6 overflow-x-auto">
          {GOVERNANCE_VIEWS.map((view) => (
            <TabsTrigger key={view.value} value={view.value} className="flex-none px-3">
              {view.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="stack-policy">
          <ApprovedComponentsSettings />
        </TabsContent>
        <TabsContent value="adoption">
          <StackAdoptionSettings />
        </TabsContent>
        <TabsContent value="app-data">
          <AppDataInventorySettings />
        </TabsContent>
        <TabsContent value="verification" className="space-y-8">
          <Section
            title="Managed verification pipelines"
            description="Run argv-based checks after generation, return verified findings to the agent, rerun them after remediation, and block completion when required checks still fail."
          >
            {canManageGovernance && editingPipeline === null && (
              <Button size="sm" variant="outline" onClick={() => startPipeline()} className="mb-4">
                <span className="inline-flex items-center gap-1">
                  <PlusIcon className="h-3.5 w-3.5" /> Add pipeline
                </span>
              </Button>
            )}
            {editingPipeline !== null && (
              <PipelineEditor
                form={pipelineForm}
                setForm={setPipelineForm}
                saving={savingPipeline}
                onSave={savePipeline}
                onCancel={() => setEditingPipeline(null)}
              />
            )}
            {loadingPipelines ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : pipelines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No managed pipelines configured.</p>
            ) : (
              <div className="space-y-2">
                {pipelines.map((pipeline) => (
                  <div key={pipeline.id} className="rounded-md border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">{pipeline.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {pipeline.commands.length} check(s) ·{" "}
                          {pipeline.blocking ? "blocking" : "report only"} ·{" "}
                          {pipeline.maxRemediationAttempts} remediation attempt(s)
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {pipeline.repoScopes?.join(", ") ||
                            pipeline.environmentScopes?.join(", ") ||
                            "all sessions"}{" "}
                          · created by {pipeline.createdBy}
                        </p>
                      </div>
                      {canManageGovernance && (
                        <div className="flex gap-2">
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => startPipeline(pipeline)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => deletePipeline(pipeline.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Repository criticality"
            description="PR risk is repository criticality × change criticality. Scores of 8 or more are forced into draft security review. Unclassified repositories default to medium."
          >
            {canManageGovernance && (
              <div className="mb-4 grid gap-3 rounded-md border border-border bg-card p-4 sm:grid-cols-2">
                <div>
                  <Label className="mb-1.5">Owner</Label>
                  <Input
                    value={riskOwner}
                    onChange={(event) => setRiskOwner(event.target.value)}
                    placeholder="acme"
                  />
                </div>
                <div>
                  <Label className="mb-1.5">Repository</Label>
                  <Input
                    value={riskName}
                    onChange={(event) => setRiskName(event.target.value)}
                    placeholder="identity-service"
                  />
                </div>
                <div>
                  <Label className="mb-1.5">Criticality</Label>
                  <Select
                    value={riskLevel}
                    onValueChange={(value) => setRiskLevel(value as RiskLevel)}
                  >
                    <SelectTrigger className="h-9 w-full rounded-sm border border-border bg-background px-3 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {" "}
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="mb-1.5">Rationale</Label>
                  <Input
                    value={riskRationale}
                    onChange={(event) => setRiskRationale(event.target.value)}
                    placeholder="Production identity boundary"
                  />
                </div>
                <Button size="sm" onClick={saveRiskProfile} className="sm:col-span-2 sm:w-fit">
                  Save criticality
                </Button>
              </div>
            )}
            {loadingRisk ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : riskProfiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No repository overrides; medium is the default.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {riskProfiles.map((profile) => (
                  <button
                    type="button"
                    key={`${profile.repoOwner}/${profile.repoName}`}
                    onClick={() => {
                      if (!canManageGovernance) return;
                      setRiskOwner(profile.repoOwner);
                      setRiskName(profile.repoName);
                      setRiskLevel(profile.criticality);
                      setRiskRationale(profile.rationale ?? "");
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                  >
                    <span className="text-sm text-foreground">
                      {profile.repoOwner}/{profile.repoName}
                    </span>
                    <span className="text-xs uppercase text-muted-foreground">
                      {profile.criticality}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Section>

          {canAssignPlatformRoles && (
            <Section
              title="Platform ownership"
              description="Editors manage the shared Skills, MCP, pipeline, and repository-risk catalogues. Administrators can also assign roles."
            >
              <div className="divide-y divide-border rounded-md border border-border">
                {users.map((user) => (
                  <div key={user.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">
                        {user.displayName || user.email || user.id}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {user.email || user.id}
                      </p>
                    </div>
                    <Select
                      value={user.role}
                      onValueChange={(value) => updateRole(user.id, value as PlatformRole)}
                    >
                      <SelectTrigger
                        aria-label={`Role for ${user.displayName || user.email || user.id}`}
                        className="h-8 rounded-sm border border-border bg-background px-2 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {" "}
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="editor">Editor</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
