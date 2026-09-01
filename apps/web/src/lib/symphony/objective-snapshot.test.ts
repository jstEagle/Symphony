import { describe, expect, it } from "vitest";
import type { ObjectiveAggregateSnapshot } from "../../../../../packages/protocol/src/index.js";
import { projectObjectiveSnapshot } from "./objective-snapshot";

const asOf = "2026-09-01T12:00:00.000Z";

function snapshot(): ObjectiveAggregateSnapshot {
  return {
    version: 1,
    eventCursor: 12,
    objective: {
      version: 1,
      id: "objective:objective-1",
      objectiveId: "objective-1",
      activeRevision: 1,
      statement: "Ship the objective.",
      state: "active",
      latestRunId: "run-1",
      latestOutcome: "running",
      workspace: null,
      createdAt: asOf,
      updatedAt: asOf,
    },
    revisions: [],
    occurrences: [],
    runs: [{
      objectiveId: "objective-1",
      runId: "run-1",
      state: "running",
      updatedAt: asOf,
      output: null,
      error: null,
      tasks: [{ id: "deploy", objective: "Deploy", state: "running", attemptId: "attempt-1", agentId: "agent-1", output: null, error: null, startedAt: asOf, finishedAt: null }],
    }] as unknown as ObjectiveAggregateSnapshot["runs"],
    currentRuns: [{
      objectiveId: "objective-1",
      runId: "run-1",
      state: "running",
      updatedAt: asOf,
      output: null,
      error: null,
      tasks: [{ id: "deploy", objective: "Deploy", state: "running", attemptId: "attempt-1", agentId: "agent-1", output: null, error: null, startedAt: asOf, finishedAt: null }],
    }] as unknown as ObjectiveAggregateSnapshot["currentRuns"],
    plan: { heads: [], revisions: [], snapshots: [] },
    frontier: [],
    attempts: [],
    approvals: [],
    attentions: [],
    artifacts: [],
    artifactReviews: [],
    checkpoints: [],
    budgets: { ledgers: [], reservations: [], debits: [] },
    mutations: { control: [], plans: [] },
    suspensions: [],
    events: [{ id: "run-event-1", cursor: 12, type: "objective.agent.started", workflowId: null, runId: "run-1", agentId: "agent-1", occurredAt: asOf, payload: { agentId: "agent-1" } }],
  };
}

describe("objective snapshot adapter", () => {
  it("keeps aggregate identity and one event cursor across frontier and runline", () => {
    const projection = projectObjectiveSnapshot(snapshot());

    expect(projection.objectiveId).toBe("objective-1");
    expect(projection.eventCursor).toBe(12);
    expect(projection.frontier).toMatchObject([{ runId: "run-1", id: "deploy", status: "running" }]);
    expect(projection.runline).toMatchObject([{ runId: "run-1", type: "agent-delegated", cursor: 12 }]);
    expect(projection.frontier.every((item) => item.evidence.eventCursor <= projection.eventCursor)).toBe(true);
    expect(projection.runline.every((entry) => entry.evidence.eventCursor <= projection.eventCursor)).toBe(true);
  });
});
