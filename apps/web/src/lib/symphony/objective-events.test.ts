import { describe, expect, it } from "vitest";
import { objectiveEventQueryPlan, isObjectiveSemanticEvent } from "./objective-events";
import type { JsonValue } from "./contracts";

const event = (type: string, runId: string | null = null, payload: JsonValue = {}) => ({
  type,
  runId,
  payload,
});

describe("objective SSE projection invalidation", () => {
  it("recognizes current and future objective semantic event names", () => {
    expect(isObjectiveSemanticEvent("objective.task.dispatched")).toBe(true);
    expect(isObjectiveSemanticEvent(" OBJECTIVE.future.signal ")).toBe(true);
    expect(isObjectiveSemanticEvent("run.task.updated")).toBe(false);
  });

  it("coalesces duplicate run IDs and extracts nested objective identities", () => {
    expect(objectiveEventQueryPlan([
      event("objective.task.dispatched", "run-a"),
      event("objective.task.updated", "run-a"),
      event("objective.future.signal", null, { result: { objectiveRunId: "run-b" } }),
    ])).toEqual({ objective: true, runIds: ["run-a", "run-b"], invalidateObjectivePrefix: false });
  });

  it("falls back to the objective prefix when identity is opaque", () => {
    expect(objectiveEventQueryPlan([
      event("objective.supervisor.attention", null, { detail: "refresh everything" }),
      event("chat.message.updated", "chat-run"),
    ])).toEqual({ objective: true, runIds: [], invalidateObjectivePrefix: true });
  });

  it("does not treat arbitrary payload IDs as objective run IDs", () => {
    expect(objectiveEventQueryPlan([
      event("objective.plan.committed", null, { id: "not-a-run", taskId: "task-1" }),
    ]).runIds).toEqual([]);
  });
});
