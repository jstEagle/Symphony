import { describe, expect, it } from "vitest";
import {
  ObjectiveRuntime,
  type ObjectiveActionReceipt,
  type ObjectiveRepository,
} from "../packages/workflow/src/objective-runtime.js";
import {
  ObjectiveSupervisor,
  type ObjectiveSupervisorAcknowledgement,
} from "../packages/workflow/src/objective-supervisor.js";
import type {
  ObjectiveApprovalRecord,
  ObjectiveCheckpointRecord,
  ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";

class MemoryObjectiveRepository implements ObjectiveRepository {
  readonly runs = new Map<string, ObjectiveRunRecord>();
  readonly receipts = new Map<string, ObjectiveActionReceipt>();
  readonly checkpoints = new Map<string, ObjectiveCheckpointRecord>();
  readonly approvals = new Map<string, ObjectiveApprovalRecord>();

  getObjectiveRun(runId: string): ObjectiveRunRecord | null { return this.runs.get(runId) ?? null; }
  getObjectiveRunByRequestKey(requestKey: string): ObjectiveRunRecord | null {
    return [...this.runs.values()].find((run) => run.requestKey === requestKey) ?? null;
  }
  saveObjectiveRun(run: ObjectiveRunRecord): void {
    const current = this.runs.get(run.runId);
    if (current && run.activePlanRevision < current.activePlanRevision) {
      throw new Error("objective run compare-and-swap lost");
    }
    this.runs.set(run.runId, run);
  }
  getObjectiveActionReceipt(requestKey: string): ObjectiveActionReceipt | null { return this.receipts.get(requestKey) ?? null; }
  saveObjectiveActionReceipt(receipt: ObjectiveActionReceipt): boolean {
    if (this.receipts.has(receipt.requestKey)) return false;
    this.receipts.set(receipt.requestKey, receipt);
    return true;
  }
  getObjectiveCheckpoint(_runId: string, checkpointId: string): ObjectiveCheckpointRecord | null { return this.checkpoints.get(checkpointId) ?? null; }
  appendObjectiveCheckpoint(checkpoint: ObjectiveCheckpointRecord): boolean {
    if (this.checkpoints.has(checkpoint.id)) return false;
    this.checkpoints.set(checkpoint.id, checkpoint);
    return true;
  }
  getObjectiveApproval(_runId: string, approvalId: string): ObjectiveApprovalRecord | null { return this.approvals.get(approvalId) ?? null; }
  saveObjectiveApproval(approval: ObjectiveApprovalRecord): boolean {
    const current = this.approvals.get(approval.id);
    if (current && current.status !== "requested") {
      if (JSON.stringify(current) === JSON.stringify(approval)) return false;
      throw new Error("approval compare-and-swap lost");
    }
    this.approvals.set(approval.id, approval);
    return true;
  }
  withDurableTransaction<T>(callback: () => T): T {
    const runs = new Map(this.runs);
    const receipts = new Map(this.receipts);
    const checkpoints = new Map(this.checkpoints);
    const approvals = new Map(this.approvals);
    try {
      return callback();
    } catch (error) {
      this.runs.clear();
      for (const [key, value] of runs) this.runs.set(key, value);
      this.receipts.clear();
      for (const [key, value] of receipts) this.receipts.set(key, value);
      this.checkpoints.clear();
      for (const [key, value] of checkpoints) this.checkpoints.set(key, value);
      this.approvals.clear();
      for (const [key, value] of approvals) this.approvals.set(key, value);
      throw error;
    }
  }
}

const authority = {
  actor: { type: "system" as const, id: "objective-supervisor-test" },
  permissionCeiling: "full-access" as const,
};

function task(id: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    id,
    objective: `Complete ${id}`,
    dependsOn,
    outputSchema: {},
    model: "fixture",
    harness: "auto" as const,
    inputs: [],
    requiresApproval: false,
    ...extra,
  };
}

function spec(overrides: Record<string, unknown> = {}) {
  return {
    id: "objective-supervisor-1",
    statement: "Complete the bounded objective.",
    criteria: [],
    approvalPolicy: { mode: "never" as const },
    maxReplans: 2,
    ...overrides,
  };
}

function harness(repository = new MemoryObjectiveRepository()) {
  let id = 0;
  let tick = 0;
  const runtime = new ObjectiveRuntime(repository, {
    id: () => `objective-id-${++id}`,
    now: () => `2026-09-01T00:00:0${++tick}.000Z`,
  });
  const supervisor = new ObjectiveSupervisor(runtime, repository, { authority });
  return { repository, runtime, supervisor };
}

function create(runtime: ObjectiveRuntime, input: Record<string, unknown> = {}) {
  return runtime.create({
    runId: "objective-run-1",
    objectiveId: "objective-supervisor-1",
    workflowId: "workflow-1",
    workflowRevision: 1,
    workflowHash: "workflow-hash-1",
    spec: spec(),
    requestKey: "objective-create-1",
    ...input,
  }, authority);
}

function ack(input: ObjectiveSupervisorAcknowledgement): ObjectiveSupervisorAcknowledgement {
  return input;
}

describe("ObjectiveSupervisor", () => {
  it("restarts from the durable frontier and requires a checkpoint acknowledgement", () => {
    const { runtime, repository, supervisor } = harness();
    const run = create(runtime, { tasks: [task("build"), task("verify", ["build"]) ] });
    const dispatch = supervisor.next(run.runId);
    expect(dispatch.kind).toBe("dispatch");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");

    const restarted = harness(repository).supervisor;
    expect(restarted.next(run.runId)).toEqual(dispatch);
    const running = supervisor.acknowledge(run.runId, ack({
      kind: "dispatch",
      intentId: dispatch.intentId,
      requestKey: "dispatch-build-ack",
      eventCursor: 2,
      taskUpdates: [{ taskId: "build", state: "running", agentId: "native-build" }],
    }));
    expect(running.tasks.find((record) => record.task.id === "build")?.state).toBe("running");
    expect(restarted.next(run.runId).kind).toBe("evaluate");
  });

  it("dispatches a parallel frontier together and finishes after evaluation", () => {
    const { runtime, supervisor } = harness();
    const run = create(runtime, {
      tasks: [task("lint"), task("unit"), task("package", ["lint", "unit"])],
    });
    const dispatch = supervisor.next(run.runId);
    expect(dispatch.kind).toBe("dispatch");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    expect(dispatch.taskIds).toEqual(["lint", "unit"]);

    const evaluating = supervisor.acknowledge(run.runId, ack({
      kind: "dispatch",
      intentId: dispatch.intentId,
      requestKey: "parallel-dispatch-ack",
      eventCursor: 4,
      taskUpdates: [
        { taskId: "lint", state: "completed", output: { ok: true } },
        { taskId: "unit", state: "completed", output: { ok: true } },
      ],
    }));
    expect(evaluating.state).toBe("executing");
    const next = supervisor.next(run.runId);
    expect(next.kind).toBe("dispatch");
    if (next.kind !== "dispatch") throw new Error("expected dependent dispatch");
    expect(next.taskIds).toEqual(["package"]);

    const completed = supervisor.acknowledge(run.runId, ack({
      kind: "dispatch",
      intentId: next.intentId,
      requestKey: "parallel-package-ack",
      eventCursor: 7,
      taskUpdates: [{ taskId: "package", state: "completed" }],
    }));
    expect(completed.state).toBe("succeeded");
    expect(supervisor.next(run.runId).kind).toBe("finish");
  });

  it("turns a failed task into a bounded replacement plan", () => {
    const { runtime, supervisor } = harness();
    const run = create(runtime, { tasks: [task("build")] });
    const dispatch = supervisor.next(run.runId);
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    const failed = supervisor.acknowledge(run.runId, ack({
      kind: "dispatch",
      intentId: dispatch.intentId,
      requestKey: "failed-build-ack",
      eventCursor: 3,
      taskUpdates: [{ taskId: "build", state: "failed", error: "compile failed" }],
    }));
    expect(failed.state).toBe("failed");

    const replan = supervisor.next(run.runId);
    expect(replan.kind).toBe("replan");
    if (replan.kind !== "replan") throw new Error("expected replan");
    const revised = supervisor.acknowledge(run.runId, ack({
      kind: "replan",
      intentId: replan.intentId,
      requestKey: "failed-build-replan",
      reason: "Retry the failed build with a smaller change.",
      tasks: [task("retry-build")],
    }));
    expect(revised.activePlanRevision).toBe(1);
    expect(revised.replanCount).toBe(1);
    expect(revised.tasks.find((record) => record.task.id === "build")?.state).toBe("superseded");

    const retry = supervisor.next(run.runId);
    expect(retry.kind).toBe("dispatch");
    if (retry.kind !== "dispatch") throw new Error("expected retry dispatch");
    const completed = supervisor.acknowledge(run.runId, ack({
      kind: "dispatch",
      intentId: retry.intentId,
      requestKey: "retry-build-ack",
      eventCursor: 6,
      taskUpdates: [{ taskId: "retry-build", state: "completed" }],
    }));
    expect(completed.state).toBe("succeeded");
    expect(runtime.frontier(completed)).toHaveLength(0);
  });

  it("waits for plan and completion approvals as durable intents", () => {
    const { runtime, repository, supervisor } = harness();
    const run = create(runtime, {
      spec: spec({ approvalPolicy: { mode: "before-completion" } }),
      tasks: [task("ship", [], { requiresApproval: true })],
    });
    const planWait = supervisor.next(run.runId);
    expect(planWait.kind).toBe("wait-for-approval");
    if (planWait.kind !== "wait-for-approval") throw new Error("expected plan approval");
    expect(repository.approvals.get(planWait.approvalId)?.status).toBe("requested");

    const opened = supervisor.acknowledge(run.runId, ack({
      kind: "wait-for-approval",
      intentId: planWait.intentId,
      requestKey: "plan-approval-ack",
      approvalId: planWait.approvalId,
      status: "approved",
      decision: "go",
    }));
    const dispatch = supervisor.next(opened.runId);
    expect(dispatch.kind).toBe("dispatch");
    if (dispatch.kind !== "dispatch") throw new Error("expected approved dispatch");
    const awaitingCompletion = supervisor.acknowledge(run.runId, ack({
      kind: "dispatch",
      intentId: dispatch.intentId,
      requestKey: "ship-completed-ack",
      eventCursor: 9,
      taskUpdates: [{ taskId: "ship", state: "completed" }],
    }));
    const completionWait = supervisor.next(awaitingCompletion.runId);
    expect(completionWait.kind).toBe("wait-for-approval");
    if (completionWait.kind !== "wait-for-approval") throw new Error("expected completion approval");
    const succeeded = supervisor.acknowledge(run.runId, ack({
      kind: "wait-for-approval",
      intentId: completionWait.intentId,
      requestKey: "completion-approval-ack",
      approvalId: completionWait.approvalId,
      status: "approved",
    }));
    expect(succeeded.state).toBe("succeeded");
  });

  it("rejects stale acknowledgements and replays an idempotent acknowledgement", () => {
    const { runtime, repository, supervisor } = harness();
    const run = create(runtime, { tasks: [task("build")] });
    const dispatch = supervisor.next(run.runId);
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch");
    const input = ack({
      kind: "dispatch",
      intentId: dispatch.intentId,
      requestKey: "stable-dispatch-ack",
      eventCursor: 2,
      taskUpdates: [{ taskId: "build", state: "running" }],
    });
    const first = supervisor.acknowledge(run.runId, input);
    expect(supervisor.acknowledge(run.runId, input)).toEqual(first);
    expect(repository.receipts.get(input.requestKey)?.kind).toBe("objective.supervisor.ack");

    expect(() => supervisor.acknowledge(run.runId, {
      ...input,
      requestKey: "stale-dispatch-ack",
    })).toThrow(/stale/);

    const current = supervisor.next(run.runId);
    expect(current.intentId).not.toBe(dispatch.intentId);
    expect(() => supervisor.acknowledge(run.runId, {
      ...input,
      intentId: current.intentId,
      requestKey: "conflicting-dispatch-ack",
      taskUpdates: [{ taskId: "unknown", state: "running" }],
    })).toThrow(/kind dispatch does not match evaluate/);
  });
});
