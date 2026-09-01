import { describe, expect, it } from "vitest";
import type {
  ObjectiveApprovalRecord,
  ObjectiveCheckpointRecord,
  ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import type { AgentRecord, EventEnvelope } from "../apps/web/src/lib/symphony/contracts.js";
import { projectObjectiveRun } from "../apps/web/src/lib/symphony/objective-project.js";

const baseRun: ObjectiveRunRecord = {
  version: 1,
  runId: "objective-run-1",
  objectiveId: "objective-1",
  workflowId: "workflow-1",
  workflowRevision: 2,
  workflowHash: "workflow-hash-1",
  conductorAgentId: "agent-conductor",
  spec: {
    id: "objective-1",
    statement: "Ship the objective with evidence.",
    criteria: [
      { id: "tests", description: "Tests pass", path: "checks.tests", op: "equals", value: true, required: true },
      { id: "docs", description: "Docs are updated", path: "checks.docs", op: "exists", required: false },
    ],
    approvalPolicy: { mode: "on-replan" },
    maxReplans: 3,
  },
  state: "executing",
  activePlanRevision: 1,
  latestCheckpointId: "checkpoint-1",
  pendingApprovalId: "approval-1",
  replanCount: 1,
  tasks: [
    {
      task: {
        id: "implement",
        objective: "Implement the change.",
        dependsOn: [],
        outputSchema: {},
        model: "auto",
        harness: "auto",
        inputs: [],
        requiresApproval: false,
      },
      state: "completed",
      attemptId: "attempt-1",
      agentId: "agent-implement",
      output: { changed: true },
      error: null,
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:01:00.000Z",
    },
    {
      task: {
        id: "verify",
        objective: "Verify the result.",
        dependsOn: ["implement"],
        outputSchema: {},
        model: "auto",
        harness: "auto",
        inputs: [],
        requiresApproval: true,
      },
      state: "waiting-approval",
      attemptId: null,
      agentId: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    },
    {
      task: {
        id: "publish",
        objective: "Publish after verification.",
        dependsOn: ["verify"],
        outputSchema: {},
        model: "auto",
        harness: "auto",
        inputs: [],
        requiresApproval: false,
      },
      state: "queued",
      attemptId: null,
      agentId: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
  context: {},
  output: null,
  error: null,
  requestKey: "objective-request-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:01:00.000Z",
  startedAt: "2026-09-01T00:00:00.000Z",
  finishedAt: null,
};

const checkpoint: ObjectiveCheckpointRecord = {
  version: 1,
  id: "checkpoint-1",
  runId: baseRun.runId,
  objectiveId: baseRun.objectiveId,
  sequence: 1,
  planRevision: 1,
  eventCursor: 12,
  context: { checks: { tests: true } },
  taskStates: { implement: "completed", verify: "waiting-approval" },
  criteria: [{
    criterionId: "tests",
    passed: true,
    actual: true,
    expected: true,
    evidenceEventIds: ["event-12"],
    evaluatedAt: "2026-09-01T00:01:00.000Z",
  }],
  contextHash: "context-hash-1",
  reason: "Implementation is complete; verification needs approval.",
  createdBy: { type: "agent", id: "agent-conductor" },
  requestKey: "checkpoint-request-1",
  createdAt: "2026-09-01T00:01:00.000Z",
};

const approval: ObjectiveApprovalRecord = {
  version: 1,
  id: "approval-1",
  runId: baseRun.runId,
  objectiveId: baseRun.objectiveId,
  planRevision: 1,
  kind: "task",
  taskId: "verify",
  question: "May verification run?",
  scope: {},
  operationId: "operation-verify",
  requestHash: "request-hash-verify",
  policyHash: "policy-hash-verify",
  sideEffectClass: "local",
  canonicalTarget: "objective://objective-1/task/verify",
  requestedBy: { type: "agent", id: "agent-conductor" },
  status: "requested",
  decision: null,
  decidedBy: null,
  requestedAt: "2026-09-01T00:01:00.000Z",
  expiresAt: null,
  resolvedAt: null,
  requestKey: "approval-request-1",
};

function event(runId: string, cursor: number, taskId?: string): EventEnvelope {
  return {
    id: `event-${cursor}`,
    cursor,
    type: "objective.task.started",
    workflowId: "workflow-1",
    runId,
    agentId: null,
    occurredAt: `2026-09-01T00:00:${String(cursor).padStart(2, "0")}.000Z`,
    payload: taskId ? { taskId, summary: "Task advanced." } : { summary: "Run advanced." },
    provenance: { source: "workflow" },
  };
}

describe("objective run projection", () => {
  it("projects mission facts, dependency packets, and only ready frontier work", () => {
    const projection = projectObjectiveRun({ run: baseRun, checkpoints: [checkpoint], approvals: [approval] });

    expect(projection.mission).toMatchObject({
      statement: "Ship the objective with evidence.",
      revision: 2,
      hash: "workflow-hash-1",
    });
    expect(projection.frontier.map((packet) => packet.id)).toEqual(["verify"]);
    expect(projection.packets.find((packet) => packet.id === "publish")?.blockedBy).toEqual(["verify"]);
    expect(projection.packets.find((packet) => packet.id === "verify")?.dependencies).toEqual([
      { id: "implement", satisfied: true, state: "completed" },
    ]);
    expect(projection.pendingApproval?.question).toBe("May verification run?");
    expect(projection.pendingApproval).toMatchObject({
      operationId: "operation-verify",
      requestHash: "request-hash-verify",
      policyHash: "policy-hash-verify",
      sideEffectClass: "local",
      canonicalTarget: "objective://objective-1/task/verify",
      isExpired: false,
      isPending: true,
    });
    expect(projection.progress).toMatchObject({ completed: 1, total: 3, active: 0, blocked: 0, pendingApproval: 1 });
  });

  it("keeps events, approvals, and checkpoints scoped to the exact objective run", () => {
    const projection = projectObjectiveRun({
      run: baseRun,
      checkpoints: [checkpoint, { ...checkpoint, id: "other-checkpoint", runId: "other-run", sequence: 2 }],
      approvals: [approval, { ...approval, id: "other-approval", runId: "other-run" }],
      events: [event(baseRun.runId, 12, "implement"), event("other-run", 13, "verify")],
    });

    expect(projection.events.map((item) => item.id)).toEqual(["event-12"]);
    expect(projection.approvals.map((item) => item.id)).toEqual(["approval-1"]);
    expect(projection.checkpoints.map((item) => item.id)).toEqual(["checkpoint-1"]);
    expect(projection.evidence).toMatchObject({ eventCursor: 12, eventCount: 1, checkpointCount: 1, linkedEventCount: 1 });
    expect(projection.packets.find((packet) => packet.id === "implement")?.latestEvent?.taskId).toBe("implement");
  });

  it("surfaces durable error and terminal state without inventing empty cards", () => {
    const projection = projectObjectiveRun({
      run: { ...baseRun, state: "failed", error: "Verification failed.", output: { reason: "tests" } },
      checkpoints: [],
      approvals: [],
      events: [],
    });

    expect(projection.terminal).toBe(true);
    expect(projection.error).toBe("Verification failed.");
    expect(projection.terminalReason).toBe("Verification failed.");
    expect(projection.output).toEqual({ reason: "tests" });
    expect(projection.checkpoints).toEqual([]);
    expect(projection.approvals).toEqual([]);
    expect(projection.events).toEqual([]);
  });

  it("uses the latest checkpoint for criterion status and records linked evidence", () => {
    const later = {
      ...checkpoint,
      id: "checkpoint-2",
      sequence: 2,
      eventCursor: 20,
      criteria: checkpoint.criteria.map((criterion) => ({ ...criterion, passed: false, actual: false, evidenceEventIds: ["event-20"] })),
      createdAt: "2026-09-01T00:02:00.000Z",
    };
    const projection = projectObjectiveRun({ run: baseRun, checkpoints: [later, checkpoint], events: [event(baseRun.runId, 20)] });

    expect(projection.latestCheckpoint?.id).toBe("checkpoint-2");
    expect(projection.mission.criteria.find((criterion) => criterion.id === "tests")).toMatchObject({ passed: false, actual: false });
    expect(projection.evidence).toMatchObject({ eventCursor: 20, linkedEventCount: 1 });
  });

  it("removes expired approvals from the pending decision inbox while preserving their identity", () => {
    const expiringApproval: ObjectiveApprovalRecord = {
      ...approval,
      id: "approval-expiring",
      operationId: "operation-expiring",
      sideEffectClass: "external",
      canonicalTarget: "https://example.test/deploy",
      expiresAt: "2026-09-01T00:02:00.000Z",
      requestKey: "approval-request-expiring",
    };
    const projection = projectObjectiveRun({
      run: { ...baseRun, pendingApprovalId: expiringApproval.id },
      approvals: [expiringApproval],
      asOf: "2026-09-01T00:03:00.000Z",
    });

    expect(projection.approvals[0]).toMatchObject({
      id: "approval-expiring",
      operationId: "operation-expiring",
      sideEffectClass: "external",
      expiresAt: "2026-09-01T00:02:00.000Z",
      isExpired: true,
      isPending: false,
    });
    expect(projection.pendingApproval).toBeNull();
    expect(projection.progress.pendingApproval).toBe(0);
  });

  it("can enrich packets with their durable agent identity without changing task state", () => {
    const agent = {
      id: "agent-implement",
      objective: "Implementation worker",
      requestedHarness: "codex",
      requestedModel: "gpt-test",
      harness: "codex",
      model: "gpt-test",
      status: "completed",
    } as AgentRecord;
    const projection = projectObjectiveRun({ run: baseRun, agents: [agent] });

    expect(projection.packets.find((packet) => packet.id === "implement")?.agent).toMatchObject({
      name: "Implementation worker",
      harness: "codex",
      model: "gpt-test",
      status: "completed",
    });
    expect(projection.packets.find((packet) => packet.id === "implement")?.state).toBe("completed");
  });
});
