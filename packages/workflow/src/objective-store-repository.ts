import {
  ObjectiveApprovalRecordSchema,
  ObjectiveBudgetLedgerRecordSchema,
  ObjectiveCheckpointRecordSchema,
  ObjectiveRunRecordSchema,
  JsonValueSchema,
  type ObjectiveActor,
  type ObjectiveApprovalRecord,
  type ObjectiveBudgetLedgerRecord,
  type ObjectiveCheckpointRecord,
  type ObjectiveRunRecord,
  type EventEnvelope,
  type ObjectiveControlMutation,
  type ObjectiveControlPlanRevision,
  type ObjectiveControlPlanSnapshot,
  type ObjectiveControlSuspensionRecord,
} from "@symphony/protocol";
import {
  type ObjectiveControlHeadRecord,
  type ObjectiveControlMutationRecord,
  type ObjectiveControlMutationCommit,
  type ObjectivePlanRevisionRecord,
  SymphonyStore,
} from "@symphony/storage";
import type {
  ObjectiveActionKind,
  ObjectiveActionReceipt,
  ObjectiveRepository,
} from "./objective-runtime.js";

/**
 * The storage package intentionally exposes narrow objective primitives, while
 * the runtime uses a provider-neutral repository. This adapter is the durable
 * boundary between those two layers. It never overwrites an objective run
 * without a revision fence and never treats a receipt collision as success.
 */
export class ObjectiveStoreRepository implements ObjectiveRepository {
  constructor(
    private readonly store: SymphonyStore,
    private readonly options: Readonly<{
      planAuthor?: ObjectiveActor;
    }> = {},
  ) {}

  /**
   * Use this when the caller needs one objective action (state, evidence,
   * approval, and receipt) to share a single SQLite commit boundary. The
   * current runtime contract predates this hook, so it remains an explicit
   * adapter capability until the daemon wires action handlers around it.
   */
  withDurableTransaction<T>(callback: () => T): T {
    return this.store.durableTransaction(callback);
  }

  getObjectiveRun(runId: string): ObjectiveRunRecord | null {
    return this.store.getObjectiveRun(runId);
  }

  getObjectiveRunByRequestKey(requestKey: string): ObjectiveRunRecord | null {
    return this.store.getObjectiveRunByRequestKey(requestKey);
  }

  saveObjectiveRun(run: ObjectiveRunRecord): void {
    this.store.durableTransaction(() => {
      const parsed = ObjectiveRunRecordSchema.parse(run);
      const existing = this.store.getObjectiveRun(parsed.runId);
      if (!existing) {
        if (!this.store.saveObjectiveRun(parsed)) {
          const raced = this.store.getObjectiveRun(parsed.runId);
          if (!raced || !sameJson(raced, parsed)) {
            throw new Error(`Objective run insert lost its idempotency race: ${parsed.runId}`);
          }
          return;
        }
        // A run begins at plan revision zero. This branch also supports
        // replaying a legacy caller that materializes its first plan in create.
        if (parsed.activePlanRevision > 0) this.savePlanSnapshot(parsed, undefined);
        return;
      }

      // A changed active revision can only be a plan commit. Store that append
      // and pointer update atomically; all other updates use the run CAS.
      if (parsed.activePlanRevision !== existing.activePlanRevision) {
        if (parsed.activePlanRevision !== existing.activePlanRevision + 1) {
          throw new Error("Objective store refuses a non-contiguous plan revision");
        }
        this.savePlanSnapshot(parsed, existing.activePlanRevision);
        // saveObjectivePlanRevision advances the plan pointer and task overlay
        // atomically, but deliberately preserves the prior run projection.
        // Apply the remaining state transition (executing/awaiting approval,
        // counters, timestamps, and error) under the same active-plan fence so
        // a restarted supervisor cannot observe a plan revision with stale
        // terminal state.
        const afterPlan = this.store.getObjectiveRun(parsed.runId);
        if (!afterPlan || afterPlan.activePlanRevision !== parsed.activePlanRevision) {
          throw new Error(`Objective plan revision CAS lost: ${parsed.runId}/${parsed.activePlanRevision}`);
        }
        if (!sameJson(afterPlan, parsed) && !this.store.updateObjectiveRun(parsed, { expectedActivePlanRevision: parsed.activePlanRevision })) {
          const raced = this.store.getObjectiveRun(parsed.runId);
          if (!raced || !sameJson(raced, parsed)) {
            throw new Error(`Objective run state update lost its compare-and-swap race: ${parsed.runId}`);
          }
        }
        return;
      }

      if (sameJson(existing, parsed)) return;
      if (this.store.updateObjectiveRun(parsed, { expectedActivePlanRevision: existing.activePlanRevision })) return;

      const raced = this.store.getObjectiveRun(parsed.runId);
      if (!raced || !sameJson(raced, parsed)) {
        throw new Error(`Objective run update lost its compare-and-swap race: ${parsed.runId}`);
      }
    });
  }

  /**
   * Materialize the accounting aggregate only after a verified admission
   * snapshot has been inserted. The outer transaction is owned by the runtime
   * action, so a ledger failure rolls the run and receipt back together.
   */
  initializeObjectiveBudgetLedger(run: ObjectiveRunRecord): void {
    if (!run.policy || !run.policyHash) return;
    const ledger: ObjectiveBudgetLedgerRecord = ObjectiveBudgetLedgerRecordSchema.parse({
      version: 1,
      runId: run.runId,
      objectiveId: run.objectiveId,
      policyHash: run.policyHash,
      limits: run.policy.budget,
      reserved: {},
      consumed: {},
      status: "active",
      pauseReason: null,
      revision: 0,
      requestKey: `${run.requestKey}:budget-ledger`,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
    const saved = this.store.saveObjectiveBudgetLedger(ledger);
    if (saved) return;
    const existing = this.store.getObjectiveBudgetLedger(run.runId);
    if (!existing || !sameJson(existing, ledger)) {
      throw new Error(`Objective budget ledger admission conflict: ${run.runId}`);
    }
  }

  getObjectiveActionReceipt(requestKey: string): ObjectiveActionReceipt | null {
    const receipt = this.store.getCommandReceipt(requestKey);
    if (!receipt) return null;
    const result = receipt.result;
    if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
    const record = result as Record<string, unknown>;
    if (record[RECEIPT_MARKER] !== true) return null;
    if (
      typeof record.kind !== "string" ||
      !isObjectiveActionKind(record.kind) ||
      typeof record.fingerprint !== "string" ||
      typeof receipt.createdAt !== "string"
    ) return null;
    const parsedResult = JsonValueSchema.safeParse(record.result);
    if (!parsedResult.success) return null;
    return {
      requestKey,
      kind: record.kind,
      fingerprint: record.fingerprint,
      result: parsedResult.data,
      createdAt: receipt.createdAt,
    };
  }

  saveObjectiveActionReceipt(receipt: ObjectiveActionReceipt): boolean {
    return this.store.durableTransaction(() => this.store.claimCommandReceipt({
        idempotencyKey: receipt.requestKey,
        accepted: true,
        state: "settled",
        result: {
          [RECEIPT_MARKER]: true,
          kind: receipt.kind,
          fingerprint: receipt.fingerprint,
          // Preserve every JsonValue result, including structured evidence.
          result: receipt.result,
        },
        createdAt: receipt.createdAt,
        updatedAt: receipt.createdAt,
      }));
  }

  appendObjectiveEventIntent(input: {
    eventKey: string;
    eventId: string;
    event: Omit<EventEnvelope, "id" | "cursor">;
  }): boolean {
    return this.store.appendObjectiveEventIntent(input);
  }

  drainObjectiveEventOutbox(options?: { batchSize?: number }): number {
    return this.store.drainObjectiveEventOutbox(options);
  }

  getObjectiveCheckpoint(runId: string, checkpointId: string): ObjectiveCheckpointRecord | null {
    return this.store.getObjectiveCheckpoint(runId, checkpointId);
  }

  saveObjectiveCheckpoint(checkpoint: ObjectiveCheckpointRecord): boolean {
    const parsed = ObjectiveCheckpointRecordSchema.parse(checkpoint);
    return this.store.durableTransaction(() => this.store.appendObjectiveCheckpoint(parsed));
  }

  getObjectiveApproval(runId: string, approvalId: string): ObjectiveApprovalRecord | null {
    return this.store.getObjectiveApproval(runId, approvalId);
  }

  saveObjectiveApproval(approval: ObjectiveApprovalRecord): boolean {
    const parsed = ObjectiveApprovalRecordSchema.parse(approval);
    return this.store.durableTransaction(() => {
      const existing = this.store.getObjectiveApproval(parsed.runId, parsed.id);
      if (!existing) return this.store.saveObjectiveApproval(parsed);
      if (sameJson(existing, parsed)) return false;
      if (existing.status === "requested") {
        const updated = this.store.updateObjectiveApproval(parsed, { expectedStatus: "requested" });
        if (updated) return true;
        const raced = this.store.getObjectiveApproval(parsed.runId, parsed.id);
        if (raced && sameJson(raced, parsed)) return false;
      }
      throw new Error(`Objective approval update lost its compare-and-swap race: ${parsed.id}`);
    });
  }

  getObjectiveControlHead(runId: string): ObjectiveControlHeadRecord | null {
    return this.store.getObjectiveControlHead(runId);
  }

  getObjectiveControlPlanRevision(runId: string, revision: number): ObjectiveControlPlanRevision | null {
    return this.store.getObjectiveControlPlanRevision(runId, revision);
  }

  getLatestObjectiveControlPlanRevision(runId: string): ObjectiveControlPlanRevision | null {
    return this.store.getLatestObjectiveControlPlanRevision(runId);
  }

  latestObjectiveControlPlanRevision(runId: string): ObjectiveControlPlanRevision | null {
    return this.store.getLatestObjectiveControlPlanRevision(runId);
  }

  getLatestObjectiveControlSnapshot(runId: string): ObjectiveControlPlanSnapshot | null {
    return this.store.getLatestObjectiveControlSnapshot(runId);
  }

  latestObjectiveControlSnapshot(runId: string): ObjectiveControlPlanSnapshot | null {
    return this.store.latestObjectiveControlSnapshot(runId);
  }

  saveObjectiveControlPlanRevision(
    revision: ObjectiveControlPlanRevision,
    snapshot: ObjectiveControlPlanSnapshot,
    options: { expectedActiveRevision?: number; expectedRevision?: number } = {},
  ): boolean {
    return this.store.saveObjectiveControlPlanRevision(revision, snapshot, options);
  }

  saveObjectiveControlSnapshot(snapshot: ObjectiveControlPlanSnapshot): boolean {
    return this.store.saveObjectiveControlSnapshot(snapshot);
  }

  commitObjectiveControlMutation(
    mutation: ObjectiveControlMutation,
    revision: ObjectiveControlPlanRevision,
    snapshot: ObjectiveControlPlanSnapshot,
  ): ObjectiveControlMutationCommit {
    return this.store.commitObjectiveControlMutation(mutation, revision, snapshot);
  }

  commitObjectiveControlMutationDerived(mutation: ObjectiveControlMutation): ObjectiveControlMutationCommit {
    return this.store.commitObjectiveControlMutationDerived(mutation);
  }

  getObjectiveControlMutation(mutationId: string): ObjectiveControlMutationRecord | null {
    return this.store.getObjectiveControlMutation(mutationId);
  }

  getObjectiveControlMutationByRequestKey(runId: string, requestKey: string): ObjectiveControlMutationRecord | null {
    return this.store.getObjectiveControlMutationByRequestKey(runId, requestKey);
  }

  listObjectiveControlMutations(runId: string): ObjectiveControlMutationRecord[] {
    return this.store.listObjectiveControlMutations(runId);
  }

  getObjectiveControlSuspension(runId: string, executionId: string): ObjectiveControlSuspensionRecord | null {
    return this.store.getObjectiveControlSuspension(runId, executionId);
  }

  listObjectiveControlSuspensions(runId: string, options?: { status?: ObjectiveControlSuspensionRecord["status"] }): ObjectiveControlSuspensionRecord[] {
    return this.store.listObjectiveControlSuspensions(runId, options);
  }

  getObjectiveControlSignalDelivery(subscriptionKey: string, deliveryId: string) {
    return this.store.getObjectiveControlSignalDelivery(subscriptionKey, deliveryId);
  }

  saveObjectiveControlSignalDelivery(record: import("@symphony/protocol").ObjectiveControlSignalDeliveryRecord): boolean {
    return this.store.saveObjectiveControlSignalDelivery(record);
  }

  private savePlanSnapshot(run: ObjectiveRunRecord, expectedActivePlanRevision: number | undefined): void {
    const plan = this.planSnapshot(run);
    const saved = this.store.saveObjectivePlanRevision(
      plan,
      expectedActivePlanRevision === undefined ? {} : { expectedActivePlanRevision },
    );
    if (saved) return;
    const persisted = this.store.getObjectivePlanRevision(run.runId, run.activePlanRevision);
    if (!persisted || !sameJson(persisted, plan)) {
      throw new Error(`Objective plan revision could not be committed deterministically: ${run.runId}/${run.activePlanRevision}`);
    }
  }

  private planSnapshot(run: ObjectiveRunRecord): ObjectivePlanRevisionRecord {
    const planAuthor = this.options.planAuthor ?? { type: "system", id: "objective-runtime" };
    return {
      version: 1,
      id: `objective-plan-${run.runId}-${run.activePlanRevision}`,
      runId: run.runId,
      objectiveId: run.objectiveId,
      workflowId: run.workflowId,
      workflowRevision: run.workflowRevision,
      workflowHash: run.workflowHash,
      policyHash: run.policyHash ?? null,
      planRevision: run.activePlanRevision,
      tasks: run.tasks,
      createdBy: planAuthor,
      requestKey: `${run.requestKey}:plan:${run.activePlanRevision}`,
      createdAt: run.updatedAt,
    };
  }

}

const RECEIPT_MARKER = "__symphonyObjectiveReceipt";

function isObjectiveActionKind(value: string): value is ObjectiveActionKind {
  return [
    "objective.create",
    "objective.plan.commit",
    "objective.checkpoint.commit",
    "objective.approval.request",
    "objective.approval.resolve",
    "objective.supervisor.ack",
    "objective.control.ack",
  ].includes(value as ObjectiveActionKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
