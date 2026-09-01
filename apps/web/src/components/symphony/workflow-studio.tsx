"use client";

import {
  BracketsCurly,
  CaretDown,
  CheckCircle,
  Clock,
  Code,
  FlowArrow,
  Gauge,
  GitBranch,
  PlayCircle,
  Plus,
  Repeat,
  Sparkle,
  Stack,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { CapabilityLibrary } from "@/components/symphony/capability-library";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSymphony } from "@/components/symphony/context";
import type { JsonValue, WorkflowRevisionRecord } from "@/lib/symphony/contracts";
import {
  activateCapability,
  activateWorkflow,
  type CapabilityActivationInput,
  deprecateCapability,
  fetchCapabilities,
  newIdempotencyKey,
  registerWorkflow,
} from "@/lib/symphony/runtime-client";
import type { CapabilityParameterValues, CapabilityTrigger, CapabilityVersionRecord as RenderCapabilityVersionRecord } from "@/lib/symphony/capability-library";
import { adaptCapabilityVersionRecord } from "@/lib/symphony/capability-library";
import {
  buildWorkflowVisualModel,
  type WorkflowBranch,
  type WorkflowJsonValidation,
  type WorkflowStepType,
  type WorkflowVisualNode,
  validateWorkflowJson,
} from "@/lib/symphony/workflow-studio";
import { cn } from "@/lib/utils";
import type { StudioMode } from "@/lib/symphony/workspace-tabs";

type StudioView = "structure" | "source";

export function WorkflowStudio({ onOpenObjective, studioMode: controlledStudioMode, onStudioModeChange }: {
  onOpenObjective: (workflow: WorkflowRevisionRecord) => void;
  studioMode?: StudioMode;
  onStudioModeChange?: (mode: StudioMode) => void;
}) {
  const symphony = useSymphony();
  const queryClient = useQueryClient();
  const runtime = symphony.mode === "runtime" && symphony.envelope.mode === "runtime";
  const [uncontrolledStudioMode, setUncontrolledStudioMode] = useState<StudioMode>("workflows");
  const studioMode = controlledStudioMode ?? uncontrolledStudioMode;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [registeredRecord, setRegisteredRecord] = useState<WorkflowRevisionRecord | null>(null);
  const [view, setView] = useState<StudioView>("structure");
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [registrationKey, setRegistrationKey] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [activating, setActivating] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registrationSuccess, setRegistrationSuccess] = useState<string | null>(null);
  const capabilityMutationKeys = useRef(new Map<string, string>());
  const setStudioMode = (mode: StudioMode) => {
    if (controlledStudioMode === undefined) setUncontrolledStudioMode(mode);
    onStudioModeChange?.(mode);
  };
  const records = useMemo(() => {
    const source = [...symphony.envelope.workflows];
    if (registeredRecord && !source.some((record) => workflowKey(record) === workflowKey(registeredRecord))) source.push(registeredRecord);
    return source.sort((left, right) => right.revision - left.revision || left.id.localeCompare(right.id));
  }, [registeredRecord, symphony.envelope.workflows]);
  const selected = records.find((record) => workflowKey(record) === selectedKey) ?? (records[0] ?? null);
  const model = useMemo(() => selected ? buildWorkflowVisualModel(selected) : null, [selected]);
  const validation = useMemo<WorkflowJsonValidation>(() => validateWorkflowJson(draft), [draft]);
  const capabilitiesQuery = useQuery({
    queryKey: ["symphony", "capabilities"],
    queryFn: ({ signal }) => fetchCapabilities({}, signal),
    enabled: runtime && studioMode === "capabilities",
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const capabilityRecords = useMemo(
    () => (capabilitiesQuery.data ?? []).map(adaptCapabilityVersionRecord),
    [capabilitiesQuery.data],
  );

  const openEditor = () => {
    setEditorOpen(true);
    setRegistrationError(null);
    setRegistrationSuccess(null);
    setDraft("");
    setRegistrationKey(newIdempotencyKey());
  };

  const updateDraft = (value: string) => {
    setDraft(value);
    // Editing changes the logical registration intent; retries without edits
    // retain the same key so a lost response cannot create another revision.
    setRegistrationKey(newIdempotencyKey());
  };

  const submitRegistration = async () => {
    if (!runtime || registering || !validation.valid || validation.value === undefined) return;
    setRegistering(true);
    setRegistrationError(null);
    setRegistrationSuccess(null);
    try {
      const requestKey = registrationKey ?? newIdempotencyKey();
      setRegistrationKey(requestKey);
      const record = await registerWorkflow(validation.value, requestKey);
      setRegisteredRecord(record);
      setSelectedKey(workflowKey(record));
      setRegistrationSuccess(`${record.id} · revision ${record.revision} is registered and pinned by the daemon.`);
      setRegistrationKey(newIdempotencyKey());
      setView("structure");
      await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
    } catch (error) {
      setRegistrationError(error instanceof Error ? error.message : String(error));
    } finally {
      setRegistering(false);
    }
  };

  const submitActivation = async () => {
    if (!runtime || !selected || activating) return;
    setActivating(true);
    setRegistrationError(null);
    try {
      await activateWorkflow(selected.id, newIdempotencyKey());
      setRegistrationSuccess(`${selected.id} schedule is active. Future daemon restarts will preserve this activation.`);
      await queryClient.invalidateQueries({ queryKey: ["symphony", "bootstrap"] });
    } catch (error) {
      setRegistrationError(error instanceof Error ? error.message : String(error));
    } finally {
      setActivating(false);
    }
  };

  const mutateCapability = async (
    action: "activate" | "deprecate",
    record: RenderCapabilityVersionRecord,
    parameters?: CapabilityParameterValues,
    triggers?: readonly CapabilityTrigger[],
  ) => {
    const mutationId = `${action}:${record.id}@${record.version}`;
    const requestKey = capabilityMutationKeys.current.get(mutationId) ?? newIdempotencyKey();
    capabilityMutationKeys.current.set(mutationId, requestKey);
    const result = action === "activate"
      ? await activateCapability(record.id, Number(record.version), requestKey, undefined, {
        parameters: materializeActivationParameters(parameters),
        triggers: (triggers ?? []).map(toActivationTrigger),
      })
      : await deprecateCapability(record.id, Number(record.version), requestKey);
    if (result.status === "committed" || result.status === "replayed") capabilityMutationKeys.current.delete(mutationId);
    await queryClient.invalidateQueries({ queryKey: ["symphony", "capabilities"] });
    return result;
  };

  if (!runtime) return <StudioState title="Workflow Studio unavailable" detail="Connect to a live Symphony daemon to inspect registered workflow revisions." />;
  if (symphony.connection === "connecting" && records.length === 0) return <StudioState title="Loading registered workflows" detail="Reading workflow authority from the daemon." loading />;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border/75 px-5 py-5 md:px-8 md:py-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-info"><FlowArrow className="size-3.5" /> Workflow Studio</div>
          <h2 className="mt-2 font-display text-xl tracking-[-0.035em] text-foreground/95 md:text-2xl">{studioMode === "workflows" ? "Compose durable work." : "Work with durable capabilities."}</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{studioMode === "workflows" ? "Inspect immutable workflow revisions, trace nested execution shape, and pin one exact revision when opening an objective." : "Inspect daemon-owned capability revisions, validate typed inputs, and manage lifecycle state with explicit confirmation."}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden rounded-full border border-success/25 bg-success/8 px-2.5 py-1 font-mono text-[9px] text-success sm:inline-flex sm:items-center sm:gap-1.5"><CheckCircle className="size-3" /> Daemon authority</span>
          {studioMode === "workflows" ? <Button variant="outline" size="sm" onClick={openEditor}><Plus className="size-3.5" /> Register revision</Button> : null}
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-1 border-b border-border/75 px-5 pt-2 md:px-8" role="tablist" aria-label="Studio modes">
        <StudioModeTab active={studioMode === "workflows"} onClick={() => setStudioMode("workflows")} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "End") { event.preventDefault(); setStudioMode("capabilities"); } }} icon={<FlowArrow />} label="Workflows" controls="studio-workflows-panel" />
        <StudioModeTab active={studioMode === "capabilities"} onClick={() => setStudioMode("capabilities")} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "Home") { event.preventDefault(); setStudioMode("workflows"); } }} icon={<Sparkle />} label="Capabilities" controls="studio-capabilities-panel" />
      </div>

      {registrationSuccess ? <Notice tone="success" icon={<CheckCircle />} onDismiss={() => setRegistrationSuccess(null)}>{registrationSuccess}</Notice> : null}
      {registrationError ? <Notice tone="danger" icon={<XCircle />} onDismiss={() => setRegistrationError(null)}>{registrationError}</Notice> : null}

      {studioMode === "workflows" && editorOpen ? (
        <RegistrationEditor
          draft={draft}
          validation={validation}
          busy={registering}
          onDraftChange={updateDraft}
          onSubmit={() => void submitRegistration()}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}

      {studioMode === "capabilities" ? (
        <div id="studio-capabilities-panel" role="tabpanel" aria-label="Capabilities" className="flex min-h-0 flex-1 flex-col">
          {capabilitiesQuery.isPending ? <StudioState title="Loading capabilities" detail="Reading capability authority from the daemon." loading /> : null}
          {capabilitiesQuery.isError ? <CapabilitiesError onRetry={() => void capabilitiesQuery.refetch()} detail={capabilitiesQuery.error instanceof Error ? capabilitiesQuery.error.message : "The daemon did not return capability records."} /> : null}
          {!capabilitiesQuery.isPending && !capabilitiesQuery.isError ? <CapabilityLibrary records={capabilityRecords} onActivate={(record, parameters, triggers) => mutateCapability("activate", record, parameters, triggers)} onDeprecate={(record) => mutateCapability("deprecate", record)} title="Capability library" description="Reusable capabilities with explicit inputs, defaults, and immutable lifecycle history." /> : null}
        </div>
      ) : <div id="studio-workflows-panel" role="tabpanel" aria-label="Workflows" className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex max-h-56 w-full shrink-0 flex-col border-b border-border/75 bg-card/20 md:max-h-none md:w-64 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-4 pb-2 pt-4"><span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Registered</span><span className="font-mono text-[10px] tabular-nums text-foreground/70">{records.length}</span></div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {records.length === 0 ? <EmptyRegistry /> : records.map((record) => <WorkflowListItem key={workflowKey(record)} record={record} selected={selected ? workflowKey(selected) === workflowKey(record) : false} onSelect={() => { setSelectedKey(workflowKey(record)); setRegisteredRecord(null); }} />)}
          </div>
        </aside>

        {selected && model ? (
          <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[100rem] px-4 py-5 md:px-8 md:py-7">
              <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-display text-lg tracking-[-0.025em] text-foreground/95">{model.name}</h3><span className="rounded-md border border-info/25 bg-info/8 px-2 py-0.5 font-mono text-[10px] text-info">r{selected.revision}</span></div>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{model.mission}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9px] text-muted-foreground/80"><span>{selected.id}</span><span className="text-border">/</span><span title={selected.hash}>sha256:{selected.hash.slice(0, 12)}…</span><span className="text-border">/</span><span>registered {formatDate(selected.createdAt)}</span></p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {selected.triggerState === "pending" ? <Button variant="outline" size="sm" onClick={() => void submitActivation()} disabled={activating} title="Promote this agent-authored schedule after inspection">{activating ? <AgentLoader kind="square" size={13} label="Activating schedule" /> : <Clock className="size-3.5" />}{activating ? "Activating…" : "Activate schedule"}</Button> : null}
                  <Button size="sm" onClick={() => onOpenObjective(selected)} title="Open objective setup with this exact workflow revision"><PlayCircle className="size-3.5" /> Use in objective</Button>
                </div>
              </header>

              <div className="mt-6 flex items-center justify-between gap-3 border-b border-border/75">
                <div className="flex items-center gap-1" role="tablist" aria-label="Workflow detail views">
                  <StudioTab active={view === "structure"} onClick={() => setView("structure")} icon={<FlowArrow />} label="Structure" />
                  <StudioTab active={view === "source"} onClick={() => setView("source")} icon={<Code />} label="Source & validation" />
                </div>
                <span className="hidden pb-2 font-mono text-[9px] text-muted-foreground sm:inline">immutable revision · daemon projected</span>
              </div>

              {view === "structure" ? <StructureView model={model} /> : <SourceView record={selected} />}
            </div>
          </section>
        ) : <EmptySelection onRegister={openEditor} />}
      </div>}
    </main>
  );
}

function materializeActivationParameters(values: CapabilityParameterValues | undefined): JsonValue {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) => value !== undefined)) as JsonValue;
}

function toActivationTrigger(trigger: CapabilityTrigger): NonNullable<CapabilityActivationInput["triggers"]>[number] {
  let configuration: JsonValue = trigger.expression ?? {};
  if (typeof configuration === "string") {
    try { configuration = JSON.parse(configuration) as JsonValue; } catch { /* caller-defined trigger expressions may be plain strings */ }
  }
  return {
    id: trigger.id,
    kind: trigger.type,
    configuration,
    enabled: trigger.enabled ?? true,
  };
}

function WorkflowListItem({ record, selected, onSelect }: { record: WorkflowRevisionRecord; selected: boolean; onSelect: () => void }) {
  const model = buildWorkflowVisualModel(record);
  return <button type="button" onClick={onSelect} className={cn("group mb-1 w-full rounded-lg border px-3 py-2.5 text-left transition-colors", selected ? "border-foreground/20 bg-accent/70" : "border-transparent hover:border-border/80 hover:bg-muted/35")} aria-current={selected ? "true" : undefined}>
    <div className="flex items-start gap-2"><span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", record.triggerState === "pending" ? "bg-warning" : selected ? "bg-info" : "bg-muted-foreground/45")} /><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium text-foreground/90">{model.name}</span><span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground">{record.id}</span></span><span className="flex shrink-0 items-center gap-1.5"><span className={cn("hidden rounded border px-1.5 py-0.5 font-mono text-[9px] sm:inline", record.triggerState === "pending" ? "border-warning/25 bg-warning/8 text-warning" : "border-border/75 text-muted-foreground")}>{record.triggerState === "pending" ? "pending" : `r${record.revision}`}</span>{record.triggerState === "pending" ? <span className="rounded border border-border/75 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground sm:hidden">r{record.revision}</span> : null}</span></div>
  </button>;
}

function StructureView({ model }: { model: ReturnType<typeof buildWorkflowVisualModel> }) {
  const dependencyCount = countDependencies(model.steps);
  return <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
    <section className="rounded-xl border border-border/80 bg-card/28 p-4 md:p-5" aria-labelledby="workflow-structure-title">
      <div className="flex items-center justify-between gap-3"><div><h4 id="workflow-structure-title" className="text-[11px] font-medium uppercase tracking-[0.12em] text-foreground/80">Execution structure</h4><p className="mt-1 text-[10px] text-muted-foreground">Containers stay visible so sequence, fan-out, decisions, loops, and prerequisite edges remain legible.</p></div><span className="font-mono text-[9px] text-muted-foreground">{model.steps.length} root step{model.steps.length === 1 ? "" : "s"}</span></div>
      <div className="mt-5 space-y-2">{model.steps.map((node, index) => <WorkflowNode key={node.id} node={node} index={index} />)}</div>
    </section>
    <aside className="space-y-3">
      <StructureLegend />
      <div className="rounded-xl border border-border/80 bg-card/28 p-4"><p className="font-mono text-[9px] uppercase tracking-[0.13em] text-muted-foreground">Revision anchor</p><p className="mt-2 text-xs leading-5 text-foreground/80">Objective setup will carry this workflow ID, revision, and hash into the durable run admission.</p>{dependencyCount > 0 ? <p className="mt-3 border-t border-border/60 pt-3 font-mono text-[10px] text-info">{dependencyCount} explicit prerequisite edge{dependencyCount === 1 ? "" : "s"}</p> : null}</div>
    </aside>
  </div>;
}

function WorkflowNode({ node, index }: { node: WorkflowVisualNode; index: number }) {
  const [open, setOpen] = useState(true);
  const hasNested = node.steps.length > 0 || node.branches.length > 0;
  const icon = stepIcon(node.type);
  const Icon = icon.icon;
  return <div className={cn("relative", node.depth > 0 && "ml-4 border-l border-border/80 pl-4 md:ml-6 md:pl-5")}>
    {node.depth === 0 && index > 0 ? <div className="absolute -top-2 left-4 h-2 border-l border-border/70" aria-hidden="true" /> : null}
    <div className={cn("rounded-lg border px-3 py-3", icon.surface)}>
      <div className="flex items-start gap-3"><span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-md", icon.badge)}><Icon className="size-3.5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">{node.label}</span><span className="font-mono text-[9px] text-muted-foreground/75">{node.id}</span></div><p className="mt-1 text-xs leading-5 text-foreground/90">{node.detail}</p>{node.dependsOn.length > 0 ? <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[9px] text-info"><FlowArrow className="size-3" aria-hidden="true" /><span className="text-info/70">after</span>{node.dependsOn.map((dependency) => <span key={dependency} className="rounded border border-info/20 bg-info/8 px-1.5 py-0.5">{dependency}</span>)}</div> : null}</div>{hasNested ? <button type="button" onClick={() => setOpen((current) => !current)} className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`${open ? "Collapse" : "Expand"} ${node.id}`}><CaretDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} /></button> : null}</div>
    </div>
    {open && node.steps.length > 0 ? <div className="mt-2 space-y-2">{node.steps.map((child, childIndex) => <WorkflowNode key={child.id} node={child} index={childIndex} />)}</div> : null}
    {open && node.branches.length > 0 ? <div className="mt-3 grid gap-3 md:grid-cols-2">{node.branches.map((branch) => <BranchGroup key={branch.label} branch={branch} />)}</div> : null}
  </div>;
}

function BranchGroup({ branch }: { branch: WorkflowBranch }) {
  return <div className="rounded-lg border border-dashed border-warning/35 bg-warning/5 p-3"><div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.14em] text-warning"><GitBranch className="size-3" /> {branch.label} branch <span className="text-warning/55">{branch.steps.length} step{branch.steps.length === 1 ? "" : "s"}</span></div><div className="mt-3 space-y-2">{branch.steps.map((node, index) => <WorkflowNode key={node.id} node={node} index={index} />)}</div></div>;
}

function SourceView({ record }: { record: WorkflowRevisionRecord }) {
  const source = JSON.stringify(record.definition, null, 2);
  return <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]"><section className="min-w-0 rounded-xl border border-border/80 bg-card/28 p-4 md:p-5"><div className="flex items-center justify-between gap-3"><div><h4 className="text-[11px] font-medium uppercase tracking-[0.12em] text-foreground/80">Daemon source</h4><p className="mt-1 text-[10px] text-muted-foreground">The exact definition used for this immutable revision.</p></div><BracketsCurly className="size-4 text-muted-foreground" /></div><pre className="mt-4 max-h-[34rem] overflow-auto rounded-lg border border-border/70 bg-background/70 p-4 font-mono text-[10px] leading-5 text-foreground/80"><code>{source}</code></pre></section><aside className="space-y-3"><div className="rounded-xl border border-success/25 bg-success/6 p-4"><div className="flex items-center gap-2 text-success"><CheckCircle className="size-4" /><p className="text-xs font-medium">Validated at registration</p></div><p className="mt-2 text-[10px] leading-5 text-muted-foreground">The daemon compiler accepted this source and pinned its content hash.</p></div><div className="rounded-xl border border-border/80 bg-card/28 p-4"><p className="font-mono text-[9px] uppercase tracking-[0.13em] text-muted-foreground">Content hash</p><p className="mt-2 break-all font-mono text-[10px] leading-5 text-foreground/75">{record.hash}</p></div></aside></div>;
}

function RegistrationEditor({ draft, validation, busy, onDraftChange, onSubmit, onClose }: { draft: string; validation: WorkflowJsonValidation; busy: boolean; onDraftChange: (value: string) => void; onSubmit: () => void; onClose: () => void }) {
  return <section className="shrink-0 border-b border-info/20 bg-info/5 px-5 py-4 md:px-8" aria-labelledby="register-workflow-title"><div className="mx-auto max-w-[100rem]"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Code className="size-4 text-info" /><h3 id="register-workflow-title" className="text-sm font-medium text-foreground/95">Register a workflow revision</h3></div><p className="mt-1 text-[10px] leading-5 text-muted-foreground">Paste a complete workflow definition. Registration is idempotent and creates a new immutable revision only when its content changes.</p></div><button type="button" onClick={onClose} className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Close editor</button></div><Textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="Paste JSON workflow definition…" aria-label="Workflow JSON definition" spellCheck={false} className="mt-3 min-h-48 resize-y rounded-lg border-border/80 bg-background/70 font-mono text-[10px] leading-5" /><p className="mt-2 font-mono text-[9px] leading-4 text-muted-foreground">Any step may declare <code className="rounded bg-background/70 px-1 text-info">&quot;dependsOn&quot;: [&quot;step-id&quot;]</code>. Dependencies are validated by the daemon and scheduled as ready frontiers inside parallel containers.</p>{validation.valid ? <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-success"><CheckCircle className="size-3.5" /> Definition passes strict client checks. The daemon will assign its revision.</div> : <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/7 px-3 py-2 text-[10px] text-destructive"><div className="flex items-center gap-2 font-medium"><WarningCircle className="size-3.5" /> Fix {validation.errors.length} validation issue{validation.errors.length === 1 ? "" : "s"}</div><ul className="mt-2 space-y-1 font-mono leading-4">{validation.errors.slice(0, 8).map((error) => <li key={error}>{error}</li>)}</ul>{validation.errors.length > 8 ? <p className="mt-1 text-destructive/70">+ {validation.errors.length - 8} more</p> : null}</div>}<div className="mt-3 flex flex-wrap items-center justify-between gap-3"><span className="font-mono text-[9px] text-muted-foreground">POST /v1/workflows · Idempotency-Key per submit</span><div className="flex items-center gap-2"><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button size="sm" onClick={onSubmit} disabled={!validation.valid || busy}>{busy ? <AgentLoader kind="square" size={13} label="Registering workflow" /> : <Plus className="size-3.5" />}{busy ? "Registering…" : "Register revision"}</Button></div></div></div></section>;
}

function StudioTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={cn("inline-flex items-center gap-1.5 border-b-2 px-2 pb-2 text-[10px] transition-colors", active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
    {icon}<span>{label}</span>
  </button>;
}

function StudioModeTab({ active, onClick, onKeyDown, icon, label, controls }: { active: boolean; onClick: () => void; onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void; icon: React.ReactNode; label: string; controls: string }) {
  return <button type="button" role="tab" aria-selected={active} aria-controls={controls} tabIndex={active ? 0 : -1} onClick={onClick} onKeyDown={onKeyDown} className={cn("inline-flex min-h-8 items-center gap-1.5 border-b-2 px-3 pb-2 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground")}>
    {icon}<span>{label}</span>
  </button>;
}

function StructureLegend() {
  return <div className="rounded-xl border border-border/80 bg-card/28 p-4"><p className="font-mono text-[9px] uppercase tracking-[0.13em] text-muted-foreground">Step vocabulary</p><div className="mt-3 grid grid-cols-2 gap-2">{(["agent", "sequence", "parallel", "if", "while", "set", "evaluate", "timer", "signal"] as WorkflowStepType[]).map((type) => { const icon = stepIcon(type); const Icon = icon.icon; return <div key={type} className="flex items-center gap-2 text-[10px] text-foreground/75"><span className={cn("grid size-5 place-items-center rounded", icon.badge)}><Icon className="size-3" /></span>{type}</div>; })}</div></div>;
}

function countDependencies(nodes: readonly WorkflowVisualNode[]): number {
  return nodes.reduce((total, node) => total + node.dependsOn.length + countDependencies(node.steps) + node.branches.reduce((branchTotal, branch) => branchTotal + countDependencies(branch.steps), 0), 0);
}

function stepIcon(type: WorkflowStepType): { icon: React.ElementType; badge: string; surface: string } {
  if (type === "agent") return { icon: PlayCircle, badge: "bg-info/12 text-info", surface: "border-info/20 bg-info/4" };
  if (type === "parallel") return { icon: Stack, badge: "bg-success/12 text-success", surface: "border-success/20 bg-success/4" };
  if (type === "if") return { icon: GitBranch, badge: "bg-warning/12 text-warning", surface: "border-warning/20 bg-warning/4" };
  if (type === "while") return { icon: Repeat, badge: "bg-warning/12 text-warning", surface: "border-warning/20 bg-warning/4" };
  if (type === "set") return { icon: BracketsCurly, badge: "bg-muted text-muted-foreground", surface: "border-border/90 bg-card/30" };
  if (type === "evaluate") return { icon: Gauge, badge: "bg-info/12 text-info", surface: "border-info/20 bg-info/4" };
  if (type === "timer" || type === "signal") return { icon: Clock, badge: "bg-warning/12 text-warning", surface: "border-warning/20 bg-warning/4" };
  return { icon: FlowArrow, badge: "bg-muted text-foreground/70", surface: "border-border/90 bg-card/30" };
}

function EmptyRegistry() { return <div className="rounded-lg border border-dashed border-border/80 px-3 py-5 text-center"><Stack className="mx-auto size-5 text-muted-foreground/55" /><p className="mt-2 text-[11px] text-foreground/75">No registered workflows</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">The daemon registry is empty.</p></div>; }
function EmptySelection({ onRegister }: { onRegister: () => void }) { return <div className="grid min-h-0 flex-1 place-items-center px-6 py-12 text-center"><div className="max-w-sm"><FlowArrow className="mx-auto size-7 text-muted-foreground/55" /><h3 className="mt-3 text-sm font-medium">Select a registered workflow</h3><p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">Workflow Studio only renders records returned by the live daemon.</p><Button variant="outline" size="sm" className="mt-4" onClick={onRegister}><Plus className="size-3.5" /> Register first revision</Button></div></div>; }
function StudioState({ title, detail, loading = false }: { title: string; detail: string; loading?: boolean }) { return <main className="grid min-h-0 flex-1 place-items-center bg-background px-6 text-center"><div className="max-w-sm">{loading ? <span className="mx-auto block size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" role="status" aria-label={title} /> : <WarningCircle className="mx-auto size-6 text-warning/80" />}<h2 className="mt-3 text-sm font-medium text-foreground/90">{title}</h2><p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{detail}</p></div></main>; }
function CapabilitiesError({ detail, onRetry }: { detail: string; onRetry: () => void }) { return <main className="grid min-h-0 flex-1 place-items-center bg-background px-6 text-center"><div className="max-w-md"><WarningCircle className="mx-auto size-6 text-warning/80" /><h2 className="mt-3 text-sm font-medium text-foreground/90">Capabilities unavailable</h2><p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{detail}</p><Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>Try again</Button></div></main>; }
function Notice({ tone, icon, children, onDismiss }: { tone: "success" | "danger"; icon: React.ReactNode; children: React.ReactNode; onDismiss: () => void }) { return <div className={cn("flex items-start gap-2 border-b px-5 py-2.5 text-[10px] md:px-8", tone === "success" ? "border-success/15 bg-success/6 text-success" : "border-destructive/20 bg-destructive/6 text-destructive")} role="status"><span className="mt-0.5 size-3.5">{icon}</span><span className="min-w-0 flex-1 leading-5">{children}</span><button type="button" className="text-current/70 hover:text-current" onClick={onDismiss} aria-label="Dismiss notice">×</button></div>; }
function workflowKey(record: Pick<WorkflowRevisionRecord, "id" | "revision">): string { return `${record.id}@${record.revision}`; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date); }
