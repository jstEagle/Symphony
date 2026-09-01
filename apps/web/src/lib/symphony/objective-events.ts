import type { EventEnvelope, JsonValue } from "./contracts";

/**
 * Objective events are a semantic projection boundary. The daemon can add
 * new objective.* event names without requiring a web release before the
 * objective workbench is refreshed.
 */
export function isObjectiveSemanticEvent(type: string): boolean {
  return type.trim().toLocaleLowerCase().startsWith("objective.");
}

export type ObjectiveEventQueryPlan = {
  objective: boolean;
  runIds: string[];
  invalidateObjectivePrefix: boolean;
};

/**
 * Build one invalidation plan for an SSE batch. Unknown run identity is kept
 * explicit: callers invalidate the objective prefix rather than risking a
 * stale detail panel. Run IDs are deliberately extracted only from fields
 * named runId/objectiveRunId so arbitrary payload IDs cannot cross-link runs.
 */
export function objectiveEventQueryPlan(
  events: readonly Pick<EventEnvelope, "type" | "runId" | "payload">[],
): ObjectiveEventQueryPlan {
  const runIds = new Set<string>();
  let objective = false;
  let invalidateObjectivePrefix = false;

  for (const event of events) {
    if (!isObjectiveSemanticEvent(event.type)) continue;
    objective = true;
    const runId = cleanId(event.runId) ?? findRunId(event.payload);
    if (runId) runIds.add(runId);
    else invalidateObjectivePrefix = true;
  }

  return { objective, runIds: [...runIds], invalidateObjectivePrefix };
}

function findRunId(value: JsonValue): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const runId = findRunId(item);
      if (runId) return runId;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "runId" || key === "objectiveRunId") {
      const runId = cleanId(child);
      if (runId) return runId;
    }
    const nested = findRunId(child);
    if (nested) return nested;
  }
  return null;
}

function cleanId(value: JsonValue | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
