import { describe, expect, it } from "vitest";
import {
  ObjectiveControlPlanRevisionSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlPlanSnapshotSchema,
  ObjectiveControlNodeSchema,
  ObjectiveControlFanoutAcknowledgementSchema,
  ObjectiveControlFanoutExecutionMetadataSchema,
  ObjectiveControlFanoutIntentSchema,
  ObjectiveControlFanoutMaterializationSchema,
  applyObjectiveControlMutation,
  objectiveControlExecutionId,
  objectiveControlFanoutItemExecutionKey,
  type ObjectiveControlExecutionRecord,
  type ObjectiveControlPlan,
  type ObjectiveControlPlanRevision,
  type ObjectiveControlPlanSnapshot,
  type ObjectiveControlSource,
  validateObjectiveControlSnapshotAgainstPlan,
} from "./objective-control.js";

const source: ObjectiveControlSource = {
  kind: "conductor-authored",
  authorAgentId: "conductor-1",
  sessionId: "session-1",
};

function node(id: string, type: "agent" | "set" = "agent") {
  return type === "agent"
    ? {
        id,
        sourceNodeId: id,
        sourcePath: id,
        dependsOn: [],
        type: "agent" as const,
        objective: `Run ${id}`,
        model: "auto",
        harness: "auto" as const,
        outputSchema: {},
        inputs: [],
        requiresApproval: false,
      }
    : {
        id,
        sourceNodeId: id,
        sourcePath: id,
        dependsOn: [],
        type: "set" as const,
        value: true,
      };
}

function fixture(): { plan: ObjectiveControlPlan; revision: ObjectiveControlPlanRevision; snapshot: ObjectiveControlPlanSnapshot } {
  const plan = ObjectiveControlPlanSchema.parse({
    version: 1,
    id: "plan-1",
    source,
    root: {
      id: "root",
      sourceNodeId: "root",
      sourcePath: "root",
      dependsOn: [],
      type: "sequence",
      steps: [
        node("worker"),
        {
          id: "branch",
          sourceNodeId: "branch",
          sourcePath: "branch",
          dependsOn: [],
          type: "if",
          condition: { path: "steps.worker", op: "exists" },
          then: [node("then-worker")],
          else: [node("else-worker", "set")],
        },
        {
          id: "repeat",
          sourceNodeId: "repeat",
          sourcePath: "repeat",
          dependsOn: [],
          type: "while",
          condition: { path: "steps.worker", op: "exists" },
          maxIterations: 2,
          steps: [node("loop-worker")],
        },
      ],
    },
    limits: { maxNodes: null, maxDepth: null, maxLoopIterations: null, maxConcurrentAgents: null },
  });
  const revision = ObjectiveControlPlanRevisionSchema.parse({
    version: 1,
    planId: plan.id,
    objectiveId: "objective-1",
    runId: "run-1",
    revision: 4,
    source,
    plan,
    hash: "plan-hash-1",
    createdBy: { type: "agent", id: "conductor-1" },
    requestKey: "plan-request-4",
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  const executions: ObjectiveControlExecutionRecord[] = [
    { key: { nodeId: "root", iterationKey: "root" }, state: "running", attemptId: null, agentId: null, output: null, error: null, startedAt: null, finishedAt: null, contextRefs: [] },
    { key: { nodeId: "branch", iterationKey: "root/branch" }, state: "running", attemptId: null, agentId: null, output: null, error: null, startedAt: null, finishedAt: null, contextRefs: [] },
    { key: { nodeId: "repeat", iterationKey: "root/repeat" }, state: "running", attemptId: null, agentId: null, output: null, error: null, startedAt: null, finishedAt: null, contextRefs: [] },
    { key: { nodeId: "worker", iterationKey: "root/worker" }, state: "running", attemptId: "attempt-worker", agentId: "agent-worker", output: null, error: null, startedAt: null, finishedAt: null, contextRefs: [] },
  ];
  const executionIds = executions.map((entry) => objectiveControlExecutionId(entry.key));
  const snapshot = ObjectiveControlPlanSnapshotSchema.parse({
    version: 1,
    planId: plan.id,
    objectiveId: "objective-1",
    runId: "run-1",
    planRevision: revision.revision,
    source,
    sequence: 2,
    eventCursor: 2,
    nodeStates: Object.fromEntries(executions.map((entry, index) => [executionIds[index], entry.state])),
    frontier: [{ nodeId: "worker", iterationKey: "root/worker" }],
    branches: { [executionIds[1]!]: "then" },
    loopIterations: { [executionIds[2]!]: 1 },
    exitReasons: {},
    attemptIds: Object.fromEntries(executions.map((entry, index) => [executionIds[index], entry.attemptId])),
    executions,
    contextRefs: [],
    reason: "fixture",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  return { plan, revision, snapshot };
}

describe("objective control snapshot validation", () => {
  it("accepts data-only evaluation nodes and rejects executable fields", () => {
    const evaluation = {
      id: "score",
      sourceNodeId: "score",
      sourcePath: "steps.0",
      dependsOn: [],
      type: "evaluate" as const,
      metric: "Quality",
      path: "release.score",
      op: "gte" as const,
      target: 8,
    };
    expect(ObjectiveControlNodeSchema.parse(evaluation)).toMatchObject(evaluation);
    expect(() => ObjectiveControlNodeSchema.parse({ ...evaluation, code: "return process.env.SECRET" })).toThrow(/code/);
    expect(() => ObjectiveControlNodeSchema.parse({ ...evaluation, op: undefined })).toThrow(/operator/);
    expect(() => ObjectiveControlNodeSchema.parse({ ...evaluation, operator: "eq", op: "gte" })).toThrow(/agree/);
  });

  it("accepts a data-only fanout blueprint and applies its unlimited default", () => {
    const fanout = {
      id: "fanout",
      sourceNodeId: "fanout",
      sourcePath: "steps.0",
      dependsOn: [],
      type: "fanout" as const,
      source: "steps.items",
      itemTemplate: node("item-template"),
      aggregation: { mode: "array" as const },
    };
    expect(ObjectiveControlNodeSchema.parse(fanout)).toMatchObject({
      ...fanout,
      concurrency: null,
    });
    expect(() => ObjectiveControlNodeSchema.parse({ ...fanout, concurrency: 0 })).toThrow(/expected number to be >0/);
    expect(() => ObjectiveControlNodeSchema.parse({ ...fanout, aggregation: { mode: "array", unsupported: true } })).toThrow(/unsupported/);
  });

  it("gives fan-out items restart-stable execution identities and validates their receipt", () => {
    const fanoutExecution = { nodeId: "fanout", iterationKey: "root/fanout" } as const;
    const first = objectiveControlFanoutItemExecutionKey(fanoutExecution, "item", "file/a.ts");
    const replay = objectiveControlFanoutItemExecutionKey(fanoutExecution, "item", "file/a.ts");
    const second = objectiveControlFanoutItemExecutionKey(fanoutExecution, "item", "file/b.ts");
    expect(first).toEqual(replay);
    expect(first).not.toEqual(second);
    const materialization = ObjectiveControlFanoutMaterializationSchema.parse({
      version: 1,
      materializationId: "fanout-materialization-1",
      fanoutExecution,
      sourcePath: "context.files",
      sourceHash: "source-hash-1",
      items: [
        { index: 0, key: "file/a.ts", value: { path: "file/a.ts" }, itemHash: "item-hash-a", execution: first },
        { index: 1, key: "file/b.ts", value: { path: "file/b.ts" }, itemHash: "item-hash-b", execution: second },
      ],
      aggregation: { mode: "array" },
    });
    expect(materialization.items.map((item) => item.execution)).toEqual([first, second]);
    expect(() => ObjectiveControlFanoutMaterializationSchema.parse({
      ...materialization,
      items: [materialization.items[0], { ...materialization.items[1], key: materialization.items[0]!.key }],
    })).toThrow(/Duplicate fan-out item key/);
    expect(() => ObjectiveControlFanoutMaterializationSchema.parse({
      ...materialization,
      items: [materialization.items[0], { ...materialization.items[1], index: materialization.items[0]!.index }],
    })).toThrow(/Duplicate fan-out item index/);
  });

  it("keeps fan-out intent and acknowledgement contracts explicit and backward-compatible", () => {
    const fanoutExecution = { nodeId: "fanout", iterationKey: "root/fanout" } as const;
    const itemExecution = objectiveControlFanoutItemExecutionKey(fanoutExecution, "item", "a");
    const materialization = {
      version: 1 as const,
      materializationId: "fanout-materialization-2",
      fanoutExecution,
      sourcePath: "context.items",
      sourceHash: "source-hash-2",
      items: [{ index: 0, key: "a", value: { id: "a" }, itemHash: "item-hash-a", execution: itemExecution }],
      aggregation: { mode: "array" as const },
    };
    const nodeValue = {
      id: "fanout",
      sourceNodeId: "fanout",
      sourcePath: "steps.0",
      dependsOn: [],
      type: "fanout" as const,
      source: "context.items",
      itemTemplate: node("item-template"),
      concurrency: null,
      aggregation: { mode: "array" as const },
    };
    const intent = ObjectiveControlFanoutIntentSchema.parse({
      intentId: "fanout-intent-1",
      planId: "plan-1",
      objectiveId: "objective-1",
      runId: "run-1",
      planRevision: 0,
      expectedSequence: 1,
      execution: fanoutExecution,
      nodeId: "fanout",
      kind: "fanout",
      node: nodeValue,
      operation: "materialize",
      materialization,
      children: [],
    });
    expect(intent.materialization.items[0]!.execution).toEqual(itemExecution);
    const acknowledgement = ObjectiveControlFanoutAcknowledgementSchema.parse({
      kind: "fanout",
      intentId: intent.intentId,
      requestKey: "fanout-ack-request-1",
      operation: "materialize",
      materializationId: materialization.materializationId,
      materialization,
    });
    expect(acknowledgement.materialization?.sourceHash).toBe("source-hash-2");
    expect(() => ObjectiveControlFanoutAcknowledgementSchema.parse({
      ...acknowledgement,
      materialization: undefined,
    })).toThrow(/requires the immutable materialization receipt/);
    expect(() => ObjectiveControlFanoutExecutionMetadataSchema.parse({
      materializationId: materialization.materializationId,
      fanoutExecution,
      sourcePath: materialization.sourcePath,
      sourceHash: materialization.sourceHash,
      itemIndex: 0,
      itemKey: "a",
      itemHash: "item-hash-a",
    })).not.toThrow();
  });

  it("accepts a complete snapshot and fences revision/source identity when available", () => {
    const { plan, revision, snapshot } = fixture();
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, snapshot)).not.toThrow();
    expect(() => validateObjectiveControlSnapshotAgainstPlan(revision, snapshot)).not.toThrow();
    expect(() => validateObjectiveControlSnapshotAgainstPlan(revision, { ...snapshot, planRevision: 3 })).toThrow(/revision/);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(revision, {
      ...snapshot,
      source: { ...source, authorAgentId: "other-conductor" },
    })).toThrow(/source/);
  });

  it("rejects unknown, duplicate, or state-inconsistent execution references", () => {
    const { plan, snapshot } = fixture();
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      nodeStates: { ...snapshot.nodeStates, "missing@root": "queued" },
    })).toThrow(/nodeStates.*orphan/);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      executions: [...snapshot.executions, { ...snapshot.executions[0]! }],
    })).toThrow(/duplicate (control )?execution/i);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      nodeStates: { ...snapshot.nodeStates, [objectiveControlExecutionId(snapshot.executions[0]!.key)]: "completed" },
    })).toThrow(/state disagrees|nodeStates.*disagrees/i);
    const missingState = { ...snapshot.nodeStates };
    delete missingState[objectiveControlExecutionId(snapshot.executions[0]!.key)];
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, { ...snapshot, nodeStates: missingState })).toThrow(/no nodeStates/);
  });

  it("requires branch, loop, attempt, and exit maps to target compatible executions", () => {
    const { plan, snapshot } = fixture();
    const ids = snapshot.executions.map((entry) => objectiveControlExecutionId(entry.key));
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      branches: { [ids[3]!]: "then" },
    })).toThrow(/branches.*if/);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      loopIterations: { [ids[1]!]: 1 },
    })).toThrow(/loopIterations.*while/);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      attemptIds: { ...snapshot.attemptIds, [ids[0]!]: "attempt-root" },
    })).toThrow(/attemptIds.*agent/);
    const completedWorker = snapshot.executions.map((entry) => entry.key.nodeId === "worker"
      ? { ...entry, state: "completed" as const }
      : entry);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      executions: completedWorker,
      nodeStates: { ...snapshot.nodeStates, [ids[3]!]: "completed" },
      exitReasons: { [ids[3]!]: "condition-false" },
    })).toThrow(/exitReasons.*condition/);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      loopIterations: { [ids[2]!]: 3 },
    })).toThrow(/exceeds.*bound/);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      contextRefs: [{ kind: "node-output", id: "missing@execution", hash: "output-hash-1" }],
    })).toThrow(/contextRefs.*orphan/);
  });

  it("rejects duplicate, missing, and terminal frontier entries", () => {
    const { plan, snapshot } = fixture();
    const worker = { nodeId: "worker" as const, iterationKey: "root/worker" };
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, { ...snapshot, frontier: [worker, worker] })).toThrow(/frontier.*duplicate/);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, { ...snapshot, frontier: [{ nodeId: "worker", iterationKey: "missing" }] })).toThrow(/frontier.*orphan/);
    const terminal = snapshot.executions.map((entry) => entry.key.nodeId === "worker" ? { ...entry, state: "completed" as const } : entry);
    expect(() => validateObjectiveControlSnapshotAgainstPlan(plan, {
      ...snapshot,
      executions: terminal,
      nodeStates: { ...snapshot.nodeStates, [objectiveControlExecutionId(worker)]: "completed" },
      attemptIds: { ...snapshot.attemptIds, [objectiveControlExecutionId(worker)]: "attempt-worker" },
    })).toThrow(/frontier.*terminal/);
  });

  it("revalidates all nested graph/dependency/limit invariants after mutations", () => {
    const { plan } = fixture();
    const baseMutation = {
      version: 1 as const,
      mutationId: "mutation-nested",
      planId: plan.id,
      objectiveId: "objective-1",
      runId: "run-1",
      expectedRevision: 0,
      type: "insert-node" as const,
      parentId: "root",
      slot: "steps" as const,
      reason: "Insert nested control subtree.",
      evidence: { eventCursor: 1, eventIds: [] },
      requestKey: "mutation-request-nested",
      actor: { type: "agent" as const, id: "conductor-1" },
    };
    const nested = {
      id: "nested",
      sourceNodeId: "nested",
      sourcePath: "nested",
      dependsOn: ["nested-leaf"],
      type: "sequence" as const,
      steps: [node("nested-leaf")],
    };
    expect(() => applyObjectiveControlMutation(plan, { ...baseMutation, node: nested })).not.toThrow();

    expect(() => applyObjectiveControlMutation(plan, {
      ...baseMutation,
      mutationId: "mutation-invalid-dependency",
      requestKey: "mutation-request-invalid-dependency",
      node: { ...nested, id: "nested-invalid", sourceNodeId: "nested-invalid", dependsOn: [], steps: [{ ...node("nested-invalid-leaf"), dependsOn: ["does-not-exist"] }] },
    })).toThrow(/unknown node/);

    const limited = ObjectiveControlPlanSchema.parse({
      ...plan,
      limits: { ...plan.limits, maxDepth: 3 },
    });
    const tooDeep = {
      ...nested,
      id: "too-deep",
      sourceNodeId: "too-deep",
      dependsOn: [],
      steps: [{
        id: "nested-inner",
        sourceNodeId: "nested-inner",
        sourcePath: "nested-inner",
        dependsOn: [],
        type: "sequence" as const,
        steps: [node("nested-inner-leaf")],
      }],
    };
    expect(() => applyObjectiveControlMutation(limited, {
      ...baseMutation,
      planId: limited.id,
      mutationId: "mutation-depth-limit",
      requestKey: "mutation-request-depth-limit",
      node: tooDeep,
    })).toThrow(/maxDepth/);

    const replaceMutation = {
      version: 1 as const,
      planId: plan.id,
      objectiveId: "objective-1",
      runId: "run-1",
      expectedRevision: 0,
      reason: "Replace with nested control subtree.",
      evidence: { eventCursor: 1, eventIds: [] },
      requestKey: "mutation-request-replace-nested",
      actor: { type: "agent" as const, id: "conductor-1" },
      type: "replace-node" as const,
      nodeId: "branch",
      mutationId: "mutation-replace-nested",
      node: {
        id: "branch",
        sourceNodeId: "branch",
        sourcePath: "branch",
        dependsOn: [],
        type: "sequence" as const,
        steps: [{ ...node("replacement-leaf"), dependsOn: ["removed-node"] }],
      },
    };
    expect(() => applyObjectiveControlMutation(plan, replaceMutation)).toThrow(/unknown node/);
  });
});
