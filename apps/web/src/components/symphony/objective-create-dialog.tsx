"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CheckCircle, Plus, Target, Trash, XCircle } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SelectControl, type SelectOption } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WorkflowRevisionRecord } from "@/lib/symphony/contracts";
import { buildObjectiveCreateRequest, ObjectiveEntryValidationError, objectiveExecutionAvailability, standaloneWorkflowIdentity, type ObjectiveCriterionDraft, type ObjectivePermission } from "@/lib/symphony/objective-entry";
import { createObjective, fetchObjectiveDetail, newIdempotencyKey } from "@/lib/symphony/runtime-client";
import { useSymphony } from "@/components/symphony/context";

const OP_OPTIONS: SelectOption[] = [
  { value: "exists", label: "Exists" },
  { value: "equals", label: "Equals" },
  { value: "not-equals", label: "Does not equal" },
  { value: "contains", label: "Contains" },
  { value: "matches", label: "Matches" },
  { value: "gt", label: "Greater than" },
  { value: "gte", label: "At least" },
  { value: "lt", label: "Less than" },
  { value: "lte", label: "At most" },
];
const PERMISSION_OPTIONS: SelectOption[] = [
  { value: "read-only", label: "Read only", description: "Inspect and evaluate without changing the workspace." },
  { value: "full-access", label: "Full access", description: "Allow plan tasks to modify the selected workspace." },
];
const APPROVAL_OPTIONS: SelectOption[] = [
  { value: "never", label: "No approval gate" },
  { value: "on-replan", label: "Approve replans" },
  { value: "before-completion", label: "Approve before completion" },
];
const SIDE_EFFECT_OPTIONS: SelectOption[] = [
  { value: "read", label: "Read only", description: "No local or external writes." },
  { value: "local", label: "Local", description: "Workspace writes are allowed." },
  { value: "external", label: "External", description: "External side effects may be requested." },
  { value: "irreversible", label: "Irreversible", description: "No additional side-effect ceiling." },
];
const DIRTY_POLICY_OPTIONS: SelectOption[] = [
  { value: "local-only", label: "Local changes only", description: "Keep the run in this local workspace." },
  { value: "require-clean", label: "Require clean", description: "Admission fails when the workspace is dirty." },
  { value: "explicit-checkpoint", label: "Explicit checkpoint", description: "Require a checkpoint before writes." },
];
const STANDALONE_WORKFLOW_KEY = "__standalone__";

const emptyCriterion = (): ObjectiveCriterionDraft => ({
  description: "",
  path: "",
  op: "exists",
  value: "",
  required: true,
});

export type ObjectiveCreateDialogProps = {
  open: boolean;
  /** Optional immutable workflow revision selected from Workflow Studio. */
  initialWorkflow?: WorkflowRevisionRecord | null;
  initialProjectId?: string;
  initialWorkspacePath?: string;
  onOpenChange: (open: boolean) => void;
  onCreated?: (runId: string) => void;
};

/** A single, explicit entry point for creating a durable objective run. */
export function ObjectiveCreateDialog({
  open,
  initialWorkflow,
  initialProjectId,
  initialWorkspacePath,
  onOpenChange,
  onCreated,
}: ObjectiveCreateDialogProps) {
  const symphony = useSymphony();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [workflowKey, setWorkflowKey] = useState("");
  const [objectiveId, setObjectiveId] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [mission, setMission] = useState("");
  const [criteria, setCriteria] = useState<ObjectiveCriterionDraft[]>([emptyCriterion()]);
  const [permission, setPermission] = useState<ObjectivePermission>("read-only");
  const [workspaceDirtyPolicy, setWorkspaceDirtyPolicy] = useState<"local-only" | "require-clean" | "explicit-checkpoint">("local-only");
  const [maxCostUsd, setMaxCostUsd] = useState("Unlimited");
  const [maxTotalTokens, setMaxTotalTokens] = useState("Unlimited");
  const [maxModelCalls, setMaxModelCalls] = useState("Unlimited");
  const [maxToolCalls, setMaxToolCalls] = useState("Unlimited");
  const [maxWallTimeSeconds, setMaxWallTimeSeconds] = useState("Unlimited");
  const [maxOutputBytes, setMaxOutputBytes] = useState("Unlimited");
  const [maxConcurrentAgents, setMaxConcurrentAgents] = useState("Unlimited");
  const [allowedCapabilities, setAllowedCapabilities] = useState("");
  const [sideEffectClassCeiling, setSideEffectClassCeiling] = useState<"read" | "local" | "external" | "irreversible">("read");
  const [expiresAt, setExpiresAt] = useState("");
  const [approvalTimeoutSeconds, setApprovalTimeoutSeconds] = useState("Unlimited");
  const [maxReplans, setMaxReplans] = useState("8");
  const [approvalPolicy, setApprovalPolicy] = useState<"never" | "on-replan" | "before-completion">("never");
  const [firstPlan, setFirstPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRunId, setCreatedRunId] = useState<string | null>(null);

  const projects = symphony.projects;
  const workflows = symphony.envelope.workflows;
  const conductorAgentId = symphony.activeConversation?.conductorAgentId?.trim() || null;
  const executionAvailability = objectiveExecutionAvailability(conductorAgentId);
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId) ?? null, [projectId, projects]);
  const workflowOptions = useMemo(() => [
    {
      value: STANDALONE_WORKFLOW_KEY,
      label: "Standalone objective",
      description: "No registered workflow required; the conductor can author the plan.",
    },
    ...workflows.map(workflowOption),
  ], [workflows]);
  const selectedWorkflow = useMemo(() => {
    const [id, revision] = workflowKey.split("@", 2);
    return workflows.find((workflow) => workflow.id === id && String(workflow.revision) === revision) ?? null;
  }, [workflowKey, workflows]);

  useEffect(() => {
    if (!open) return;
    const selected = initialProjectId && projects.some((project) => project.id === initialProjectId)
      ? projects.find((project) => project.id === initialProjectId)
      : projects[0];
    const workflow = initialWorkflow && workflows.some((candidate) => candidate.id === initialWorkflow.id && candidate.revision === initialWorkflow.revision)
      ? initialWorkflow
      : latestWorkflow(workflows);
    setProjectId(selected?.id ?? "");
    setWorkspacePath(initialWorkspacePath?.trim() || selected?.workspacePath || "");
    setWorkflowKey(workflow ? `${workflow.id}@${workflow.revision}` : STANDALONE_WORKFLOW_KEY);
    setObjectiveId(`objective-${newIdempotencyKey()}`);
    setMission("");
    setCriteria([emptyCriterion()]);
    setPermission("read-only");
    setWorkspaceDirtyPolicy("local-only");
    setMaxCostUsd("Unlimited");
    setMaxTotalTokens("Unlimited");
    setMaxModelCalls("Unlimited");
    setMaxToolCalls("Unlimited");
    setMaxWallTimeSeconds("Unlimited");
    setMaxOutputBytes("Unlimited");
    setMaxConcurrentAgents("Unlimited");
    setAllowedCapabilities("");
    setSideEffectClassCeiling("read");
    setExpiresAt("");
    setApprovalTimeoutSeconds("Unlimited");
    setMaxReplans("8");
    setApprovalPolicy("never");
    setFirstPlan("");
    setBusy(false);
    setError(null);
    setCreatedRunId(null);
  }, [initialProjectId, initialWorkflow?.hash, initialWorkflow?.id, initialWorkflow?.revision, initialWorkspacePath, open]);

  const setProject = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    const project = projects.find((candidate) => candidate.id === nextProjectId);
    if (project) setWorkspacePath(project.workspacePath);
  };

  const updateCriterion = (index: number, patch: Partial<ObjectiveCriterionDraft>) => {
    setCriteria((current) => current.map((criterion, criterionIndex) => criterionIndex === index ? { ...criterion, ...patch } : criterion));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || createdRunId) return;
    setError(null);
    if (symphony.mode !== "runtime") {
      setError("Objective creation requires a live Symphony runtime.");
      return;
    }
    if (!executionAvailability.executable) {
      setError(executionAvailability.message);
      return;
    }
    setBusy(true);
    try {
      const standaloneWorkflow = standaloneWorkflowIdentity(objectiveId);
      const request = buildObjectiveCreateRequest({
        objectiveId,
        workflowId: selectedWorkflow?.id ?? (workflowKey === STANDALONE_WORKFLOW_KEY ? standaloneWorkflow.workflowId : ""),
        workflowRevision: selectedWorkflow?.revision ?? standaloneWorkflow.workflowRevision,
        workflowHash: selectedWorkflow?.hash ?? (workflowKey === STANDALONE_WORKFLOW_KEY ? standaloneWorkflow.workflowHash : ""),
        conductorAgentId,
        workspacePath,
        workspaceDirtyPolicy,
        mission,
        criteria,
        permission,
        maxCostUsd,
        maxTotalTokens,
        maxModelCalls,
        maxToolCalls,
        maxWallTimeSeconds,
        maxOutputBytes,
        maxConcurrentAgents,
        allowedCapabilities,
        sideEffectClassCeiling,
        expiresAt,
        approvalTimeoutSeconds,
        maxReplans,
        approvalPolicy,
        firstPlan,
      });
      const run = await createObjective(request, newIdempotencyKey());
      const authoritative = await fetchObjectiveDetail(run.runId, { limit: 1 });
      if (authoritative.run.runId !== run.runId) throw new Error("The daemon returned a different objective run while refreshing.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] }),
        queryClient.invalidateQueries({ queryKey: ["symphony", "objectives"] }),
        queryClient.invalidateQueries({ queryKey: ["symphony", "objective", run.runId] }),
      ]);
      setCreatedRunId(run.runId);
      onCreated?.(run.runId);
    } catch (nextError) {
      setError(nextError instanceof ObjectiveEntryValidationError || nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const projectOptions = projects.map((project) => ({ value: project.id, label: project.title, description: project.workspacePath }));
  const canSubmit = symphony.mode === "runtime" && executionAvailability.executable && !busy && !createdRunId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(48rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-2xl">
        {createdRunId ? (
          <div className="grid gap-4 py-8 text-center">
            <CheckCircle className="mx-auto size-9 text-success" weight="fill" />
            <div>
              <DialogTitle>Objective created</DialogTitle>
              <DialogDescription className="mt-2">The daemon accepted the objective and the projection was refreshed.</DialogDescription>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">{createdRunId}</p>
            <Button className="mx-auto" onClick={() => onOpenChange(false)}>Done</Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="mb-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><Target className="size-3.5 text-info" /> Objective Runtime</div>
              <DialogTitle>Start an objective</DialogTitle>
              <DialogDescription>Set the mission and runtime bounds for a durable run, with an optional workspace plan.</DialogDescription>
            </DialogHeader>

            <form onSubmit={submit} className="space-y-5">
              <section className="space-y-3" aria-labelledby="objective-scope-heading">
                <SectionHeading id="objective-scope-heading" title="Scope" />
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Project">
                    <SelectControl value={projectId} options={projectOptions} onValueChange={setProject} ariaLabel="Project" placeholder="Choose a project" />
                  </Field>
                  <Field label="Workflow revision">
                    <SelectControl value={workflowKey} options={workflowOptions} onValueChange={setWorkflowKey} ariaLabel="Workflow revision" placeholder="Choose a workflow" disabled={!workflowOptions.length} />
                  </Field>
                </div>
                <Field label="Workspace path">
                  <Input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="/Users/you/Programming/project" aria-label="Workspace path" className="font-mono text-xs" />
                </Field>
                <Field label="Workspace policy">
                  <SelectControl value={workspaceDirtyPolicy} options={DIRTY_POLICY_OPTIONS} onValueChange={(value) => setWorkspaceDirtyPolicy(value as typeof workspaceDirtyPolicy)} ariaLabel="Workspace policy" />
                </Field>
                <p className="text-[10px] text-muted-foreground">{selectedProject ? `${selectedProject.title} · ` : ""}{selectedWorkflow ? "The selected revision anchors this run. Workspace scope is applied to first-plan tasks." : "Standalone workflow identity; no workflow registration is required."}</p>
                <div className={executionAvailability.executable ? "rounded-lg bg-success/10 px-3 py-2 text-[10px] text-success" : "rounded-lg bg-warning/10 px-3 py-2 text-[10px] text-warning"} role="status" aria-live="polite">
                  {executionAvailability.executable ? (
                    <><span className="font-medium">Conductor attached</span><span className="ml-1.5 font-mono text-[9px] opacity-80">{conductorAgentId}</span><span className="ml-1.5 opacity-80">· this chat owns dispatch and replanning.</span></>
                  ) : (
                    <><span className="font-medium">Needs an active conductor</span><span className="ml-1.5 opacity-80">· standalone identity is available, but executable work cannot be dispatched without a live conductor chat.</span></>
                  )}
                </div>
              </section>

              <section className="space-y-3" aria-labelledby="objective-mission-heading">
                <SectionHeading id="objective-mission-heading" title="Mission" />
                <Field label="What should be true when this is done?">
                  <Textarea value={mission} onChange={(event) => setMission(event.target.value)} placeholder="Describe the outcome, not a fixed set of agent roles." aria-label="Mission" rows={3} />
                </Field>
                <Field label="Objective ID">
                  <Input value={objectiveId} onChange={(event) => setObjectiveId(event.target.value)} aria-label="Objective ID" className="font-mono text-xs" />
                </Field>
              </section>

              <section className="space-y-3" aria-labelledby="objective-criteria-heading">
                <div className="flex items-center justify-between gap-3"><SectionHeading id="objective-criteria-heading" title="Success criteria" /><button type="button" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setCriteria((current) => [...current, emptyCriterion()])}><Plus className="size-3" /> Add</button></div>
                <div className="space-y-3">
                  {criteria.map((criterion, index) => (
                    <div key={index} className="rounded-lg bg-muted/30 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-muted-foreground">criterion {index + 1}</span>{criteria.length > 1 ? <button type="button" aria-label={`Remove criterion ${index + 1}`} className="text-muted-foreground hover:text-destructive" onClick={() => setCriteria((current) => current.filter((_, criterionIndex) => criterionIndex !== index))}><Trash className="size-3.5" /></button> : null}</div>
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                        <Input value={criterion.description} onChange={(event) => updateCriterion(index, { description: event.target.value })} placeholder="Tests pass" aria-label={`Criterion ${index + 1} description`} />
                        <Input value={criterion.path} onChange={(event) => updateCriterion(index, { path: event.target.value })} placeholder="checks.tests" aria-label={`Criterion ${index + 1} evidence path`} className="font-mono text-xs" />
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                        <SelectControl value={criterion.op} options={OP_OPTIONS} onValueChange={(value) => updateCriterion(index, { op: value as ObjectiveCriterionDraft["op"] })} ariaLabel={`Criterion ${index + 1} operation`} />
                        <Input value={criterion.value} onChange={(event) => updateCriterion(index, { value: event.target.value })} placeholder={criterion.op === "exists" ? "No value needed" : "true or JSON"} aria-label={`Criterion ${index + 1} expected value`} disabled={criterion.op === "exists"} className="font-mono text-xs" />
                        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })} /> Required</label>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground">Paths are evaluated against checkpoint context. Leave the row blank to omit it.</p>
              </section>

              <section className="space-y-3" aria-labelledby="objective-bounds-heading">
                <SectionHeading id="objective-bounds-heading" title="Admission policy" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="First-plan task permission">
                    <SelectControl value={permission} options={PERMISSION_OPTIONS} onValueChange={(value) => setPermission(value as ObjectivePermission)} ariaLabel="Permission" />
                  </Field>
                  <Field label="Side-effect ceiling">
                    <SelectControl value={sideEffectClassCeiling} options={SIDE_EFFECT_OPTIONS} onValueChange={(value) => setSideEffectClassCeiling(value as typeof sideEffectClassCeiling)} ariaLabel="Side-effect ceiling" />
                  </Field>
                  <Field label="Max replans"><Input value={maxReplans} onChange={(event) => setMaxReplans(event.target.value)} inputMode="numeric" aria-label="Max replans" /></Field>
                  <Field label="Approval policy"><SelectControl value={approvalPolicy} options={APPROVAL_OPTIONS} onValueChange={(value) => setApprovalPolicy(value as typeof approvalPolicy)} ariaLabel="Approval policy" /></Field>
                  <LimitField label="Cost ceiling (USD)" value={maxCostUsd} onChange={setMaxCostUsd} decimal ariaLabel="Maximum cost in USD" />
                  <LimitField label="Total token ceiling" value={maxTotalTokens} onChange={setMaxTotalTokens} ariaLabel="Maximum total tokens" />
                  <LimitField label="Model-call ceiling" value={maxModelCalls} onChange={setMaxModelCalls} ariaLabel="Maximum model calls" />
                  <LimitField label="Tool-call ceiling" value={maxToolCalls} onChange={setMaxToolCalls} ariaLabel="Maximum tool calls" />
                  <LimitField label="Wall-time ceiling (seconds)" value={maxWallTimeSeconds} onChange={setMaxWallTimeSeconds} decimal ariaLabel="Maximum wall time in seconds" />
                  <LimitField label="Output-byte ceiling" value={maxOutputBytes} onChange={setMaxOutputBytes} ariaLabel="Maximum output bytes" />
                  <LimitField label="Concurrent-agent ceiling" value={maxConcurrentAgents} onChange={setMaxConcurrentAgents} ariaLabel="Maximum concurrent agents" />
                  <LimitField label="Approval timeout (seconds)" value={approvalTimeoutSeconds} onChange={setApprovalTimeoutSeconds} ariaLabel="Approval timeout in seconds" />
                </div>
                <Field label="Allowed capabilities">
                  <Input value={allowedCapabilities} onChange={(event) => setAllowedCapabilities(event.target.value)} placeholder="read, observe" aria-label="Allowed capabilities" />
                </Field>
                <Field label="Objective expiry">
                  <Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} aria-label="Objective expiry" />
                </Field>
                <p className="text-[10px] text-muted-foreground">Every quantitative ceiling is sent as a number or explicit Unlimited. Leave expiry blank for no expiry; the daemon remains authoritative and may narrow any request.</p>
              </section>

              <section className="space-y-3" aria-labelledby="objective-plan-heading">
                <SectionHeading id="objective-plan-heading" title="First plan" optional />
                <Field label="One task per line">
                  <Textarea value={firstPlan} onChange={(event) => setFirstPlan(event.target.value)} placeholder="Inspect the current state\nImplement the smallest coherent change\nVerify the success criteria" aria-label="First plan" rows={4} />
                </Field>
                <p className="text-[10px] text-muted-foreground">Each line is an initial intent. The conductor owns dependencies, topology, and harness choices as the objective evolves.</p>
              </section>

              {error ? <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"><XCircle className="mt-0.5 size-3.5 shrink-0" /><span>{error}</span></div> : null}
              <div className="flex items-center justify-between gap-3 border-t border-border pt-4"><span className="text-[10px] text-muted-foreground">{symphony.mode === "preview" ? "Live runtime required" : executionAvailability.executable ? "Creates one durable run" : "Open a live conductor chat to continue"}</span><Button type="submit" disabled={!canSubmit}>{busy ? <AgentLoader kind="square" size={14} label="Creating objective" /> : <Target className="size-3.5" />}{busy ? "Creating…" : "Create objective"}</Button></div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionHeading({ id, title, optional = false }: { id: string; title: string; optional?: boolean }) {
  return <h2 id={id} className="text-[11px] font-medium tracking-[0.08em] text-foreground/85">{title}{optional ? <span className="ml-1.5 font-normal text-muted-foreground">optional</span> : null}</h2>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1.5"><span className="block text-[10px] font-medium text-muted-foreground">{label}</span>{children}</label>;
}

function LimitField({ label, value, onChange, ariaLabel, decimal = false }: { label: string; value: string; onChange: (value: string) => void; ariaLabel: string; decimal?: boolean }) {
  return <Field label={label}><Input value={value} onChange={(event) => onChange(event.target.value)} inputMode={decimal ? "decimal" : "numeric"} placeholder="Unlimited" aria-label={ariaLabel} /></Field>;
}

function workflowOption(workflow: WorkflowRevisionRecord): SelectOption {
  const mission = workflow.mission;
  const statement = mission && typeof mission === "object" && !Array.isArray(mission) && typeof mission.statement === "string" ? mission.statement : undefined;
  return { value: `${workflow.id}@${workflow.revision}`, label: `${workflow.id} · r${workflow.revision}`, ...(statement ? { description: statement } : {}) };
}

function latestWorkflow(workflows: readonly WorkflowRevisionRecord[]): WorkflowRevisionRecord | null {
  return [...workflows].sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id))[0] ?? null;
}
