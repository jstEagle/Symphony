import { describe, expect, it } from "vitest";
import {
  projectObjectiveAggregateSnapshot,
  projectObjectiveFrontier,
  projectObjectiveRunline,
  projectObjectiveWorkspace,
} from "./objective-frontier.js";

const asOf = "2026-09-01T12:00:00.000Z";

function input(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    objectiveId: "objective-1",
    runId: "run-1",
    asOf,
    eventCursor: 20,
    ...overrides,
  };
}

function suspension(kind: "timer" | "signal", nodeId: string, iterationKey = "root") {
  return kind === "timer"
    ? {
      version: 1 as const,
      objectiveId: "objective-1",
      runId: "run-1",
      nodeId,
      execution: { nodeId, iterationKey },
      attemptId: "attempt-" + nodeId,
      since: "2026-09-01T11:00:00.000Z",
      expiresAt: null,
      status: "waiting" as const,
      terminalReason: null,
      settledAt: null,
      kind,
      dueAt: "2026-09-01T13:00:00.000Z",
    }
    : {
      version: 1 as const,
      objectiveId: "objective-1",
      runId: "run-1",
      nodeId,
      execution: { nodeId, iterationKey },
      attemptId: "attempt-" + nodeId,
      since: "2026-09-01T11:00:00.000Z",
      expiresAt: null,
      status: "waiting" as const,
      terminalReason: null,
      settledAt: null,
      kind,
      signalKey: "deployment.health",
      subscriptionKey: "subscription-" + nodeId,
      deliveryId: null,
      deliveredAt: null,
      payload: null,
    };
}

describe("objective frontier projection", () => {
  it("merges legacy tasks and attempts, preserving retry lineage and dependency truth", () => {
    const projection = projectObjectiveFrontier(input({
      tasks: [
        { id: "build", objective: "Build", dependsOn: [], state: "completed", attemptId: "build-2", agentId: null, output: {}, error: null, startedAt: asOf, finishedAt: asOf },
        { id: "verify", objective: "Verify", dependsOn: ["build"], state: "queued", attemptId: null, agentId: null, output: null, error: null, startedAt: null, finishedAt: null },
        { id: "publish", objective: "Publish", dependsOn: ["verify"], state: "queued" },
      ],
      attempts: [
        { id: "build-1", runId: "run-1", stepId: "build", iterationKey: "root", attempt: 1, status: "failed", input: {}, output: null, error: "flaky", idempotencyKey: "attempt-build-1", startedAt: asOf, updatedAt: asOf, finishedAt: asOf },
        { id: "build-2", runId: "run-1", stepId: "build", iterationKey: "root", attempt: 2, status: "completed", input: { agentId: "agent-build" }, output: {}, error: null, idempotencyKey: "attempt-build-2", startedAt: asOf, updatedAt: asOf, finishedAt: asOf },
      ],
    }));

    expect(projection.items.map((item) => [item.id, item.status])).toEqual([
      ["build", "completed"],
      ["publish", "blocked-dependency"],
      ["verify", "runnable"],
    ]);
    expect(projection.items.find((item) => item.id === "build")?.attemptLineage.map((item) => item.attemptId)).toEqual(["build-1", "build-2"]);
    expect(projection.items.find((item) => item.id === "build")?.attemptLineage[1]?.replacementOf).toBe("build-1");
    expect(projection.summary).not.toContain("%");
  });

  it("keeps a zero-active run healthy while waiting on timer, signal, and attention", () => {
    const projection = projectObjectiveFrontier(input({
      runState: "waiting",
      controlExecutions: [
        { key: { nodeId: "timer", iterationKey: "root" }, state: "waiting", attemptId: "attempt-timer", agentId: null, output: null, error: null, startedAt: null, finishedAt: null, contextRefs: [] },
        { key: { nodeId: "signal", iterationKey: "root" }, state: "waiting", attemptId: "attempt-signal", agentId: null, output: null, error: null, startedAt: null, finishedAt: null, contextRefs: [] },
      ],
      suspensions: [suspension("timer", "timer"), suspension("signal", "signal")],
      approvals: [{ id: "approval-1", runId: "run-1", taskId: "approval-task", status: "requested" }],
      tasks: [{ id: "approval-task", objective: "Approve", state: "queued" }],
    }));

    expect(projection.state).toBe("waiting");
    expect(projection.counts.running).toBe(0);
    expect(projection.items.find((item) => item.id === "timer@root")?.status).toBe("waiting-timer");
    expect(projection.items.find((item) => item.id === "signal@root")?.status).toBe("waiting-signal");
    expect(projection.items.find((item) => item.id === "approval-task")?.status).toBe("waiting-attention");
    expect(projection.summary).toContain("waiting");
    expect(projection.summary).not.toContain("%");
  });

  it("keeps unknown native outcomes unknown until reconciliation is durable", () => {
    const unknown = { id: "unknown-1", taskId: "deploy", attemptId: "deploy-1", reason: "Native receipt was lost", nativeEventId: null, reconciliationId: "reconcile-1" };
    const pending = projectObjectiveFrontier(input({ tasks: [{ id: "deploy", objective: "Deploy", state: "running", attemptId: "deploy-1" }], unknownOutcomes: [unknown], reconciliations: [{ id: "reconcile-1", unknownOutcomeId: "unknown-1", status: "pending", reason: "Query provider" }] }));
    expect(pending.items[0]?.status).toBe("outcome-unknown");
    expect(pending.state).toBe("outcome-unknown");

    const matched = projectObjectiveFrontier(input({ tasks: [{ id: "deploy", objective: "Deploy", state: "queued", attemptId: null }], unknownOutcomes: [unknown], reconciliations: [{ id: "reconcile-1", unknownOutcomeId: "unknown-1", status: "matched", reason: "Provider says no receipt" }] }));
    expect(matched.items[0]?.status).toBe("runnable");
  });

  it("uses execution-scoped identities for loop iterations and does not invent branch progress", () => {
    const projection = projectObjectiveFrontier(input({
      controlExecutions: [
        { key: { nodeId: "branch", iterationKey: "root" }, state: "completed", attemptId: null, agentId: null, output: { selected: "then" }, error: null, startedAt: null, finishedAt: asOf, contextRefs: [] },
        { key: { nodeId: "loop-work", iterationKey: "root/loop:1" }, state: "completed", attemptId: "loop-1", agentId: "a1", output: {}, error: null, startedAt: null, finishedAt: asOf, contextRefs: [] },
        { key: { nodeId: "loop-work", iterationKey: "root/loop:2" }, state: "running", attemptId: "loop-2", agentId: "a2", output: null, error: null, startedAt: asOf, finishedAt: null, contextRefs: [] },
      ],
    }));
    expect(projection.items.map((item) => item.id)).toEqual(["branch@root", "loop-work@root/loop:1", "loop-work@root/loop:2"]);
    expect(projection.items.find((item) => item.id === "loop-work@root/loop:2")?.status).toBe("running");
  });
});

describe("objective semantic runline", () => {
  it("maps semantic events, drops transcript deltas, collapses repeats, and scopes stale records", () => {
    const base = input({ events: [
      { id: "foreign", cursor: 1, runId: "other-run", type: "objective.task.started", payload: { taskId: "stale", summary: "stale" }, occurredAt: asOf },
      { id: "start-1", cursor: 2, runId: "run-1", type: "objective.agent.started", payload: { agentId: "agent-1", summary: "Agent started" }, occurredAt: asOf },
      { id: "delta-1", cursor: 3, runId: "run-1", type: "driver.message.delta", payload: { agentId: "agent-1", summary: "token" }, occurredAt: asOf },
      { id: "start-2", cursor: 4, runId: "run-1", type: "objective.agent.started", payload: { agentId: "agent-1", summary: "Agent started" }, occurredAt: asOf },
      { id: "branch-1", cursor: 5, runId: "run-1", type: "objective.branch.selected", payload: { nodeId: "branch", summary: "then branch" }, occurredAt: asOf },
      { id: "eval-1", cursor: 6, runId: "run-1", type: "objective.evaluation.completed", payload: { nodeId: "eval", summary: "score" }, occurredAt: asOf },
    ] });
    const projection = projectObjectiveRunline(base);
    expect(projection.entries.map((entry) => entry.type)).toEqual(["agent-delegated", "branch-selected", "evaluation"]);
    expect(projection.entries[0]?.collapsedCount).toBe(2);
    expect(projection.entries.some((entry) => entry.evidence.eventIds.includes("foreign"))).toBe(false);
  });

  it("includes retry, unknown, reconciliation, artifact/checkpoint, and loop evidence as typed entries", () => {
    const projection = projectObjectiveRunline(input({
      controlExecutions: [{ key: { nodeId: "loop-work", iterationKey: "root/loop:3" }, state: "running", attemptId: "loop-3", agentId: "agent-3", output: null, error: null, startedAt: asOf, finishedAt: null, contextRefs: [] }],
      retries: [{ id: "retry-1", executionId: "loop-work@root/loop:3", retryAt: "2026-09-02T00:00:00.000Z", reason: "Backoff" }],
      unknownOutcomes: [{ id: "unknown-1", executionId: "loop-work@root/loop:3", attemptId: "loop-3", reason: "No native receipt" }],
      reconciliations: [{ id: "reconcile-1", unknownOutcomeId: "unknown-1", status: "pending", reason: "Still checking" }],
      events: [{ id: "loop-1", cursor: 21, type: "objective.loop.iteration", payload: { executionId: "loop-work@root/loop:3", summary: "iteration 3" }, occurredAt: asOf }],
    }));
    expect(projection.entries.map((entry) => entry.type)).toEqual(["loop-iteration", "reconciliation", "outcome-unknown", "retry-scheduled"]);
    expect(projection.entries.find((entry) => entry.type === "outcome-unknown")?.attemptLineage[0]?.attemptId).toBe("loop-3");
  });

  it("is deterministic across replay/restart and validates strict output", () => {
    const value = input({ tasks: [{ id: "a", objective: "A", state: "completed" }], events: [{ id: "event-a", cursor: 9, type: "objective.task.completed", payload: { taskId: "a" }, occurredAt: asOf }] });
    const first = projectObjectiveWorkspace(value);
    const second = projectObjectiveWorkspace(JSON.parse(JSON.stringify(value)));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.frontier.items.every((item) => Object.keys(item).every((key) => key !== "progress" && key !== "percentage"))).toBe(true);
  });

  it("projects every run from one fenced aggregate cursor, including waits and unknown outcomes", () => {
    const snapshot = {
      objective: { objectiveId: "objective-1", updatedAt: asOf },
      eventCursor: 42,
      runs: [
        {
          objectiveId: "objective-1", runId: "run-z", state: "waiting", updatedAt: asOf,
          output: null, error: null,
          tasks: [],
        },
        {
          objectiveId: "objective-1", runId: "run-a", state: "running", updatedAt: asOf,
          output: null, error: null,
          tasks: [{ id: "deploy", objective: "Deploy", state: "running", attemptId: "deploy-1", agentId: "agent-a", output: null, error: null, startedAt: asOf, finishedAt: null }],
        },
      ],
      attempts: [{
        id: "deploy-1", runId: "run-a", stepId: "deploy", iterationKey: "root", attempt: 1,
        status: "running", input: {}, output: null, error: null, idempotencyKey: "attempt-deploy-1",
        startedAt: asOf, updatedAt: asOf, finishedAt: null,
      }],
      suspensions: [{
        version: 1, objectiveId: "objective-1", runId: "run-z", nodeId: "timer",
        execution: { nodeId: "timer", iterationKey: "root" }, attemptId: "timer-1",
        since: asOf, expiresAt: null, status: "waiting", terminalReason: null, settledAt: null,
        kind: "timer", dueAt: "2026-09-01T13:00:00.000Z",
      }],
      plan: {
        snapshots: [{
          version: 1, planId: "plan-z", objectiveId: "objective-1", runId: "run-z", planRevision: 0,
          sequence: 1, eventCursor: 42, nodeStates: { "timer@root": "waiting" },
          frontier: [{ nodeId: "timer", iterationKey: "root" }], branches: {}, loopIterations: {},
          exitReasons: {}, attemptIds: { "timer@root": "timer-1" }, executions: [{
            key: { nodeId: "timer", iterationKey: "root" }, state: "waiting", attemptId: "timer-1",
            agentId: null, output: null, error: null, startedAt: null, finishedAt: null, contextRefs: [],
            suspension: {
              version: 1, objectiveId: "objective-1", runId: "run-z", nodeId: "timer",
              execution: { nodeId: "timer", iterationKey: "root" }, attemptId: "timer-1",
              since: asOf, expiresAt: null, status: "waiting", terminalReason: null, settledAt: null,
              kind: "timer", dueAt: "2026-09-01T13:00:00.000Z",
            },
          }], cancellations: [], context: {}, contextRefs: [], reason: "waiting", createdAt: asOf,
        }],
      },
      unknownOutcomes: [{
        id: "unknown-deploy", runId: "run-a", taskId: "deploy", attemptId: "deploy-1",
        reason: "Native receipt was lost", nativeEventId: null, reconciliationId: "reconcile-deploy",
      }],
      reconciliations: [{
        id: "reconcile-deploy", runId: "run-a", unknownOutcomeId: "unknown-deploy", status: "pending",
        attemptId: "deploy-1", nativeEventId: null, reason: "Provider lookup pending",
      }],
      events: [],
    };
    const first = projectObjectiveAggregateSnapshot(snapshot);
    const second = projectObjectiveAggregateSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(first.frontierProjection.eventCursor).toBe(42);
    expect(first.runline.eventCursor).toBe(42);
    expect(first.frontierProjection.runs.map((entry) => entry.runId)).toEqual(["run-a", "run-z"]);
    expect(first.frontierProjection.frontier.find((item) => item.runId === "run-z")?.status).toBe("waiting-timer");
    expect(first.frontierProjection.frontier.find((item) => item.runId === "run-a")?.status).toBe("outcome-unknown");
    expect(first.frontierProjection.state).toBe("outcome-unknown");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
