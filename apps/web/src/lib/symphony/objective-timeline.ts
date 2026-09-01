import type { ObjectiveTaskRecord, ObjectiveTaskState } from "../../../../../packages/protocol/src/index.js";
import type {
  ObjectiveApprovalProjection,
  ObjectiveCheckpointProjection,
  ObjectiveProjection,
  ObjectiveTaskProjection,
} from "./objective-project";
import type { ObjectivePlanRevisionRecord } from "./contracts";

/** One task as it appeared in an immutable plan snapshot. */
export type ObjectiveTimelineTask = {
  id: string;
  objective: string;
  state: ObjectiveTaskState;
  dependsOn: string[];
  /** The current projection is only used for the active plan revision. */
  dependencies: ObjectiveTaskProjection["dependencies"];
  attemptIds: string[];
  attemptCount: number;
  retryCount: number;
  requiresApproval: boolean;
  frontier: boolean;
  error: string | null;
};

/** A compact, causal row in the objective plan history. */
export type ObjectiveRevisionTimelineEntry = {
  id: string;
  planRevision: number;
  createdAt: string;
  createdBy: ObjectivePlanRevisionRecord["createdBy"];
  requestKey: string;
  current: boolean;
  reason: string | null;
  tasks: ObjectiveTimelineTask[];
  addedTaskIds: string[];
  removedTaskIds: string[];
  changedTaskIds: string[];
  checkpoints: ObjectiveCheckpointProjection[];
  approvals: ObjectiveApprovalProjection[];
  evidenceEventCount: number;
  pendingApprovalCount: number;
};

/**
 * Build the read-only plan/revision timeline from daemon projections.
 *
 * Revisions are immutable snapshots, while the task record on the run is the
 * latest state. We therefore only overlay latest state on the active revision;
 * history keeps the snapshot's own state and dependencies. Attempts are
 * counted by stable attempt IDs in objective task events, so a failed dispatch
 * followed by a replacement is visible as a retry without guessing from time.
 */
export function buildObjectiveRevisionTimeline(
  projection: ObjectiveProjection,
): ObjectiveRevisionTimelineEntry[] {
  const revisions = projection.planRevisions
    .slice()
    .sort((left, right) => left.planRevision - right.planRevision || left.createdAt.localeCompare(right.createdAt));
  if (revisions.length === 0) return [];

  const currentById = new Map(projection.packets.map((task) => [task.id, task]));
  const frontierIds = new Set(projection.frontier.map((task) => task.id));
  const attemptsByTask = collectAttempts(projection.events);
  const reasonByRevision = new Map<number, string>();
  for (const event of projection.events) {
    if (event.type !== "objective.plan.committed" || event.planRevision === null) continue;
    if (event.detail && event.detail !== event.type) reasonByRevision.set(event.planRevision, event.detail);
  }

  return revisions.map((revision, index) => {
    const previous = revisions[index - 1];
    const previousById = new Map(previous?.tasks.map((task) => [task.task.id, task]) ?? []);
    const taskIds = new Set(revision.tasks.map((task) => task.task.id));
    const addedTaskIds = revision.tasks
      .map((task) => task.task.id)
      .filter((id) => !previousById.has(id));
    const removedTaskIds = previous?.tasks
      .map((task) => task.task.id)
      .filter((id) => !taskIds.has(id)) ?? [];
    const changedTaskIds = revision.tasks
      .filter((task) => {
        const prior = previousById.get(task.task.id);
        return prior !== undefined && taskSignature(prior) !== taskSignature(task);
      })
      .map((task) => task.task.id);
    const checkpoints = projection.checkpoints.filter((checkpoint) => checkpoint.planRevision === revision.planRevision);
    const approvals = projection.approvals.filter((approval) => approval.planRevision === revision.planRevision);
    const tasks = revision.tasks.map((record) => {
      const current = revision.planRevision === projection.planRevision ? currentById.get(record.task.id) : undefined;
      const attemptIds = new Set(attemptsByTask.get(record.task.id) ?? []);
      if (record.attemptId) attemptIds.add(record.attemptId);
      if (current?.attemptId) attemptIds.add(current.attemptId);
      const orderedAttempts = [...attemptIds];
      return {
        id: record.task.id,
        objective: record.task.objective,
        state: current?.state ?? record.state,
        dependsOn: [...record.task.dependsOn],
        dependencies: current?.dependencies ?? record.task.dependsOn.map((id) => ({ id, satisfied: false, state: null })),
        attemptIds: orderedAttempts,
        attemptCount: orderedAttempts.length,
        retryCount: Math.max(0, orderedAttempts.length - 1),
        requiresApproval: record.task.requiresApproval,
        frontier: revision.planRevision === projection.planRevision && frontierIds.has(record.task.id),
        error: current?.error ?? record.error,
      } satisfies ObjectiveTimelineTask;
    });
    return {
      id: revision.id,
      planRevision: revision.planRevision,
      createdAt: revision.createdAt,
      createdBy: revision.createdBy,
      requestKey: revision.requestKey,
      current: revision.planRevision === projection.planRevision,
      reason: reasonByRevision.get(revision.planRevision) ?? null,
      tasks,
      addedTaskIds,
      removedTaskIds,
      changedTaskIds,
      checkpoints,
      approvals,
      evidenceEventCount: checkpoints.reduce((total, checkpoint) => total + checkpoint.evidenceEventCount, 0),
      pendingApprovalCount: approvals.filter((approval) => approval.isPending).length,
    };
  });
}

function collectAttempts(events: ObjectiveProjection["events"]): Map<string, string[]> {
  const attemptsByTask = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.taskId || !event.attemptId) continue;
    const attempts = attemptsByTask.get(event.taskId) ?? new Set<string>();
    attempts.add(event.attemptId);
    attemptsByTask.set(event.taskId, attempts);
  }
  return new Map([...attemptsByTask.entries()].map(([taskId, attempts]) => [taskId, [...attempts]]));
}

function taskSignature(record: ObjectiveTaskRecord): string {
  return JSON.stringify({
    objective: record.task.objective,
    dependsOn: record.task.dependsOn,
    model: record.task.model,
    harness: record.task.harness,
    requiresApproval: record.task.requiresApproval,
    state: record.state,
  });
}
