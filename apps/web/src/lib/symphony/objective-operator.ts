import type {
  ObjectiveFrontierStatus,
  ObjectiveRunlineEntry,
  ObjectiveRunlineEventType,
} from "../../../../../packages/protocol/src/index.js";
import type { ObjectiveWorkspaceProjection } from "./objective-snapshot";

export const OPERATOR_FILTERS = ["all", "work", "decisions", "waiting", "evidence", "system"] as const;
export type OperatorFilter = (typeof OPERATOR_FILTERS)[number];

export type OperatorDensity = "comfortable" | "compact";

export type OperatorRunlineEntry = ObjectiveRunlineEntry & { runId: string; category: Exclude<OperatorFilter, "all"> };

export type ObjectiveOperatorProjection = {
  runline: OperatorRunlineEntry[];
  frontier: ObjectiveWorkspaceProjection["frontier"];
  counts: {
    total: number;
    active: number;
    runnable: number;
    waiting: number;
    attention: number;
    unknown: number;
    failed: number;
    settled: number;
  };
};

const categoryByType: Record<ObjectiveRunlineEventType, OperatorRunlineEntry["category"]> = {
  "objective-revision": "system",
  "plan-revised": "system",
  "stage-entered": "work",
  "stage-exited": "work",
  "agent-delegated": "work",
  "agent-settled": "work",
  "agent-failed": "work",
  "branch-selected": "decisions",
  "loop-iteration": "work",
  "loop-stopped": "decisions",
  evaluation: "decisions",
  "artifact-published": "evidence",
  "artifact-superseded": "evidence",
  "checkpoint-committed": "evidence",
  "retry-scheduled": "waiting",
  "attention-requested": "waiting",
  "attention-resolved": "decisions",
  "suspension-created": "waiting",
  "suspension-settled": "decisions",
  "outcome-unknown": "waiting",
  reconciliation: "decisions",
  "run-completed": "system",
  "run-failed": "system",
  "run-cancelled": "system",
  "run-expired": "system",
  observation: "system",
};

/**
 * Create the operator projection from the already atomic workspace projection.
 * This is intentionally small and deterministic: the UI can filter and sort
 * the daemon's causal records, but it cannot invent progress or merge state
 * from separate requests.
 */
export function projectObjectiveOperator(workspace: ObjectiveWorkspaceProjection): ObjectiveOperatorProjection {
  const runline = workspace.runline.map((entry) => ({
    ...entry,
    category: categoryByType[entry.type],
  }));
  const frontier = workspace.frontier.slice();
  return {
    runline,
    frontier,
    counts: {
      total: frontier.length,
      active: frontier.filter((item) => item.status === "running").length,
      runnable: frontier.filter((item) => item.status === "runnable").length,
      waiting: frontier.filter((item) => isWaitingStatus(item.status)).length,
      attention: frontier.filter((item) => item.status === "waiting-attention").length,
      unknown: frontier.filter((item) => item.status === "outcome-unknown").length,
      failed: frontier.filter((item) => item.status === "failed").length,
      settled: workspace.runline.filter((entry) => entry.type === "run-completed" || entry.type === "agent-settled").length,
    },
  };
}

export function filterOperatorRunline(
  entries: readonly OperatorRunlineEntry[],
  filter: OperatorFilter,
  query = "",
  runId: string | null = null,
): OperatorRunlineEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (filter !== "all" && entry.category !== filter) return false;
    if (runId !== null && entry.runId !== runId) return false;
    if (!normalizedQuery) return true;
    return [entry.summary, entry.type, entry.subjectId ?? "", entry.runId]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}

export function isWaitingStatus(status: ObjectiveFrontierStatus): boolean {
  return status === "blocked-dependency"
    || status === "waiting-timer"
    || status === "waiting-signal"
    || status === "waiting-attention"
    || status === "retry-scheduled"
    || status === "expired";
}

export function operatorStatusLabel(status: ObjectiveFrontierStatus): string {
  return status.replaceAll("-", " ");
}

export function operatorStatusTone(status: ObjectiveFrontierStatus): "info" | "success" | "warning" | "danger" {
  if (status === "running" || status === "runnable") return "info";
  if (status === "completed") return "success";
  if (status === "failed" || status === "outcome-unknown") return "danger";
  return "warning";
}

export function operatorEventTone(type: ObjectiveRunlineEventType): "info" | "success" | "warning" | "danger" | "default" {
  if (type === "agent-failed" || type === "run-failed" || type === "outcome-unknown") return "danger";
  if (type === "agent-settled" || type === "run-completed" || type === "checkpoint-committed" || type === "artifact-published") return "success";
  if (categoryByType[type] === "waiting") return "warning";
  if (categoryByType[type] === "work") return "info";
  return "default";
}
