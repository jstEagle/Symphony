import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ObjectiveOperator } from "@/components/symphony/objective-operator";
import {
  filterOperatorRunline,
  operatorEventTone,
  projectObjectiveOperator,
} from "./objective-operator";
import type { ObjectiveWorkspaceProjection, ObjectiveWorkspaceRunlineEntry } from "./objective-snapshot";
import type { ObjectiveRunlineEntry } from "../../../../../packages/protocol/src/index.js";

const entry = (type: ObjectiveRunlineEntry["type"], summary: string, runId = "run-1"): ObjectiveWorkspaceRunlineEntry => ({
  version: 1,
  id: `${runId}:${type}:${summary}`,
  type,
  cursor: 4,
  occurredAt: "2026-09-01T12:00:00.000Z",
  subjectId: "task-1",
  subjectKind: "task",
  summary,
  collapsedCount: 1,
  evidence: { eventCursor: 4, eventIds: [], attemptIds: [], artifactIds: [], checkpointIds: [], attentionIds: [], contextRefs: [] },
  attemptLineage: [],
  runId,
});

function workspace(overrides: Partial<ObjectiveWorkspaceProjection> = {}): ObjectiveWorkspaceProjection {
  return {
    snapshot: { approvals: [], plan: { revisions: [] } } as unknown as ObjectiveWorkspaceProjection["snapshot"],
    objectiveId: "objective-1",
    objective: {} as ObjectiveWorkspaceProjection["objective"],
    revisions: [],
    occurrences: [],
    runs: [],
    currentRuns: [],
    frontier: [],
    runline: [],
    runlineByRun: [],
    attentions: [],
    artifacts: [],
    artifactReviews: [],
    checkpoints: [],
    controlMutations: [],
    planMutations: [],
    eventCursor: 4,
    ...overrides,
  };
}

describe("objective operator projection", () => {
  it("maps semantic events to operator categories and counts only authoritative frontier state", () => {
    const projection = projectObjectiveOperator(workspace({
      runline: [
        entry("agent-delegated", "Started research", "run-1"),
        entry("branch-selected", "Selected safe branch", "run-2"),
        entry("artifact-published", "Published report", "run-2"),
        entry("suspension-created", "Waiting for approval", "run-1"),
      ],
      frontier: [
        { status: "running" } as ObjectiveWorkspaceProjection["frontier"][number],
        { status: "runnable" } as ObjectiveWorkspaceProjection["frontier"][number],
        { status: "waiting-signal" } as ObjectiveWorkspaceProjection["frontier"][number],
        { status: "outcome-unknown" } as ObjectiveWorkspaceProjection["frontier"][number],
        { status: "failed" } as ObjectiveWorkspaceProjection["frontier"][number],
      ],
    }));

    expect(projection.runline.map((item) => item.category)).toEqual(["work", "decisions", "evidence", "waiting"]);
    expect(projection.counts).toMatchObject({ total: 5, active: 1, runnable: 1, waiting: 1, unknown: 1, failed: 1 });
  });

  it("filters by category, search terms, and run without changing ordering", () => {
    const entries = projectObjectiveOperator(workspace({ runline: [entry("agent-delegated", "Inspect runtime"), entry("evaluation", "Runtime passed", "run-2")] })).runline;
    expect(filterOperatorRunline(entries, "work").map((item) => item.summary)).toEqual(["Inspect runtime"]);
    expect(filterOperatorRunline(entries, "all", "passed").map((item) => item.runId)).toEqual(["run-2"]);
    expect(filterOperatorRunline(entries, "all", "", "run-1").map((item) => item.summary)).toEqual(["Inspect runtime"]);
  });

  it("keeps failure and unknown outcomes visually distinct from live work", () => {
    expect(operatorEventTone("outcome-unknown")).toBe("danger");
    expect(operatorEventTone("agent-delegated")).toBe("info");
    expect(operatorEventTone("checkpoint-committed")).toBe("success");
  });

  it("renders the operator surface with truthful state rails and inspectable runline controls", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(ObjectiveOperator, {
      workspace: workspace({
        objective: { objectiveId: "objective-1", activeRevision: 2, statement: "Reach the objective.", state: "active" } as ObjectiveWorkspaceProjection["objective"],
        runline: [entry("agent-delegated", "Started the first task")],
        frontier: [{ status: "waiting-signal", label: "Wait for deployment", sourceState: "waiting", signalKey: "deployment-ready", blockedBy: [], attentionIds: [] } as unknown as ObjectiveWorkspaceProjection["frontier"][number]],
        eventCursor: 4,
      }),
    })));

    expect(html).toContain("Objective operator");
    expect(html).toContain("Runline");
    expect(html).toContain("Waiting");
    expect(html).toContain("Wait for deployment");
    expect(html).toContain("Search events, runs, subjects");
  });
});
