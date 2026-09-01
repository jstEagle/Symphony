import { describe, expect, it } from "vitest";
import type {
  ObjectiveApprovalRecord,
  ObjectiveCheckpointRecord,
  ObjectiveRunRecord,
  ObjectiveTaskRecord,
} from "../packages/protocol/src/index.js";
import type { EventEnvelope, ObjectivePlanRevisionRecord } from "../apps/web/src/lib/symphony/contracts.js";
import { projectObjectiveRun } from "../apps/web/src/lib/symphony/objective-project.js";
import { buildObjectiveRevisionTimeline } from "../apps/web/src/lib/symphony/objective-timeline.js";

const runId = "timeline-run";
const objectiveId = "timeline-objective";
const workflowId = "timeline-workflow";

function taskRecord(
  id: string,
  objective: string,
  dependsOn: string[] = [],
  overrides: Partial<Pick<ObjectiveTaskRecord, "state" | "attemptId" | "agentId" | "error">> = {},
): ObjectiveTaskRecord {
  return {
    task: {
      id,
      objective,
      dependsOn,
      outputSchema: {},
      model: "auto",
      harness: "auto",
      inputs: [],
      requiresApproval: id === "publish",
    },
    state: "queued",
    attemptId: null,
    agentId: null,
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const planOneTasks = [
  taskRecord("gather", "Gather inputs", [], { state: "completed", attemptId: "attempt-gather-1" }),
  taskRecord("shape", "Shape the result", ["gather"]),
];
const planTwoTasks = [
  taskRecord("gather", "Gather inputs", [], { state: "running", attemptId: "attempt-gather-2" }),
  taskRecord("shape", "Shape the result with a second pass", ["gather"], { state: "queued" }),
  taskRecord("publish", "Publish the verified output", ["shape"], { state: "waiting-approval" }),
];

function plan(planRevision: number, tasks: ObjectiveTaskRecord[], createdAt: string): ObjectivePlanRevisionRecord {
  return {
    version: 1,
    id: `plan-${planRevision}`,
    runId,
    objectiveId,
    workflowId,
    workflowRevision: 1,
    workflowHash: "timeline-workflow-hash",
    planRevision,
    tasks,
    createdBy: { type: "agent", id: "conductor" },
    requestKey: `plan-request-${planRevision}`,
    createdAt,
  };
}

const run: ObjectiveRunRecord = {
  version: 1,
  runId,
  objectiveId,
  workflowId,
  workflowRevision: 1,
  workflowHash: "timeline-workflow-hash",
  conductorAgentId: "conductor",
  spec: {
    id: objectiveId,
    statement: "Prove a dynamic plan can evolve.",
    criteria: [],
    approvalPolicy: { mode: "on-replan" },
    maxReplans: 4,
  },
  state: "awaiting-approval",
  activePlanRevision: 2,
  latestCheckpointId: "checkpoint-2",
  pendingApprovalId: "approval-2",
  replanCount: 1,
  tasks: planTwoTasks,
  context: {},
  output: null,
  error: null,
  requestKey: "run-request-key",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:03:00.000Z",
  startedAt: "2026-09-01T00:00:00.000Z",
  finishedAt: null,
};

const checkpoint: ObjectiveCheckpointRecord = {
  version: 1,
  id: "checkpoint-2",
  runId,
  objectiveId,
  sequence: 2,
  planRevision: 2,
  eventCursor: 8,
  context: {},
  taskStates: { gather: "running", shape: "queued", publish: "waiting-approval" },
  criteria: [],
  contextHash: "timeline-context-hash",
  reason: "Pause before publishing for a human decision.",
  createdBy: { type: "system", id: "objective-runtime" },
  requestKey: "checkpoint-request-2",
  createdAt: "2026-09-01T00:03:00.000Z",
};

const approval: ObjectiveApprovalRecord = {
  version: 1,
  id: "approval-2",
  runId,
  objectiveId,
  planRevision: 2,
  kind: "task",
  taskId: "publish",
  question: "May the output be published?",
  scope: {},
  operationId: "publish-operation",
  requestHash: "publish-request-hash",
  policyHash: "publish-policy-hash",
  sideEffectClass: "external",
  canonicalTarget: "https://example.test/output",
  expiresAt: "2026-09-01T01:00:00.000Z",
  requestedBy: { type: "agent", id: "conductor" },
  status: "requested",
  decision: null,
  decidedBy: null,
  requestedAt: "2026-09-01T00:03:00.000Z",
  resolvedAt: null,
  requestKey: "approval-request-2",
};

function event(cursor: number, type: string, payload: Record<string, string | number>): EventEnvelope {
  return {
    id: `event-${cursor}`,
    cursor,
    type,
    workflowId,
    runId,
    agentId: null,
    occurredAt: `2026-09-01T00:0${cursor}:00.000Z`,
    payload,
    provenance: { source: "workflow" },
  };
}

describe("objective revision timeline projection", () => {
  it("keeps revisions, dependency changes, retries, evidence, and attention gates legible for arbitrary task names", () => {
    const projection = projectObjectiveRun({
      run,
      planRevisions: [plan(2, planTwoTasks, "2026-09-01T00:03:00.000Z"), plan(1, planOneTasks, "2026-09-01T00:01:00.000Z")],
      checkpoints: [checkpoint],
      approvals: [approval],
      events: [
        event(1, "objective.task.dispatched", { taskId: "gather", attemptId: "attempt-gather-1" }),
        event(2, "objective.task.failed", { taskId: "gather", attemptId: "attempt-gather-1", error: "Transient worker loss" }),
        event(3, "objective.task.dispatched", { taskId: "gather", attemptId: "attempt-gather-2" }),
        event(4, "objective.plan.committed", { planRevision: 2, reason: "Replan after worker loss" }),
      ],
      asOf: "2026-09-01T00:04:00.000Z",
    });
    const timeline = buildObjectiveRevisionTimeline(projection);

    expect(timeline.map((entry) => entry.planRevision)).toEqual([1, 2]);
    expect(timeline[1]).toMatchObject({
      current: true,
      reason: "Replan after worker loss",
      addedTaskIds: ["publish"],
      changedTaskIds: ["gather", "shape"],
      pendingApprovalCount: 1,
      evidenceEventCount: 0,
    });
    expect(timeline[1]?.tasks.find((task) => task.id === "gather")).toMatchObject({
      state: "running",
      dependsOn: [],
      attemptIds: ["attempt-gather-1", "attempt-gather-2"],
      attemptCount: 2,
      retryCount: 1,
      frontier: true,
    });
    expect(timeline[1]?.tasks.find((task) => task.id === "publish")).toMatchObject({
      dependsOn: ["shape"],
      requiresApproval: true,
      frontier: true,
    });
    expect(timeline[1]?.approvals[0]?.isPending).toBe(true);
    expect(timeline[1]?.checkpoints[0]?.eventCursor).toBe(8);
  });

  it("does not let another run's immutable snapshots or events enter the timeline", () => {
    const projection = projectObjectiveRun({
      run,
      planRevisions: [plan(1, planOneTasks, "2026-09-01T00:01:00.000Z"), { ...plan(9, planOneTasks, "2026-09-01T00:09:00.000Z"), runId: "other-run" }],
      events: [event(1, "objective.task.dispatched", { taskId: "gather", attemptId: "attempt-gather-1" }), { ...event(2, "objective.task.dispatched", { taskId: "shape", attemptId: "other-attempt" }), runId: "other-run" }],
    });

    const timeline = buildObjectiveRevisionTimeline(projection);
    expect(timeline.map((entry) => entry.planRevision)).toEqual([1]);
    expect(timeline[0]?.tasks.find((task) => task.id === "shape")?.attemptIds).toEqual([]);
  });
});
