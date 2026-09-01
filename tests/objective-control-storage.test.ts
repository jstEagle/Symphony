import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ObjectiveControlMutation,
  ObjectiveControlPlanRevision,
  ObjectiveControlPlanSnapshot,
  ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { objectiveControlPlanHash, SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const now = "2026-09-01T00:00:00.000Z";
const source = { kind: "workflow-revision" as const, workflowId: "workflow-1", workflowRevision: 1, workflowHash: "workflow-hash-1" };

const run: ObjectiveRunRecord = {
  version: 1,
  runId: "control-run-1",
  objectiveId: "objective-control-1",
  workflowId: source.workflowId,
  workflowRevision: source.workflowRevision,
  workflowHash: source.workflowHash,
  conductorAgentId: "conductor-1",
  spec: {
    id: "objective-control-1",
    statement: "Exercise the durable control plan.",
    criteria: [],
    approvalPolicy: { mode: "never" },
    maxReplans: 3,
  },
  state: "planning",
  activePlanRevision: 0,
  latestCheckpointId: null,
  pendingApprovalId: null,
  replanCount: 0,
  tasks: [],
  context: {},
  output: null,
  error: null,
  requestKey: "control-run-request-1",
  createdAt: now,
  updatedAt: now,
  startedAt: null,
  finishedAt: null,
};

function makeStore(): SymphonyStore {
  const directory = mkdtempSync(join(tmpdir(), "symphony-control-store-"));
  temporary.push(directory);
  return new SymphonyStore(join(directory, "state.sqlite"));
}

function planRoot(value: unknown = { ok: true }) {
  return {
    version: 1 as const,
    id: "control-plan-1",
    source,
    root: {
      id: "root",
      sourceNodeId: "root",
      sourcePath: "root",
      dependsOn: [],
      type: "set" as const,
      value,
    },
    limits: { maxNodes: null, maxDepth: null, maxLoopIterations: null, maxConcurrentAgents: null },
  };
}

function revision(revisionNumber: number, requestKey = `control-plan-request-${revisionNumber}`, value: unknown = { ok: true }): ObjectiveControlPlanRevision {
  return {
    version: 1,
    planId: "control-plan-1",
    objectiveId: run.objectiveId,
    runId: run.runId,
    revision: revisionNumber,
    source,
    plan: planRoot(value),
    hash: objectiveControlPlanHash(planRoot(value)),
    createdBy: { type: "agent", id: "conductor-1" },
    requestKey,
    createdAt: `2026-09-01T00:00:0${revisionNumber}.000Z`,
  };
}

function snapshot(
  revisionNumber: number,
  sequence: number,
  executions: ObjectiveControlPlanSnapshot["executions"] = [],
  loopIterations: Record<string, number> = {},
): ObjectiveControlPlanSnapshot {
  return {
    version: 1,
    planId: "control-plan-1",
    objectiveId: run.objectiveId,
    runId: run.runId,
    planRevision: revisionNumber,
    sequence,
    eventCursor: sequence,
    nodeStates: Object.fromEntries(executions.map((entry) => [`${entry.key.nodeId}@${entry.key.iterationKey}`, entry.state])),
    frontier: [],
    branches: {},
    loopIterations,
    exitReasons: {},
    attemptIds: Object.fromEntries(executions.map((entry) => [`${entry.key.nodeId}@${entry.key.iterationKey}`, entry.attemptId])),
    executions,
    contextRefs: [],
    reason: `snapshot ${sequence}`,
    createdAt: `2026-09-01T00:00:0${sequence}.000Z`,
  };
}

function insertMutation(expectedRevision: number, mutationId = `control-mutation-${expectedRevision + 1}`, requestKey = `control-mutation-request-${expectedRevision + 1}`): ObjectiveControlMutation {
  return {
    version: 1,
    mutationId,
    planId: "control-plan-1",
    objectiveId: run.objectiveId,
    runId: run.runId,
    expectedRevision,
    type: "replace-node",
    nodeId: "root",
    node: {
      id: "root",
      sourceNodeId: "root",
      sourcePath: "root",
      dependsOn: [],
      type: "set",
      value: { revision: expectedRevision + 1 },
    },
    reason: "Update the durable control plan.",
    evidence: { eventCursor: expectedRevision, eventIds: [] },
    requestKey,
    actor: { type: "agent", id: "conductor-1" },
  };
}

describe("objective control-plan storage", () => {
  it("admits revision zero and its first snapshot atomically, then reads after restart", () => {
    const store = makeStore();
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 15").get()).toEqual({ version: 15 });
    expect(store.saveObjectiveRun(run)).toBe(true);
    const first = revision(0);
    const firstSnapshot = snapshot(0, 1);
    expect(store.saveObjectiveControlPlanRevision(first, firstSnapshot)).toBe(true);
    expect(store.getObjectiveControlHead(run.runId)).toMatchObject({ activeRevision: 0, latestSnapshotSequence: 1 });
    expect(store.listObjectiveControlPlanRevisions(run.runId)).toEqual([first]);
    expect(store.listObjectiveControlSnapshots(run.runId)).toEqual([firstSnapshot]);
    const path = store.path;
    store.close();
    const reopened = new SymphonyStore(path);
    expect(reopened.getObjectiveControlPlanRevision(run.runId, 0)).toEqual(first);
    expect(reopened.getLatestObjectiveControlSnapshot(run.runId)).toEqual(firstSnapshot);
    reopened.close();
  });

  it("keeps legacy objectives null and does not reuse flat plan tables", () => {
    const store = makeStore();
    expect(store.saveObjectiveRun(run)).toBe(true);
    expect(store.getObjectiveControlHead(run.runId)).toBeNull();
    expect(store.listObjectiveControlPlanRevisions(run.runId)).toEqual([]);
    expect(store.listObjectiveControlSnapshots(run.runId)).toEqual([]);
    expect(store.listObjectiveControlMutations(run.runId)).toEqual([]);
    expect(store.database.prepare("SELECT name FROM sqlite_master WHERE name = 'workflow_plan_mutations'").get()).toEqual({ name: "workflow_plan_mutations" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM objective_control_mutations").get()).toEqual({ count: 0 });
    store.close();
  });

  it("commits typed mutation + revision + snapshot exactly once and replays it", () => {
    const store = makeStore();
    store.saveObjectiveRun(run);
    store.saveObjectiveControlPlanRevision(revision(0), snapshot(0, 1));
    const mutation = insertMutation(0);
    const next = revision(1, mutation.requestKey, { revision: 1 });
    const nextSnapshot = snapshot(1, 2);
    const committed = store.commitObjectiveControlMutation(mutation, next, nextSnapshot);
    expect(committed.status).toBe("committed");
    expect(store.listObjectiveControlPlanRevisions(run.runId)).toHaveLength(2);
    expect(store.listObjectiveControlSnapshots(run.runId)).toHaveLength(2);
    const replay = store.commitObjectiveControlMutation(mutation, next, nextSnapshot);
    expect(replay.status).toBe("replayed");
    expect(replay.mutation?.mutationId).toBe(mutation.mutationId);
    expect(store.listObjectiveControlMutations(run.runId)).toHaveLength(1);
  });

  it("derives the next revision, snapshot, and semantic event inside one durable commit", () => {
    const store = makeStore();
    store.saveObjectiveRun(run);
    store.saveObjectiveControlPlanRevision(revision(0), snapshot(0, 1));
    const mutation = insertMutation(0, "derived-mutation-1", "derived-request-1");
    const committed = store.commitObjectiveControlMutationDerived(mutation);
    expect(committed.status).toBe("committed");
    expect(committed.revision?.revision).toBe(1);
    expect(committed.snapshot?.planRevision).toBe(1);
    expect(committed.snapshot?.eventCursor).toBeGreaterThan(0);
    expect(store.eventsAfter(0, { runId: run.runId, types: ["objective.control-plan.changed"] })).toHaveLength(1);

    const replay = store.commitObjectiveControlMutationDerived(mutation);
    expect(replay.status).toBe("replayed");
    expect(store.listObjectiveControlPlanRevisions(run.runId)).toHaveLength(2);
    expect(store.listObjectiveControlSnapshots(run.runId)).toHaveLength(2);
    expect(store.eventsAfter(0, { runId: run.runId, types: ["objective.control-plan.changed"] })).toHaveLength(1);

    const stale = store.commitObjectiveControlMutationDerived({
      ...mutation,
      mutationId: "derived-mutation-stale",
      requestKey: "derived-request-stale",
    });
    expect(stale.status).toBe("conflict");
    expect(stale.reason).toMatch(/stale|revision/i);
    store.close();
  });

  it("distinguishes a stale CAS conflict and elects one winner for two writers", () => {
    const store = makeStore();
    store.saveObjectiveRun(run);
    store.saveObjectiveControlPlanRevision(revision(0), snapshot(0, 1));
    const first = insertMutation(0, "control-mutation-a", "control-mutation-request-a");
    const second = insertMutation(0, "control-mutation-b", "control-mutation-request-b");
    expect(store.commitObjectiveControlMutation(first, revision(1, first.requestKey, { revision: 1 }), snapshot(1, 2)).status).toBe("committed");
    expect(store.commitObjectiveControlMutation(second, revision(1, "control-plan-request-b"), snapshot(1, 2)).status).toBe("conflict");
    expect(store.getObjectiveControlHead(run.runId)?.activeRevision).toBe(1);
    expect(store.listObjectiveControlMutations(run.runId)).toHaveLength(1);
  });

  it("rejects source identity drift and preserves loop execution keys", () => {
    const store = makeStore();
    store.saveObjectiveRun(run);
    const first = revision(0);
    const loopSnapshot = snapshot(0, 1, [
      { key: { nodeId: "root", iterationKey: "root/loop:1" }, state: "completed", attemptId: "attempt-1" },
      { key: { nodeId: "root", iterationKey: "root/loop:2" }, state: "running", attemptId: "attempt-2" },
    ], { "root@root/loop:1": 1, "root@root/loop:2": 2 });
    store.saveObjectiveControlPlanRevision(first, loopSnapshot);
    expect(store.getObjectiveControlSnapshot(run.runId, 1)?.executions.map((entry) => entry.key.iterationKey)).toEqual(["root/loop:1", "root/loop:2"]);
    expect(store.getObjectiveControlSnapshot(run.runId, 1)?.loopIterations).toEqual({ "root@root/loop:1": 1, "root@root/loop:2": 2 });
    const driftedSource = { ...source, workflowHash: "different-workflow-hash" };
    const driftedPlan = { ...planRoot(), source: driftedSource };
    expect(() => store.saveObjectiveControlPlanRevision({ ...revision(1), source: driftedSource, plan: driftedPlan, hash: objectiveControlPlanHash(driftedPlan) }, snapshot(1, 2), { expectedActiveRevision: 0 })).toThrow(/identity|source/i);
    store.close();
  });

  it("requires every revision to carry an active-plan snapshot and rejects stale snapshots", () => {
    const store = makeStore();
    store.saveObjectiveRun(run);
    expect(() => store.saveObjectiveControlPlanRevision(revision(1))).toThrow(/requires a snapshot/);
    store.saveObjectiveControlPlanRevision(revision(0), snapshot(0, 1));
    const mutation = insertMutation(0);
    const next = revision(1, mutation.requestKey, { revision: 1 });
    expect(store.commitObjectiveControlMutation(mutation, next, snapshot(1, 2)).status).toBe("committed");
    expect(() => store.saveObjectiveControlSnapshot(snapshot(0, 3))).toThrow(/active plan revision/);
    store.close();
  });

  it("rejects mutations whose actor, request key, or resulting plan is not bound to the revision", () => {
    const store = makeStore();
    store.saveObjectiveRun(run);
    store.saveObjectiveControlPlanRevision(revision(0), snapshot(0, 1));

    const mutation = insertMutation(0, "control-mutation-invalid", "control-mutation-request-invalid");
    const mismatchedRevision = revision(1, mutation.requestKey, { revision: 999 });
    expect(store.commitObjectiveControlMutation(mutation, mismatchedRevision, snapshot(1, 2)).status).toBe("conflict");
    expect(store.getObjectiveControlHead(run.runId)?.activeRevision).toBe(0);

    const actorMismatch = { ...mutation, mutationId: "control-mutation-actor", requestKey: "control-mutation-request-actor", actor: { type: "agent" as const, id: "other-agent" } };
    const actorRevision = revision(1, actorMismatch.requestKey, { revision: 1 });
    expect(store.commitObjectiveControlMutation(actorMismatch, actorRevision, snapshot(1, 2)).status).toBe("conflict");
    expect(store.getObjectiveControlHead(run.runId)?.activeRevision).toBe(0);
    store.close();
  });

  it("rolls back all control state when a transaction fails", () => {
    const store = makeStore();
    store.saveObjectiveRun(run);
    expect(() => store.transaction(() => {
      expect(store.saveObjectiveControlPlanRevision(revision(0), snapshot(0, 1))).toBe(true);
      throw new Error("injected crash before commit");
    })).toThrow("injected crash before commit");
    expect(store.getObjectiveControlHead(run.runId)).toBeNull();
    expect(store.listObjectiveControlPlanRevisions(run.runId)).toEqual([]);
    expect(store.listObjectiveControlSnapshots(run.runId)).toEqual([]);
    store.close();
  });
});
