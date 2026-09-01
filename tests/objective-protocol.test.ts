import { describe, expect, it } from "vitest";
import {
  ObjectiveApprovalRecordSchema,
  ObjectiveApprovalIdentitySchema,
  ObjectiveCheckpointRecordSchema,
  ObjectiveCriterionSchema,
  ObjectiveRunRecordSchema,
  ObjectiveSpecSchema,
  ObjectiveTaskSchema,
} from "../packages/protocol/src/index.js";

const criterion = {
  id: "tests-pass",
  description: "The verification suite passes.",
  path: "verification.passed",
  op: "equals" as const,
  value: true,
};

const task = {
  id: "implement",
  objective: "Implement the requested change and return a typed result.",
  dependsOn: [],
  outputSchema: { type: "object" },
  model: "auto",
  harness: "auto" as const,
  inputs: [],
  requiresApproval: false,
};

const taskRecord = {
  task,
  state: "queued" as const,
  attemptId: null,
  agentId: null,
  output: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

const run = {
  version: 1 as const,
  runId: "run-1",
  objectiveId: "objective-1",
  workflowId: "workflow-1",
  workflowRevision: 1,
  workflowHash: "workflow-hash-1",
  conductorAgentId: "conductor-1",
  spec: {
    id: "objective-1",
    statement: "Ship the change and prove it works.",
    criteria: [criterion],
    approvalPolicy: { mode: "on-replan" as const },
    maxReplans: 3,
  },
  state: "executing" as const,
  activePlanRevision: 0,
  latestCheckpointId: null,
  pendingApprovalId: null,
  replanCount: 0,
  tasks: [taskRecord],
  context: {},
  output: null,
  error: null,
  requestKey: "objective-request-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  startedAt: "2026-09-01T00:00:00.000Z",
  finishedAt: null,
};

const approvalInput = {
  version: 1 as const,
  id: "approval-1",
  runId: "run-1",
  objectiveId: "objective-1",
  planRevision: 1,
  kind: "task" as const,
  taskId: "implement",
  question: "May this task use full workspace access?",
  scope: { permission: "full-access" },
  operationId: "operation-1",
  requestHash: "request-hash-1",
  policyHash: "policy-hash-1",
  sideEffectClass: "local" as const,
  canonicalTarget: "workspace:/repo",
  requestedBy: { type: "agent" as const, id: "conductor-1" },
  status: "requested" as const,
  requestedAt: "2026-09-01T00:00:00.000Z",
  requestKey: "approval-request-1",
};
const approval = ObjectiveApprovalRecordSchema.parse(approvalInput);

describe("Objective Runtime protocol", () => {
  it("parses bounded objective intent and applies safe defaults", () => {
    expect(ObjectiveSpecSchema.parse({ id: "objective-1", statement: "Ship it." })).toMatchObject({
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 8,
    });
    expect(ObjectiveCriterionSchema.parse(criterion)).toMatchObject({ required: true });
    expect(ObjectiveTaskSchema.parse({ id: "task-1", objective: "Do one thing." })).toMatchObject({
      dependsOn: [],
      model: "auto",
      harness: "auto",
      inputs: [],
      requiresApproval: false,
    });
  });

  it("rejects duplicate criterion ids and unknown external fields", () => {
    expect(() => ObjectiveSpecSchema.parse({
      id: "objective-1",
      statement: "Ship it.",
      criteria: [criterion, { ...criterion, description: "Same id." }],
    })).toThrow(/Duplicate objective criterion id/);
    expect(() => ObjectiveCriterionSchema.parse({ ...criterion, authorAgentId: "forged" })).toThrow();
  });

  it("rejects duplicate dependencies, self-dependencies, and duplicate task ids", () => {
    expect(() => ObjectiveRunRecordSchema.parse({
      ...run,
      tasks: [{
        ...taskRecord,
        task: { ...task, id: "a", dependsOn: ["b", "b"] },
      }, {
        ...taskRecord,
        task: { ...task, id: "b", dependsOn: ["b"] },
      }, {
        ...taskRecord,
        task: { ...task, id: "a" },
      }],
    })).toThrow(/Duplicate dependency|cannot depend on itself|Duplicate objective task id/);
  });

  it("rejects dangling dependencies and bounded dependency cycles", () => {
    expect(() => ObjectiveRunRecordSchema.parse({
      ...run,
      tasks: [{
        ...taskRecord,
        task: { ...task, id: "a", dependsOn: ["missing"] },
      }],
    })).toThrow(/depends on unknown task/);

    expect(() => ObjectiveRunRecordSchema.parse({
      ...run,
      tasks: [{
        ...taskRecord,
        task: { ...task, id: "a", dependsOn: ["b"] },
      }, {
        ...taskRecord,
        task: { ...task, id: "b", dependsOn: ["a"] },
      }],
    })).toThrow(/dependency cycle detected/);
  });

  it("captures evidence-linked checkpoints and immutable actor identity", () => {
    const checkpoint = ObjectiveCheckpointRecordSchema.parse({
      version: 1,
      id: "checkpoint-1",
      runId: "run-1",
      objectiveId: "objective-1",
      sequence: 1,
      planRevision: 0,
      eventCursor: 42,
      context: { verification: { passed: true } },
      taskStates: { implement: "completed" },
      criteria: [{
        criterionId: "tests-pass",
        passed: true,
        actual: true,
        expected: true,
        evidenceEventIds: ["event-42"],
        evaluatedAt: "2026-09-01T00:00:00.000Z",
      }],
      contextHash: "context-hash-1",
      reason: "The implementation and verification boundary is complete.",
      createdBy: { type: "agent", id: "conductor-1" },
      requestKey: "checkpoint-request-1",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(checkpoint).toMatchObject({ eventCursor: 42, taskStates: { implement: "completed" } });
    expect(() => ObjectiveCheckpointRecordSchema.parse({
      ...checkpoint,
      createdBy: { type: "agent", id: "conductor-1", forged: true },
    })).toThrow();
  });

  it("binds task approvals to a task and keeps other approval scopes task-free", () => {
    expect(approval).toMatchObject({ taskId: "implement", status: "requested", decision: null });
    expect(() => ObjectiveApprovalRecordSchema.parse({
      ...approval,
      taskId: null,
    })).toThrow(/must identify a task/);
    expect(() => ObjectiveApprovalRecordSchema.parse({
      ...approval,
      kind: "completion",
    })).toThrow(/Only task approvals/);
  });

  it("requires immutable operation identity and expiry for external or irreversible work", () => {
    const external = ObjectiveApprovalRecordSchema.parse({
      ...approval,
      sideEffectClass: "external",
      expiresAt: "2026-09-01T01:00:00.000Z",
    });
    const identity = {
      operationId: external.operationId,
      requestHash: external.requestHash,
      policyHash: external.policyHash,
      sideEffectClass: external.sideEffectClass,
      canonicalTarget: external.canonicalTarget,
      expiresAt: external.expiresAt,
    };
    expect(ObjectiveApprovalIdentitySchema.parse(identity)).toMatchObject({
      operationId: "operation-1",
      requestHash: "request-hash-1",
      policyHash: "policy-hash-1",
      sideEffectClass: "external",
      canonicalTarget: "workspace:/repo",
      expiresAt: "2026-09-01T01:00:00.000Z",
    });
    expect(() => ObjectiveApprovalRecordSchema.parse({
      ...approval,
      sideEffectClass: "irreversible",
    })).toThrow(/expiry is required/);
    expect(() => ObjectiveApprovalRecordSchema.parse({
      ...approval,
      operationId: undefined,
    })).toThrow();

    // A replay with the same operation ID but a changed hash/target is a
    // distinct identity; the durable owner must reject it rather than reuse
    // the original decision.
    const replayMismatch = ObjectiveApprovalIdentitySchema.parse({
      ...identity,
      requestHash: "different-request-hash",
      canonicalTarget: "workspace:/other-repo",
    });
    expect(replayMismatch.operationId).toBe(external.operationId);
    expect(replayMismatch.requestHash).not.toBe(external.requestHash);
    expect(replayMismatch.canonicalTarget).not.toBe(external.canonicalTarget);
    expect(replayMismatch).not.toEqual(identity);
  });
});
