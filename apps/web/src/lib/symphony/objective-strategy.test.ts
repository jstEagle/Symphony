import { describe, expect, it } from "vitest";
import { buildObjectiveStrategyViewModel, projectObjectiveStrategy, strategyStatusLabel, type ObjectiveStrategyReadyProjection } from "./objective-strategy";
import type { ObjectiveProjection } from "./objective-project";
import type { ObjectiveControlProjection } from "./contracts";

const agent = (id: string, state: "active" | "completed" = "completed") => ({
  kind: "agent" as const,
  id,
  label: id,
  objective: null,
  state,
  agentId: `agent-${id}`,
  harness: "codex",
  model: "model",
  attempt: 1,
  maxAttempts: 2,
  error: null,
});

const projection: ObjectiveStrategyReadyProjection = {
  kind: "ready",
  objectiveId: "obj-1",
  runId: "run-1",
  revision: 3,
  source: { kind: "workflow-revision", id: "workflow-1", revision: 2, hash: "abcdef" },
  roots: [
    { kind: "sequence", id: "sequence", label: "Main", state: "active", children: [agent("first"), { kind: "set", id: "answer", label: "Record answer", state: "completed", valueSummary: "context.answer = 42" }, { kind: "while", id: "loop", label: "Retry until green", state: "active", condition: "tests fail", iteration: 2, maxIterations: 4, exitReason: null, body: [agent("retry", "active")] }] },
    { kind: "if", id: "branch", label: "Choose path", state: "undecided", condition: "lint passes", selectedBranch: "then", then: [agent("then")], else: [agent("else")] },
  ],
  frontierIds: ["retry"],
  mutations: [
    { id: "m1", revision: 1, kind: "insert-node", summary: "Added first", createdAt: "2026-09-01T01:00:00Z", actor: "conductor" },
    { id: "m2", revision: 3, kind: "replace-node", summary: "Changed retry", createdAt: "2026-09-01T02:00:00Z", actor: "conductor" },
  ],
  updatedAt: "2026-09-01T02:00:00Z",
};

describe("objective strategy projection", () => {
  it("adapts only daemon plan revisions and keeps missing plans explicit", () => {
    const projection = {
      runId: "run-1",
      objectiveId: "objective-1",
      planRevision: 2,
      packets: [{
        id: "task-1",
        objective: "Verify release",
        state: "running",
        attemptId: "attempt-1",
        agentId: "agent-1",
        agent: { name: "Verifier", harness: "codex", model: "gpt-5.6", status: "running" },
        dependencies: [], blockedBy: [], requiresApproval: false, outputPresent: false, error: null,
        startedAt: null, finishedAt: null, latestEvent: null,
      }],
      frontier: [],
      planRevisions: [{
        version: 1,
        id: "plan-2",
        runId: "run-1",
        objectiveId: "objective-1",
        workflowId: "workflow-1",
        workflowRevision: 3,
        workflowHash: "workflow-hash",
        planRevision: 2,
        tasks: [{ task: {
          id: "task-1", objective: "Verify release", dependsOn: [], outputSchema: {}, model: "auto", harness: "auto",
          inputs: [], requiresApproval: false,
        }, state: "running", attemptId: "attempt-1", agentId: "agent-1", output: null, error: null, startedAt: null, finishedAt: null }],
        createdBy: { type: "user", id: "user-1" },
        requestKey: "request-key",
        createdAt: "2026-09-01T00:00:00.000Z",
      }],
    } as unknown as ObjectiveProjection;

    expect(projectObjectiveStrategy(projection)).toMatchObject({
      kind: "ready",
      revision: 2,
      source: { id: "workflow-1@3", hash: "workflow-hash" },
      roots: [{ kind: "agent", id: "task-1", state: "active", agentId: "agent-1", executionKey: "attempt-1" }],
    });
    expect(projectObjectiveStrategy({ ...projection, planRevisions: [] })).toMatchObject({ kind: "legacy-null", runId: "run-1" });
  });

  it("walks nested nodes in stable depth-first order and marks frontier", () => {
    const view = buildObjectiveStrategyViewModel(projection);
    if (view.kind !== "ready") throw new Error("expected ready projection");
    expect(view.rows.map((row) => row.id)).toEqual(["sequence", "first", "answer", "loop", "retry", "branch", "then", "else"]);
    expect(view.frontier.map((row) => row.id)).toEqual(["retry"]);
    expect(view.rows.find((row) => row.id === "retry")).toMatchObject({ depth: 2, parentId: "loop", iteration: 2 });
  });

  it("counts attention states without treating undecided branches as failures", () => {
    const view = buildObjectiveStrategyViewModel({ ...projection, roots: [{ kind: "if", id: "if", label: "if", state: "undecided", condition: null, selectedBranch: null, then: [], else: [] }] });
    if (view.kind !== "ready") throw new Error("expected ready projection");
    expect(view.counts).toEqual({ total: 1, active: 0, completed: 0, attention: 0, frontier: 0 });
  });

  it("sorts durable mutation history newest first", () => {
    const view = buildObjectiveStrategyViewModel(projection);
    if (view.kind !== "ready") throw new Error("expected ready projection");
    expect(view.mutations.map((mutation) => mutation.id)).toEqual(["m2", "m1"]);
  });

  it("preserves explicit empty, error, and legacy states", () => {
    expect(buildObjectiveStrategyViewModel({ kind: "empty" })).toEqual({ kind: "empty" });
    expect(buildObjectiveStrategyViewModel({ kind: "error", message: "offline", retryable: true })).toEqual({ kind: "error", message: "offline", retryable: true });
    expect(buildObjectiveStrategyViewModel({ kind: "legacy-null", runId: "run-1" })).toEqual({ kind: "legacy-null", runId: "run-1" });
  });

  it("uses human-readable state labels", () => {
    expect(strategyStatusLabel("idle")).toBe("ready");
    expect(strategyStatusLabel("undecided")).toBe("undecided");
  });

  it("projects durable evaluate results and loop context from a control snapshot", () => {
    const evaluateNode = {
      id: "score",
      sourceNodeId: "score",
      sourcePath: "steps.0",
      dependsOn: [],
      label: "Release quality",
      type: "evaluate",
      metric: "Release quality",
      path: "release.score",
      operator: "gte",
      target: 8,
    };
    const control = {
      runId: "run-control",
      objectiveId: "objective-control",
      planId: "control-plan",
      revision: {
        version: 1,
        planId: "control-plan",
        objectiveId: "objective-control",
        runId: "run-control",
        revision: 2,
        source: { kind: "workflow-revision", workflowId: "workflow-1", workflowRevision: 4, workflowHash: "workflow-hash" },
        plan: {
          version: 1,
          id: "control-plan",
          source: { kind: "workflow-revision", workflowId: "workflow-1", workflowRevision: 4, workflowHash: "workflow-hash" },
          root: { id: "root-control", sourceNodeId: "root-control", sourcePath: "root", dependsOn: [], label: "Release", type: "sequence", steps: [evaluateNode] },
          limits: { maxNodes: null, maxDepth: null, maxLoopIterations: null, maxConcurrentAgents: null },
        },
        hash: "control-hash",
        createdBy: { type: "user", id: "user-1" },
        requestKey: "control-plan-request",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
      snapshot: {
        version: 1,
        planId: "control-plan",
        objectiveId: "objective-control",
        runId: "run-control",
        planRevision: 2,
        sequence: 3,
        eventCursor: 4,
        nodeStates: { "root-control@root": "running", "score@root/root-control/score": "completed" },
        frontier: [],
        branches: {},
        loopIterations: {},
        exitReasons: {},
        attemptIds: { "root-control@root": null, "score@root/root-control/score": null },
        executions: [
          { key: { nodeId: "root-control", iterationKey: "root" }, state: "running", attemptId: null, agentId: null, output: null, error: null, startedAt: null, finishedAt: null, contextRefs: [] },
          { key: { nodeId: "score", iterationKey: "root/root-control/score" }, state: "completed", attemptId: null, agentId: null, output: { actual: 9, target: 8, operator: "gte", pass: true }, error: null, startedAt: null, finishedAt: "2026-09-01T00:00:01.000Z", contextRefs: [] },
        ],
        context: { release: { score: 9 } },
        contextRefs: [],
        reason: "fixture",
        createdAt: "2026-09-01T00:00:01.000Z",
      },
    } as unknown as ObjectiveControlProjection;
    const projection = {
      runId: "run-control",
      objectiveId: "objective-control",
      planRevision: 2,
      planRevisions: [],
      packets: [],
      frontier: [],
      control,
    } as unknown as ObjectiveProjection;

    const projected = projectObjectiveStrategy(projection);
    expect(projected).toMatchObject({ kind: "ready", revision: 2, source: { id: "workflow-1@4" }, roots: [{ kind: "evaluate", metric: "Release quality", path: "release.score", target: 8, actual: 9, pass: true }] });
    if (projected.kind !== "ready") throw new Error("expected ready projection");
    const view = buildObjectiveStrategyViewModel(projected);
    if (view.kind !== "ready") throw new Error("expected ready view model");
    expect(view.rows).toMatchObject([{ id: "score", kind: "evaluate", state: "completed" }]);
  });

  it("keeps repeated loop executions distinct when node IDs are reused", () => {
    const repeated = { ...agent("retry", "completed"), executionKey: "loop.1.retry", iterationPath: [1] };
    const view = buildObjectiveStrategyViewModel({ ...projection, roots: [repeated, { ...repeated, executionKey: "loop.2.retry", iterationPath: [2] }] });
    if (view.kind !== "ready") throw new Error("expected ready projection");
    expect(view.rows.map((row) => row.key)).toEqual(["loop.1.retry", "loop.2.retry"]);
    expect(view.rows.map((row) => row.iterationPath)).toEqual([[1], [2]]);
  });
});
