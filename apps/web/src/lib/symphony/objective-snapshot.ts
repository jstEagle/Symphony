import type {
  ObjectiveAggregateSnapshot,
  ObjectiveArtifactRecord,
  ObjectiveArtifactReviewRecord,
  ObjectiveAttentionRecord,
  ObjectiveFrontierItem,
  ObjectiveAggregateFrontierProjection,
  ObjectiveAggregateRunlineProjection,
  ObjectiveRunRecord,
  ObjectiveRunlineEntry,
  ObjectiveRunOccurrenceRecord,
  ObjectiveRevisionRecord,
} from "../../../../../packages/protocol/src/index.js";
import { projectObjectiveAggregateSnapshot } from "../../../../../packages/workflow/src/objective-frontier.js";
import type { JsonValue } from "./contracts";

/**
 * Browser-facing view of the daemon's atomic objective snapshot.
 *
 * The frontier and runline fields intentionally use the protocol module's
 * types. This adapter only binds the aggregate's many run occurrences to the
 * shared run-scoped projector; it does not reimplement frontier semantics.
 */
export type ObjectiveWorkspaceFrontierItem = ObjectiveFrontierItem & { runId: string };
export type ObjectiveWorkspaceRunlineEntry = ObjectiveRunlineEntry & { runId: string };

export type ObjectiveWorkspaceProjection = {
  snapshot: ObjectiveAggregateSnapshot;
  objectiveId: string;
  objective: ObjectiveAggregateSnapshot["objective"];
  revisions: ObjectiveRevisionRecord[];
  occurrences: ObjectiveRunOccurrenceRecord[];
  runs: ObjectiveRunRecord[];
  currentRuns: ObjectiveRunRecord[];
  frontier: ObjectiveWorkspaceFrontierItem[];
  runline: ObjectiveWorkspaceRunlineEntry[];
  runlineByRun: ObjectiveAggregateRunlineProjection["runs"];
  attentions: ObjectiveAttentionRecord[];
  artifacts: ObjectiveArtifactRecord[];
  artifactReviews: ObjectiveArtifactReviewRecord[];
  checkpoints: ObjectiveAggregateSnapshot["checkpoints"];
  controlMutations: JsonValue[];
  planMutations: JsonValue[];
  eventCursor: number;
};

/**
 * Project an atomic daemon response into one objective workspace model.
 * Every derived record is bounded by the snapshot's single event cursor.
 */
export function projectObjectiveSnapshot(snapshot: ObjectiveAggregateSnapshot): ObjectiveWorkspaceProjection {
  const projected = projectObjectiveAggregateSnapshot(snapshot);
  const aggregateFrontier: ObjectiveAggregateFrontierProjection = projected.frontierProjection;
  const aggregateRunline: ObjectiveAggregateRunlineProjection = projected.runline;
  const frontier = aggregateFrontier.frontier;
  const runline = aggregateRunline.entries;

  return {
    snapshot,
    objectiveId: snapshot.objective.objectiveId,
    objective: snapshot.objective,
    revisions: snapshot.revisions,
    occurrences: snapshot.occurrences,
    runs: snapshot.runs,
    currentRuns: snapshot.currentRuns,
    frontier,
    runline,
    runlineByRun: aggregateRunline.runs,
    attentions: snapshot.attentions,
    artifacts: snapshot.artifacts,
    artifactReviews: snapshot.artifactReviews,
    checkpoints: snapshot.checkpoints,
    controlMutations: snapshot.mutations.control,
    planMutations: snapshot.mutations.plans,
    eventCursor: snapshot.eventCursor,
  };
}

/** Select the durable active occurrence deterministically for opened-objective navigation. */
export function primaryObjectiveRun(snapshot: ObjectiveAggregateSnapshot): ObjectiveRunRecord | null {
  return snapshot.currentRuns[0]
    ?? snapshot.runs.find((run) => run.runId === snapshot.objective.latestRunId)
    ?? snapshot.runs[0]
    ?? null;
}
