import { describe, expect, it } from "vitest";
import {
  ObjectiveRuntime,
  ObjectiveRuntimeError,
  type ObjectiveActionReceipt,
  type ObjectiveRepository,
} from "../packages/workflow/src/objective-runtime.js";
import { ObjectiveApprovalExpiryProcessor } from "../packages/workflow/src/objective-approval-expiry.js";
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
  saveObjectiveRun(run: ObjectiveRunRecord): void { this.runs.set(run.runId, run); }
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
    if (this.approvals.has(approval.id) && this.approvals.get(approval.id)?.status !== "requested") {
      this.approvals.set(approval.id, approval);
      return true;
    }
    this.approvals.set(approval.id, approval);
    return true;
  }
}

class TransactionalMemoryObjectiveRepository extends MemoryObjectiveRepository {
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

class FailingReceiptRepository extends TransactionalMemoryObjectiveRepository {
  saveObjectiveActionReceipt(_receipt: ObjectiveActionReceipt): boolean {
    throw new Error("receipt write failed");
  }
}

const authority = {
  actor: { type: "agent" as const, id: "conductor-1" },
  permissionCeiling: "full-access" as const,
};
const readOnlyAuthority = {
  actor: { type: "agent" as const, id: "read-only-agent" },
  permissionCeiling: "read-only" as const,
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
    id: "objective-1",
    statement: "Ship the objective and prove it works.",
    criteria: [{ id: "verified", description: "The result is verified.", path: "verification.passed", op: "equals" as const, value: true }],
    approvalPolicy: { mode: "never" as const },
    maxReplans: 1,
    ...overrides,
  };
}

function makeRuntime(repository = new MemoryObjectiveRepository()) {
  let id = 0;
  let tick = 0;
  return {
    repository,
    runtime: new ObjectiveRuntime(repository, {
      id: () => `id-${++id}`,
      now: () => `2026-09-01T00:00:0${++tick}.000Z`,
    }),
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    objectiveId: "objective-1",
    workflowId: "workflow-1",
    workflowRevision: 1,
    workflowHash: "workflow-hash-1",
    spec: spec(),
    requestKey: "create-request-1",
    ...overrides,
  };
}

describe("ObjectiveRuntime", () => {
  it("creates durably, replays idempotently, and exposes the dependency frontier", () => {
    const { runtime, repository } = makeRuntime();
    const initialTasks = [task("build"), task("verify", ["build"]) ];
    const created = runtime.create(createInput({ tasks: initialTasks }), authority);
    expect(created.state).toBe("executing");
    expect(created.activePlanRevision).toBe(0);
    expect(runtime.frontier(created).map((record) => record.task.id)).toEqual(["build"]);
    expect(runtime.create(createInput({ tasks: initialTasks }), authority)).toEqual(created);
    expect(repository.receipts.get("create-request-1")?.kind).toBe("objective.create");
  });

  it("fences authority, revision, missing dependencies, and cycles", () => {
    const { runtime } = makeRuntime();
    expect(() => runtime.create(createInput({ tasks: [task("write", [], { permissions: "full-access" })] }), readOnlyAuthority)).toThrowError(ObjectiveRuntimeError);
    const created = runtime.create(createInput({ tasks: [task("build")] }), authority);
    expect(() => runtime.commitPlan(created.runId, { expectedPlanRevision: 1, tasks: [task("verify")], requestKey: "revision-request" }, authority)).toThrow(/revision conflict/);
    expect(() => runtime.commitPlan(created.runId, { expectedPlanRevision: 0, tasks: [task("verify", ["missing"])], requestKey: "missing-request" }, authority)).toThrow(/does not exist/);
    expect(() => runtime.commitPlan(created.runId, { expectedPlanRevision: 0, tasks: [task("one", ["two"]), task("two", ["one"])], requestKey: "cycle-request" }, authority)).toThrow(/cycle/);
  });

  it("checkpoints task progress, evaluates criteria, and records evidence state", () => {
    const { runtime, repository } = makeRuntime();
    const created = runtime.create(createInput({ tasks: [task("build"), task("verify", ["build"]) ] }), authority);
    const afterBuild = runtime.checkpoint(created.runId, {
      eventCursor: 4,
      taskUpdates: [{ taskId: "build", state: "completed", output: { changed: true } }],
      context: { verification: { passed: false } },
      reason: "Build completed; verification remains.",
      requestKey: "checkpoint-build",
    }, authority);
    expect(afterBuild.state).toBe("executing");
    expect(runtime.frontier(afterBuild).map((record) => record.task.id)).toEqual(["verify"]);
    const completed = runtime.checkpoint(created.runId, {
      eventCursor: 7,
      taskUpdates: [{ taskId: "verify", state: "completed", output: { passed: true } }],
      context: { verification: { passed: true } },
      reason: "Verification passed.",
      requestKey: "checkpoint-verified",
    }, authority);
    expect(completed.state).toBe("succeeded");
    expect(completed.output).toEqual({ verification: { passed: true } });
    expect(repository.checkpoints.size).toBe(2);
    expect(runtime.checkpoint(created.runId, {
      eventCursor: 7,
      taskUpdates: [{ taskId: "verify", state: "completed", output: { passed: true } }],
      context: { verification: { passed: true } },
      reason: "Verification passed.",
      requestKey: "checkpoint-verified",
    }, authority)).toEqual(completed);
    expect(repository.checkpoints.size).toBe(2);
  });

  it("merges checkpoint context patches durably and replays them after later updates", () => {
    const { runtime } = makeRuntime();
    const created = runtime.create(createInput({
      context: {
        verification: { passed: false },
        retained: "from-create",
        nullable: "before",
      },
      tasks: [task("build"), task("verify", ["build"])],
    }), authority);

    const afterBuild = runtime.checkpoint(created.runId, {
      eventCursor: 4,
      context: {
        verification: { passed: true },
        nullable: null,
      },
      taskUpdates: [{ taskId: "build", state: "completed" }],
      reason: "Build completed and verification evidence arrived.",
      requestKey: "checkpoint-context-merge",
    }, authority);
    expect(afterBuild.context).toEqual({
      verification: { passed: true },
      retained: "from-create",
      nullable: null,
    });

    const completed = runtime.checkpoint(created.runId, {
      eventCursor: 5,
      // The verification key is omitted intentionally. Its previous value
      // must survive so criteria can be evaluated against durable context.
      context: { later: "evidence" },
      taskUpdates: [{ taskId: "verify", state: "completed" }],
      reason: "Verification completed with the accumulated evidence.",
      requestKey: "checkpoint-context-merge-final",
    }, authority);
    expect(completed.state).toBe("succeeded");
    expect(completed.context).toEqual({
      verification: { passed: true },
      retained: "from-create",
      nullable: null,
      later: "evidence",
    });

    // The request fingerprint is based on the patch, not the mutable
    // accumulated context, so retrying the first request remains a replay.
    expect(runtime.checkpoint(created.runId, {
      eventCursor: 4,
      context: {
        verification: { passed: true },
        nullable: null,
      },
      taskUpdates: [{ taskId: "build", state: "completed" }],
      reason: "Build completed and verification evidence arrived.",
      requestKey: "checkpoint-context-merge",
    }, authority)).toEqual(completed);
  });

  it("rejects stale evidence cursors and task-state rollback", () => {
    const { runtime } = makeRuntime();
    const created = runtime.create(createInput({ tasks: [task("build"), task("verify", ["build"]) ] }), authority);
    const running = runtime.checkpoint(created.runId, {
      eventCursor: 5,
      taskUpdates: [{ taskId: "build", state: "running" }],
      reason: "Build started.",
      requestKey: "checkpoint-running",
    }, authority);

    expect(() => runtime.checkpoint(created.runId, {
      eventCursor: 4,
      taskUpdates: [{ taskId: "build", state: "running" }],
      reason: "A stale worker update.",
      requestKey: "checkpoint-stale-cursor",
    }, authority)).toThrow(/behind durable cursor/);
    expect(() => runtime.checkpoint(created.runId, {
      eventCursor: 6,
      taskUpdates: [{ taskId: "build", state: "queued" }],
      reason: "A stale worker state.",
      requestKey: "checkpoint-state-rollback",
    }, authority)).toThrow(/cannot transition/);

    const completed = runtime.checkpoint(running.runId, {
      eventCursor: 6,
      taskUpdates: [{ taskId: "build", state: "completed" }],
      reason: "Build completed.",
      requestKey: "checkpoint-completed",
    }, authority);
    expect(() => runtime.checkpoint(completed.runId, {
      eventCursor: 7,
      taskUpdates: [{ taskId: "build", state: "failed" }],
      reason: "A late failure for a completed task.",
      requestKey: "checkpoint-late-failure",
    }, authority)).toThrow(/cannot transition/);
  });

  it("marks failed descendants blocked and bounds replanning", () => {
    const { runtime } = makeRuntime();
    const created = runtime.create(createInput({ tasks: [task("build"), task("verify", ["build"]) ] }), authority);
    const failed = runtime.checkpoint(created.runId, {
      eventCursor: 2,
      taskUpdates: [{ taskId: "build", state: "failed", error: "compile failed" }],
      reason: "The build failed.",
      requestKey: "checkpoint-failed",
    }, authority);
    expect(failed.state).toBe("failed");
    expect(failed.tasks.find((record) => record.task.id === "verify")?.state).toBe("blocked");

    const retryRuntime = makeRuntime();
    const retry = retryRuntime.runtime.create(createInput({ tasks: [task("build")] }), authority);
    const replanning = retryRuntime.runtime.checkpoint(retry.runId, {
      eventCursor: 3,
      taskUpdates: [{ taskId: "build", state: "completed" }],
      context: { verification: { passed: false } },
      reason: "The first attempt completed but the criterion is not met.",
      requestKey: "checkpoint-replan",
    }, authority);
    expect(replanning.state).toBe("replanning");
    const revised = retryRuntime.runtime.commitPlan(retry.runId, { expectedPlanRevision: 0, tasks: [task("fix", ["build"])], requestKey: "plan-revision-1" }, authority);
    expect(revised.activePlanRevision).toBe(1);
    expect(revised.replanCount).toBe(1);
    expect(() => retryRuntime.runtime.commitPlan(retry.runId, { expectedPlanRevision: 1, tasks: [task("too-late")], requestKey: "plan-revision-2" }, authority)).toThrow(/replan allowance/);
    const fixed = retryRuntime.runtime.checkpoint(retry.runId, {
      eventCursor: 5,
      taskUpdates: [{ taskId: "fix", state: "completed" }],
      context: { verification: { passed: true } },
      reason: "The bounded replan fixed the criterion.",
      requestKey: "checkpoint-fixed",
    }, authority);
    expect(fixed.state).toBe("succeeded");
  });

  it("blocks plans and completion behind approvals, then resolves them deterministically", () => {
    const { runtime, repository } = makeRuntime();
    const created = runtime.create(createInput({ spec: spec({ approvalPolicy: { mode: "before-completion" } }) }), authority);
    const planned = runtime.commitPlan(created.runId, {
      expectedPlanRevision: 0,
      tasks: [task("ship", [], { requiresApproval: true })],
      reason: "Request approval for the execution plan.",
      requestKey: "approval-plan-request",
    }, authority);
    expect(planned.state).toBe("awaiting-approval");
    expect(planned.pendingApprovalId).not.toBeNull();
    const planApprovalId = planned.pendingApprovalId as string;
    const opened = runtime.resolveApproval(planned.runId, planApprovalId, { status: "approved", decision: "go", requestKey: "approval-plan-resolution" }, authority);
    expect(opened.state).toBe("executing");
    expect(opened.finishedAt).toBeNull();
    expect(opened.tasks[0]?.state).toBe("queued");
    const awaitingCompletion = runtime.checkpoint(opened.runId, {
      eventCursor: 9,
      taskUpdates: [{ taskId: "ship", state: "completed" }],
      context: { verification: { passed: true } },
      reason: "The objective is ready for final approval.",
      requestKey: "approval-completion-request",
    }, authority);
    expect(awaitingCompletion.state).toBe("awaiting-approval");
    const completionApprovalId = awaitingCompletion.pendingApprovalId as string;
    const succeeded = runtime.resolveApproval(awaitingCompletion.runId, completionApprovalId, { status: "approved", requestKey: "approval-completion-resolution" }, authority);
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.finishedAt).not.toBeNull();
    expect(repository.approvals.get(completionApprovalId)?.status).toBe("approved");
    expect(runtime.resolveApproval(awaitingCompletion.runId, completionApprovalId, { status: "approved", requestKey: "approval-completion-resolution" }, authority)).toEqual(succeeded);
  });

  it("does not allow a pending approval to be replaced by a later plan", () => {
    const { runtime } = makeRuntime();
    const created = runtime.create(createInput({ tasks: [task("ship", [], { requiresApproval: true })] }), authority);
    expect(created.pendingApprovalId).not.toBeNull();
    expect(() => runtime.commitPlan(created.runId, {
      expectedPlanRevision: 0,
      tasks: [task("bypass")],
      reason: "Attempt to replace the gated plan.",
      requestKey: "approval-bypass-plan",
    }, authority)).toThrow(/pending approval/);
    expect(runtime.get(created.runId)).toEqual(created);
  });

  it("does not let manual completion approval bypass task or criterion readiness", () => {
    const { runtime } = makeRuntime();
    const created = runtime.create(createInput({ spec: spec({ maxReplans: 0 }), tasks: [task("ship")] }), authority);
    expect(() => runtime.requestApproval(created.runId, {
      kind: "completion",
      question: "Approve an incomplete objective.",
      operationId: "premature-completion",
      requestHash: "premature-request-hash",
      policyHash: "premature-policy-hash",
      sideEffectClass: "local",
      canonicalTarget: "objective/objective-1",
      requestKey: "premature-approval-request",
    }, authority)).toThrow(/not ready/);

    const completed = runtime.checkpoint(created.runId, {
      eventCursor: 1,
      taskUpdates: [{ taskId: "ship", state: "completed" }],
      reason: "The task completed without satisfying verification.",
      requestKey: "premature-completion-checkpoint",
    }, authority);
    expect(completed.state).toBe("failed");
    expect(() => runtime.requestApproval(completed.runId, {
      kind: "completion",
      question: "Approve a terminal objective.",
      operationId: "terminal-completion",
      requestHash: "terminal-request-hash",
      policyHash: "terminal-policy-hash",
      sideEffectClass: "local",
      canonicalTarget: "objective/objective-1",
      requestKey: "terminal-approval-request",
    }, authority)).toThrow(/not ready|already failed/);
  });

  it("does not allow evidence context to change while completion approval is pending", () => {
    const { runtime } = makeRuntime();
    const created = runtime.create(createInput({
      spec: spec({ approvalPolicy: { mode: "before-completion" } }),
      tasks: [task("ship")],
    }), authority);
    const awaiting = runtime.checkpoint(created.runId, {
      eventCursor: 1,
      taskUpdates: [{ taskId: "ship", state: "completed" }],
      context: { verification: { passed: true } },
      reason: "The objective passed its criteria.",
      requestKey: "completion-pending-checkpoint",
    }, authority);
    expect(awaiting.state).toBe("awaiting-approval");
    expect(() => runtime.checkpoint(awaiting.runId, {
      eventCursor: 2,
      context: { verification: { passed: false } },
      reason: "Attempt to alter evidence under approval.",
      requestKey: "completion-pending-tamper",
    }, authority)).toThrow(/while approval .* pending/);
  });

  it("settles an expired approval as expired instead of leaving the run stuck", () => {
    const { runtime, repository } = makeRuntime();
    const created = runtime.create(createInput(), authority);
    const pending = runtime.requestApproval(created.runId, {
      kind: "plan",
      question: "Approve the completion boundary.",
      operationId: "completion-operation",
      requestHash: "completion-request-hash",
      policyHash: "completion-policy-hash",
      sideEffectClass: "external",
      canonicalTarget: "objective/objective-1",
      expiresAt: "2026-09-01T00:00:03.000Z",
      requestKey: "approval-expiry-request",
    }, authority);
    const expired = runtime.resolveApproval(pending.runId, pending.pendingApprovalId as string, {
      status: "expired",
      requestKey: "approval-expiry-resolution",
    }, authority);
    expect(expired.state).toBe("failed");
    expect(expired.pendingApprovalId).toBeNull();
    expect(repository.approvals.get(pending.pendingApprovalId as string)?.status).toBe("expired");
  });

  it("derives policy approval timeouts and expires them exactly once across a restart", () => {
    const repository = new TransactionalMemoryObjectiveRepository();
    let now = "2026-09-01T00:00:00.000Z";
    const runtime = new ObjectiveRuntime(repository, {
      id: (() => {
        let id = 0;
        return () => `timeout-id-${++id}`;
      })(),
      now: () => now,
    });
    const created = runtime.create(createInput({
      policy: {
        approvalPolicy: { mode: "on-replan", timeoutSeconds: 5 },
      },
    }), authority);
    const pending = runtime.requestApproval(created.runId, {
      kind: "plan",
      question: "Approve the next plan.",
      operationId: "timeout-plan",
      requestHash: "timeout-request-hash",
      policyHash: created.policyHash as string,
      sideEffectClass: "local",
      canonicalTarget: "objective/objective-1/plan",
      requestKey: "timeout-approval-request",
    }, authority);
    expect(repository.approvals.get(pending.pendingApprovalId as string)?.expiresAt).toBe("2026-09-01T00:00:05.000Z");

    const expiryStore = {
      listObjectiveApprovals: (options: { status?: ObjectiveApprovalRecord["status"][]; expiresAtLte?: string; limit?: number }) => [...repository.approvals.values()]
        .filter((approval) => options.status?.includes(approval.status) ?? true)
        .filter((approval) => approval.expiresAt !== null && (options.expiresAtLte === undefined || Date.parse(approval.expiresAt) <= Date.parse(options.expiresAtLte)))
        .sort((left, right) => Date.parse(left.expiresAt as string) - Date.parse(right.expiresAt as string))
        .slice(0, options.limit),
    };
    now = "2026-09-01T00:00:06.000Z";
    const firstPass = new ObjectiveApprovalExpiryProcessor(runtime, repository, expiryStore, { now: () => now });
    expect(firstPass.expireRequested()).toHaveLength(1);
    expect(repository.approvals.get(pending.pendingApprovalId as string)?.status).toBe("expired");

    // A newly-created processor represents a daemon restart. The durable
    // resolution receipt and status projection leave nothing to settle again.
    const restartedPass = new ObjectiveApprovalExpiryProcessor(runtime, repository, expiryStore, { now: () => now });
    expect(restartedPass.expireRequested()).toHaveLength(0);
    expect(repository.approvals.get(pending.pendingApprovalId as string)?.status).toBe("expired");
  });

  it("cannot starve a later expired approval behind older non-expiring requests", () => {
    const repository = new TransactionalMemoryObjectiveRepository();
    let now = "2026-09-01T00:00:10.000Z";
    const runtime = new ObjectiveRuntime(repository, {
      id: (() => {
        let id = 0;
        return () => `starvation-id-${++id}`;
      })(),
      now: () => now,
    });
    const created = runtime.create(createInput({
      policy: { approvalPolicy: { mode: "on-replan", timeoutSeconds: 1 } },
    }), authority);
    const pending = runtime.requestApproval(created.runId, {
      kind: "plan",
      question: "Approve the plan.",
      operationId: "starvation-plan",
      requestHash: "starvation-request-hash",
      policyHash: created.policyHash as string,
      sideEffectClass: "local",
      canonicalTarget: "objective/objective-1/plan",
      requestKey: "starvation-approval-request",
    }, authority);
    now = "2026-09-01T00:00:12.000Z";
    const expired = repository.approvals.get(pending.pendingApprovalId as string) as ObjectiveApprovalRecord;
    const olderNonExpired = Array.from({ length: 3 }, (_, index) => ({
      ...expired,
      id: `older-request-${index}`,
      operationId: `older-operation-${index}`,
      requestHash: `older-request-hash-${index}`,
      expiresAt: "2026-09-01T00:01:00.000Z",
      requestKey: `older-request-key-${index}`,
    }));
    const candidates = [...olderNonExpired, expired];
    const requestedQueries: Array<{ expiresAtLte?: string; limit?: number }> = [];
    const expiryStore = {
      listObjectiveApprovals: (options: { status?: ObjectiveApprovalRecord["status"][]; expiresAtLte?: string; limit?: number }) => {
        requestedQueries.push(options);
        return candidates
          .filter((approval) => options.status?.includes(approval.status) ?? true)
          .filter((approval) => approval.expiresAt !== null && Date.parse(approval.expiresAt) <= Date.parse(options.expiresAtLte as string))
          .sort((left, right) => Date.parse(left.expiresAt as string) - Date.parse(right.expiresAt as string))
          .slice(0, options.limit);
      },
    };
    const processor = new ObjectiveApprovalExpiryProcessor(runtime, repository, expiryStore, { now: () => now, scanLimit: 3 });
    expect(processor.expireRequested()).toHaveLength(1);
    expect(requestedQueries).toEqual([{ status: ["requested"], expiresAtLte: now, limit: 3 }]);
    expect(repository.approvals.get(expired.id)?.status).toBe("expired");
  });

  it("rolls back the whole action when the receipt write fails", () => {
    const repository = new FailingReceiptRepository();
    const { runtime } = makeRuntime(repository);
    expect(() => runtime.create(createInput(), authority)).toThrow("receipt write failed");
    expect(repository.runs.size).toBe(0);
    expect(repository.receipts.size).toBe(0);
  });
});
