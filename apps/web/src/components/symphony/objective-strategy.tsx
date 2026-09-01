"use client";

import {
  ArrowSquareOut,
  BracketsCurly,
  CaretDown,
  CheckCircle,
  Clock,
  Gauge,
  GitBranch,
  ListBullets,
  Repeat,
  Shuffle,
  XCircle,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { cn } from "@/lib/utils";
import {
  buildObjectiveStrategyViewModel,
  strategyExecutionKey,
  strategyStatusLabel,
  type ObjectiveStrategyIfNode,
  type ObjectiveStrategyEvaluateNode,
  type ObjectiveStrategyNode,
  type ObjectiveStrategySignalNode,
  type ObjectiveStrategyTimerNode,
  type ObjectiveStrategyProjection,
  type ObjectiveStrategyStatus,
  type ObjectiveStrategyViewModel,
} from "@/lib/symphony/objective-strategy";

export type ObjectiveStrategyProps = {
  projection: ObjectiveStrategyProjection;
  onOpenAgent?: (agentId: string) => void;
};

/**
 * A dense, inspectable strategy surface for a durable objective.
 *
 * This is intentionally read-only. The parent owns the authoritative
 * projection and can later add mutation callbacks once the daemon's typed
 * control-plan API is available.
 */
export function ObjectiveStrategy({ projection, onOpenAgent }: ObjectiveStrategyProps) {
  const viewModel = useMemo(() => buildObjectiveStrategyViewModel(projection), [projection]);

  if (viewModel.kind !== "ready") return <StrategyState projection={viewModel} />;

  const { projection: ready, counts } = viewModel;
  const frontierIds = useMemo(() => new Set(ready.frontierIds), [ready.frontierIds]);
  return (
    <section data-slot="objective-strategy" aria-labelledby="objective-strategy-heading" className="min-w-0">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            <GitBranch className="size-3.5 text-info" aria-hidden="true" />
            <span>Control surface</span>
          </div>
          <h2 id="objective-strategy-heading" className="text-[clamp(1.2rem,2vw,1.6rem)] font-medium tracking-[-0.03em] text-foreground/95">Strategy</h2>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">The plan the daemon is executing now, including branches, iterations, and the agents attached to each leaf.</p>
        </div>
        <StrategyIdentity projection={ready} />
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border/45 py-2.5 font-mono text-[9px] text-muted-foreground">
        <span>{counts.total} nodes</span>
        <span className="text-info">{counts.active} active</span>
        <span className="text-success">{counts.completed} done</span>
        {counts.attention > 0 ? <span className="text-warning">{counts.attention} attention</span> : null}
        <span className="ml-auto">{counts.frontier} frontier</span>
      </div>

      {viewModel.frontier.length > 0 ? <FrontierStrip viewModel={viewModel} /> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,0.34fr)]">
        <div className="min-w-0 rounded-xl border border-border/55 bg-card/[0.18] p-3 backdrop-blur-xl md:p-4">
          {ready.roots.length === 0 ? <InlineState detail="This strategy has no executable nodes yet." /> : (
            <div className="space-y-1">
              {ready.roots.map((node) => <StrategyNodeView key={strategyExecutionKey(node)} node={node} depth={0} frontierIds={frontierIds} onOpenAgent={onOpenAgent} />)}
            </div>
          )}
        </div>
        <MutationHistory mutations={viewModel.mutations} />
      </div>
    </section>
  );
}

function StrategyIdentity({ projection }: { projection: Extract<ObjectiveStrategyProjection, { kind: "ready" }> }) {
  const sourceLabel = projection.source.kind === "workflow-revision" ? "workflow" : projection.source.kind;
  return (
    <div className="min-w-0 text-right font-mono text-[9px] text-muted-foreground">
      <div className="truncate text-foreground/80" title={projection.objectiveId}>{projection.objectiveId}</div>
      <div className="mt-1 flex flex-wrap justify-end gap-x-2 gap-y-1">
        <span>r{projection.revision}</span>
        <span>{sourceLabel}{projection.source.revision === null ? "" : ` r${projection.source.revision}`}</span>
        {projection.source.hash ? <span title={projection.source.hash}>{projection.source.hash.slice(0, 10)}</span> : null}
      </div>
    </div>
  );
}

function FrontierStrip({ viewModel }: { viewModel: ObjectiveStrategyViewModel }) {
  return (
    <div className="mb-5 border-l-2 border-info/65 bg-info/[0.045] px-3 py-2.5" aria-label="Current strategy frontier">
      <div className="mb-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.1em] text-info"><ListBullets className="size-3" aria-hidden="true" /> Current frontier</div>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] text-foreground/85">
        {viewModel.frontier.map((row) => <span key={row.key} className="inline-flex min-w-0 items-center gap-1.5"><StatusMarker status={row.state} label={`${row.label} ${strategyStatusLabel(row.state)}`} /><span className="truncate">{row.label}{row.iterationPath.length > 0 ? ` · iteration ${row.iterationPath.join(".")}` : ""}</span></span>)}
      </div>
    </div>
  );
}

function StrategyNodeView({ node, depth, frontierIds, onOpenAgent }: { node: ObjectiveStrategyNode; depth: number; frontierIds: Set<string>; onOpenAgent?: (agentId: string) => void }) {
  if (node.kind === "agent") return <AgentNode node={node} depth={depth} frontier={isFrontier(node, frontierIds)} onOpenAgent={onOpenAgent} />;
  if (node.kind === "timer") return <TimerNode node={node} depth={depth} frontier={isFrontier(node, frontierIds)} />;
  if (node.kind === "signal") return <SignalNode node={node} depth={depth} frontier={isFrontier(node, frontierIds)} />;
  if (node.kind === "if") return <IfNode node={node} depth={depth} frontier={isFrontier(node, frontierIds)} frontierIds={frontierIds} onOpenAgent={onOpenAgent} />;
  if (node.kind === "set") return <SetNode node={node} depth={depth} frontier={isFrontier(node, frontierIds)} />;
  if (node.kind === "evaluate") return <EvaluateNode node={node} depth={depth} frontier={isFrontier(node, frontierIds)} />;

  const children = node.kind === "while" ? node.body : node.children;
  const icon = node.kind === "while" ? <Repeat /> : node.kind === "parallel" ? <Shuffle /> : <ListBullets />;
  const detail = node.kind === "while"
    ? `${node.iteration}${node.maxIterations === null ? "" : `/${node.maxIterations}`} iteration${node.iteration === 1 ? "" : "s"}${node.exitReason ? ` · ${node.exitReason}` : ""}`
    : `${children.length} step${children.length === 1 ? "" : "s"}`;

  return (
    <details open className={cn("group/strategy rounded-lg", depth > 0 && "ml-3 border-l border-border/40 pl-3")}>
      <summary className="list-none cursor-pointer rounded-lg outline-none transition-colors hover:bg-muted/25 focus-visible:bg-muted/25 [&::-webkit-details-marker]:hidden">
        <NodeHeader icon={icon} label={node.label} kind={node.kind} state={node.state} frontier={isFrontier(node, frontierIds)} detail={detail} />
      </summary>
      <div className="mt-1 space-y-1">
        {children.length === 0 ? <InlineState detail="No child nodes recorded." /> : children.map((child) => <StrategyNodeView key={strategyExecutionKey(child)} node={child} depth={depth + 1} frontierIds={frontierIds} onOpenAgent={onOpenAgent} />)}
      </div>
    </details>
  );
}

function TimerNode({ node, depth, frontier }: { node: ObjectiveStrategyTimerNode; depth: number; frontier: boolean }) {
  const className = cn("rounded-lg", depth > 0 && "ml-3 border-l border-border/40 pl-3");
  const detail = node.suspensionStatus === "waiting"
    ? `waiting until ${node.dueAt ? formatDate(node.dueAt) : "due time pending"}${node.since ? ` · since ${formatDate(node.since)}` : ""}`
    : node.suspensionStatus === "delivered"
      ? `completed at ${node.dueAt ? formatDate(node.dueAt) : "due time"}`
      : `${Math.round(node.durationMs / 1_000)}s timer`;
  return <div className={className} data-suspension-kind="timer"><NodeHeader icon={<Clock className="size-3.5" />} label={node.label} kind="timer" state={node.state} frontier={frontier} detail={detail} /></div>;
}

function SignalNode({ node, depth, frontier }: { node: ObjectiveStrategySignalNode; depth: number; frontier: boolean }) {
  const className = cn("rounded-lg", depth > 0 && "ml-3 border-l border-border/40 pl-3");
  const detail = node.suspensionStatus === "waiting"
    ? `waiting for ${node.signalKey}${node.since ? ` since ${formatDate(node.since)}` : ""}${node.expiresAt ? ` · expires ${formatDate(node.expiresAt)}` : ""}`
    : `${node.signalKey}${node.suspensionStatus ? ` · ${node.suspensionStatus}` : ""}`;
  return <div className={className} data-suspension-kind="signal"><NodeHeader icon={<Clock className="size-3.5" />} label={node.label} kind="signal" state={node.state} frontier={frontier} detail={detail} /></div>;
}

function IfNode({ node, depth, frontier, frontierIds, onOpenAgent }: { node: ObjectiveStrategyIfNode; depth: number; frontier: boolean; frontierIds: Set<string>; onOpenAgent?: (agentId: string) => void }) {
  return (
    <div className={cn("rounded-lg", depth > 0 && "ml-3 border-l border-border/40 pl-3")}>
      <div className="rounded-lg"><NodeHeader icon={<GitBranch />} label={node.label} kind="if" state={node.state} frontier={frontier} detail={node.condition ?? "condition unavailable"} /></div>
      <div className="mt-1 grid gap-1.5 pl-3 sm:grid-cols-2">
        <BranchColumn branch="then" selected={node.selectedBranch === "then"} nodes={node.then} frontierIds={frontierIds} onOpenAgent={onOpenAgent} />
        <BranchColumn branch="else" selected={node.selectedBranch === "else"} nodes={node.else} frontierIds={frontierIds} onOpenAgent={onOpenAgent} />
      </div>
    </div>
  );
}

function SetNode({ node, depth, frontier }: { node: Extract<ObjectiveStrategyNode, { kind: "set" }>; depth: number; frontier: boolean }) {
  const className = cn("rounded-lg", depth > 0 && "ml-3 border-l border-border/40 pl-3");
  return <div className={className}><NodeHeader icon={<BracketsCurly />} label={node.label} kind="set" state={node.state} frontier={frontier} detail={node.valueSummary ?? "value unavailable"} /></div>;
}

function EvaluateNode({ node, depth, frontier }: { node: ObjectiveStrategyEvaluateNode; depth: number; frontier: boolean }) {
  const className = cn("rounded-lg", depth > 0 && "ml-3 border-l border-border/40 pl-3");
  const iterationPath = node.iterationPath ?? [];
  const iterationContext = node.iterationContext ?? (iterationPath.length > 0 ? iterationPath.join(".") : "root");
  const result = node.pass === null ? "pending" : node.pass ? "pass" : "fail";
  const resultClass = node.pass === null ? "text-muted-foreground/70" : node.pass ? "text-success" : "text-destructive";
  const detail = `${node.metric} · ${node.operator} · target ${formatJson(node.target)} · current ${formatJson(node.actual)} · iteration ${iterationContext}`;
  return (
    <div className={className} data-evaluation-pass={node.pass === null ? "pending" : node.pass ? "true" : "false"}>
      <NodeHeader icon={<Gauge className="size-3.5" />} label={node.metric} kind="evaluate" state={node.state} frontier={frontier} detail={detail} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-8 pb-2 font-mono text-[9px] text-muted-foreground/80">
        <span>metric {node.path}</span><span>target {formatJson(node.target)}</span><span>current {formatJson(node.actual)}</span>
        <span className={cn("uppercase tracking-[0.08em]", resultClass)}>{result}</span>
        <span>iteration {iterationContext}</span>
      </div>
    </div>
  );
}

function BranchColumn({ branch, selected, nodes, frontierIds, onOpenAgent }: { branch: "then" | "else"; selected: boolean; nodes: ObjectiveStrategyNode[]; frontierIds: Set<string>; onOpenAgent?: (agentId: string) => void }) {
  const skipped = !selected && nodes.length > 0;
  return (
    <div className={cn("min-w-0 rounded-md border px-2 py-2", selected ? "border-info/45 bg-info/[0.045]" : skipped ? "border-border/35 opacity-55" : "border-border/35")}>
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
        {selected ? <CheckCircle className="size-3 text-info" aria-hidden="true" /> : skipped ? <Clock className="size-3" aria-hidden="true" /> : <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden="true" />}
        <span>{branch}</span><span className="ml-auto normal-case tracking-normal">{selected ? "selected" : skipped ? "skipped" : "undecided"}</span>
      </div>
      {nodes.length === 0 ? <div className="text-[10px] text-muted-foreground/65">No nodes</div> : nodes.map((node) => <StrategyNodeView key={node.id} node={node} depth={0} frontierIds={frontierIds} onOpenAgent={onOpenAgent} />)}
    </div>
  );
}

function AgentNode({ node, depth, frontier, onOpenAgent }: { node: Extract<ObjectiveStrategyNode, { kind: "agent" }>; depth: number; frontier: boolean; onOpenAgent?: (agentId: string) => void }) {
  const executionDetail = node.iterationPath && node.iterationPath.length > 0
    ? `iteration ${node.iterationPath.join(".")}`
    : node.executionKey
      ? `exec ${node.executionKey}`
      : null;
  const detail = [node.harness, node.model, node.attempt > 0 ? `attempt ${node.attempt}${node.maxAttempts === null ? "" : `/${node.maxAttempts}`}` : null, executionDetail].filter(Boolean).join(" · ") || "agent identity pending";
  const content = <NodeHeader icon={<span className="inline-flex"><StatusMarker status={node.state} label={`${node.label} ${strategyStatusLabel(node.state)}`} /></span>} label={node.label} kind="agent" state={node.state} frontier={frontier} detail={detail} error={node.error} />;
  const className = cn("rounded-lg", depth > 0 && "ml-3 border-l border-border/40 pl-3");
  if (!node.agentId || !onOpenAgent) return <div className={className}>{content}</div>;
  return <button type="button" onClick={() => onOpenAgent(node.agentId!)} className={cn(className, "group/agent w-full text-left outline-none hover:bg-muted/25 focus-visible:bg-muted/25")} aria-label={`Open agent ${node.label}`}>{content}</button>;
}

function NodeHeader({ icon, label, kind, state, frontier, detail, error }: { icon: React.ReactNode; label: string; kind: string; state: ObjectiveStrategyStatus; frontier: boolean; detail?: string; error?: string | null }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2 px-2 py-2", frontier && "bg-info/[0.035]")}>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-[11px] font-medium text-foreground/90">{label}</span>
          <span className="font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground/70">{kind}</span>
          {frontier ? <span className="font-mono text-[8px] uppercase tracking-[0.08em] text-info">frontier</span> : null}
          <span className={cn("font-mono text-[9px] capitalize", statusText[state])}>{strategyStatusLabel(state)}</span>
        </span>
        {detail ? <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground/75" title={detail}>{detail}</span> : null}
        {error ? <span className="mt-1 flex min-w-0 items-center gap-1 text-[9px] text-destructive" title={error}><XCircle className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{error}</span></span> : null}
      </span>
      {kind !== "agent" && kind !== "set" ? <CaretDown className="mt-1 size-3 shrink-0 text-muted-foreground/45 transition-transform group-open/strategy:rotate-0" aria-hidden="true" /> : null}
      {kind === "agent" && frontier ? <ArrowSquareOut className="mt-1 size-3 shrink-0 text-info/65" aria-hidden="true" /> : null}
    </div>
  );
}

function StatusMarker({ status, label }: { status: ObjectiveStrategyStatus; label: string }) {
  const active = status === "active";
  return active ? <AgentLoader kind="square" size={13} label={label} animated tone="info" /> : status === "failed" ? <XCircle className="size-3.5 text-destructive" aria-hidden="true" /> : status === "completed" ? <CheckCircle className="size-3.5 text-success" weight="fill" aria-hidden="true" /> : <span className={cn("size-2 rounded-full", statusDot[status])} aria-label={label} role="img" />;
}

function isFrontier(node: ObjectiveStrategyNode, frontierIds: Set<string>): boolean {
  return frontierIds.has(node.id) || frontierIds.has(strategyExecutionKey(node));
}

function MutationHistory({ mutations }: { mutations: ObjectiveStrategyViewModel["mutations"] }) {
  return (
    <aside aria-labelledby="objective-strategy-history-heading" className="min-w-0">
      <div className="mb-2 flex items-center gap-2"><Clock className="size-3.5 text-muted-foreground" aria-hidden="true" /><h3 id="objective-strategy-history-heading" className="text-[11px] font-medium text-foreground/85">Mutation history</h3><span className="ml-auto font-mono text-[9px] text-muted-foreground">{mutations.length}</span></div>
      {mutations.length === 0 ? <InlineState detail="No durable strategy mutations recorded." /> : <ol className="border-l border-border/50 pl-3">{mutations.map((mutation) => <li key={mutation.id} className="relative pb-4 last:pb-0"><span className="absolute -left-[0.96rem] top-1 size-1.5 rounded-full bg-info/70 ring-4 ring-background" aria-hidden="true" /><div className="flex items-baseline gap-2"><span className="font-mono text-[9px] text-info">r{mutation.revision}</span><span className="truncate text-[10px] text-foreground/80" title={mutation.summary}>{mutation.summary}</span></div><div className="mt-1 font-mono text-[8px] text-muted-foreground/70">{mutation.kind}{mutation.actor ? ` · ${mutation.actor}` : ""} · {formatDate(mutation.createdAt)}</div></li>)}</ol>}
    </aside>
  );
}

function StrategyState({ projection }: { projection: Exclude<ObjectiveStrategyProjection, Extract<ObjectiveStrategyProjection, { kind: "ready" }>> }) {
  const isError = projection.kind === "error";
  const title = isError ? "Strategy unavailable" : projection.kind === "legacy-null" ? "Strategy not recorded" : "Strategy is empty";
  const detail = isError ? projection.message : projection.detail ?? (projection.kind === "legacy-null" ? "This run predates durable control-plan snapshots. Its native transcript remains available." : "The daemon has not published a control plan for this objective yet.");
  return <section data-slot="objective-strategy-state" aria-live={isError ? "assertive" : "polite"} className="border-y border-border/45 py-8"><div className="flex items-start gap-3"><StatusMarker status={isError ? "failed" : "waiting"} label={title} /><div><h2 className="text-sm font-medium text-foreground/90">{title}</h2><p className="mt-1 max-w-xl text-[11px] leading-relaxed text-muted-foreground">{detail}</p>{isError && projection.retryable ? <span className="mt-2 inline-block font-mono text-[9px] uppercase tracking-[0.08em] text-warning">reconnect to retry</span> : null}</div></div></section>;
}

function InlineState({ detail }: { detail: string }) { return <div className="py-4 text-[10px] text-muted-foreground/75">{detail}</div>; }
function formatDate(value: string): string { const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp) : value; }
function formatJson(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }

const statusText: Record<ObjectiveStrategyStatus, string> = { active: "text-info", completed: "text-success", failed: "text-destructive", blocked: "text-warning", waiting: "text-warning", cancelled: "text-muted-foreground/70", expired: "text-destructive/80", skipped: "text-muted-foreground/60", undecided: "text-muted-foreground/65", idle: "text-muted-foreground" };
const statusDot: Record<ObjectiveStrategyStatus, string> = { active: "bg-info", completed: "bg-success", failed: "bg-destructive", blocked: "bg-warning", waiting: "bg-warning", cancelled: "bg-muted-foreground/60", expired: "bg-destructive/80", skipped: "bg-muted-foreground/40", undecided: "bg-muted-foreground/35", idle: "bg-muted-foreground/50" };
