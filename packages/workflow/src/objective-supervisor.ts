import { createHash } from "node:crypto";
import {
  ObjectiveActorSchema,
  PermissionSchema,
  resolveChildPermission,
  type JsonValue,
  type ObjectiveApprovalRecord,
  type ObjectiveRunRecord,
  type ObjectiveTask,
  type ObjectiveTaskRecord,
} from "@symphony/protocol";
import {
  ObjectiveRuntimeError,
  type ObjectiveActionReceipt,
  type ObjectiveRepository,
  type ObjectiveRuntime,
  type ObjectiveRuntimeAuthority,
  type ObjectiveTaskUpdate,
} from "./objective-runtime.js";

/**
 * The supervisor is deliberately a decision kernel, not an executor. It
 * reads the durable objective projection, emits one deterministic intent, and
 * waits for an explicit acknowledgement from the daemon/native-harness
 * boundary before deriving the next intent.
 */

export type ObjectiveSupervisorIntentBase = Readonly<{
  runId: string;
  objectiveId: string;
  planRevision: number;
  intentId: string;
  /** Stable key a daemon may use when claiming its dispatch/checkpoint work. */
  acknowledgementKey: string;
}>;

export type ObjectiveSupervisorDispatchIntent = ObjectiveSupervisorIntentBase & Readonly<{
  kind: "dispatch";
  tasks: ObjectiveTaskRecord[];
  taskIds: string[];
  expectedEventCursor: number;
}>;

export type ObjectiveSupervisorEvaluateIntent = ObjectiveSupervisorIntentBase & Readonly<{
  kind: "evaluate";
  taskIds: string[];
  expectedEventCursor: number;
}>;

export type ObjectiveSupervisorReplanIntent = ObjectiveSupervisorIntentBase & Readonly<{
  kind: "replan";
  failedTaskIds: string[];
  replanCount: number;
  remainingReplans: number;
  reason: string;
}>;

export type ObjectiveSupervisorApprovalIntent = ObjectiveSupervisorIntentBase & Readonly<{
  kind: "wait-for-approval";
  approvalId: string;
  approval: ObjectiveApprovalRecord;
}>;

export type ObjectiveSupervisorFinishIntent = ObjectiveSupervisorIntentBase & Readonly<{
  kind: "finish";
  state: Extract<ObjectiveRunRecord["state"], "succeeded" | "failed" | "cancelled" | "interrupted">;
  output: JsonValue | null;
  error: string | null;
}>;

export type ObjectiveSupervisorIntent =
  | ObjectiveSupervisorDispatchIntent
  | ObjectiveSupervisorEvaluateIntent
  | ObjectiveSupervisorReplanIntent
  | ObjectiveSupervisorApprovalIntent
  | ObjectiveSupervisorFinishIntent;

  type ObjectiveSupervisorAcknowledgementBase = Readonly<{
  intentId: string;
  requestKey: string;
  /** Optional duplicate fence for callers that already carry the plan CAS. */
  expectedPlanRevision?: number;
}>;

export type ObjectiveSupervisorDispatchAcknowledgement = ObjectiveSupervisorAcknowledgementBase & Readonly<{
  kind: "dispatch";
  eventCursor: number;
  taskUpdates: readonly ObjectiveTaskUpdate[];
  context?: Readonly<Record<string, JsonValue>>;
  reason?: string;
}>;

export type ObjectiveSupervisorEvaluateAcknowledgement = ObjectiveSupervisorAcknowledgementBase & Readonly<{
  kind: "evaluate";
  eventCursor: number;
  taskUpdates?: readonly ObjectiveTaskUpdate[];
  context?: Readonly<Record<string, JsonValue>>;
  reason?: string;
}>;

export type ObjectiveSupervisorReplanAcknowledgement = ObjectiveSupervisorAcknowledgementBase & Readonly<{
  kind: "replan";
  tasks: readonly ObjectiveTask[];
  reason: string;
}>;

export type ObjectiveSupervisorApprovalAcknowledgement = ObjectiveSupervisorAcknowledgementBase & Readonly<{
  kind: "wait-for-approval";
  approvalId: string;
  status: Extract<ObjectiveApprovalRecord["status"], "approved" | "rejected" | "expired" | "cancelled">;
  decision?: JsonValue | null;
}>;

export type ObjectiveSupervisorFinishAcknowledgement = ObjectiveSupervisorAcknowledgementBase & Readonly<{
  kind: "finish";
}>;

export type ObjectiveSupervisorAcknowledgement =
  | ObjectiveSupervisorDispatchAcknowledgement
  | ObjectiveSupervisorEvaluateAcknowledgement
  | ObjectiveSupervisorReplanAcknowledgement
  | ObjectiveSupervisorApprovalAcknowledgement
  | ObjectiveSupervisorFinishAcknowledgement;

export type ObjectiveSupervisorOptions = Readonly<{
  authority: ObjectiveRuntimeAuthority;
  now?: () => string;
  /** Test/recovery hook invoked after the acknowledgement transaction commits. */
  afterAcknowledgementCommit?: () => void;
}>;

export class ObjectiveSupervisor {
  private readonly now: () => string;

  constructor(
    runtime: ObjectiveRuntime,
    repository: ObjectiveRepository,
    authority: ObjectiveRuntimeAuthority,
  );
  constructor(
    runtime: ObjectiveRuntime,
    repository: ObjectiveRepository,
    options: ObjectiveSupervisorOptions,
  );
  constructor(
    private readonly runtime: ObjectiveRuntime,
    private readonly repository: ObjectiveRepository,
    optionsOrAuthority: ObjectiveSupervisorOptions | ObjectiveRuntimeAuthority,
  ) {
    const options = "authority" in optionsOrAuthority
      ? optionsOrAuthority
      : { authority: optionsOrAuthority };
    ObjectiveSupervisor.assertAuthority(options.authority);
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private readonly options: ObjectiveSupervisorOptions;

  /**
   * Derive one action from durable state. No in-memory cursor is consulted,
   * which means a newly constructed supervisor resumes exactly where the
   * previous daemon instance left off.
   */
  next(runOrId: ObjectiveRunRecord | string): ObjectiveSupervisorIntent {
    const run = typeof runOrId === "string" ? this.runtime.get(runOrId) : runOrId;
    const latest = this.latestCheckpoint(run);
    if (run.latestCheckpointId !== null && latest === null) {
      throw new ObjectiveRuntimeError(
        `Objective ${run.runId} references missing checkpoint ${run.latestCheckpointId}.`,
        "invalid-state",
      );
    }
    const expectedEventCursor = latest?.eventCursor ?? 0;
    const frontier = this.runtime.frontier(run);
    const failedTaskIds = run.tasks
      .filter((record) => record.state === "failed" || record.state === "blocked")
      .map((record) => record.task.id);

    if (["succeeded", "failed", "cancelled", "interrupted"].includes(run.state)) {
      // A failed task is a recoverable failure while replan allowance remains.
      // Approval rejection and exhausted failures remain terminal finishes.
      if (run.state === "failed" && failedTaskIds.length > 0 && run.replanCount < run.spec.maxReplans) {
        return this.replanIntent(run, failedTaskIds);
      }
      return this.finishIntent(run);
    }

    if (run.pendingApprovalId !== null) {
      const approval = this.repository.getObjectiveApproval(run.runId, run.pendingApprovalId);
      if (!approval || approval.status !== "requested") {
        throw new ObjectiveRuntimeError(
          `Objective ${run.runId} points to a missing or settled approval.`,
          "invalid-state",
        );
      }
      return this.approvalIntent(run, approval);
    }

    if (run.state === "planning" || run.state === "replanning") {
      return this.replanIntent(run, failedTaskIds);
    }

    if (frontier.length > 0) {
      return this.dispatchIntent(run, frontier, expectedEventCursor);
    }

    // Once a dispatch has been checkpointed as running, the native harness is
    // outside this kernel. Evaluation is the explicit reconciliation boundary
    // where its observed terminal state and event cursor return to the runtime.
    return this.evaluateIntent(run, expectedEventCursor);
  }

  /** Alias useful to daemon code that names the operation as a decision. */
  decide(runOrId: ObjectiveRunRecord | string): ObjectiveSupervisorIntent {
    return this.next(runOrId);
  }

  /** Alias useful to recovery code that describes this as one bounded step. */
  step(runOrId: ObjectiveRunRecord | string): ObjectiveSupervisorIntent {
    return this.next(runOrId);
  }

  /**
   * Apply one acknowledged intent. Every mutating acknowledgement carries the
   * intent fingerprint and plan revision it observed. A stale daemon response
   * therefore fails closed instead of being applied to a newer frontier.
   */
  acknowledge(runId: string, input: ObjectiveSupervisorAcknowledgement): ObjectiveRunRecord {
    this.assertRequestKey(input.requestKey);
    const payload = this.ackPayload(runId, input);
    const existing = this.repository.getObjectiveActionReceipt(input.requestKey);
    if (existing) {
      this.assertReceipt(existing, payload);
      this.drainObjectiveEventOutbox();
      return this.runtime.get(runId);
    }

    const next = this.withDurableTransaction(() => {
      // Re-check inside the durable boundary. Another supervisor instance may
      // have advanced the run after the first read above.
      const racedReceipt = this.repository.getObjectiveActionReceipt(input.requestKey);
      if (racedReceipt) {
        this.assertReceipt(racedReceipt, payload);
        return this.runtime.get(runId);
      }

      const run = this.runtime.get(runId);
      const intent = this.next(run);
      if (intent.intentId !== input.intentId) {
        throw new ObjectiveRuntimeError(
          `Objective acknowledgement ${input.requestKey} is stale for ${runId}.`,
          "revision-conflict",
        );
      }
      if (input.expectedPlanRevision !== undefined && input.expectedPlanRevision !== run.activePlanRevision) {
        throw new ObjectiveRuntimeError(
          `Objective acknowledgement expected plan revision ${input.expectedPlanRevision}, actual ${run.activePlanRevision}.`,
          "revision-conflict",
        );
      }
      if (input.kind !== intent.kind) {
        throw new ObjectiveRuntimeError(
          `Objective acknowledgement kind ${input.kind} does not match ${intent.kind}.`,
          "invalid-state",
        );
      }

      const next = this.applyAcknowledgement(run, intent, input);
      this.appendAcknowledgementEvent(run, next, input);
      const receipt: ObjectiveActionReceipt = {
        requestKey: input.requestKey,
        kind: "objective.supervisor.ack",
        fingerprint: fingerprint(payload),
        result: {
          runId,
          intentId: input.intentId,
          kind: input.kind,
          state: next.state,
          planRevision: next.activePlanRevision,
        },
        createdAt: this.now(),
      };
      this.saveReceipt(receipt);
      return next;
    });
    // Publishing is deliberately outside the state transaction. If the
    // process dies at this exact boundary, the durable receipt and outbox
    // intent survive and a restarted runner can replay them without creating
    // a second semantic event.
    this.options.afterAcknowledgementCommit?.();
    this.drainObjectiveEventOutbox();
    return next;
  }

  private appendAcknowledgementEvent(
    previous: ObjectiveRunRecord,
    next: ObjectiveRunRecord,
    input: ObjectiveSupervisorAcknowledgement,
  ): void {
    if (!this.repository.appendObjectiveEventIntent) return;
    const eventKey = `objective-supervisor-ack:${input.requestKey}`;
    const eventId = `objective-event-${fingerprint({ eventKey, runId: next.runId })}`;
    const agentId = this.options.authority.actor.type === "agent"
      ? this.options.authority.actor.id
      : next.conductorAgentId;
    this.repository.appendObjectiveEventIntent({
      eventKey,
      eventId,
      event: {
        type: "objective.supervisor.acknowledged",
        workflowId: next.workflowId,
        runId: next.runId,
        agentId,
        occurredAt: this.now(),
        payload: {
          acknowledgementKey: input.requestKey,
          intentId: input.intentId,
          kind: input.kind,
          previousState: previous.state,
          state: next.state,
          planRevision: next.activePlanRevision,
        },
        provenance: { source: "daemon" },
      },
    });
  }

  private drainObjectiveEventOutbox(): void {
    // A delivery error must not turn a committed acknowledgement into a
    // client-visible rollback. The pending intent remains durable and is
    // retried on the next acknowledgement/recovery/startup pass.
    try {
      this.repository.drainObjectiveEventOutbox?.();
    } catch {
      // Intentionally ignored: the outbox is the recovery record.
    }
  }

  private applyAcknowledgement(
    run: ObjectiveRunRecord,
    intent: ObjectiveSupervisorIntent,
    input: ObjectiveSupervisorAcknowledgement,
  ): ObjectiveRunRecord {
    if (input.kind === "dispatch") {
      this.assertDispatchAcknowledgement(intent, input);
      const taskIds = new Set(intent.taskIds);
      const updates = input.taskUpdates.map((update) => ({
        ...update,
        attemptId: update.attemptId ?? this.attemptId(run.runId, update.taskId, intent.intentId),
      }));
      if (updates.some((update) => !taskIds.has(update.taskId))) {
        throw new ObjectiveRuntimeError("Dispatch acknowledgement references a task outside its frontier.", "invalid-plan");
      }
      return this.runtime.checkpoint(run.runId, {
        eventCursor: input.eventCursor,
        ...(input.context === undefined ? {} : { context: input.context }),
        taskUpdates: updates,
        reason: input.reason ?? "Objective frontier dispatch acknowledged.",
        requestKey: this.runtimeRequestKey(intent.acknowledgementKey, "checkpoint"),
      }, this.options.authority);
    }

    if (input.kind === "evaluate") {
      this.assertEvaluateAcknowledgement(intent, input, run);
      return this.runtime.checkpoint(run.runId, {
        eventCursor: input.eventCursor,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.taskUpdates === undefined ? {} : { taskUpdates: input.taskUpdates }),
        reason: input.reason ?? "Objective execution evaluated at a durable boundary.",
        requestKey: this.runtimeRequestKey(intent.acknowledgementKey, "checkpoint"),
      }, this.options.authority);
    }

    if (input.kind === "replan") {
      if (intent.kind !== "replan") throw new ObjectiveRuntimeError("Replan acknowledgement is not pending.", "invalid-state");
      return this.runtime.commitPlan(run.runId, {
        expectedPlanRevision: run.activePlanRevision,
        tasks: input.tasks,
        reason: input.reason,
        requestKey: this.runtimeRequestKey(intent.acknowledgementKey, "plan"),
      }, this.options.authority);
    }

    if (input.kind === "wait-for-approval") {
      if (intent.kind !== "wait-for-approval" || intent.approvalId !== input.approvalId) {
        throw new ObjectiveRuntimeError("Approval acknowledgement does not match the pending approval.", "approval-required");
      }
      return this.runtime.resolveApproval(run.runId, input.approvalId, {
        status: input.status,
        decision: input.decision ?? null,
        requestKey: this.runtimeRequestKey(intent.acknowledgementKey, "approval"),
      }, this.options.authority);
    }

    if (intent.kind !== "finish") throw new ObjectiveRuntimeError("Finish acknowledgement is not pending.", "invalid-state");
    return run;
  }

  private assertDispatchAcknowledgement(
    intent: ObjectiveSupervisorIntent,
    input: ObjectiveSupervisorDispatchAcknowledgement,
  ): asserts intent is ObjectiveSupervisorDispatchIntent {
    if (intent.kind !== "dispatch") throw new ObjectiveRuntimeError("Dispatch acknowledgement is not pending.", "invalid-state");
    this.assertDispatchAuthority(intent.tasks);
    this.assertEventCursor(input.eventCursor, intent.expectedEventCursor);
    const expected = new Set(intent.taskIds);
    const seen = new Set<string>();
    for (const update of input.taskUpdates) {
      if (seen.has(update.taskId)) throw new ObjectiveRuntimeError(`Dispatch acknowledgement repeats task ${update.taskId}.`, "invalid-plan");
      seen.add(update.taskId);
      if (!expected.has(update.taskId)) throw new ObjectiveRuntimeError(`Dispatch acknowledgement references task ${update.taskId} outside the frontier.`, "invalid-plan");
      if (!["running", "completed", "failed"].includes(update.state)) {
        throw new ObjectiveRuntimeError(`Dispatch acknowledgement cannot set task ${update.taskId} to ${update.state}.`, "invalid-state");
      }
    }
    if (seen.size !== expected.size) throw new ObjectiveRuntimeError("Dispatch acknowledgement must cover its complete frontier.", "invalid-plan");
  }

  private assertEvaluateAcknowledgement(
    intent: ObjectiveSupervisorIntent,
    input: ObjectiveSupervisorEvaluateAcknowledgement,
    run: ObjectiveRunRecord,
  ): asserts intent is ObjectiveSupervisorEvaluateIntent {
    if (intent.kind !== "evaluate") throw new ObjectiveRuntimeError("Evaluation acknowledgement is not pending.", "invalid-state");
    this.assertEventCursor(input.eventCursor, intent.expectedEventCursor);
    const known = new Set(intent.taskIds);
    for (const update of input.taskUpdates ?? []) {
      if (!known.has(update.taskId)) throw new ObjectiveRuntimeError(`Evaluation references task ${update.taskId} outside the active objective.`, "invalid-plan");
      const task = run.tasks.find((record) => record.task.id === update.taskId);
      if (!task || task.state !== "running") {
        throw new ObjectiveRuntimeError(`Evaluation can only reconcile running task ${update.taskId}.`, "invalid-state");
      }
      this.assertDispatchAuthority([task]);
      if (!["running", "completed", "failed"].includes(update.state)) {
        throw new ObjectiveRuntimeError(`Evaluation cannot set task ${update.taskId} to ${update.state}.`, "invalid-state");
      }
    }
  }

  private assertEventCursor(eventCursor: number, expected: number): void {
    if (!Number.isInteger(eventCursor) || eventCursor < expected) {
      throw new ObjectiveRuntimeError(
        `Objective acknowledgement event cursor ${eventCursor} is behind durable cursor ${expected}.`,
        "revision-conflict",
      );
    }
  }

  private assertDispatchAuthority(tasks: readonly ObjectiveTaskRecord[]): void {
    for (const task of tasks) {
      // Objective tasks default to read-only at the native boundary. An
      // omitted permission is therefore safe under either supervisor ceiling;
      // only an explicit full-access request needs a ceiling check here.
      const requested = task.task.permissions ?? "read-only";
      const effective = resolveChildPermission(this.options.authority.permissionCeiling, requested);
      if (requested === "full-access" && effective !== "full-access") {
        throw new ObjectiveRuntimeError(
          `Objective task ${task.task.id} requests full-access above the supervisor authority ceiling.`,
          "authority-exceeded",
        );
      }
    }
  }

  private dispatchIntent(
    run: ObjectiveRunRecord,
    tasks: ObjectiveTaskRecord[],
    expectedEventCursor: number,
  ): ObjectiveSupervisorDispatchIntent {
    this.assertDispatchAuthority(tasks);
    const identity = {
      kind: "dispatch" as const,
      runId: run.runId,
      objectiveId: run.objectiveId,
      planRevision: run.activePlanRevision,
      expectedEventCursor,
      tasks,
      context: run.context,
      pendingApprovalId: run.pendingApprovalId,
    };
    return {
      ...identity,
      tasks: [...tasks],
      taskIds: tasks.map((record) => record.task.id),
      intentId: fingerprint(identity),
      acknowledgementKey: this.acknowledgementKey(run.runId, fingerprint(identity)),
    };
  }

  private evaluateIntent(run: ObjectiveRunRecord, expectedEventCursor: number): ObjectiveSupervisorEvaluateIntent {
    const taskIds = run.tasks.map((record) => record.task.id);
    const identity = {
      kind: "evaluate" as const,
      runId: run.runId,
      objectiveId: run.objectiveId,
      planRevision: run.activePlanRevision,
      expectedEventCursor,
      tasks: run.tasks,
      context: run.context,
      pendingApprovalId: run.pendingApprovalId,
    };
    return {
      ...identity,
      taskIds,
      intentId: fingerprint(identity),
      acknowledgementKey: this.acknowledgementKey(run.runId, fingerprint(identity)),
    };
  }

  private replanIntent(run: ObjectiveRunRecord, failedTaskIds: string[]): ObjectiveSupervisorReplanIntent {
    const remainingReplans = Math.max(0, run.spec.maxReplans - run.replanCount);
    const reason = failedTaskIds.length > 0
      ? "A task failed or was blocked; provide a bounded replacement plan."
      : run.state === "planning"
        ? "The objective has no executable plan; provide its initial bounded plan."
        : "The latest evaluation did not satisfy the objective criteria; provide a bounded replacement plan.";
    const identity = {
      kind: "replan" as const,
      runId: run.runId,
      objectiveId: run.objectiveId,
      planRevision: run.activePlanRevision,
      replanCount: run.replanCount,
      remainingReplans,
      failedTaskIds,
      reason,
      tasks: run.tasks,
      context: run.context,
    };
    return {
      ...identity,
      intentId: fingerprint(identity),
      acknowledgementKey: this.acknowledgementKey(run.runId, fingerprint(identity)),
    };
  }

  private approvalIntent(run: ObjectiveRunRecord, approval: ObjectiveApprovalRecord): ObjectiveSupervisorApprovalIntent {
    const identity = {
      kind: "wait-for-approval" as const,
      runId: run.runId,
      objectiveId: run.objectiveId,
      planRevision: run.activePlanRevision,
      approval,
    };
    return {
      ...identity,
      approvalId: approval.id,
      intentId: fingerprint(identity),
      acknowledgementKey: this.acknowledgementKey(run.runId, fingerprint(identity)),
    };
  }

  private finishIntent(run: ObjectiveRunRecord): ObjectiveSupervisorFinishIntent {
    const identity = {
      kind: "finish" as const,
      runId: run.runId,
      objectiveId: run.objectiveId,
      planRevision: run.activePlanRevision,
      state: run.state as ObjectiveSupervisorFinishIntent["state"],
      output: run.output,
      error: run.error,
    };
    return {
      ...identity,
      intentId: fingerprint(identity),
      acknowledgementKey: this.acknowledgementKey(run.runId, fingerprint(identity)),
    };
  }

  private latestCheckpoint(run: ObjectiveRunRecord) {
    return run.latestCheckpointId
      ? this.repository.getObjectiveCheckpoint(run.runId, run.latestCheckpointId)
      : null;
  }

  private withDurableTransaction<T>(callback: () => T): T {
    return this.repository.withDurableTransaction
      ? this.repository.withDurableTransaction(callback)
      : callback();
  }

  private saveReceipt(receipt: ObjectiveActionReceipt): void {
    if (this.repository.saveObjectiveActionReceipt(receipt)) return;
    const existing = this.repository.getObjectiveActionReceipt(receipt.requestKey);
    if (!existing || existing.kind !== receipt.kind || existing.fingerprint !== receipt.fingerprint) {
      throw new ObjectiveRuntimeError(
        `Objective acknowledgement ${receipt.requestKey} could not be committed deterministically.`,
        "idempotency-conflict",
      );
    }
  }

  private assertReceipt(receipt: ObjectiveActionReceipt, payload: JsonValue): void {
    if (receipt.kind !== "objective.supervisor.ack" || receipt.fingerprint !== fingerprint(payload)) {
      throw new ObjectiveRuntimeError(
        `Objective acknowledgement request ${receipt.requestKey} was reused for a different intent.`,
        "idempotency-conflict",
      );
    }
  }

  private ackPayload(runId: string, input: ObjectiveSupervisorAcknowledgement): JsonValue {
    return {
      runId,
      intentId: input.intentId,
      kind: input.kind,
      expectedPlanRevision: input.expectedPlanRevision ?? null,
      ...(input.kind === "dispatch" || input.kind === "evaluate"
        ? {
            eventCursor: input.eventCursor,
            taskUpdates: input.taskUpdates ?? [],
            context: input.context ?? null,
            reason: input.reason ?? null,
          }
        : input.kind === "replan"
          ? { tasks: input.tasks, reason: input.reason }
          : input.kind === "wait-for-approval"
            ? { approvalId: input.approvalId, status: input.status, decision: input.decision ?? null }
            : {}),
    } as JsonValue;
  }

  private runtimeRequestKey(requestKey: string, suffix: string): string {
    return `objective-supervisor:${requestKey}:${suffix}`;
  }

  private acknowledgementKey(runId: string, intentId: string): string {
    return `objective-supervisor:${runId}:${intentId}`;
  }

  private attemptId(runId: string, taskId: string, intentId: string): string {
    return `objective-attempt:${runId}:${taskId}:${intentId}`;
  }

  private assertRequestKey(requestKey: string): void {
    if (typeof requestKey !== "string" || requestKey.length < 8) {
      throw new ObjectiveRuntimeError("Objective supervisor requestKey must contain at least 8 characters.", "idempotency-conflict");
    }
  }

  /** Validate the authority envelope eagerly when a supervisor is created. */
  static assertAuthority(authority: ObjectiveRuntimeAuthority): void {
    try {
      ObjectiveActorSchema.parse(authority.actor);
      PermissionSchema.parse(authority.permissionCeiling);
    } catch {
      throw new ObjectiveRuntimeError("Objective supervisor actions require an externally supplied authority envelope.", "invalid-authority");
    }
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
