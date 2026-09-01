import { describe, expect, it } from "vitest";
import { selectLatestObjective } from "../apps/web/src/lib/symphony/objective-project.js";
import type { ObjectiveRunRecord } from "../apps/web/src/lib/symphony/contracts.js";

function objective(runId: string, workflowId: string, updatedAt: string): ObjectiveRunRecord {
  return { runId, workflowId, updatedAt } as ObjectiveRunRecord;
}

describe("objective run selection", () => {
  it("keeps the workflow boundary exact and selects the newest run deterministically", () => {
    const runs = [
      objective("older", "chat:thread-1", "2026-09-01T00:00:00.000Z"),
      objective("newest", "chat:thread-1", "2026-09-01T01:00:00.000Z"),
      objective("foreign", "chat:thread-10", "2026-09-01T02:00:00.000Z"),
    ];

    expect(selectLatestObjective(runs, "chat:thread-1")?.runId).toBe("newest");
  });

  it("uses the run ID as a stable tie breaker without mutating the source list", () => {
    const runs = [
      objective("run-a", "workflow", "2026-09-01T00:00:00.000Z"),
      objective("run-z", "workflow", "2026-09-01T00:00:00.000Z"),
    ];
    const originalOrder = runs.map((run) => run.runId);

    expect(selectLatestObjective(runs, "workflow")?.runId).toBe("run-z");
    expect(runs.map((run) => run.runId)).toEqual(originalOrder);
  });

  it("prefers an objective owned by the active conductor over a newer shared-workflow run", () => {
    const runs = [
      {
        ...objective("owned", "manual-objective", "2026-09-01T00:00:00.000Z"),
        conductorAgentId: "conductor-thread-1",
      },
      {
        ...objective("foreign", "chat:thread-1", "2026-09-01T02:00:00.000Z"),
        conductorAgentId: "conductor-thread-2",
      },
    ];

    expect(selectLatestObjective(runs, {
      workflowId: "chat:thread-1",
      conductorAgentId: "conductor-thread-1",
    })?.runId).toBe("owned");
  });

  it("can discover an objective attached to a recovered lineage agent without leaking a foreign tree", () => {
    const runs = [
      {
        ...objective("lineage", "manual-lineage", "2026-09-01T00:00:00.000Z"),
        conductorAgentId: "child-thread-1",
      },
      {
        ...objective("foreign", "manual-foreign", "2026-09-01T01:00:00.000Z"),
        conductorAgentId: "child-thread-2",
      },
    ];

    expect(selectLatestObjective(runs, {
      workflowId: "chat:thread-1",
      agentIds: ["conductor-thread-1", "child-thread-1"],
    })?.runId).toBe("lineage");
  });

  it("falls back to the exact workflow only when no owned objective is present", () => {
    const runs = [
      {
        ...objective("workflow-newest", "shared-workflow", "2026-09-01T02:00:00.000Z"),
        conductorAgentId: null,
      },
      {
        ...objective("foreign", "other-workflow", "2026-09-01T03:00:00.000Z"),
        conductorAgentId: "other-conductor",
      },
    ];

    expect(selectLatestObjective(runs, {
      workflowId: "shared-workflow",
      conductorAgentId: "active-conductor",
    })?.runId).toBe("workflow-newest");
  });
});
