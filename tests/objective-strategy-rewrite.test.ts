import { describe, expect, it } from "vitest";
import {
  ObjectiveControlMutationSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlPlanSnapshotSchema,
  objectiveControlExecutionId,
  applyObjectiveControlMutation,
  applyObjectiveControlMutationToSnapshot,
  previewObjectiveControlMutation,
} from "../packages/protocol/src/objective-control.js";
import {
  applyObjectiveControlAcknowledgement,
  createObjectiveControlSnapshot,
  nextObjectiveControlIntent,
} from "../packages/workflow/src/objective-control-plan.js";
import type { ObjectiveControlAcknowledgement } from "../packages/protocol/src/objective-control.js";

const base = (id: string, sourcePath = id) => ({ id, sourceNodeId: id, sourcePath, dependsOn: [] as string[] });
const agent = (id: string, sourcePath = id) => ({
  ...base(id, sourcePath), type: "agent" as const, objective: id, model: "fixture", harness: "auto" as const,
  outputSchema: {}, inputs: [], requiresApproval: false,
});
const plan = ObjectiveControlPlanSchema.parse({
  version: 1,
  id: "rewrite-plan",
  source: { kind: "conductor-authored", authorAgentId: "conductor", sessionId: null },
  root: { ...base("root"), type: "sequence" as const, steps: [agent("live", "steps.0"), agent("keep", "steps.1")] },
  limits: { maxNodes: null, maxDepth: null, maxLoopIterations: null, maxConcurrentAgents: null },
});

function mutation(input: Record<string, unknown>) {
  return ObjectiveControlMutationSchema.parse({
    version: 1, mutationId: "rewrite-mutation-1", planId: plan.id, objectiveId: "objective", runId: "run", expectedRevision: 0,
    reason: "bounded strategy rewrite", evidence: { eventCursor: 7, eventIds: ["event-7"] }, requestKey: "rewrite-request-1",
    actor: { type: "agent", id: "conductor" }, ...input,
  });
}

describe("policy-safe strategy rewrites", () => {
  it("keeps removed active attempts in explicit cancellation lineage", () => {
    const remove = mutation({
      type: "remove-subtree", nodeId: "live",
      cancellationIntent: { type: "cancel-active-attempts", reason: "live branch is obsolete", preserveLineage: true },
    });
    const candidate = applyObjectiveControlMutation(plan, remove);
    const snapshot = ObjectiveControlPlanSnapshotSchema.parse({
      version: 1, planId: plan.id, objectiveId: "objective", runId: "run", planRevision: 0, sequence: 1, eventCursor: 7,
      nodeStates: { "live@root": "running", "keep@root": "queued" }, frontier: [{ nodeId: "live", iterationKey: "root" }], branches: {}, loopIterations: {}, exitReasons: {},
      attemptIds: { "live@root": "attempt-live", "keep@root": null },
      executions: [
        { key: { nodeId: "live", iterationKey: "root" }, state: "running", attemptId: "attempt-live", agentId: "native-live" },
        { key: { nodeId: "keep", iterationKey: "root" }, state: "queued", attemptId: null },
      ], contextRefs: [], reason: "running", createdAt: "2026-09-01T00:00:00.000Z",
    });
    const reduced = applyObjectiveControlMutationToSnapshot(plan, snapshot, remove, candidate, "2026-09-01T00:00:01.000Z");
    expect(reduced.executions.map((entry) => entry.key.nodeId)).toEqual(["keep"]);
    expect(reduced.cancellations).toMatchObject([{ attemptId: "attempt-live", agentId: "native-live", sourceMutationId: "rewrite-mutation-1" }]);
  });

  it("previews branch and dependency rewrites with deterministic impact", () => {
    const insert = mutation({
      type: "insert-branch", branchNodeId: "root", branch: "then", node: { ...agent("inserted"), sourcePath: "root.then.0" },
    });
    expect(() => applyObjectiveControlMutation(plan, insert)).toThrow(/if node/);
    const rewire = mutation({ type: "rewire-dependencies", nodeId: "keep", dependsOn: ["live"] });
    const candidate = applyObjectiveControlMutation(plan, rewire);
    const snapshot = ObjectiveControlPlanSnapshotSchema.parse({
      version: 1, planId: plan.id, objectiveId: "objective", runId: "run", planRevision: 0, sequence: 1, eventCursor: 7,
      nodeStates: { "root@root": "queued" }, frontier: [{ nodeId: "root", iterationKey: "root" }], branches: {}, loopIterations: {}, exitReasons: {}, attemptIds: { "root@root": null },
      executions: [{ key: { nodeId: "root", iterationKey: "root" }, state: "queued", attemptId: null }], contextRefs: [], reason: "queued", createdAt: "2026-09-01T00:00:00.000Z",
    });
    const preview = previewObjectiveControlMutation(plan, snapshot, rewire);
    expect(preview.valid).toBe(true);
    expect(preview.impact.edgesAdded).toEqual([{ from: "keep", to: "live" }]);
    expect(candidate.root.type).toBe("sequence");
  });

  it("rejects executable-source fields in typed insertion nodes", () => {
    expect(() => ObjectiveControlMutationSchema.parse({
      ...mutation({ type: "insert-artifact", parentId: "root", slot: "steps", node: {
        ...base("artifact"), type: "artifact", kind: "evidence", name: "proof", mediaType: "application/json", content: {}, execute: "process.exit(1)",
      } }),
    })).toThrow();
  });

  it("materializes inserted work into an active parallel frontier", () => {
    const parallel = ObjectiveControlPlanSchema.parse({
      ...plan,
      id: "parallel-rewrite-plan",
      root: {
        ...base("root"),
        type: "sequence" as const,
        steps: [{
          ...base("fanout"),
          type: "parallel" as const,
          steps: [agent("first"), agent("second")],
        }],
      },
    });
    const initial = createObjectiveControlSnapshot(parallel, {
      objectiveId: "objective",
      runId: "parallel-run",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    let current = acknowledge(parallel, initial, "parallel-ack-root");
    current = acknowledge(parallel, current, "parallel-ack-fanout");
    const first = nextObjectiveControlIntent(parallel, current);
    expect(first.kind).toBe("agent");
    current = acknowledge(parallel, current, "parallel-ack-first", { output: { ok: true } });

    const mutation = ObjectiveControlMutationSchema.parse({
      version: 1,
      mutationId: "parallel-rewrite-1",
      planId: parallel.id,
      objectiveId: "objective",
      runId: "parallel-run",
      expectedRevision: 0,
      type: "insert-node",
      parentId: "fanout",
      slot: "steps",
      position: 2,
      node: { ...agent("third"), sourcePath: "root.steps.0.steps.2" },
      reason: "Add the next verification frontier.",
      evidence: { eventCursor: 7, eventIds: ["event-7"] },
      requestKey: "parallel-rewrite-request",
      actor: { type: "agent", id: "conductor" },
    });
    const nextPlan = applyObjectiveControlMutation(parallel, mutation);
    current = applyObjectiveControlMutationToSnapshot(parallel, current, mutation, nextPlan, "2026-09-01T00:00:01.000Z");

    expect(current.executions.some((entry) => entry.key.nodeId === "third")).toBe(true);
    expect(current.frontier.map((entry) => entry.nodeId)).toEqual(expect.arrayContaining(["second", "third"]));

    const second = nextObjectiveControlIntent(nextPlan, current);
    expect(second).toMatchObject({ kind: "agent", node: { id: "second" } });
    current = acknowledge(nextPlan, current, "parallel-ack-second", { output: { ok: true } });
    expect(nextObjectiveControlIntent(nextPlan, current)).toMatchObject({ kind: "agent", node: { id: "third" } });
  });

  it("defers a sequence insertion until the active predecessor settles", () => {
    const sequence = ObjectiveControlPlanSchema.parse({
      ...plan,
      id: "sequence-rewrite-plan",
      root: {
        ...base("root"),
        type: "sequence" as const,
        steps: [agent("first"), agent("second")],
      },
    });
    const initial = createObjectiveControlSnapshot(sequence, {
      objectiveId: "objective",
      runId: "sequence-run",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    let current = acknowledge(sequence, initial, "sequence-ack-root");
    current = acknowledge(sequence, current, "sequence-start-first", { state: "running", agentId: "native-first" });

    const rewrite = ObjectiveControlMutationSchema.parse({
      version: 1,
      mutationId: "sequence-rewrite-1",
      planId: sequence.id,
      objectiveId: "objective",
      runId: "sequence-run",
      expectedRevision: 0,
      type: "insert-node",
      parentId: "root",
      slot: "steps",
      position: 1,
      node: { ...agent("inserted"), sourcePath: "root.steps.1" },
      reason: "Insert a validation stage before the next step.",
      evidence: { eventCursor: 8, eventIds: ["event-8"] },
      requestKey: "sequence-rewrite-request",
      actor: { type: "agent", id: "conductor" },
    });
    const nextPlan = applyObjectiveControlMutation(sequence, rewrite);
    current = applyObjectiveControlMutationToSnapshot(sequence, current, rewrite, nextPlan, "2026-09-01T00:00:01.000Z");

    expect(current.executions.find((entry) => entry.key.nodeId === "inserted")?.state).toBe("queued");
    expect(current.frontier.map((entry) => entry.nodeId)).toEqual(["first"]);

    current = acknowledge(nextPlan, current, "sequence-finish-first", { output: { ok: true } });
    expect(nextObjectiveControlIntent(nextPlan, current)).toMatchObject({ kind: "agent", node: { id: "inserted" } });
  });

  it("materializes an inserted loop step for the current durable iteration", () => {
    const loop = ObjectiveControlPlanSchema.parse({
      ...plan,
      id: "loop-rewrite-plan",
      root: {
        ...base("root"),
        type: "while" as const,
        condition: { path: "context.continue", op: "eq" as const, value: true, default: false },
        maxIterations: 3,
        steps: [agent("first")],
      },
    });
    const loopExecution = { nodeId: "root", iterationKey: "root" } as const;
    const firstExecution = { nodeId: "first", iterationKey: "root/root/iteration-1/first" } as const;
    const current = ObjectiveControlPlanSnapshotSchema.parse({
      version: 1,
      planId: loop.id,
      objectiveId: "objective",
      runId: "loop-run",
      planRevision: 0,
      sequence: 2,
      eventCursor: 7,
      nodeStates: {
        "root@root": "running",
        "first@root/root/iteration-1/first": "running",
      },
      frontier: [firstExecution],
      branches: {},
      loopIterations: { "root@root": 1 },
      exitReasons: {},
      attemptIds: {
        "root@root": null,
        "first@root/root/iteration-1/first": "attempt-first",
      },
      executions: [
        { key: loopExecution, state: "running", attemptId: null },
        { key: firstExecution, state: "running", attemptId: "attempt-first", agentId: "native-first" },
      ],
      context: { continue: true },
      contextRefs: [],
      reason: "running",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const rewrite = ObjectiveControlMutationSchema.parse({
      version: 1,
      mutationId: "loop-rewrite-1",
      planId: loop.id,
      objectiveId: "objective",
      runId: "loop-run",
      expectedRevision: 0,
      type: "insert-node",
      parentId: "root",
      slot: "steps",
      position: 1,
      node: { ...agent("inserted"), sourcePath: "root.steps.1" },
      reason: "Add a second check to this iteration.",
      evidence: { eventCursor: 8, eventIds: ["event-8"] },
      requestKey: "loop-rewrite-request",
      actor: { type: "agent", id: "conductor" },
    });
    const nextPlan = applyObjectiveControlMutation(loop, rewrite);
    const reduced = applyObjectiveControlMutationToSnapshot(loop, current, rewrite, nextPlan, "2026-09-01T00:00:01.000Z");

    const insertedId = "inserted@root/root/iteration-1/inserted";
    expect(reduced.executions.find((entry) => objectiveControlExecutionId(entry.key) === insertedId)?.state).toBe("queued");
    expect(reduced.frontier.map((entry) => entry.nodeId)).toEqual(["first"]);
  });
});

let acknowledgementNumber = 0;
function acknowledge(
  planInput: ReturnType<typeof ObjectiveControlPlanSchema.parse>,
  snapshot: ReturnType<typeof ObjectiveControlPlanSnapshotSchema.parse>,
  requestKey: string,
  fields: Partial<ObjectiveControlAcknowledgement> = {},
) {
  const intent = nextObjectiveControlIntent(planInput, snapshot);
  const acknowledgement: ObjectiveControlAcknowledgement = {
    kind: intent.kind,
    intentId: intent.intentId,
    requestKey: `${requestKey}-${++acknowledgementNumber}`,
    now: "2026-09-01T00:00:00.000Z",
    ...(intent.kind === "agent" && intent.operation !== "approval" ? { attemptId: intent.attemptId } : {}),
    ...fields,
  };
  return applyObjectiveControlAcknowledgement(planInput, snapshot, acknowledgement);
}
