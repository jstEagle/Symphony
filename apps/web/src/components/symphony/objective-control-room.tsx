"use client";

import {
  ArrowClockwise,
  ArrowSquareOut,
  Check,
  CheckCircle,
  Eye,
  GitBranch,
  Pause,
  Play,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { cn } from "@/lib/utils";
import {
  CONTROL_ROOM_LANES,
  buildControlRoomViewModel,
  type ControlRoomLane,
  type ControlRoomObjectiveCard,
} from "@/lib/symphony/objective-control-room";
import type { ObjectiveProjection } from "@/lib/symphony/objective-project";
import type { ObjectiveWorkspaceProjection } from "@/lib/symphony/objective-snapshot";

export type ObjectiveControlRoomProps = {
  projections?: readonly ObjectiveProjection[];
  workspaces?: readonly ObjectiveWorkspaceProjection[];
  onOpenObjective?: (runId: string) => void;
  onPauseObjective?: (runId: string) => void | Promise<void>;
  onResumeObjective?: (runId: string) => void | Promise<void>;
  onRetryObjective?: (runId: string) => void | Promise<void>;
  onStopObjective?: (runId: string) => void | Promise<void>;
  onApproveObjective?: (runId: string, approvalId: string) => void | Promise<void>;
  onPeekAgent?: (agentId: string) => void;
  onOpenAgent?: (agentId: string) => void;
};

const laneMeta: Record<ControlRoomLane, { label: string; description: string }> = {
  "needs-input": { label: "Needs input", description: "A durable decision is waiting for you." },
  working: { label: "Working", description: "Live objectives and their current frontier." },
  blocked: { label: "Blocked / failed", description: "Work needs intervention or recovery." },
  completed: { label: "Completed", description: "Settled objectives and their last evidence." },
};

/**
 * Operational objective control room. This is a pure projection surface:
 * actions leave authority with the daemon and are represented only by
 * callbacks supplied by the owning shell.
 */
export function ObjectiveControlRoom({
  projections,
  workspaces,
  onOpenObjective,
  onPauseObjective,
  onResumeObjective,
  onRetryObjective,
  onStopObjective,
  onApproveObjective,
  onPeekAgent,
  onOpenAgent,
}: ObjectiveControlRoomProps) {
  if (workspaces) {
    return <AggregateControlRoom workspaces={workspaces} onOpenObjective={onOpenObjective} onPauseObjective={onPauseObjective} onResumeObjective={onResumeObjective} onRetryObjective={onRetryObjective} onStopObjective={onStopObjective} onApproveObjective={onApproveObjective} onOpenAgent={onOpenAgent} />;
  }
  const model = buildControlRoomViewModel(projections ?? []);

  return (
    <main className="min-h-full flex-1 bg-background text-foreground" aria-label="Objective control room">
      <div className="mx-auto w-full max-w-[108rem] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <header className="mb-6 flex flex-col gap-4 border-b border-border/35 pb-5 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground/75">
              <GitBranch className="size-3.5 text-info" aria-hidden="true" />
              Control room
            </div>
            <h1 className="text-[clamp(1.35rem,2.6vw,2.1rem)] font-medium tracking-[-0.04em]">Objectives in motion</h1>
            <p className="mt-1.5 max-w-2xl text-[11px] leading-5 text-muted-foreground">
              One live view of durable runs, their decisions, and the evidence they have left behind.
            </p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground" aria-label="Objective totals">
            <span>{model.totals.objectives} objective{model.totals.objectives === 1 ? "" : "s"}</span>
            <span className="text-info">{model.totals.liveAgents} live agent{model.totals.liveAgents === 1 ? "" : "s"}</span>
            {model.totals.needsInput > 0 ? <span className="text-warning">{model.totals.needsInput} need input</span> : null}
            {model.totals.blocked > 0 ? <span className="text-destructive">{model.totals.blocked} blocked</span> : null}
          </div>
        </header>

        <div className="grid gap-4 xl:grid-cols-4" role="region" aria-label="Objective lanes">
          {CONTROL_ROOM_LANES.map((lane) => (
            <ControlRoomLaneView
              key={lane}
              lane={lane}
              cards={model.lanes[lane]}
              onOpenObjective={onOpenObjective}
              onPauseObjective={onPauseObjective}
              onResumeObjective={onResumeObjective}
              onRetryObjective={onRetryObjective}
              onStopObjective={onStopObjective}
              onApproveObjective={onApproveObjective}
              onPeekAgent={onPeekAgent}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </div>
      </div>
    </main>
  );
}

function ControlRoomLaneView({
  lane,
  cards,
  onOpenObjective,
  onPauseObjective,
  onResumeObjective,
  onRetryObjective,
  onStopObjective,
  onApproveObjective,
  onPeekAgent,
  onOpenAgent,
}: {
  lane: ControlRoomLane;
  cards: ControlRoomObjectiveCard[];
  onOpenObjective?: ObjectiveControlRoomProps["onOpenObjective"];
  onPauseObjective?: ObjectiveControlRoomProps["onPauseObjective"];
  onResumeObjective?: ObjectiveControlRoomProps["onResumeObjective"];
  onRetryObjective?: ObjectiveControlRoomProps["onRetryObjective"];
  onStopObjective?: ObjectiveControlRoomProps["onStopObjective"];
  onApproveObjective?: ObjectiveControlRoomProps["onApproveObjective"];
  onPeekAgent?: ObjectiveControlRoomProps["onPeekAgent"];
  onOpenAgent?: ObjectiveControlRoomProps["onOpenAgent"];
}) {
  const meta = laneMeta[lane];
  return (
    <section className="min-w-0 rounded-2xl border border-border/45 bg-card/[0.22] p-2.5 shadow-[0_18px_60px_-40px_color-mix(in_oklab,var(--foreground)_38%,transparent)] backdrop-blur-xl" aria-labelledby={`control-room-${lane}-heading`}>
      <div className="mb-2 flex items-start justify-between gap-3 px-2 py-1">
        <div className="min-w-0">
          <h2 id={`control-room-${lane}-heading`} className="text-[12px] font-medium text-foreground/90">{meta.label}</h2>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground/70">{meta.description}</p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-1 font-mono text-[10px] tabular-nums", laneTone(lane))} aria-label={`${cards.length} ${meta.label.toLocaleLowerCase()}`}>
          {cards.length}
        </span>
      </div>

      {cards.length === 0 ? (
        <LaneEmptyState lane={lane} />
      ) : (
        <div className="space-y-2">
          {cards.map((card) => (
            <ObjectiveCard
              key={card.runId}
              card={card}
              onOpenObjective={onOpenObjective}
              onPauseObjective={onPauseObjective}
              onResumeObjective={onResumeObjective}
              onRetryObjective={onRetryObjective}
              onStopObjective={onStopObjective}
              onApproveObjective={onApproveObjective}
              onPeekAgent={onPeekAgent}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ObjectiveCard({
  card,
  onOpenObjective,
  onPauseObjective,
  onResumeObjective,
  onRetryObjective,
  onStopObjective,
  onApproveObjective,
  onPeekAgent,
  onOpenAgent,
}: {
  card: ControlRoomObjectiveCard;
  onOpenObjective?: ObjectiveControlRoomProps["onOpenObjective"];
  onPauseObjective?: ObjectiveControlRoomProps["onPauseObjective"];
  onResumeObjective?: ObjectiveControlRoomProps["onResumeObjective"];
  onRetryObjective?: ObjectiveControlRoomProps["onRetryObjective"];
  onStopObjective?: ObjectiveControlRoomProps["onStopObjective"];
  onApproveObjective?: ObjectiveControlRoomProps["onApproveObjective"];
  onPeekAgent?: ObjectiveControlRoomProps["onPeekAgent"];
  onOpenAgent?: ObjectiveControlRoomProps["onOpenAgent"];
}) {
  const titleId = `control-room-objective-${card.runId}`;
  const statusTone = card.lane === "blocked" ? "danger" : card.lane === "needs-input" ? "warning" : card.lane === "completed" ? "success" : "info";
  return (
    <article className={cn("group rounded-xl border border-border/45 bg-background/35 p-3.5 transition-[border-color,background-color,transform] duration-200 hover:-translate-y-px hover:border-border/75 hover:bg-background/55", card.live && "border-info/25", card.lane === "blocked" && "border-destructive/25")} aria-labelledby={titleId}>
      <div className="flex items-start gap-2.5">
        {card.live ? <AgentLoader kind="square" size={18} label={`${card.statement} live`} animated tone="info" /> : <StatusIcon card={card} tone={statusTone} />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <h3 id={titleId} className="min-w-0 truncate text-[13px] font-medium leading-5 text-foreground/95" title={card.statement}>{card.statement}</h3>
            <span className={cn("shrink-0 font-mono text-[9px] capitalize", toneText(statusTone))}>{card.stateLabel}</span>
          </div>
          <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground/75" title={card.runId}>run {card.runId}</p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y border-border/30 py-2.5 text-[10px]">
        <Fact label="Strategy" value={`${card.strategy.label} · r${card.strategy.revision}`} detail={card.strategy.workflowId} />
        <Fact label="Agents" value={`${card.agents.total} · ${card.agents.active} active`} detail={`${card.agents.completed} done · ${card.agents.failed} failed`} />
        <Fact label="Budget" value={card.budget.label} detail={card.budget.status ?? (card.budget.available ? "ledger" : "ledger unavailable")} warning={card.budget.unknownCost} />
        <Fact label="Tasks" value={`${card.tasks.completed}/${card.tasks.total} complete`} detail={card.tasks.active > 0 ? `${card.tasks.active} active` : "no active tasks"} />
      </div>

      {card.attention ? (
        <div className={cn("mt-2.5 flex min-w-0 items-start gap-1.5 text-[10px] leading-4", card.lane === "blocked" ? "text-destructive" : "text-warning")} role="status">
          {card.lane === "blocked" ? <WarningCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" /> : <WarningCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />}
          <span className="truncate" title={card.attention}>{card.attention}</span>
        </div>
      ) : null}

      <div className="mt-2.5 flex min-w-0 items-center justify-between gap-2 text-[9px] text-muted-foreground/70">
        <EvidenceLine card={card} />
        {onOpenObjective ? <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-foreground/75 transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" onClick={() => onOpenObjective(card.runId)}>Open <ArrowSquareOut className="size-3" aria-hidden="true" /></button> : null}
      </div>

      {card.agentList.length > 0 ? (
        <div className="mt-2.5 flex min-w-0 flex-wrap gap-1.5" aria-label="Agents">
          {card.agentList.map((agent) => (
            <AgentChip key={agent.id} agent={agent} onPeek={onPeekAgent} onOpen={onOpenAgent} />
          ))}
        </div>
      ) : null}

      {hasActions(card, { onPauseObjective, onResumeObjective, onRetryObjective, onStopObjective, onApproveObjective }) ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/30 pt-2.5" aria-label={`Actions for ${card.statement}`}>
          {onApproveObjective && card.pendingApproval && card.actions.canApprove ? <ActionButton label="Approve" icon={<Check />} tone="warning" onClick={() => onApproveObjective(card.runId, card.pendingApproval!.id)} /> : null}
          {onPauseObjective && card.actions.canPause ? <ActionButton label="Pause" icon={<Pause />} onClick={() => onPauseObjective(card.runId)} /> : null}
          {onResumeObjective && card.actions.canResume ? <ActionButton label="Resume" icon={<Play />} tone="info" onClick={() => onResumeObjective(card.runId)} /> : null}
          {onRetryObjective && card.actions.canRetry ? <ActionButton label="Retry" icon={<ArrowClockwise />} tone="warning" onClick={() => onRetryObjective(card.runId)} /> : null}
          {onStopObjective && card.actions.canStop ? <ActionButton label="Stop" icon={<Stop />} tone="danger" onClick={() => onStopObjective(card.runId)} /> : null}
        </div>
      ) : null}
    </article>
  );
}

function AgentChip({ agent, onPeek, onOpen }: { agent: ControlRoomObjectiveCard["agentList"][number]; onPeek?: (id: string) => void; onOpen?: (id: string) => void }) {
  if (!onPeek && !onOpen) {
    return <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/25 px-2 py-1 font-mono text-[9px] text-muted-foreground" title={`${agent.name} · ${agent.harness} · ${agent.model}`}><span className={cn("size-1.5 rounded-full", agent.live ? "bg-info" : "bg-success")} aria-hidden="true" /><span className="max-w-[10rem] truncate">{agent.name}</span></span>;
  }
  return (
    <span className="inline-flex min-w-0 items-center rounded-md bg-muted/25 text-[9px] text-muted-foreground">
      <button type="button" className="inline-flex min-w-0 items-center gap-1.5 rounded-l-md px-2 py-1 font-mono hover:bg-muted/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" onClick={() => (onPeek ?? onOpen)!(agent.id)} title={`${agent.name} · ${agent.harness} · ${agent.model}`}>
        {agent.live ? <AgentLoader kind="square" size={11} label={`${agent.name} live`} animated tone="info" /> : <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />}
        <span className="max-w-[8rem] truncate">{agent.name}</span>
        {onPeek ? <Eye className="size-3 shrink-0 opacity-65" aria-hidden="true" /> : null}
      </button>
      {onOpen && onPeek ? <button type="button" className="rounded-r-md border-l border-border/35 px-1.5 py-1 hover:bg-muted/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" onClick={() => onOpen(agent.id)} aria-label={`Open ${agent.name}`}><ArrowSquareOut className="size-3" aria-hidden="true" /></button> : null}
    </span>
  );
}

function Fact({ label, value, detail, warning = false }: { label: string; value: string; detail: string; warning?: boolean }) {
  return <div className="min-w-0"><p className="font-mono uppercase tracking-[0.08em] text-muted-foreground/50">{label}</p><p className={cn("truncate font-medium text-foreground/85", warning && "text-warning")} title={value}>{value}</p><p className="truncate font-mono text-[9px] text-muted-foreground/55" title={detail}>{detail}</p></div>;
}

function EvidenceLine({ card }: { card: ControlRoomObjectiveCard }) {
  if (card.latestEvent) return <span className="min-w-0 truncate" title={card.latestEvent.detail}>event {card.latestEvent.cursor} · {card.latestEvent.title}</span>;
  if (card.checkpoint) return <span className="min-w-0 truncate" title={card.checkpoint.reason}>checkpoint {card.checkpoint.sequence} · {card.checkpoint.reason}</span>;
  return <span>no checkpoint or event yet</span>;
}

function ActionButton({ label, icon, tone = "default", onClick }: { label: string; icon: ReactNode; tone?: "default" | "info" | "warning" | "danger"; onClick: () => void | Promise<void> }) {
  return <button type="button" className={cn("inline-flex items-center gap-1 rounded-md border border-border/45 bg-background/35 px-2 py-1 font-mono text-[9px] text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60", tone === "info" && "border-info/35 text-info hover:bg-info/10", tone === "warning" && "border-warning/35 text-warning hover:bg-warning/10", tone === "danger" && "border-destructive/35 text-destructive hover:bg-destructive/10")} onClick={() => void onClick()}>{icon}<span>{label}</span></button>;
}

function StatusIcon({ card, tone }: { card: ControlRoomObjectiveCard; tone: "info" | "success" | "warning" | "danger" }) {
  if (card.lane === "completed") return <CheckCircle className="mt-0.5 size-[18px] text-success" weight="fill" aria-label="Completed" />;
  if (tone === "danger") return <WarningCircle className="mt-0.5 size-[18px] text-destructive" weight="fill" aria-label="Blocked or failed" />;
  return <WarningCircle className="mt-0.5 size-[18px] text-warning" weight="fill" aria-label="Needs input" />;
}

function LaneEmptyState({ lane }: { lane: ControlRoomLane }) {
  const copy = {
    "needs-input": "No decisions are waiting.",
    working: "No objectives are running.",
    blocked: "No blocked or failed objectives.",
    completed: "Completed runs will remain visible here.",
  }[lane];
  return <div className="flex min-h-28 items-center justify-center rounded-xl border border-dashed border-border/30 px-4 text-center text-[10px] leading-4 text-muted-foreground/60"><span>{copy}</span></div>;
}

function hasActions(card: ControlRoomObjectiveCard, callbacks: Pick<ObjectiveControlRoomProps, "onPauseObjective" | "onResumeObjective" | "onRetryObjective" | "onStopObjective" | "onApproveObjective">): boolean {
  return Boolean((callbacks.onApproveObjective && card.actions.canApprove) || (callbacks.onPauseObjective && card.actions.canPause) || (callbacks.onResumeObjective && card.actions.canResume) || (callbacks.onRetryObjective && card.actions.canRetry) || (callbacks.onStopObjective && card.actions.canStop));
}

function laneTone(lane: ControlRoomLane): string {
  if (lane === "needs-input") return "bg-warning/10 text-warning";
  if (lane === "working") return "bg-info/10 text-info";
  if (lane === "blocked") return "bg-destructive/10 text-destructive";
  return "bg-success/10 text-success";
}

function toneText(tone: "info" | "success" | "warning" | "danger"): string {
  return { info: "text-info", success: "text-success", warning: "text-warning", danger: "text-destructive" }[tone];
}

function AggregateControlRoom({
  workspaces,
  onOpenObjective,
  onPauseObjective,
  onResumeObjective,
  onRetryObjective,
  onStopObjective,
  onApproveObjective,
  onOpenAgent,
}: {
  workspaces: readonly ObjectiveWorkspaceProjection[];
  onOpenObjective?: ObjectiveControlRoomProps["onOpenObjective"];
  onPauseObjective?: ObjectiveControlRoomProps["onPauseObjective"];
  onResumeObjective?: ObjectiveControlRoomProps["onResumeObjective"];
  onRetryObjective?: ObjectiveControlRoomProps["onRetryObjective"];
  onStopObjective?: ObjectiveControlRoomProps["onStopObjective"];
  onApproveObjective?: ObjectiveControlRoomProps["onApproveObjective"];
  onOpenAgent?: ObjectiveControlRoomProps["onOpenAgent"];
}) {
  const openAttentionCount = workspaces.reduce((total, workspace) => total + workspace.attentions.filter((attention) => attention.status === "open").length, 0);
  const runningCount = workspaces.reduce((total, workspace) => total + workspace.frontier.filter((item) => item.status === "running").length, 0);
  return (
    <main className="min-h-full flex-1 bg-background text-foreground" aria-label="Objective control room">
      <div className="mx-auto w-full max-w-[108rem] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <header className="mb-6 flex flex-col gap-4 border-b border-border/35 pb-5 md:flex-row md:items-end md:justify-between"><div className="min-w-0"><div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground/75"><GitBranch className="size-3.5 text-info" aria-hidden="true" />Control room</div><h1 className="text-[clamp(1.35rem,2.6vw,2.1rem)] font-medium tracking-[-0.04em]">Objectives in motion</h1><p className="mt-1.5 max-w-2xl text-[11px] leading-5 text-muted-foreground">Aggregate identity, durable frontier, and evidence from one cursor-fenced snapshot.</p></div><div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground"><span>{workspaces.length} objective{workspaces.length === 1 ? "" : "s"}</span><span className="text-info">{runningCount} active execution{runningCount === 1 ? "" : "s"}</span>{openAttentionCount > 0 ? <span className="text-warning">{openAttentionCount} need attention</span> : null}</div></header>
        {workspaces.length === 0 ? <div className="rounded-xl border border-dashed border-border/45 px-5 py-12 text-center text-[11px] text-muted-foreground">No durable objectives are available.</div> : <div className="grid gap-4 xl:grid-cols-2">{workspaces.map((workspace) => <AggregateObjectiveCard key={workspace.objectiveId} workspace={workspace} onOpenObjective={onOpenObjective} onPauseObjective={onPauseObjective} onResumeObjective={onResumeObjective} onRetryObjective={onRetryObjective} onStopObjective={onStopObjective} onApproveObjective={onApproveObjective} onOpenAgent={onOpenAgent} />)}</div>}
      </div>
    </main>
  );
}

function AggregateObjectiveCard({ workspace, onOpenObjective, onPauseObjective, onResumeObjective, onRetryObjective, onStopObjective, onApproveObjective, onOpenAgent }: { workspace: ObjectiveWorkspaceProjection; onOpenObjective?: ObjectiveControlRoomProps["onOpenObjective"]; onPauseObjective?: ObjectiveControlRoomProps["onPauseObjective"]; onResumeObjective?: ObjectiveControlRoomProps["onResumeObjective"]; onRetryObjective?: ObjectiveControlRoomProps["onRetryObjective"]; onStopObjective?: ObjectiveControlRoomProps["onStopObjective"]; onApproveObjective?: ObjectiveControlRoomProps["onApproveObjective"]; onOpenAgent?: ObjectiveControlRoomProps["onOpenAgent"] }) {
  const { objective, frontier, attentions, artifacts, eventCursor } = workspace;
  const openAttentions = attentions.filter((attention) => attention.status === "open");
  const primaryRun = workspace.currentRuns[0] ?? workspace.runs.find((run) => run.runId === objective.latestRunId) ?? workspace.runs[0];
  const pendingApproval = workspace.snapshot.approvals.find((approval) => approval.status === "requested");
  const active = frontier.some((item) => item.status === "running");
  const runFrontier = primaryRun ? frontier.filter((item) => item.runId === primaryRun.runId) : [];
  const failedOrUnknown = runFrontier.some((item) => item.status === "failed" || item.status === "outcome-unknown");
  const latestCheckpoint = primaryRun ? workspace.checkpoints.some((checkpoint) => checkpoint.runId === primaryRun.runId) : false;
  const canResume = Boolean(onResumeObjective && primaryRun && latestCheckpoint && (objective.state === "waiting" || primaryRun.state === "awaiting-approval"));
  const canRetry = Boolean(onRetryObjective && primaryRun && latestCheckpoint && failedOrUnknown);
  const canStop = Boolean(onStopObjective && primaryRun && !["succeeded", "failed", "cancelled", "interrupted"].includes(primaryRun.state));
  return <article className={cn("rounded-2xl border border-border/45 bg-card/[0.22] p-4 shadow-[0_18px_60px_-40px_color-mix(in_oklab,var(--foreground)_38%,transparent)] backdrop-blur-xl", active && "border-info/25", openAttentions.length > 0 && "border-warning/25")}><div className="flex items-start gap-3"><span className="mt-0.5">{active ? <AgentLoader kind="square" size={18} label="Objective active" animated tone="info" /> : <StatusIconForAggregate state={objective.state} />}</span><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-[13px] font-medium text-foreground/95" title={objective.statement ?? objective.spec?.statement}>{objective.statement ?? objective.spec?.statement ?? "Untitled objective"}</h2><p className="mt-1 truncate font-mono text-[9px] text-muted-foreground/75" title={objective.objectiveId}>{objective.objectiveId}</p></div><span className="shrink-0 font-mono text-[9px] capitalize text-muted-foreground">{objective.state}</span></div><div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y border-border/30 py-2.5 text-[10px]"><AggregateFact label="Frontier" value={String(frontier.length)} detail="unfinished" /><AggregateFact label="Runs" value={String(workspace.runs.length)} detail={`${workspace.currentRuns.length} current`} /><AggregateFact label="Attention" value={String(openAttentions.length)} detail="open requests" warning={openAttentions.length > 0} /><AggregateFact label="Evidence" value={String(eventCursor)} detail="cursor fence" /></div>{frontier.length > 0 ? <div className="mt-3 space-y-1.5">{frontier.slice(0, 4).map((item) => <AggregateFrontierRow key={`${item.runId}:${item.id}`} item={item} onOpenAgent={onOpenAgent} />)}{frontier.length > 4 ? <p className="font-mono text-[9px] text-muted-foreground">+{frontier.length - 4} more frontier items</p> : null}</div> : <p className="mt-3 text-[10px] text-muted-foreground">No unfinished frontier work at this fence.</p>}{openAttentions.length > 0 ? <p className="mt-3 text-[10px] text-warning">{openAttentions[0]?.reason}</p> : null}<div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/30 pt-2.5">{onOpenObjective && primaryRun ? <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[9px] text-foreground/75 hover:bg-muted/45 hover:text-foreground" onClick={() => onOpenObjective(primaryRun.runId)}>Open objective <ArrowSquareOut className="size-3" aria-hidden="true" /></button> : null}{pendingApproval && onApproveObjective ? <button type="button" className="inline-flex items-center gap-1 rounded-md border border-warning/35 px-2 py-1 font-mono text-[9px] text-warning hover:bg-warning/10" onClick={() => onApproveObjective(pendingApproval.runId, pendingApproval.id)}><Check className="size-3" aria-hidden="true" />Approve</button> : null}{canResume && primaryRun ? <ActionButton label="Resume" icon={<Play />} tone="info" onClick={() => onResumeObjective!(primaryRun.runId)} /> : null}{canRetry && primaryRun ? <ActionButton label="Retry" icon={<ArrowClockwise />} tone="warning" onClick={() => onRetryObjective!(primaryRun.runId)} /> : null}{canStop && primaryRun ? <ActionButton label="Stop" icon={<Stop />} tone="danger" onClick={() => onStopObjective!(primaryRun.runId)} /> : null}{active ? <span className="font-mono text-[9px] text-muted-foreground/65" title="The daemon does not expose a durable objective pause command.">Pause unavailable</span> : null}{!pendingApproval && !canResume && !canRetry && !canStop && !active ? <span className="font-mono text-[9px] text-muted-foreground/65">{artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}</span> : null}</div></div></div></article>;
}

function AggregateFrontierRow({ item, onOpenAgent }: { item: import("@/lib/symphony/objective-snapshot").ObjectiveWorkspaceFrontierItem; onOpenAgent?: (agentId: string) => void }) {
  const label = item.status.replaceAll("-", " ");
  const content = <span className="flex min-w-0 items-center gap-2"><span className="shrink-0">{item.status === "running" ? <AgentLoader kind="square" size={11} label={`${item.label} active`} animated tone="info" /> : <span className={cn("block size-1.5 rounded-full", item.status === "outcome-unknown" || item.status === "failed" ? "bg-destructive" : item.status === "waiting-attention" ? "bg-warning" : "bg-info")} aria-hidden="true" />}</span><span className="min-w-0 flex-1 truncate text-[10px] text-foreground/85">{item.label}</span><span className="shrink-0 font-mono text-[9px] capitalize text-muted-foreground">{label}</span></span>;
  return item.agentId && onOpenAgent ? <button type="button" className="w-full rounded-md px-1.5 py-1 text-left hover:bg-muted/35" onClick={() => onOpenAgent(item.agentId!)}>{content}</button> : <div className="px-1.5 py-1">{content}</div>;
}

function AggregateFact({ label, value, detail, warning = false }: { label: string; value: string; detail: string; warning?: boolean }) { return <div className="min-w-0"><p className="font-mono uppercase tracking-[0.08em] text-muted-foreground/50">{label}</p><p className={cn("truncate font-medium text-foreground/85", warning && "text-warning")}>{value}</p><p className="truncate font-mono text-[9px] text-muted-foreground/55">{detail}</p></div>; }
function StatusIconForAggregate({ state }: { state: string }) { return state === "achieved" ? <CheckCircle className="size-[18px] text-success" weight="fill" aria-label="Achieved" /> : state === "abandoned" ? <WarningCircle className="size-[18px] text-destructive" weight="fill" aria-label="Abandoned" /> : <WarningCircle className="size-[18px] text-warning" weight="fill" aria-label="Waiting" />; }
