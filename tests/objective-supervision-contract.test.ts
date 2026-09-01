import { describe, expect, it } from "vitest";
import {
  ObjectiveRuntime,
  type ObjectiveActionReceipt,
  type ObjectiveRepository,
} from "../packages/workflow/src/objective-runtime.js";
import {
  ObjectiveSupervisor,
  type ObjectiveSupervisorAcknowledgement,
  type ObjectiveSupervisorIntent,
} from "../packages/workflow/src/objective-supervisor.js";
import type {
  ObjectiveApprovalRecord,
  ObjectiveCheckpointRecord,
  ObjectiveRunRecord,
  ObjectiveTask,
} from "../packages/protocol/src/index.js";

/**
 * A deliberately small durable adapter. The supervisor is black-boxed: tests
 * only use create/commit through ObjectiveRuntime, next, and acknowledge.
 * Copy-on-write transactions make a failed acknowledgement deterministic.
 */
class DurableFixture implements ObjectiveRepository {
  readonly runs = new Map<string, ObjectiveRunRecord>();
  readonly receipts = new Map<string, ObjectiveActionReceipt>();
  readonly checkpoints = new Map<string, ObjectiveCheckpointRecord>();
  readonly approvals = new Map<string, ObjectiveApprovalRecord>();
  private sequence = 0;

  getObjectiveRun(runId: string): ObjectiveRunRecord | null { return this.runs.get(runId) ?? null; }
  getObjectiveRunByRequestKey(requestKey: string): ObjectiveRunRecord | null {
    return [...this.runs.values()].find((run) => run.requestKey === requestKey) ?? null;
  }
  saveObjectiveRun(run: ObjectiveRunRecord): void { this.runs.set(run.runId, run); }
  getObjectiveActionReceipt(requestKey: string): ObjectiveActionReceipt | null {
    return this.receipts.get(requestKey) ?? null;
  }
  saveObjectiveActionReceipt(receipt: ObjectiveActionReceipt): boolean {
    if (this.receipts.has(receipt.requestKey)) return false;
    this.receipts.set(receipt.requestKey, receipt);
    return true;
  }
  getObjectiveCheckpoint(_runId: string, checkpointId: string): ObjectiveCheckpointRecord | null {
    return this.checkpoints.get(checkpointId) ?? null;
  }
  appendObjectiveCheckpoint(checkpoint: ObjectiveCheckpointRecord): boolean {
    if (this.checkpoints.has(checkpoint.id)) return false;
    this.checkpoints.set(checkpoint.id, checkpoint);
    return true;
  }
  getObjectiveApproval(_runId: string, approvalId: string): ObjectiveApprovalRecord | null {
    return this.approvals.get(approvalId) ?? null;
  }
  saveObjectiveApproval(approval: ObjectiveApprovalRecord): boolean {
    const existing = this.approvals.get(approval.id);
    if (existing && existing.status !== "requested" && JSON.stringify(existing) !== JSON.stringify(approval)) {
      throw new Error("approval compare-and-swap lost");
    }
    if (existing && JSON.stringify(existing) === JSON.stringify(approval)) return false;
    this.approvals.set(approval.id, approval);
    return true;
  }
  withDurableTransaction<T>(callback: () => T): T {
    const snapshot = {
      runs: new Map(this.runs),
      receipts: new Map(this.receipts),
      checkpoints: new Map(this.checkpoints),
      approvals: new Map(this.approvals),
    };
    try {
      return callback();
    } catch (error) {
      for (const [key, value] of snapshot.runs) this.runs.set(key, value);
      for (const [key, value] of snapshot.receipts) this.receipts.set(key, value);
      for (const [key, value] of snapshot.checkpoints) this.checkpoints.set(key, value);
      for (const [key, value] of snapshot.approvals) this.approvals.set(key, value);
      throw error;
    }
  }

  nextId(prefix: string): string { return `${prefix}-${++this.sequence}`; }
}

const daemonAuthority = {
  actor: { type: "system" as const, id: "daemon-objective-supervisor" },
  permissionCeiling: "full-access" as const,
};
const foreignReadOnlyAuthority = {
  actor: { type: "agent" as const, id: "foreign-agent" },
  permissionCeiling: "read-only" as const,
};

function task(id: string, dependsOn: string[] = [], extra: Partial<ObjectiveTask> = {}): ObjectiveTask {
  return {
    id,
    objective: `Complete ${id}`,
    dependsOn,
    outputSchema: {},
    model: "fixture",
    harness: "auto",
    inputs: [],
    requiresApproval: false,
    ...extra,
  };
}

function makeFixture(): {
  repository: DurableFixture;
  runtime: ObjectiveRuntime;
  supervisor: ObjectiveSupervisor;
} {
  const repository = new DurableFixture();
  const runtime = new ObjectiveRuntime(repository, {
    id: () => repository.nextId("objective-id"),
    now: () => "2026-09-01T00:00:00.000Z",
  });
  return { repository, runtime, supervisor: new ObjectiveSupervisor(runtime, repository, { authority: daemonAuthority }) };
}

function create(runtime: ObjectiveRuntime, overrides: Record<string, unknown> = {}): ObjectiveRunRecord {
  return runtime.create({
    runId: "objective-supervision-contract-run",
    objectiveId: "objective-supervision-contract",
    workflowId: "objective-supervision-workflow",
    workflowRevision: 1,
    workflowHash: "objective-supervision-workflow-hash",
    spec: {
      id: "objective-supervision-contract",
      statement: "Complete the objective under daemon supervision.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 2,
    },
    requestKey: "objective-supervision-create",
    ...overrides,
  }, daemonAuthority);
}

function acknowledge(input: ObjectiveSupervisorAcknowledgement): ObjectiveSupervisorAcknowledgement {
  return input;
}

function expectKind<K extends ObjectiveSupervisorIntent["kind"]>(intent: ObjectiveSupervisorIntent, kind: K): Extract<ObjectiveSupervisorIntent, { kind: K }> {
  expect(intent.kind).toBe(kind);
  if (intent.kind !== kind) throw new Error(`expected ${kind} intent`);
  return intent as Extract<ObjectiveSupervisorIntent, { kind: K }>;
}

describe("daemon-owned objective supervision contract", () => {
  it("turns objective creation plus an acknowledged initial plan into one dispatch intent", () => {
    const { runtime, supervisor } = makeFixture();
    const created = create(runtime);
    const planning = expectKind(supervisor.next(created.runId), "replan");

    const planned = supervisor.acknowledge(created.runId, acknowledge({
      kind: "replan",
      intentId: planning.intentId,
      requestKey: "objective-supervision-initial-plan",
      reason: "Create the initial executable frontier.",
      tasks: [task("build")],
    }));
    expect(planned.activePlanRevision).toBe(1);
    expect(planned.state).toBe("executing");
    expectKind(supervisor.next(planned.runId), "dispatch");
  });

  it("emits all currently runnable tasks as a parallel frontier", () => {
    const { runtime, supervisor } = makeFixture();
    const created = create(runtime, { tasks: [task("lint"), task("unit"), task("package", ["lint", "unit"]) ] });
    const frontier = expectKind(supervisor.next(created.runId), "dispatch");
    expect(frontier.taskIds).toEqual(["lint", "unit"]);
    expect(frontier.taskIds).not.toContain("package");
  });

  it("reconstructs the same pending dispatch after a daemon restart and never duplicates it", () => {
    const first = makeFixture();
    const created = create(first.runtime, { tasks: [task("build")] });
    const pending = expectKind(first.supervisor.next(created.runId), "dispatch");

    // A restart gets a fresh supervisor over the same durable adapter. Intent
    // identity, frontier, and acknowledgement key must all remain identical.
    const restarted = new ObjectiveSupervisor(first.runtime, first.repository, { authority: daemonAuthority });
    expect(restarted.next(created.runId)).toEqual(pending);
    expect(restarted.next(created.runId).intentId).toBe(pending.intentId);
    expect(first.repository.receipts).toHaveProperty("size", 1); // create only
  });

  it("records terminal agent evidence, evaluates it, and moves failed criteria to replan", () => {
    const { runtime, supervisor, repository } = makeFixture();
    const created = create(runtime, {
      spec: {
        id: "objective-supervision-contract",
        statement: "Satisfy the evidence criterion.",
        criteria: [{ id: "verified", description: "verification passes", path: "verified", op: "equals", value: true }],
        approvalPolicy: { mode: "never" },
        maxReplans: 2,
      },
      tasks: [task("verify")],
    });
    const dispatch = expectKind(supervisor.next(created.runId), "dispatch");
    const running = supervisor.acknowledge(created.runId, acknowledge({
      kind: "dispatch",
      intentId: dispatch.intentId,
      requestKey: "objective-supervision-running",
      eventCursor: 3,
      taskUpdates: [{ taskId: "verify", state: "running", agentId: "native-verify" }],
    }));
    expect(running.latestCheckpointId).not.toBeNull();
    const evaluation = expectKind(supervisor.next(running.runId), "evaluate");
    const replanning = supervisor.acknowledge(running.runId, acknowledge({
      kind: "evaluate",
      intentId: evaluation.intentId,
      requestKey: "objective-supervision-terminal-failure",
      eventCursor: 8,
      taskUpdates: [{ taskId: "verify", state: "completed", output: { verified: false } }],
      context: { verified: false },
      reason: "The terminal agent result did not satisfy verification.",
    }));
    expect(replanning.state).toBe("replanning");
    expect(repository.checkpoints.size).toBe(2);
    expectKind(supervisor.next(replanning.runId), "replan");
  });

  it("keeps approval waits durable and does not dispatch approved-gated tasks", () => {
    const { runtime, supervisor, repository } = makeFixture();
    const created = create(runtime, {
      tasks: [task("publish", [], { requiresApproval: true })],
    });
    const wait = expectKind(supervisor.next(created.runId), "wait-for-approval");
    expect(repository.approvals.get(wait.approvalId)?.status).toBe("requested");
    expect(supervisor.next(created.runId)).toEqual(wait);
    expect(supervisor.next(created.runId).kind).not.toBe("dispatch");
  });

  it("rejects steering by a foreign lower-authority actor", () => {
    const first = makeFixture();
    const created = create(first.runtime, {
      tasks: [task("write", [], { permissions: "full-access" })],
    });
    const dispatch = expectKind(first.supervisor.next(created.runId), "dispatch");
    const foreign = new ObjectiveSupervisor(first.runtime, first.repository, { authority: foreignReadOnlyAuthority });

    expect(() => foreign.acknowledge(created.runId, acknowledge({
      kind: "dispatch",
      intentId: dispatch.intentId,
      requestKey: "foreign-objective-steering",
      eventCursor: 1,
      taskUpdates: [{ taskId: "write", state: "running", agentId: "foreign-native" }],
    }))).toThrow(/authority|permission/i);
    expect(first.runtime.get(created.runId).tasks[0]?.state).toBe("queued");
  });
});
