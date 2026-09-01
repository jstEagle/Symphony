"use client";

import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  Clock,
  Funnel,
  GitBranch,
  MagnifyingGlass,
  Pulse,
  ShieldCheck,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useMemo, useRef, useState, type ElementType } from "react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { ObjectiveArtifactWorkspace } from "@/components/symphony/objective-artifact-workspace";
import type { ObjectiveWorkspaceFrontierItem, ObjectiveWorkspaceProjection, ObjectiveWorkspaceRunlineEntry } from "@/lib/symphony/objective-snapshot";
import {
  filterOperatorRunline,
  OPERATOR_FILTERS,
  operatorEventTone,
  operatorStatusLabel,
  operatorStatusTone,
  projectObjectiveOperator,
  type OperatorDensity,
  type OperatorFilter,
} from "@/lib/symphony/objective-operator";
import { cn } from "@/lib/utils";

type ApprovalDecision = "approved" | "rejected";

export type ObjectiveOperatorProps = {
  workspace: ObjectiveWorkspaceProjection;
  onOpenAgent?: (agentId: string) => void;
  onResolveApproval?: (approvalId: string, decision: ApprovalDecision) => void | Promise<void>;
  onReviewArtifact?: (artifactId: string, state: "verified" | "rejected", reason: string) => void | Promise<void>;
  resolvingApprovalId?: string | null;
  approvalError?: string | null;
};

/**
 * Dense operator surface for a cursor-fenced objective. It deliberately reads
 * like an operations console: one causal runline, one durable state rail, and
 * actions only where the owning caller supplied an idempotent command.
 */
export function ObjectiveOperator({
  workspace,
  onOpenAgent,
  onResolveApproval,
  onReviewArtifact,
  resolvingApprovalId = null,
  approvalError = null,
}: ObjectiveOperatorProps) {
  const projection = useMemo(() => projectObjectiveOperator(workspace), [workspace]);
  const [filter, setFilter] = useState<OperatorFilter>("all");
  const [query, setQuery] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [density, setDensity] = useState<OperatorDensity>("comfortable");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const runlineRef = useRef<HTMLOListElement>(null);
  const runIds = useMemo(() => [...new Set(projection.runline.map((entry) => entry.runId))], [projection.runline]);
  const filteredEntries = useMemo(
    () => filterOperatorRunline(projection.runline, filter, query, runId),
    [filter, projection.runline, query, runId],
  );
  const selectedEntry = filteredEntries.find((entry) => entry.id === selectedEntryId)
    ?? projection.runline.find((entry) => entry.id === selectedEntryId)
    ?? null;
  const openAttentions = workspace.attentions.filter((attention) => attention.status === "open");
  const pendingApprovals = workspace.snapshot.approvals.filter((approval) => approval.status === "requested");
  const activeExecution = projection.counts.active > 0;
  const stateTone = objectiveStateTone(workspace.objective.state, openAttentions.length > 0);

  const jumpToLatest = () => {
    const list = runlineRef.current;
    if (!list) return;
    list.scrollTo({ top: 0, behavior: "smooth" });
    setSelectedEntryId(filteredEntries[0]?.id ?? null);
  };

  return (
    <main className="min-h-full flex-1 bg-background text-foreground" aria-label="Objective operator">
      <div className="mx-auto w-full max-w-[108rem] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <header className="border-b border-border/45 pb-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 max-w-4xl">
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/75">
                <Pulse className="size-3.5 text-info" aria-hidden="true" />
                <span className="text-info">Operator</span>
                <span aria-hidden="true">/</span>
                <span>fence {workspace.eventCursor}</span>
                {workspace.objective.activeRevision ? <><span aria-hidden="true">/</span><span>objective r{workspace.objective.activeRevision}</span></> : null}
              </div>
              <h1 className="text-[clamp(1.25rem,2.3vw,2rem)] font-medium leading-[1.12] tracking-[-0.035em] text-foreground/95">
                {workspace.objective.statement ?? workspace.objective.spec?.statement ?? "Untitled objective"}
              </h1>
              <p className="mt-2 max-w-3xl text-[11px] leading-5 text-muted-foreground">
                {workspace.objective.objectiveId} · {workspace.currentRuns.length} current run{workspace.currentRuns.length === 1 ? "" : "s"} · {workspace.occurrences.length} occurrence{workspace.occurrences.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <StateBadge state={workspace.objective.state} tone={stateTone} active={activeExecution} />
              <button type="button" className="operator-button" onClick={jumpToLatest} disabled={filteredEntries.length === 0} title="Jump to the newest visible runline entry">
                <ArrowClockwise className="size-3.5" aria-hidden="true" /> Latest
              </button>
            </div>
          </div>
          <StateStrip workspace={workspace} projection={projection} />
        </header>

        <div className="mt-5 grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <section className="min-w-0" aria-labelledby="operator-runline-heading">
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 id="operator-runline-heading" className="text-[13px] font-medium text-foreground/90">Runline</h2>
                  <span className="font-mono text-[9px] text-muted-foreground">{filteredEntries.length}/{projection.runline.length}</span>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">Causal events in daemon order. Expand one row to inspect its evidence.</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Runline controls">
                <div className="flex items-center gap-1 rounded-lg border border-border/55 bg-card/25 p-0.5" role="group" aria-label="Runline density">
                  <DensityButton active={density === "comfortable"} onClick={() => setDensity("comfortable")} label="Comfortable" />
                  <DensityButton active={density === "compact"} onClick={() => setDensity("compact")} label="Compact" />
                </div>
                {runIds.length > 1 ? <RunSelector runIds={runIds} value={runId} onChange={setRunId} /> : null}
              </div>
            </div>
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <label className="relative min-w-0 flex-1">
                <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/65" aria-hidden="true" />
                <span className="sr-only">Search runline</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search events, runs, subjects…" className="operator-input w-full pl-8" />
              </label>
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5" role="group" aria-label="Filter runline">
                <Funnel className="ml-1 size-3.5 shrink-0 text-muted-foreground/65" aria-hidden="true" />
                {OPERATOR_FILTERS.map((value) => <FilterButton key={value} value={value} active={filter === value} onClick={() => setFilter(value)} />)}
              </div>
            </div>

            {filteredEntries.length === 0 ? (
              <OperatorEmptyState filtered={projection.runline.length > 0} />
            ) : (
              <ol ref={runlineRef} className="operator-runline mt-3 max-h-[48rem] overflow-y-auto overscroll-contain rounded-xl bg-card/[0.12] pr-1" aria-label="Objective runline">
                {filteredEntries.map((entry, index) => (
                  <RunlineEntryRow
                    key={`${entry.runId}:${entry.id}`}
                    entry={entry}
                    selected={selectedEntry?.id === entry.id}
                    density={density}
                    last={index === filteredEntries.length - 1}
                    onSelect={() => setSelectedEntryId((current) => current === entry.id ? null : entry.id)}
                  />
                ))}
              </ol>
            )}
          </section>

          <aside className="min-w-0 space-y-4" aria-label="Objective state and controls">
            <CurrentState workspace={workspace} stateTone={stateTone} />
            <FrontierPanel frontier={projection.frontier} onOpenAgent={onOpenAgent} />
            <AttentionPanel
              attentions={openAttentions}
              approvals={pendingApprovals}
              onResolveApproval={onResolveApproval}
              resolvingApprovalId={resolvingApprovalId}
              approvalError={approvalError}
            />
          </aside>
        </div>
        <ObjectiveArtifactWorkspace workspace={workspace} onReviewArtifact={onReviewArtifact} />
      </div>
    </main>
  );
}

function StateStrip({ workspace, projection }: { workspace: ObjectiveWorkspaceProjection; projection: ReturnType<typeof projectObjectiveOperator> }) {
  const cells = [
    { label: "Active", value: projection.counts.active, detail: "executing", tone: "info" as const },
    { label: "Runnable", value: projection.counts.runnable, detail: "ready to advance", tone: "info" as const },
    { label: "Waiting", value: projection.counts.waiting, detail: "timer, signal, dependency", tone: "warning" as const },
    { label: "Unknown", value: projection.counts.unknown, detail: "needs reconciliation", tone: "danger" as const },
    { label: "Events", value: workspace.eventCursor, detail: "authoritative fence", tone: "default" as const },
  ];
  return <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/45 bg-border/35 sm:grid-cols-5">{cells.map((cell) => <div key={cell.label} className="bg-card/40 px-3 py-2.5"><p className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/65">{cell.label}</p><p className={cn("mt-1 text-sm font-medium tabular-nums", toneText[cell.tone])}>{cell.value}</p><p className="mt-0.5 truncate text-[9px] text-muted-foreground/65" title={cell.detail}>{cell.detail}</p></div>)}</div>;
}

function RunlineEntryRow({ entry, selected, density, last, onSelect }: { entry: ObjectiveWorkspaceRunlineEntry & { category: Exclude<OperatorFilter, "all"> }; selected: boolean; density: OperatorDensity; last: boolean; onSelect: () => void }) {
  const tone = operatorEventTone(entry.type);
  const Icon = eventIcon(entry.type);
  const live = tone === "info" && ["stage-entered", "agent-delegated", "loop-iteration"].includes(entry.type);
  return <li className={cn("relative pl-6", density === "compact" ? "pb-1.5" : "pb-2.5", last && "pb-0")}>
    <span className={cn("absolute left-[0.25rem] top-[1.05rem] z-10 grid size-3.5 -translate-x-1/2 place-items-center rounded-full ring-4 ring-background", toneDot[tone])} aria-hidden="true">{live ? <span className="size-1.5 rounded-full bg-background/85" /> : null}</span>
    {!last ? <span className="absolute bottom-[-0.1rem] left-[0.25rem] top-[1.65rem] w-px -translate-x-1/2 bg-border/65" aria-hidden="true" /> : null}
    <button type="button" onClick={onSelect} aria-expanded={selected} className={cn("group w-full rounded-lg border text-left transition-[background-color,border-color,transform] duration-150 ease-out hover:-translate-y-px hover:bg-muted/28 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none motion-reduce:hover:transform-none", density === "compact" ? "px-3 py-2" : "px-3.5 py-3", selected ? "border-foreground/20 bg-card/45" : "border-border/35 bg-card/20")}>
      <span className="flex min-w-0 items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", toneText[tone])} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[11px] font-medium capitalize text-foreground/90">{entry.type.replaceAll("-", " ")}</span>
            {entry.collapsedCount > 1 ? <span className="rounded bg-muted/35 px-1 py-0.5 font-mono text-[9px] text-muted-foreground">×{entry.collapsedCount}</span> : null}
            <span className={cn("font-mono text-[9px]", toneText[tone])}>{entry.category}</span>
            <span className="font-mono text-[9px] text-muted-foreground/65">{entry.cursor === null ? "—" : `#${entry.cursor}`}</span>
          </span>
          <span className="mt-1 block text-[10px] leading-4 text-foreground/80">{entry.summary}</span>
          <span className="mt-1.5 flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[9px] text-muted-foreground/65">
            <span>{entry.runId}</span>
            {entry.subjectKind && entry.subjectId ? <span>{entry.subjectKind} · {entry.subjectId}</span> : null}
            <span>{formatTime(entry.occurredAt)}</span>
          </span>
        </span>
        <CaretDown className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-hover:text-foreground/75 motion-reduce:transition-none", selected && "rotate-180")} aria-hidden="true" />
      </span>
      {selected ? <RunlineInspector entry={entry} /> : null}
    </button>
  </li>;
}

function RunlineInspector({ entry }: { entry: ObjectiveWorkspaceRunlineEntry & { category: Exclude<OperatorFilter, "all"> } }) {
  return <span className="mt-3 grid gap-2 border-t border-border/35 pt-2.5 sm:grid-cols-3">
    <InspectorFact label="Subject" value={entry.subjectId ?? "objective"} />
    <InspectorFact label="Evidence" value={entry.evidence.eventCursor === null ? "not attached" : `cursor ${entry.evidence.eventCursor}`} />
    <InspectorFact label="Attempts" value={entry.attemptLineage.length ? `${entry.attemptLineage.length} lineage record${entry.attemptLineage.length === 1 ? "" : "s"}` : "none recorded"} />
  </span>;
}

function InspectorFact({ label, value }: { label: string; value: string }) { return <span className="min-w-0"><span className="block font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground/55">{label}</span><span className="mt-0.5 block truncate font-mono text-[9px] text-foreground/75" title={value}>{value}</span></span>; }

function CurrentState({ workspace, stateTone }: { workspace: ObjectiveWorkspaceProjection; stateTone: "info" | "success" | "warning" | "danger" }) {
  const summary = workspace.snapshot.runline?.summary ?? workspace.snapshot.frontierProjection?.summary ?? "The daemon has not published a state summary for this objective.";
  return <OperatorPanel title="Current state" icon={<Pulse />} meta={`fence ${workspace.eventCursor}`}>
    <div className="flex items-center gap-2"><StatusDot tone={stateTone} active={stateTone === "info"} /><span className={cn("text-[12px] font-medium capitalize", toneText[stateTone])}>{workspace.objective.state.replaceAll("-", " ")}</span></div>
    <p className="mt-2 text-[10px] leading-4 text-muted-foreground">{summary}</p>
    <div className="mt-3 grid gap-2 border-t border-border/35 pt-3 text-[9px] text-muted-foreground"><span className="flex justify-between gap-3"><span>Active revision</span><span className="font-mono text-foreground/75">r{workspace.objective.activeRevision}</span></span><span className="flex justify-between gap-3"><span>Plan revisions</span><span className="font-mono text-foreground/75">{workspace.planMutations.length + workspace.snapshot.plan.revisions.length}</span></span><span className="flex justify-between gap-3"><span>Current runs</span><span className="font-mono text-foreground/75">{workspace.currentRuns.length}</span></span></div>
  </OperatorPanel>;
}

function FrontierPanel({ frontier, onOpenAgent }: { frontier: ObjectiveWorkspaceProjection["frontier"]; onOpenAgent?: (agentId: string) => void }) {
  return <OperatorPanel title="Frontier" icon={<GitBranch />} meta={`${frontier.length} unfinished`}>
    {frontier.length === 0 ? <Quiet detail="No unfinished execution is published at this fence." /> : <div className="space-y-1.5">{frontier.slice(0, 7).map((item) => <FrontierItem key={`${item.runId}:${item.id}`} item={item} onOpenAgent={onOpenAgent} />)}{frontier.length > 7 ? <p className="pt-1 font-mono text-[9px] text-muted-foreground">+{frontier.length - 7} more items in the runline</p> : null}</div>}
  </OperatorPanel>;
}

function FrontierItem({ item, onOpenAgent }: { item: ObjectiveWorkspaceFrontierItem; onOpenAgent?: (agentId: string) => void }) {
  const tone = operatorStatusTone(item.status);
  const active = item.status === "running";
  const detail = frontierDetail(item);
  const content = <span className="flex min-w-0 items-start gap-2"><span className="mt-0.5 shrink-0">{active ? <AgentLoader kind="square" size={14} label={`${item.label} active`} animated tone="info" /> : <StatusDot tone={tone} active={false} />}</span><span className="min-w-0 flex-1"><span className="flex min-w-0 items-baseline gap-1.5"><span className="min-w-0 flex-1 truncate text-[10px] font-medium text-foreground/85">{item.label}</span><span className={cn("shrink-0 font-mono text-[8px] capitalize", toneText[tone])}>{operatorStatusLabel(item.status)}</span></span><span className="mt-0.5 block truncate text-[9px] text-muted-foreground/70" title={detail}>{detail}</span></span>{onOpenAgent ? <ArrowSquareOut className="mt-0.5 size-3 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-foreground/75" aria-hidden="true" /> : null}</span>;
  return item.agentId && onOpenAgent ? <button type="button" className="group w-full rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" onClick={() => onOpenAgent(item.agentId!)}>{content}</button> : <div className="px-1.5 py-1.5">{content}</div>;
}

function AttentionPanel({ attentions, approvals, onResolveApproval, resolvingApprovalId, approvalError }: { attentions: ObjectiveWorkspaceProjection["attentions"]; approvals: ObjectiveWorkspaceProjection["snapshot"]["approvals"]; onResolveApproval?: ObjectiveOperatorProps["onResolveApproval"]; resolvingApprovalId: string | null; approvalError: string | null }) {
  const total = attentions.length + approvals.length;
  return <OperatorPanel title="Attention" icon={<WarningCircle />} meta={total ? `${total} open` : "clear"} tone={total ? "warning" : undefined}>
    {total === 0 ? <Quiet detail="No durable decisions or attention requests are waiting." /> : <div className="space-y-2">{attentions.slice(0, 3).map((attention) => <div key={attention.id} className="rounded-md bg-warning/[0.06] px-2.5 py-2"><p className="text-[10px] font-medium text-foreground/85">{attention.reason}</p><p className="mt-1 text-[9px] leading-4 text-muted-foreground">{attention.proposedAction}</p><span className="mt-1 block font-mono text-[8px] uppercase text-warning/80">{attention.urgency} · {attention.risk} risk</span></div>)}{approvals.slice(0, 3).map((approval) => <ApprovalItem key={approval.id} approval={approval} onResolve={onResolveApproval} resolving={resolvingApprovalId === approval.id} />)}{approvalError ? <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-[9px] leading-4 text-destructive" role="alert">{approvalError}</p> : null}</div>}
  </OperatorPanel>;
}

function ApprovalItem({ approval, onResolve, resolving }: { approval: ObjectiveWorkspaceProjection["snapshot"]["approvals"][number]; onResolve?: ObjectiveOperatorProps["onResolveApproval"]; resolving: boolean }) {
  return <div className="rounded-md bg-warning/[0.06] px-2.5 py-2.5"><div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" /><p className="min-w-0 text-[10px] font-medium leading-4 text-foreground/85">{approval.question}</p></div><p className="mt-1 font-mono text-[8px] text-muted-foreground/75">{approval.sideEffectClass} effect · run {approval.runId}</p><div className="mt-2 flex flex-wrap items-center gap-1.5"><button type="button" disabled={!onResolve || resolving} onClick={() => void onResolve?.(approval.id, "approved")} className="rounded bg-foreground px-2 py-1 font-mono text-[8px] text-background disabled:cursor-not-allowed disabled:opacity-45">{resolving ? "Resolving" : "Approve"}</button><button type="button" disabled={!onResolve || resolving} onClick={() => void onResolve?.(approval.id, "rejected")} className="rounded border border-border/65 px-2 py-1 font-mono text-[8px] text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45">Reject</button>{!onResolve ? <span className="font-mono text-[8px] text-muted-foreground/60">command unavailable</span> : null}</div></div>;
}

function OperatorPanel({ title, icon, meta, tone, children }: { title: string; icon: React.ReactNode; meta: string; tone?: "warning" | "danger"; children: React.ReactNode }) {
  return <section className={cn("rounded-xl border bg-card/[0.22] p-3.5 backdrop-blur-xl", tone === "warning" ? "border-warning/30" : tone === "danger" ? "border-destructive/30" : "border-border/45")}><header className="mb-3 flex items-center gap-2"><span className={cn("text-muted-foreground [&>svg]:size-3.5", tone === "warning" && "text-warning", tone === "danger" && "text-destructive")} aria-hidden="true">{icon}</span><h2 className="text-[11px] font-medium text-foreground/85">{title}</h2><span className="ml-auto font-mono text-[9px] text-muted-foreground">{meta}</span></header>{children}</section>;
}

function StateBadge({ state, tone, active }: { state: string; tone: "info" | "success" | "warning" | "danger"; active: boolean }) { return <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 font-mono text-[9px] capitalize", toneBorder[tone])}>{active ? <AgentLoader kind="square" size={12} label={`${state} active`} animated tone={tone} /> : <StatusDot tone={tone} active={false} />}{state.replaceAll("-", " ")}</span>; }
function StatusDot({ tone, active }: { tone: "info" | "success" | "warning" | "danger"; active: boolean }) { return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", toneDot[tone], active && "animate-pulse motion-reduce:animate-none")} aria-hidden="true" />; }
function DensityButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) { return <button type="button" onClick={onClick} aria-pressed={active} className={cn("rounded-md px-2 py-1 font-mono text-[8px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60", active ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-muted/35 hover:text-foreground")}>{label}</button>; }
function FilterButton({ value, active, onClick }: { value: OperatorFilter; active: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} aria-pressed={active} className={cn("shrink-0 rounded-md px-2 py-1 font-mono text-[8px] capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60", active ? "bg-info/12 text-info" : "text-muted-foreground hover:bg-muted/35 hover:text-foreground")}>{value}</button>; }
function RunSelector({ runIds, value, onChange }: { runIds: string[]; value: string | null; onChange: (value: string | null) => void }) { return <label className="flex items-center gap-1.5 rounded-lg border border-border/55 bg-card/25 px-2 py-1 font-mono text-[8px] text-muted-foreground"><span className="sr-only">Filter by run</span><select value={value ?? "all"} onChange={(event) => onChange(event.target.value === "all" ? null : event.target.value)} className="max-w-[8rem] bg-transparent text-[8px] text-foreground/75 outline-none"><option value="all">All runs</option>{runIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>; }
function OperatorEmptyState({ filtered }: { filtered: boolean }) { return <div className="mt-3 grid min-h-48 place-items-center rounded-xl border border-dashed border-border/45 bg-card/[0.12] px-5 text-center"><div><MagnifyingGlass className="mx-auto size-5 text-muted-foreground/50" aria-hidden="true" /><p className="mt-2 text-[11px] font-medium text-foreground/80">{filtered ? "No runline entries match" : "No execution events yet"}</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{filtered ? "Clear the search or choose a wider filter." : "The daemon will publish causal events as the objective moves."}</p></div></div>; }
function Quiet({ detail }: { detail: string }) { return <p className="rounded-md border border-dashed border-border/35 px-2.5 py-3 text-[9px] leading-4 text-muted-foreground/75">{detail}</p>; }
function frontierDetail(item: ObjectiveWorkspaceFrontierItem): string { if (item.status === "blocked-dependency" && item.blockedBy.length) return `blocked by ${item.blockedBy.join(", ")}`; if (item.status === "waiting-timer" && item.dueAt) return `due ${formatTime(item.dueAt)}`; if (item.status === "waiting-signal" && item.signalKey) return `signal ${item.signalKey}`; if (item.status === "waiting-attention" && item.attentionIds.length) return `${item.attentionIds.length} attention request${item.attentionIds.length === 1 ? "" : "s"}`; return item.unknownReason ?? item.terminalReason ?? item.sourceState; }
function eventIcon(type: ObjectiveWorkspaceRunlineEntry["type"]): ElementType { if (type.includes("failed") || type === "outcome-unknown") return XCircle; if (type.includes("artifact") || type.includes("checkpoint")) return CheckCircle; if (type.includes("branch") || type.includes("plan") || type.includes("revision")) return GitBranch; if (type.includes("attention") || type.includes("suspension") || type.includes("retry")) return WarningCircle; if (type.includes("loop") || type.includes("stage") || type.includes("agent")) return Pulse; return Clock; }
function objectiveStateTone(state: string, attention: boolean): "info" | "success" | "warning" | "danger" { if (state === "achieved") return "success"; if (state === "abandoned") return "danger"; if (attention || state === "waiting") return "warning"; return "info"; }
function formatTime(value: string): string { const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp) : value; }

const toneDot = { info: "bg-info", success: "bg-success", warning: "bg-warning", danger: "bg-destructive", default: "bg-muted-foreground/55" } as const;
const toneText = { info: "text-info", success: "text-success", warning: "text-warning", danger: "text-destructive", default: "text-muted-foreground" } as const;
const toneBorder = { info: "border-info/30 bg-info/[0.04] text-info", success: "border-success/30 bg-success/[0.04] text-success", warning: "border-warning/30 bg-warning/[0.04] text-warning", danger: "border-destructive/30 bg-destructive/[0.04] text-destructive" } as const;
