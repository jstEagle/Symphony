"use client";

import {
  ArrowRight,
  Check,
  CheckCircle,
  Clock,
  GitBranch,
  ShieldCheck,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import type { ObjectiveProjection } from "@/lib/symphony/objective-project";
import {
  buildObjectiveRevisionTimeline,
  type ObjectiveRevisionTimelineEntry,
  type ObjectiveTimelineTask,
} from "@/lib/symphony/objective-timeline";
import { cn } from "@/lib/utils";

export function ObjectiveRevisionTimeline({ projection }: { projection: ObjectiveProjection }) {
  const entries = useMemo(() => buildObjectiveRevisionTimeline(projection), [projection]);

  return (
    <section aria-labelledby="objective-plan-history-heading" className="mt-7 min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
        <GitBranch className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <h2 id="objective-plan-history-heading" className="text-[11px] font-medium tracking-[0.08em] text-foreground/85">
          Plan history &amp; frontier
        </h2>
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
          {entries.length > 0 ? `${entries.length} revision${entries.length === 1 ? "" : "s"} · r${projection.planRevision} active` : "awaiting immutable plan"}
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="border-y border-dashed border-border/55 px-4 py-5 text-[11px] text-muted-foreground/80">
          No immutable plan revision is available for this run yet.
        </div>
      ) : (
        <ol className="relative border-l border-border/65 pl-4 md:pl-5">
          {entries.map((entry) => <RevisionEntry key={entry.id} entry={entry} single={entries.length === 1} />)}
        </ol>
      )}
    </section>
  );
}

function RevisionEntry({ entry, single }: { entry: ObjectiveRevisionTimelineEntry; single: boolean }) {
  return (
    <li className="relative pb-5 last:pb-0">
      <span
        className={cn(
          "absolute -left-[1.32rem] top-2 size-1.5 rounded-full ring-4 ring-background",
          entry.current ? "bg-info" : entry.pendingApprovalCount > 0 ? "bg-warning" : "bg-foreground/45",
        )}
        aria-hidden="true"
      />
      <details open={entry.current || single} className="group">
        <summary className="cursor-pointer list-none py-1 outline-none focus-visible:text-info [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-[11px] font-medium text-foreground/90">plan r{entry.planRevision}</span>
            {entry.current ? <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-info">active</span> : null}
            <span className="text-[10px] text-muted-foreground">{entry.tasks.length} task{entry.tasks.length === 1 ? "" : "s"}</span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground">{formatDate(entry.createdAt)}</span>
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span>{entry.reason ?? (entry.planRevision === 0 ? "Initial plan" : "Plan revision committed")}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{entry.createdBy.type}:{entry.createdBy.id}</span>
          </span>
        </summary>

        <div className="mt-2 border-t border-border/40">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 font-mono text-[9px] text-muted-foreground/80">
            {entry.addedTaskIds.length > 0 ? <DiffSignal tone="success" text={`+${entry.addedTaskIds.length} added`} /> : null}
            {entry.changedTaskIds.length > 0 ? <DiffSignal tone="info" text={`${entry.changedTaskIds.length} changed`} /> : null}
            {entry.removedTaskIds.length > 0 ? <DiffSignal tone="warning" text={`−${entry.removedTaskIds.length} removed`} /> : null}
            {entry.evidenceEventCount > 0 ? <DiffSignal tone="success" text={`${entry.evidenceEventCount} evidence refs`} icon={<CheckCircle />} /> : null}
            {entry.pendingApprovalCount > 0 ? <DiffSignal tone="warning" text={`${entry.pendingApprovalCount} attention gate${entry.pendingApprovalCount === 1 ? "" : "s"}`} icon={<WarningCircle />} /> : null}
            {entry.addedTaskIds.length === 0 && entry.changedTaskIds.length === 0 && entry.removedTaskIds.length === 0 && entry.evidenceEventCount === 0 && entry.pendingApprovalCount === 0 ? (
              <span>unchanged snapshot · {entry.requestKey}</span>
            ) : null}
          </div>

          <div className="divide-y divide-border/35 border-y border-border/35">
            {entry.tasks.map((task) => <TimelineTask key={task.id} task={task} />)}
          </div>

          {entry.checkpoints.length > 0 || entry.approvals.length > 0 ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1.5 pt-2 text-[9px] text-muted-foreground">
              {entry.checkpoints.map((checkpoint) => (
                <span key={checkpoint.id} className="inline-flex items-center gap-1.5" title={checkpoint.reason}>
                  {checkpoint.criteriaTotal > 0 && checkpoint.criteriaPassed === checkpoint.criteriaTotal ? (
                    <CheckCircle className="size-3 text-success" weight="fill" aria-hidden="true" />
                  ) : (
                    <Clock className="size-3 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span>checkpoint {checkpoint.sequence} · {checkpoint.criteriaPassed}/{checkpoint.criteriaTotal} criteria · {checkpoint.evidenceEventCount} evidence · cursor {checkpoint.eventCursor}</span>
                </span>
              ))}
              {entry.approvals.map((approval) => (
                <span
                  key={approval.id}
                  className={cn("inline-flex items-center gap-1.5", approval.isPending ? "text-warning" : approval.status === "rejected" || approval.status === "expired" ? "text-destructive" : "text-success")}
                  title={approval.question}
                >
                  {approval.isPending ? <WarningCircle className="size-3" aria-hidden="true" /> : approval.status === "rejected" || approval.status === "expired" ? <XCircle className="size-3" aria-hidden="true" /> : <ShieldCheck className="size-3" aria-hidden="true" />}
                  <span>{approval.isPending ? "attention gate · pending" : `gate · ${approval.status}`}{approval.taskId ? ` · ${approval.taskId}` : ""}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

function TimelineTask({ task }: { task: ObjectiveTimelineTask }) {
  const tone = taskTone(task.state);
  return (
    <div className={cn("min-w-0 px-2 py-2", task.frontier && "bg-info/[0.035]")}>
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", toneDot[tone])} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-[11px] font-medium text-foreground/90" title={task.objective}>{task.objective}</span>
            <span className={cn("font-mono text-[9px] capitalize", toneText[tone])}>{task.state.replaceAll("-", " ")}</span>
            {task.frontier ? <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-info">frontier</span> : null}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[9px] text-muted-foreground/80">
            <span className="font-mono">{task.id}</span>
            {task.dependsOn.length > 0 ? (
              <span className="inline-flex min-w-0 items-center gap-1" title={`Dependencies: ${task.dependsOn.join(", ")}`}>
                <ArrowRight className="size-2.5 shrink-0" aria-hidden="true" />
                <span className="truncate">after {task.dependsOn.join(", ")}</span>
              </span>
            ) : <span>no dependencies</span>}
            {task.attemptCount > 0 ? (
              <span className={cn("font-mono", task.retryCount > 0 ? "text-warning" : "")} title={task.attemptIds.join(", ")}>
                {task.attemptCount} attempt{task.attemptCount === 1 ? "" : "s"}{task.retryCount > 0 ? ` · ${task.retryCount} retr${task.retryCount === 1 ? "y" : "ies"}` : ""}
              </span>
            ) : <span className="font-mono">no attempt yet</span>}
            {task.requiresApproval ? <span className="inline-flex items-center gap-1 text-warning"><ShieldCheck className="size-2.5" aria-hidden="true" />approval gate</span> : null}
            {task.error ? <span className="inline-flex min-w-0 items-center gap-1 text-destructive" title={task.error}><XCircle className="size-2.5 shrink-0" aria-hidden="true" /><span className="max-w-[22rem] truncate">{task.error}</span></span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffSignal({ tone, text, icon }: { tone: "info" | "success" | "warning"; text: string; icon?: React.ReactNode }) {
  return <span className={cn("inline-flex items-center gap-1", toneText[tone])}>{icon ?? <Check className="size-2.5" weight="bold" aria-hidden="true" />}{text}</span>;
}

function taskTone(state: ObjectiveTimelineTask["state"]): "info" | "success" | "warning" | "danger" {
  if (state === "failed") return "danger";
  if (state === "waiting-approval" || state === "blocked") return "warning";
  if (state === "completed" || state === "superseded") return "success";
  return "info";
}

function formatDate(value: string): string {
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
