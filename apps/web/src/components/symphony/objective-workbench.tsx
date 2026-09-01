"use client";

import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  Clock,
  GitBranch,
  ListBullets,
  ShieldCheck,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import type { ObjectiveProjection, ObjectiveTaskProjection } from "@/lib/symphony/objective-project";
import { AgentLoader } from "@/components/symphony/agent-tool";
import { ObjectiveRevisionTimeline } from "@/components/symphony/objective-revision-timeline";
import { ObjectivePolicyRail } from "@/components/symphony/objective-policy-rail";
import { ObjectiveStrategy } from "@/components/symphony/objective-strategy";
import { ObjectiveOperator } from "@/components/symphony/objective-operator";
import { projectObjectiveStrategy } from "@/lib/symphony/objective-strategy";
import type { JsonValue } from "@/lib/symphony/contracts";
import type { ObjectiveWorkspaceProjection, ObjectiveWorkspaceFrontierItem, ObjectiveWorkspaceRunlineEntry } from "@/lib/symphony/objective-snapshot";
import { cn } from "@/lib/utils";

type ApprovalDecision = "approved" | "rejected";

export type ObjectiveWorkbenchProps = {
  projection?: ObjectiveProjection;
  workspace?: ObjectiveWorkspaceProjection;
  onOpenAgent?: (agentId: string) => void;
  onResolveApproval?: (approvalId: string, decision: ApprovalDecision) => void | Promise<void>;
  onReviewArtifact?: (artifactId: string, state: "verified" | "rejected", reason: string) => void | Promise<void>;
  resolvingApprovalId?: string | null;
  approvalError?: string | null;
};

/**
 * The durable objective surface. It renders only the supplied projection: the
 * daemon remains the source of truth and this component does not create work,
 * infer progress, or fall back to demo cards.
 */
export function ObjectiveWorkbench({
  projection,
  workspace,
  onOpenAgent,
  onResolveApproval,
  onReviewArtifact,
  resolvingApprovalId = null,
  approvalError = null,
}: ObjectiveWorkbenchProps) {
  if (workspace) {
    return <ObjectiveOperator workspace={workspace} onOpenAgent={onOpenAgent} onResolveApproval={onResolveApproval} onReviewArtifact={onReviewArtifact} resolvingApprovalId={resolvingApprovalId} approvalError={approvalError} />;
  }
  if (!projection) return null;
  const progressPercent = projection.progress.total > 0
    ? Math.round((projection.progress.completed / projection.progress.total) * 100)
    : 0;
  const blockedTasks = projection.packets.filter((task) => task.state === "blocked");
  const failedTasks = projection.packets.filter((task) => task.state === "failed");
  const pendingApprovals = projection.approvals.filter((approval) => approval.isPending);

  return (
    <main className="flex min-h-full flex-1 flex-col bg-background text-foreground">
      <div className="mx-auto w-full max-w-[96rem] flex-1 px-5 py-7 md:px-8 md:py-9 lg:px-12">
        <header className="border-b border-border/45 pb-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 max-w-4xl">
              <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground">
                <span className="text-foreground/70">Objective</span>
                <span aria-hidden="true">·</span>
                <span className="truncate">{projection.objectiveId}</span>
                <span aria-hidden="true">·</span>
                <span>plan r{projection.planRevision}</span>
              </div>
              <h1 className="text-[clamp(1.35rem,2.5vw,2.35rem)] font-medium leading-[1.12] tracking-[-0.035em]">
                {projection.mission.statement}
              </h1>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-muted-foreground">
                <span className="font-mono">run {projection.runId}</span>
                <span className="font-mono">workflow r{projection.mission.revision}</span>
                <span className="font-mono">{projection.mission.hash}</span>
              </div>
            </div>

            <RunState state={projection.state} terminal={projection.terminal} />
          </div>

          <div className="mt-7 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div>
              <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
                <span className="font-medium text-foreground/85">Objective progress</span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {projection.progress.completed}/{projection.progress.total} complete
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted/75"
                role="progressbar"
                aria-label="Objective progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width,background-color] duration-300",
                    projection.progress.failed > 0 ? "bg-destructive/80" : projection.terminal ? "bg-success/80" : "bg-info/80",
                  )}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground md:justify-end">
              <span>{projection.progress.active} active</span>
              <span>{projection.progress.blocked} blocked</span>
              <span>{projection.progress.pendingApproval} decisions</span>
              <span>{projection.evidence.eventCount} events</span>
            </div>
          </div>
        </header>

        <ObjectivePolicyRail projection={projection} />

        <div className="mt-7 border-t border-border/45 pt-7">
          <ObjectiveStrategy projection={projectObjectiveStrategy(projection)} onOpenAgent={onOpenAgent} />
        </div>

        {projection.error || approvalError || blockedTasks.length > 0 || failedTasks.length > 0 ? (
          <section className="mt-6 grid gap-2" aria-label="Objective attention">
            {projection.error ? <Attention tone="danger" icon={<XCircle />} title="Objective error" detail={projection.error} /> : null}
            {approvalError ? <Attention tone="danger" icon={<XCircle />} title="Approval action failed" detail={approvalError} /> : null}
            {failedTasks.length > 0 ? (
              <Attention
                tone="danger"
                icon={<XCircle />}
                title={`${failedTasks.length} failed task${failedTasks.length === 1 ? "" : "s"}`}
                detail={failedTasks.map((task) => task.objective).join(" · ")}
              />
            ) : null}
            {blockedTasks.length > 0 ? (
              <Attention
                tone="warning"
                icon={<WarningCircle />}
                title={`${blockedTasks.length} blocked task${blockedTasks.length === 1 ? "" : "s"}`}
                detail={blockedTasks.map((task) => task.objective).join(" · ")}
              />
            ) : null}
          </section>
        ) : null}

        <ObjectiveRevisionTimeline projection={projection} />

        <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
          <section aria-labelledby="objective-frontier-heading" className="min-w-0">
            <SectionHeading
              id="objective-frontier-heading"
              icon={<GitBranch />}
              title="Current frontier"
              meta={`${projection.frontier.length} ready`}
            />
            {projection.frontier.length === 0 ? (
              <QuietState detail={projection.terminal ? "The objective has no remaining frontier work." : "No task is ready to advance yet."} />
            ) : (
              <div className="divide-y divide-border/45 overflow-hidden rounded-xl border border-border/65 bg-card/35 backdrop-blur-xl">
                {projection.frontier.map((task) => (
                  <TaskPacket key={task.id} task={task} onOpenAgent={onOpenAgent} />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="objective-decisions-heading" className="min-w-0">
            <SectionHeading
              id="objective-decisions-heading"
              icon={<ShieldCheck />}
              title="Decision inbox"
              meta={`${pendingApprovals.length} pending`}
            />
            {pendingApprovals.length === 0 ? (
              <QuietState detail="No approval is currently blocking the objective." />
            ) : (
              <div className="space-y-2.5">
                {pendingApprovals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    onResolve={onResolveApproval}
                    resolving={resolvingApprovalId === approval.id}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
          <section aria-labelledby="objective-plan-heading" className="min-w-0">
            <SectionHeading
              id="objective-plan-heading"
              icon={<ListBullets />}
              title="Living plan"
              meta={`revision ${projection.planRevision} · ${projection.replanCount} replans`}
            />
            <div className="overflow-hidden rounded-xl border border-border/65 bg-card/25 backdrop-blur-xl">
              {projection.packets.length === 0 ? (
                <QuietState detail="The durable plan has no task packets yet." />
              ) : (
                <div className="divide-y divide-border/40">
                  {projection.packets.map((task) => (
                    <PlanRow key={task.id} task={task} />
                  ))}
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby="objective-evidence-heading" className="min-w-0">
            <SectionHeading
              id="objective-evidence-heading"
              icon={<Clock />}
              title="Checkpoints & evidence"
              meta={`${projection.checkpoints.length} checkpoints`}
            />
            {projection.checkpoints.length === 0 ? (
              <QuietState detail="No durable checkpoint has been recorded yet." />
            ) : (
              <div className="space-y-2.5">
                {projection.checkpoints.map((checkpoint) => (
                  <CheckpointRow key={checkpoint.id} checkpoint={checkpoint} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function RunState({ state, terminal }: { state: ObjectiveProjection["state"]; terminal: boolean }) {
  const tone = state === "failed" ? "danger" : state === "succeeded" ? "success" : state === "awaiting-approval" ? "warning" : "info";
  const label = state.replaceAll("-", " ");
  const active = !terminal && (state === "executing" || state === "evaluating" || state === "replanning");
  return (
    <div className={cn("inline-flex shrink-0 items-center gap-2 self-start rounded-full border px-3 py-1.5 text-[10px] font-mono capitalize", toneBorder[tone])}>
      {active ? <AgentLoader kind="square" size={14} label={`Objective ${label} active`} animated tone={tone} /> : <StatusDot tone={tone} active={false} />}
      {label}
    </div>
  );
}

function TaskPacket({ task, onOpenAgent }: { task: ObjectiveTaskProjection; onOpenAgent?: (agentId: string) => void }) {
  const active = task.state === "running";
  const tone = task.state === "failed" ? "danger" : task.state === "blocked" || task.state === "waiting-approval" ? "warning" : task.state === "completed" ? "success" : "info";
  const content = (
    <>
      <span className="flex min-w-0 items-start gap-3">
        {active ? (
          <AgentLoader kind="square" size={18} label={`${task.objective} active`} animated tone="info" />
        ) : (
          <StatusDot tone={tone} active={false} className="mt-1.5" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium text-foreground/95">{task.objective}</span>
            <span className={cn("font-mono text-[9px] capitalize", toneText[tone])}>{task.state.replaceAll("-", " ")}</span>
          </span>
          <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span className="font-mono">{task.id}</span>
            {task.agent ? <span>{task.agent.name} · {task.agent.harness} · {task.agent.model}</span> : <span>unassigned</span>}
            {task.blockedBy.length > 0 ? <span>blocked by {task.blockedBy.join(", ")}</span> : null}
          </span>
          {task.latestEvent ? <span className="mt-2 block truncate text-[10px] text-muted-foreground/75">{task.latestEvent.detail}</span> : null}
        </span>
        {task.agentId && onOpenAgent ? <ArrowSquareOut className="mt-1 size-3.5 shrink-0 text-muted-foreground/45" aria-hidden="true" /> : null}
      </span>
    </>
  );

  if (task.agentId && onOpenAgent) {
    return (
      <button type="button" onClick={() => onOpenAgent(task.agentId!)} className="group w-full px-4 py-4 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none md:px-5">
        {content}
      </button>
    );
  }
  return <div className="px-4 py-4 md:px-5">{content}</div>;
}

function ApprovalCard({
  approval,
  onResolve,
  resolving,
}: {
  approval: ObjectiveProjection["approvals"][number];
  onResolve?: (approvalId: string, decision: ApprovalDecision) => void | Promise<void>;
  resolving: boolean;
}) {
  const controlsUnavailable = !onResolve;
  const controlsDisabled = controlsUnavailable || resolving;
  return (
    <article className="rounded-xl border border-warning/35 bg-warning/[0.045] p-4 backdrop-blur-xl">
      <div className="flex items-start gap-3">
        <StatusDot tone="warning" active={false} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium text-foreground/95">{approval.question}</span>
            <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-warning">{approval.kind}</span>
          </div>
          <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground" title={approval.canonicalTarget}>
            {approval.canonicalTarget}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>{approval.sideEffectClass} effect</span>
            <span>requested by {approval.requestedBy.id}</span>
            {approval.expiresAt ? <span>expires {formatApprovalExpiry(approval.expiresAt)}</span> : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => void onResolve?.(approval.id, "approved")}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[10px] font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-45"
              title={controlsUnavailable ? "Approval resolution is unavailable." : resolving ? "Resolving approval…" : "Approve this decision"}
              aria-busy={resolving}
            >
              <Check className="size-3" weight="bold" aria-hidden="true" /> {resolving ? "Resolving…" : "Approve"}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => void onResolve?.(approval.id, "rejected")}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 px-2.5 text-[10px] text-foreground/80 transition-colors hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-45"
              title={controlsUnavailable ? "Approval resolution is unavailable." : resolving ? "Resolving approval…" : "Reject this decision"}
              aria-busy={resolving}
            >
              <XCircle className="size-3" aria-hidden="true" /> Reject
            </button>
            {controlsUnavailable ? <span className="text-[9px] text-muted-foreground">Resolution unavailable</span> : null}
            <span className="ml-auto font-mono text-[9px] text-muted-foreground/70" title={approval.operationId}>op {approval.operationId}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function PlanRow({ task }: { task: ObjectiveTaskProjection }) {
  const tone = task.state === "failed" ? "danger" : task.state === "blocked" || task.state === "waiting-approval" ? "warning" : task.state === "completed" ? "success" : "info";
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-3 md:px-5">
      <StatusDot tone={tone} active={false} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/85">{task.objective}</span>
      <span className={cn("shrink-0 font-mono text-[9px] capitalize", toneText[tone])}>{task.state.replaceAll("-", " ")}</span>
      {task.requiresApproval ? <ShieldCheck className="size-3.5 shrink-0 text-warning/80" aria-label="Approval required" /> : null}
    </div>
  );
}

function CheckpointRow({ checkpoint }: { checkpoint: ObjectiveProjection["checkpoints"][number] }) {
  const complete = checkpoint.criteriaTotal > 0 && checkpoint.criteriaPassed === checkpoint.criteriaTotal;
  return (
    <div className="rounded-xl border border-border/60 bg-card/25 px-4 py-3.5 backdrop-blur-xl md:px-5">
      <div className="flex items-center gap-3">
        {complete ? <CheckCircle className="size-4 shrink-0 text-success" weight="fill" /> : <Clock className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 text-[12px] font-medium text-foreground/90">Checkpoint {checkpoint.sequence}</span>
        <span className="font-mono text-[9px] text-muted-foreground">r{checkpoint.planRevision}</span>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">{checkpoint.reason}</p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground/75">
        <span>{checkpoint.criteriaPassed}/{checkpoint.criteriaTotal} criteria</span>
        <span>{checkpoint.evidenceEventCount} evidence refs</span>
        <span>cursor {checkpoint.eventCursor}</span>
      </div>
    </div>
  );
}

function SectionHeading({ id, icon, title, meta }: { id: string; icon: React.ReactNode; title: string; meta: string }) {
  return (
    <div className="mb-3 flex items-center gap-2 px-1">
      <span className="text-muted-foreground [&>svg]:size-3.5" aria-hidden="true">{icon}</span>
      <h2 id={id} className="text-[11px] font-medium tracking-[0.08em] text-foreground/85">{title}</h2>
      <span className="ml-auto font-mono text-[9px] text-muted-foreground">{meta}</span>
    </div>
  );
}

function QuietState({ detail }: { detail: string }) {
  return <div className="rounded-xl border border-dashed border-border/55 bg-card/15 px-4 py-7 text-center text-[11px] text-muted-foreground/80">{detail}</div>;
}

function Attention({ tone, icon, title, detail }: { tone: "warning" | "danger"; icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-3 rounded-lg border px-3.5 py-3 text-[11px]", tone === "danger" ? "border-destructive/35 bg-destructive/[0.045]" : "border-warning/35 bg-warning/[0.045]")}>
      <span className={cn("mt-0.5 [&>svg]:size-4", tone === "danger" ? "text-destructive" : "text-warning")} aria-hidden="true">{icon}</span>
      <span className="min-w-0"><strong className="font-medium text-foreground/90">{title}</strong><span className="ml-2 text-muted-foreground">{detail}</span></span>
    </div>
  );
}

function StatusDot({ tone, active, className }: { tone: "info" | "success" | "warning" | "danger"; active: boolean; className?: string }) {
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", toneDot[tone], active && "animate-pulse", className)} aria-hidden="true" />;
}

function formatApprovalExpiry(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp);
}

const toneDot = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
} as const;

const toneText = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
} as const;

const toneBorder = {
  info: "border-info/30 bg-info/[0.04] text-info",
  success: "border-success/30 bg-success/[0.04] text-success",
  warning: "border-warning/30 bg-warning/[0.04] text-warning",
  danger: "border-destructive/30 bg-destructive/[0.04] text-destructive",
} as const;

/** Aggregate-first objective workbench backed by one event-fenced snapshot. */
function _ObjectiveSnapshotWorkbench({
  workspace,
  onOpenAgent,
  onReviewArtifact,
  onResolveApproval,
  resolvingApprovalId,
  approvalError,
}: {
  workspace: ObjectiveWorkspaceProjection;
  onOpenAgent?: (agentId: string) => void;
  onResolveApproval?: ObjectiveWorkbenchProps["onResolveApproval"];
  onReviewArtifact?: ObjectiveWorkbenchProps["onReviewArtifact"];
  resolvingApprovalId?: string | null;
  approvalError?: string | null;
}) {
  const { objective, frontier, runline, occurrences, attentions, artifacts, artifactReviews, controlMutations, eventCursor } = workspace;
  const openAttentions = attentions.filter((attention) => attention.status === "open");
  const pendingApprovals = workspace.snapshot.approvals.filter((approval) => approval.status === "requested");
  const aggregateState = objective.state.replaceAll("-", " ");
  const activeExecution = frontier.some((item) => item.status === "running");
  const statusTone = objective.state === "achieved" ? "success" : objective.state === "abandoned" ? "danger" : openAttentions.length > 0 ? "warning" : "info";
  const reviewByArtifact = new Map(artifactReviews.map((review) => [review.artifactId, review]));

  return (
    <main className="flex min-h-full flex-1 flex-col bg-background text-foreground" aria-label="Objective workbench">
      <div className="mx-auto w-full max-w-[96rem] flex-1 px-5 py-7 md:px-8 md:py-9 lg:px-12">
        <header className="border-b border-border/45 pb-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 max-w-4xl">
              <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.11em] text-muted-foreground"><span className="text-info">Objective</span><span aria-hidden="true">·</span><span className="truncate normal-case" title={objective.objectiveId}>{objective.objectiveId}</span><span aria-hidden="true">·</span><span>revision {objective.activeRevision}</span></div>
              <h1 className="text-[clamp(1.35rem,2.5vw,2.35rem)] font-medium leading-[1.12] tracking-[-0.035em]">{objective.statement ?? objective.spec?.statement ?? "Untitled objective"}</h1>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-muted-foreground"><span>{workspace.currentRuns.length} current run{workspace.currentRuns.length === 1 ? "" : "s"}</span><span>{occurrences.length} occurrence{occurrences.length === 1 ? "" : "s"}</span><span className="font-mono">event fence {eventCursor}</span></div>
            </div>
            <div className={cn("inline-flex shrink-0 items-center gap-2 self-start rounded-full border px-3 py-1.5 text-[10px] font-mono capitalize", toneBorder[statusTone])}>{activeExecution ? <AgentLoader kind="square" size={14} label="Objective execution active" animated tone="info" /> : <StatusDot tone={statusTone} active={false} />}{aggregateState}</div>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-4"><SnapshotMetric label="Frontier" value={String(frontier.length)} detail="unfinished executions" /><SnapshotMetric label="Attention" value={String(openAttentions.length)} detail="open durable requests" warning={openAttentions.length > 0} /><SnapshotMetric label="Artifacts" value={String(artifacts.length)} detail="published evidence" /><SnapshotMetric label="Events" value={String(eventCursor)} detail="single cursor fence" /></div>
        </header>

        <section className="mt-7" aria-labelledby="snapshot-frontier-heading"><SnapshotHeading id="snapshot-frontier-heading" title="Unified frontier" meta={frontier.length ? `${frontier.length} unfinished` : "settled"} />{frontier.length === 0 ? <SnapshotQuiet detail={objective.state === "achieved" ? "The objective is achieved; no unfinished execution remains." : "No unfinished execution is published at this event fence."} /> : <div className="divide-y divide-border/45 overflow-hidden rounded-xl border border-border/65 bg-card/30">{frontier.map((item) => <FrontierRow key={`${item.runId}:${item.id}`} item={item} onOpenAgent={onOpenAgent} />)}</div>}</section>

        <section className="mt-8" aria-labelledby="snapshot-runline-heading"><SnapshotHeading id="snapshot-runline-heading" title="Semantic runline" meta={`${runline.length} entries · fence ${eventCursor}`} />{runline.length === 0 ? <SnapshotQuiet detail="No semantic execution events have been published yet." /> : <ol className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/65 bg-card/20">{runline.map((entry) => <RunlineRow key={`${entry.runId}:${entry.id}`} entry={entry} />)}</ol>}</section>

        <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.85fr)]"><section aria-labelledby="snapshot-attention-heading" className="min-w-0"><SnapshotHeading id="snapshot-attention-heading" title="Attention inbox" meta={`${openAttentions.length + pendingApprovals.length} open`} />{openAttentions.length === 0 && pendingApprovals.length === 0 ? <SnapshotQuiet detail="No durable attention requests are waiting." /> : <div className="space-y-2.5">{openAttentions.map((attention) => <AttentionInboxRow key={attention.id} attention={attention} />)}{pendingApprovals.filter((approval) => !openAttentions.some((attention) => attention.operationId === approval.operationId)).map((approval) => <ApprovalInboxRow key={approval.id} approval={approval} onResolve={onResolveApproval} resolving={resolvingApprovalId === approval.id} />)}{approvalError ? <p className="rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-[10px] text-destructive" role="alert">{approvalError}</p> : null}</div>}</section><section aria-labelledby="snapshot-occurrence-heading" className="min-w-0"><SnapshotHeading id="snapshot-occurrence-heading" title="Run occurrences" meta={String(occurrences.length)} />{occurrences.length === 0 ? <SnapshotQuiet detail="No run occurrence has been recorded." /> : <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/65 bg-card/20">{occurrences.map((occurrence) => <OccurrenceRow key={occurrence.id} occurrence={occurrence} />)}</div>}</section></div>
        <section className="mt-8" aria-labelledby="snapshot-revision-heading"><SnapshotHeading id="snapshot-revision-heading" title="Objective revisions" meta={`${workspace.revisions.length} immutable`} />{workspace.revisions.length === 0 ? <SnapshotQuiet detail="No immutable objective revision is available." /> : <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/65 bg-card/20">{workspace.revisions.map((revision) => <RevisionRow key={revision.id} revision={revision} />)}</div>}</section>

        <section className="mt-8" aria-labelledby="snapshot-artifact-heading"><SnapshotHeading id="snapshot-artifact-heading" title="Artifact shelf" meta={`${artifacts.length} published`} />{artifacts.length === 0 ? <SnapshotQuiet detail="No artifacts have been published at this event fence." /> : <div className="space-y-4">{artifactShelfGroups(artifacts, workspace).map((group) => <div key={group.key}><div className="mb-2 flex flex-wrap items-center gap-2 px-1 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70"><span>{group.reviewState}</span><span>·</span><span>{group.provenance}</span><span>·</span><span>{group.outcome}</span><span className="ml-auto">{group.artifacts.length}</span></div><div className="grid gap-2.5 md:grid-cols-2">{group.artifacts.map((artifact) => <ArtifactShelfCard key={artifact.id} artifact={artifact} latestReview={reviewByArtifact.get(artifact.id)} onReview={onReviewArtifact} />)}</div></div>)}</div>}</section>

        <section className="mt-8" aria-labelledby="snapshot-mutation-heading"><SnapshotHeading id="snapshot-mutation-heading" title="Control history" meta={`${controlMutations.length} mutations`} />{controlMutations.length === 0 ? <SnapshotQuiet detail="No control-plan mutation has been recorded." /> : <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/65 bg-card/20">{controlMutations.map((mutation, index) => <MutationRow key={mutationKey(mutation, index)} mutation={mutation} />)}</div>}</section>
      </div>
    </main>
  );
}

function SnapshotMetric({ label, value, detail, warning = false }: { label: string; value: string; detail: string; warning?: boolean }) { return <div className="rounded-lg border border-border/50 bg-card/20 px-3 py-2.5"><p className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/65">{label}</p><p className={cn("mt-1 text-sm font-medium tabular-nums", warning && "text-warning")}>{value}</p><p className="mt-0.5 text-[9px] text-muted-foreground/65">{detail}</p></div>; }
function SnapshotHeading({ id, title, meta }: { id: string; title: string; meta: string }) { return <div className="mb-3 flex items-center gap-2 px-1"><h2 id={id} className="text-[11px] font-medium tracking-[0.08em] text-foreground/85">{title}</h2><span className="ml-auto font-mono text-[9px] text-muted-foreground">{meta}</span></div>; }
function SnapshotQuiet({ detail }: { detail: string }) { return <div className="rounded-xl border border-dashed border-border/55 bg-card/15 px-4 py-7 text-center text-[11px] text-muted-foreground/80">{detail}</div>; }

function FrontierRow({ item, onOpenAgent }: { item: ObjectiveWorkspaceFrontierItem; onOpenAgent?: (agentId: string) => void }) {
  const active = item.status === "running";
  const tone = frontierTone(item.status);
  const detail = item.status === "blocked-dependency" && item.blockedBy.length > 0 ? `blocked by ${item.blockedBy.join(", ")}` : item.status === "waiting-timer" && item.dueAt ? `timer due ${formatTimestamp(item.dueAt)}` : item.status === "waiting-signal" && item.signalKey ? `signal ${item.signalKey}` : item.status === "waiting-attention" && item.attentionIds.length > 0 ? `${item.attentionIds.length} attention request${item.attentionIds.length === 1 ? "" : "s"}` : item.unknownReason ?? item.terminalReason ?? item.sourceState;
  const content = <span className="flex min-w-0 items-start gap-3"><span className="mt-0.5 shrink-0">{active ? <AgentLoader kind="square" size={17} label={`${item.label} active`} animated tone="info" /> : <StatusDot tone={tone} active={false} />}</span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-[12px] font-medium text-foreground/95">{item.label}</span><span className={cn("font-mono text-[9px] capitalize", toneText[tone])}>{item.status.replaceAll("-", " ")}</span></span><span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground"><span className="font-mono">{item.runId} · {item.id}</span>{item.attemptId ? <span>attempt {item.attemptId}</span> : null}{item.agentId ? <span>agent {item.agentId}</span> : null}</span><span className="mt-1 block text-[10px] text-muted-foreground/75">{detail}</span></span></span>;
  return item.agentId && onOpenAgent ? <button type="button" onClick={() => onOpenAgent(item.agentId!)} className="group w-full px-4 py-3.5 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none md:px-5">{content}</button> : <div className="px-4 py-3.5 md:px-5">{content}</div>;
}
function RunlineRow({ entry }: { entry: ObjectiveWorkspaceRunlineEntry }) { return <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-3.5 md:px-5"><span className="pt-0.5 font-mono text-[9px] tabular-nums text-muted-foreground/65">{entry.cursor === null ? "—" : `#${entry.cursor}`}</span><div className="min-w-0"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-[11px] font-medium capitalize text-foreground/90">{entry.type.replaceAll("-", " ")}</span>{entry.collapsedCount > 1 ? <span className="font-mono text-[9px] text-muted-foreground">×{entry.collapsedCount}</span> : null}<span className="font-mono text-[9px] text-muted-foreground/65">{entry.runId}</span></div><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{entry.summary}</p></div></li>; }
function AttentionInboxRow({ attention }: { attention: ObjectiveWorkspaceProjection["attentions"][number] }) { return <article className="rounded-xl border border-warning/35 bg-warning/[0.045] p-4"><div className="flex items-start gap-3"><WarningCircle className="mt-0.5 size-4 shrink-0 text-warning" weight="fill" aria-hidden="true" /><div className="min-w-0"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><h3 className="text-[12px] font-medium text-foreground/95">{attention.reason}</h3><span className="font-mono text-[9px] uppercase tracking-[0.08em] text-warning">{attention.urgency}</span></div><p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{attention.consequence}</p><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground/75"><span>{attention.risk} risk</span><span>run {attention.runId}</span>{attention.nodeId ? <span>node {attention.nodeId}</span> : null}{attention.expiresAt ? <span>expires {formatTimestamp(attention.expiresAt)}</span> : null}</div><p className="mt-2 text-[10px] text-foreground/75">Proposed: {attention.proposedAction}</p><span className="mt-2 inline-block font-mono text-[9px] text-muted-foreground">Resolution unavailable here; use the owning control endpoint.</span></div></div></article>; }
function ApprovalInboxRow({ approval, onResolve, resolving }: { approval: ObjectiveWorkspaceProjection["snapshot"]["approvals"][number]; onResolve?: ObjectiveWorkbenchProps["onResolveApproval"]; resolving: boolean }) { const disabled = !onResolve || resolving; return <article className="rounded-xl border border-warning/35 bg-warning/[0.045] p-4"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" /><div className="min-w-0 flex-1"><h3 className="text-[12px] font-medium text-foreground/95">{approval.question}</h3><p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{approval.sideEffectClass} effect · run {approval.runId}</p><div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" disabled={disabled} className="rounded-md bg-foreground px-2.5 py-1.5 font-mono text-[9px] text-background disabled:cursor-not-allowed disabled:opacity-45" onClick={() => void onResolve?.(approval.id, "approved")}>{resolving ? "Resolving…" : "Approve"}</button><button type="button" disabled={disabled} className="rounded-md border border-border/65 px-2.5 py-1.5 font-mono text-[9px] text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45" onClick={() => void onResolve?.(approval.id, "rejected")}>Reject</button>{!onResolve ? <span className="font-mono text-[9px] text-muted-foreground/65">Resolution unavailable</span> : null}</div></div></div></article>; }
function OccurrenceRow({ occurrence }: { occurrence: ObjectiveWorkspaceProjection["occurrences"][number] }) { const tone = occurrence.outcome === "succeeded" ? "success" : ["failed", "abandoned"].includes(occurrence.outcome) ? "danger" : occurrence.outcome === "running" ? "info" : "warning"; return <div className="flex min-w-0 items-start gap-3 px-4 py-3.5"><StatusDot tone={tone} active={occurrence.outcome === "running"} className="mt-1.5" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="font-mono text-[10px] text-foreground/85">{occurrence.runId}</span><span className={cn("font-mono text-[9px] capitalize", toneText[tone])}>{occurrence.outcome.replaceAll("-", " ")}</span><span className="font-mono text-[9px] text-muted-foreground">revision {occurrence.objectiveRevision}</span></div><p className="mt-1 text-[10px] text-muted-foreground">{occurrence.kind} occurrence{occurrence.occurrenceKey ? ` · ${occurrence.occurrenceKey}` : ""}</p></div><span className="shrink-0 font-mono text-[9px] text-muted-foreground/65">{formatTimestamp(occurrence.updatedAt)}</span></div>; }
function RevisionRow({ revision }: { revision: ObjectiveWorkspaceProjection["revisions"][number] }) { return <div className="flex min-w-0 items-start gap-3 px-4 py-3.5 md:px-5"><StatusDot tone="info" active={false} className="mt-1.5" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="font-mono text-[10px] text-foreground/90">revision {revision.revision}</span><span className="text-[10px] text-muted-foreground">{revision.createdBy.type} {revision.createdBy.id}</span></div><p className="mt-1 truncate text-[10px] text-muted-foreground" title={revision.spec.statement}>{revision.spec.statement}</p></div><span className="shrink-0 font-mono text-[9px] text-muted-foreground/65">{formatTimestamp(revision.createdAt)}</span></div>; }
function ArtifactShelfCard({ artifact, latestReview, onReview }: { artifact: ObjectiveWorkspaceProjection["artifacts"][number]; latestReview?: ObjectiveWorkspaceProjection["artifactReviews"][number]; onReview?: (artifactId: string, state: "verified" | "rejected", reason: string) => void | Promise<void> }) { const provenance = artifact.publishedBy.type === "agent" ? `agent ${artifact.publishedBy.id}` : artifact.publishedBy.type; return <article className="rounded-xl border border-border/60 bg-card/25 p-4"><div className="flex items-start gap-3"><ListBullets className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><h3 className="truncate text-[12px] font-medium text-foreground/90" title={artifact.name}>{artifact.name}</h3><span className={cn("font-mono text-[9px] capitalize", reviewTone(artifact.reviewState))}>{artifact.reviewState}</span></div><p className="mt-1 text-[10px] text-muted-foreground">{artifact.kind} · {artifact.mediaType} · {formatBytes(artifact.sizeBytes)}</p><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground/70"><span>{provenance}</span><span>run {artifact.runId}</span><span>cursor {artifact.evidence.eventCursor}</span></div>{latestReview ? <p className="mt-2 text-[10px] text-muted-foreground">Latest review: {latestReview.reason}</p> : null}<div className="mt-3 flex flex-wrap items-center gap-2">{onReview && artifact.reviewState === "pending" ? <><button type="button" className="rounded-md bg-foreground px-2 py-1 font-mono text-[9px] text-background hover:opacity-85" onClick={() => void onReview(artifact.id, "verified", "Verified from the objective shelf.")}>Verify</button><button type="button" className="rounded-md border border-border/65 px-2 py-1 font-mono text-[9px] text-muted-foreground hover:bg-muted/35" onClick={() => void onReview(artifact.id, "rejected", "Rejected from the objective shelf.")}>Reject</button></> : <span className="font-mono text-[9px] text-muted-foreground/65">{onReview ? "No review action" : "Review unavailable"}</span>}</div></div></div></article>; }
function MutationRow({ mutation }: { mutation: JsonValue }) { const record = asRecord(mutation); const type = stringField(record, "type") ?? stringField(record, "operation") ?? "control mutation"; const reason = stringField(record, "reason") ?? stringField(record, "summary") ?? "Durable control change."; const actor = asRecord(record?.actor); const actorLabel = stringField(actor, "id") ?? stringField(actor, "type"); const revision = numberField(record, "expectedRevision") ?? numberField(record, "revision"); const path = stringField(record, "nodeId") ?? stringField(record, "parentId"); const payload = record?.node ?? record?.maxIterations ?? record?.nextValue ?? record?.after ?? null; return <div className="flex min-w-0 items-start gap-3 px-4 py-3.5 md:px-5"><GitBranch className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden="true" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="font-mono text-[10px] text-foreground/85">{type.replaceAll("-", " ")}</span>{actorLabel ? <span className="font-mono text-[9px] text-muted-foreground">by {actorLabel}</span> : null}{path ? <span className="font-mono text-[9px] text-muted-foreground">{path}</span> : null}</div><p className="mt-1 text-[10px] text-muted-foreground">{reason}</p>{payload !== null ? <details className="mt-2"><summary className="cursor-pointer font-mono text-[9px] text-info/80">show durable diff</summary><pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted/25 p-2 font-mono text-[9px] leading-4 text-muted-foreground">{typeof payload === "string" || typeof payload === "number" ? String(payload) : JSON.stringify(payload, null, 2)}</pre></details> : null}</div>{revision !== null ? <span className="shrink-0 font-mono text-[9px] text-muted-foreground">r{revision}</span> : null}</div>; }
function asRecord(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function stringField(record: Record<string, unknown> | null, key: string): string | null { return typeof record?.[key] === "string" && record[key] ? record[key] as string : null; }
function numberField(record: Record<string, unknown> | null, key: string): number | null { return typeof record?.[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : null; }
function mutationKey(value: JsonValue, index: number): string { const record = asRecord(value); return stringField(record, "mutationId") ?? stringField(record, "id") ?? `mutation-${index}`; }
function formatTimestamp(value: string): string { const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp) : value; }
function formatBytes(value: number): string { return value < 1_024 ? `${value} B` : value < 1_048_576 ? `${(value / 1_024).toFixed(1)} KB` : `${(value / 1_048_576).toFixed(1)} MB`; }
function reviewTone(state: string): string { return state === "verified" ? "text-success" : state === "rejected" ? "text-destructive" : state === "superseded" ? "text-muted-foreground" : "text-warning"; }
function frontierTone(status: ObjectiveWorkspaceFrontierItem["status"]): "info" | "success" | "warning" | "danger" { return status === "running" || status === "runnable" ? "info" : status === "completed" ? "success" : status === "failed" || status === "outcome-unknown" ? "danger" : "warning"; }

function artifactShelfGroups(artifacts: ObjectiveWorkspaceProjection["artifacts"], workspace: ObjectiveWorkspaceProjection): Array<{ key: string; reviewState: string; provenance: string; outcome: string; artifacts: ObjectiveWorkspaceProjection["artifacts"] }> {
  const outcomeByRun = new Map(workspace.occurrences.map((occurrence) => [occurrence.runId, occurrence.outcome]));
  const groups = new Map<string, { key: string; reviewState: string; provenance: string; outcome: string; artifacts: ObjectiveWorkspaceProjection["artifacts"] }>();
  for (const artifact of artifacts) {
    const provenance = artifact.publishedBy.type === "agent" ? "agent" : artifact.publishedBy.type;
    const outcome = outcomeByRun.get(artifact.runId) ?? "unknown";
    const key = `${artifact.reviewState}:${provenance}:${outcome}`;
    const group = groups.get(key) ?? { key, reviewState: artifact.reviewState, provenance, outcome, artifacts: [] };
    group.artifacts.push(artifact);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key));
}
