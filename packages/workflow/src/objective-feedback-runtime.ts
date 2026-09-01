import { createHash } from "node:crypto";
import {
  CapabilityResultFeedbackRecordSchema,
  type CapabilityResultDecisionRecord,
  type CapabilityResultEvaluationRecord,
  type CapabilityResultFeedbackRecord,
  type CapabilityResultEvidenceRef,
  type JsonValue,
  type ObjectiveAttentionRecord,
  type ObjectiveTask,
  type ObjectiveRunRecord,
  withCapabilityResultDecisionHash,
  withCapabilityResultEvaluationHash,
} from "@symphony/protocol";
import {
  CapabilityResultFeedbackRepository,
  ObjectiveAttentionRegistry,
} from "@symphony/storage";
import {
  ObjectiveFeedbackInputRecordSchema,
  ObjectiveFeedbackContextSchema,
  ObjectiveFeedbackReducer,
  type ObjectiveFeedbackContext,
  type ObjectiveFeedbackDecision,
  type ObjectiveFeedbackInputRecord,
} from "./objective-feedback.js";
import {
  ObjectiveRuntime,
  type ObjectiveRepository,
  type ObjectiveRuntimeAuthority,
} from "./objective-runtime.js";

/**
 * The durable seam between capability-result records and objective
 * supervision. The capability repository is the source of truth for the
 * accepted observation and its immutable children; ObjectiveRuntime remains
 * the only owner of checkpoint/plan mutations.
 */
export type ObjectiveFeedbackRuntimeOptions = Readonly<{
  feedbackRepository: CapabilityResultFeedbackRepository;
  objectiveRepository: ObjectiveRepository;
  runtime: ObjectiveRuntime;
  authority: ObjectiveRuntimeAuthority;
  attentionRegistry?: ObjectiveAttentionRegistry;
  now?: () => string;
}>;

export type ObjectiveFeedbackApplyOptions = Readonly<{
  /** A replacement plan is optional; omission leaves a replan decision proposed. */
  replanTasks?: readonly ObjectiveTask[];
}>;

export type ObjectiveFeedbackRuntimeResult = Readonly<{
  feedback: CapabilityResultFeedbackRecord;
  evaluation: CapabilityResultEvaluationRecord;
  decision: CapabilityResultDecisionRecord;
  reduced: ObjectiveFeedbackDecision;
  run: ObjectiveRunRecord;
  applied: "continue" | "attention" | "replan" | "wait-for-approval" | "finish" | "deferred" | "replayed";
  attention: ObjectiveAttentionRecord | null;
}>;

type ReducerStatus = ObjectiveFeedbackInputRecord["status"];

export class ObjectiveFeedbackRuntime {
  private readonly reducer = new ObjectiveFeedbackReducer();
  private readonly attentionRegistry: ObjectiveAttentionRegistry | undefined;
  private readonly now: () => string;

  constructor(private readonly options: ObjectiveFeedbackRuntimeOptions) {
    this.attentionRegistry = options.attentionRegistry;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Reduce one record only after its accepted form is durably present. An
   * absent/mismatched/non-accepted record is rejected before any child or
   * objective mutation is attempted.
   */
  processAccepted(
    rawFeedback: CapabilityResultFeedbackRecord,
    context: ObjectiveFeedbackContext,
    apply: ObjectiveFeedbackApplyOptions = {},
  ): ObjectiveFeedbackRuntimeResult {
    const feedback = CapabilityResultFeedbackRecordSchema.parse(rawFeedback);
    if (feedback.status !== "accepted") throw new Error(`Capability feedback is not accepted: ${feedback.id}`);
    const durable = this.options.feedbackRepository.getFeedback(feedback.id);
    if (!durable) throw new Error(`Accepted capability feedback is not durably admitted: ${feedback.id}`);
    if (durable.hash !== feedback.hash || stableJson(durable) !== stableJson(feedback)) {
      throw new Error(`Capability feedback identity conflict: ${feedback.id}`);
    }

    const run = this.options.runtime.get(feedback.runId);
    if (run.objectiveId !== feedback.objectiveId) {
      throw new Error(`Capability feedback objective identity conflict: ${feedback.id}`);
    }

    const parsedContext = ObjectiveFeedbackContextSchema.parse(context);
    const evidenceInScope = feedback.evidenceRefs.every((ref) => ref.cursor === undefined || ref.cursor <= parsedContext.evidence.eventCursor);
    const reducerInput = toReducerInput(feedback, evidenceInScope ? undefined : "unknown");
    const priorEvaluation = this.options.feedbackRepository.getByIdempotencyKey("evaluation", evaluationKey(feedback.id)) as CapabilityResultEvaluationRecord | null;
    const priorDecisionId = priorEvaluation && priorEvaluation.evaluation !== null && typeof priorEvaluation.evaluation === "object" && !Array.isArray(priorEvaluation.evaluation)
      && typeof (priorEvaluation.evaluation as Record<string, JsonValue>).decisionId === "string"
      ? (priorEvaluation.evaluation as Record<string, JsonValue>).decisionId as string
      : null;
    const reduced = this.reducer.reduce({
      feedback: reducerInput,
      context: priorDecisionId
        ? { ...parsedContext, priorDecision: { requestKey: reducerInput.requestKey, decisionId: priorDecisionId, fingerprint: priorDecisionId } }
        : parsedContext,
    });
    const records = this.persistChildren(feedback, reduced);

    let current = this.options.runtime.get(run.runId);
    let applied: ObjectiveFeedbackRuntimeResult["applied"] = records.replayed ? "replayed" : "deferred";
    let attention: ObjectiveAttentionRecord | null = null;
    const operationRequestKey = reduced.kind === "continue"
      ? `${feedback.id}:continue`
      : reduced.kind === "replan"
        ? `${feedback.id}:replan`
        : reduced.kind === "wait-for-approval"
          ? `${feedback.id}:approval`
          : reduced.kind === "finish"
            ? `${feedback.id}:finish`
            : null;
    const operationApplied = operationRequestKey !== null && this.feedbackOperationApplied(reduced, current, operationRequestKey);
    if (!records.replayed || reduced.kind === "attention" || (operationRequestKey !== null && !operationApplied)) {
      const outcome = this.applyDecision(feedback, reduced, current, apply);
      current = outcome.run;
      applied = records.replayed && outcome.applied !== "deferred" ? "replayed" : outcome.applied;
      attention = outcome.attention;
    }

    return {
      feedback,
      evaluation: records.evaluation,
      decision: records.decision,
      reduced,
      run: current,
      applied,
      attention,
    };
  }

  private persistChildren(
    feedback: CapabilityResultFeedbackRecord,
    reduced: ObjectiveFeedbackDecision,
  ): { evaluation: CapabilityResultEvaluationRecord; decision: CapabilityResultDecisionRecord; replayed: boolean } {
    const evaluationId = `capability-evaluation:${feedback.id}`;
    const decisionId = `capability-decision:${feedback.id}`;
    const evaluationKeyValue = evaluationKey(feedback.id);
    const decisionKeyValue = decisionKey(feedback.id);
    const identity = {
      version: 1 as const,
      objectiveId: feedback.objectiveId,
      runId: feedback.runId,
      nodeId: feedback.nodeId,
      attemptId: feedback.attemptId,
      capabilityAdmissionId: feedback.capabilityAdmissionId,
      capabilityAdmissionHash: feedback.capabilityAdmissionHash,
      agentId: feedback.agentId,
      nativeAgentId: feedback.nativeAgentId,
      nativeSessionId: feedback.nativeSessionId,
      nativeRunId: feedback.nativeRunId,
      evidenceRefs: feedback.evidenceRefs,
      charterCitation: feedback.charterCitation,
      createdAt: feedback.createdAt,
    };
    const evaluation = {
      ...identity,
      id: evaluationId,
      feedbackId: feedback.id,
      status: "completed" as const,
      assessment: assessmentFor(reduced),
      score: scoreFor(reduced),
      findings: [reduced.reason],
      evaluation: { decisionId: reduced.decisionId, kind: reduced.kind },
      idempotencyKey: evaluationKeyValue,
    };
    const decision = {
      ...identity,
      id: decisionId,
      feedbackId: feedback.id,
      evaluationId,
      status: "proposed" as const,
      decision: reduced.kind,
      reason: reduced.reason,
      idempotencyKey: decisionKeyValue,
    };
    // Hashes are content addresses; the protocol constructors validate the
    // complete immutable record before the storage repository sees it.
    const evaluationWithHash = withCapabilityResultEvaluationHash(evaluation);
    const decisionWithHash = withCapabilityResultDecisionHash(decision);
    return this.options.feedbackRepository.durableTransaction(() => {
      const priorEvaluation = this.options.feedbackRepository.getByIdempotencyKey("evaluation", evaluationKeyValue) as CapabilityResultEvaluationRecord | null;
      const priorDecision = this.options.feedbackRepository.getByIdempotencyKey("decision", decisionKeyValue) as CapabilityResultDecisionRecord | null;
      if (priorEvaluation && stableJson(priorEvaluation) !== stableJson(evaluationWithHash)) throw new Error(`Capability evaluation idempotency conflict: ${feedback.id}`);
      if (priorDecision && stableJson(priorDecision) !== stableJson(decisionWithHash)) throw new Error(`Capability decision idempotency conflict: ${feedback.id}`);
      if (!priorEvaluation) this.options.feedbackRepository.saveEvaluation(evaluationWithHash);
      if (!priorDecision) this.options.feedbackRepository.saveDecision(decisionWithHash);
      return {
        evaluation: priorEvaluation ?? evaluationWithHash,
        decision: priorDecision ?? decisionWithHash,
        replayed: Boolean(priorEvaluation && priorDecision),
      };
    });
  }

  private applyDecision(
    feedback: CapabilityResultFeedbackRecord,
    reduced: ObjectiveFeedbackDecision,
    run: ObjectiveRunRecord,
    apply: ObjectiveFeedbackApplyOptions,
  ): { run: ObjectiveRunRecord; applied: Exclude<ObjectiveFeedbackRuntimeResult["applied"], "replayed">; attention: ObjectiveAttentionRecord | null } {
    if (reduced.kind === "attention") {
      return { run, applied: "attention", attention: this.openAttention(feedback, reduced, run) };
    }
    if (reduced.kind === "continue") {
      if (!feedback.nodeId || !feedback.attemptId) return { run, applied: "continue", attention: null };
      const task = run.tasks.find((candidate) => candidate.task.id === feedback.nodeId);
      if (!task || task.attemptId !== feedback.attemptId) {
        return { run, applied: "attention", attention: this.openInvalidAttention(feedback, run, "Capability feedback attempt is not the current objective frontier.") };
      }
      if (task.state === "completed") return { run, applied: "continue", attention: null };
      const latestCheckpoint = run.latestCheckpointId
        ? this.options.objectiveRepository.getObjectiveCheckpoint(run.runId, run.latestCheckpointId)
        : null;
      const next = this.options.runtime.checkpoint(run.runId, {
        eventCursor: Math.max(reduced.evidence.eventCursor, latestCheckpoint?.eventCursor ?? 0),
        taskUpdates: [{ taskId: task.task.id, state: "completed", attemptId: feedback.attemptId, output: resultOutput(feedback.result) }],
        reason: `Capability feedback ${feedback.id} was accepted and reduced to continue.`,
        requestKey: `${feedback.id}:continue`,
      }, this.options.authority);
      return { run: next, applied: "continue", attention: null };
    }
    if (reduced.kind === "replan") {
      if (!apply.replanTasks || apply.replanTasks.length === 0) return { run, applied: "deferred", attention: null };
      if (run.activePlanRevision !== reduced.expectedPlanRevision) {
        return { run, applied: "attention", attention: this.openInvalidAttention(feedback, run, "Capability feedback replan CAS head is stale; no replacement plan was committed.") };
      }
      if (reduced.nextReplanCount !== run.replanCount + 1 || run.tasks.length === 0) {
        return { run, applied: "attention", attention: this.openInvalidAttention(feedback, run, "Capability feedback replan context is not the current failed objective frontier.") };
      }
      let current = run;
      const failedTask = run.tasks.find((candidate) => candidate.task.id === feedback.nodeId);
      if (feedback.nodeId !== null && !failedTask) {
        return { run, applied: "attention", attention: this.openInvalidAttention(feedback, run, "Capability feedback replan task is outside the current objective frontier.") };
      }
      if (failedTask && failedTask.state !== "failed" && failedTask.state !== "blocked" && failedTask.state !== "superseded") {
        if (failedTask.state === "completed") {
          return { run, applied: "attention", attention: this.openInvalidAttention(feedback, run, "A failed capability result does not match the already-completed objective task.") };
        }
        const latestCheckpoint = run.latestCheckpointId
          ? this.options.objectiveRepository.getObjectiveCheckpoint(run.runId, run.latestCheckpointId)
          : null;
        current = this.options.runtime.checkpoint(run.runId, {
          eventCursor: Math.max(reduced.evidence.eventCursor, latestCheckpoint?.eventCursor ?? 0),
          taskUpdates: [{ taskId: failedTask.task.id, state: "failed", attemptId: feedback.attemptId, error: feedback.summary ?? "Capability result failed." }],
          reason: `Capability feedback ${feedback.id} recorded a failed attempt before replanning.`,
          requestKey: `${feedback.id}:failure`,
        }, this.options.authority);
      }
      if (current.activePlanRevision !== reduced.expectedPlanRevision) {
        return { run: current, applied: "attention", attention: this.openInvalidAttention(feedback, current, "Capability feedback replan CAS head changed before the replacement plan commit.") };
      }
      const next = this.options.runtime.commitPlan(current.runId, {
        expectedPlanRevision: reduced.expectedPlanRevision,
        tasks: apply.replanTasks,
        reason: reduced.reason,
        ...(typeof run.policyHash === "string" ? { policyHash: run.policyHash } : {}),
        requestKey: `${feedback.id}:replan`,
      }, this.options.authority);
      return { run: next, applied: "replan", attention: null };
    }
    if (reduced.kind === "wait-for-approval") return this.applyApproval(feedback, reduced, run);
    return this.applyFinish(feedback, reduced, run);
  }

  /**
   * Approval and completion are daemon-owned operations. The reducer only
   * proposes them; this boundary is where the proposal gets the same durable
   * request-key/CAS semantics as every other ObjectiveRuntime mutation.
   */
  private applyApproval(
    feedback: CapabilityResultFeedbackRecord,
    reduced: Extract<ObjectiveFeedbackDecision, { kind: "wait-for-approval" }>,
    run: ObjectiveRunRecord,
  ): { run: ObjectiveRunRecord; applied: "wait-for-approval" | "attention"; attention: ObjectiveAttentionRecord | null } {
    const expectedKind = reduced.approvalKind === "completion" ? "completion" : "plan";
    const pending = run.pendingApprovalId === null
      ? null
      : this.options.objectiveRepository.getObjectiveApproval(run.runId, run.pendingApprovalId);
    if (pending) {
      if (pending.status !== "requested" || pending.kind !== expectedKind || (reduced.approvalId !== undefined && pending.id !== reduced.approvalId)) {
        return { run, applied: "attention", attention: this.openInvalidAttention(feedback, run, "Capability feedback approval does not match the durable pending approval.") };
      }
      return { run, applied: "wait-for-approval", attention: null };
    }
    if (reduced.approvalId !== undefined) {
      return { run, applied: "attention", attention: this.openInvalidAttention(feedback, run, "Capability feedback references an approval that is not pending.") };
    }

    let current = run;
    if (expectedKind === "completion") {
      const prepared = this.prepareSuccessfulAttempt(feedback, current, `${feedback.id}:approval:prepare`);
      if (prepared.attention) return { run: prepared.run, applied: "attention", attention: prepared.attention };
      current = prepared.run;
      const preparedApproval = current.pendingApprovalId === null
        ? null
        : this.options.objectiveRepository.getObjectiveApproval(current.runId, current.pendingApprovalId);
      if (preparedApproval) {
        if (preparedApproval.status !== "requested" || preparedApproval.kind !== "completion") {
          return { run: current, applied: "attention", attention: this.openInvalidAttention(feedback, current, "Completion approval preparation produced an invalid durable approval.") };
        }
        return { run: current, applied: "wait-for-approval", attention: null };
      }
    } else {
      const prepared = this.prepareFailedAttempt(feedback, current, `${feedback.id}:approval:prepare`);
      if (prepared.attention) return { run: prepared.run, applied: "attention", attention: prepared.attention };
      current = prepared.run;
    }

    try {
      const next = this.options.runtime.requestApproval(current.runId, {
        kind: expectedKind,
        taskId: null,
        question: reduced.reason,
        scope: {
          feedbackId: feedback.id,
          evidence: {
            eventCursor: reduced.evidence.eventCursor,
            eventIds: reduced.evidence.eventIds,
            observationIds: reduced.evidence.observationIds,
            artifactIds: reduced.evidence.artifactIds,
            checkpointIds: reduced.evidence.checkpointIds,
          },
          decisionId: reduced.decisionId,
        },
        operationId: `objective-feedback:${expectedKind}:${feedback.id}`,
        requestHash: reduced.decisionId,
        policyHash: current.policyHash ?? current.workflowHash,
        sideEffectClass: current.policy?.sideEffectClassCeiling ?? "local",
        canonicalTarget: `${current.workflowId}:${current.objectiveId}:${expectedKind}`,
        expiresAt: null,
        requestKey: `${feedback.id}:approval`,
      }, this.options.authority);
      return { run: next, applied: "wait-for-approval", attention: null };
    } catch (error) {
      return { run: current, applied: "attention", attention: this.openInvalidAttention(feedback, current, error instanceof Error ? error.message : String(error)) };
    }
  }

  private applyFinish(
    feedback: CapabilityResultFeedbackRecord,
    reduced: Extract<ObjectiveFeedbackDecision, { kind: "finish" }>,
    run: ObjectiveRunRecord,
  ): { run: ObjectiveRunRecord; applied: "finish" | "attention"; attention: ObjectiveAttentionRecord | null } {
    if (run.state === "succeeded") return { run, applied: "finish", attention: null };
    if (["failed", "cancelled", "interrupted", "awaiting-approval"].includes(run.state)) {
      return { run, applied: "attention", attention: this.openInvalidAttention(feedback, run, "Capability feedback finish does not match the durable objective state.") };
    }
    const prepared = this.prepareSuccessfulAttempt(feedback, run, `${feedback.id}:finish`);
    if (prepared.attention) return { run: prepared.run, applied: "attention", attention: prepared.attention };
    if (prepared.run.state !== "succeeded") {
      return { run: prepared.run, applied: "attention", attention: this.openInvalidAttention(feedback, prepared.run, "Capability feedback claimed completion but the durable objective did not reach a succeeded state.") };
    }
    return { run: prepared.run, applied: "finish", attention: null };
  }

  private prepareSuccessfulAttempt(
    feedback: CapabilityResultFeedbackRecord,
    run: ObjectiveRunRecord,
    requestKey: string,
  ): { run: ObjectiveRunRecord; attention: ObjectiveAttentionRecord | null } {
    const task = run.tasks.find((candidate) => candidate.task.id === feedback.nodeId);
    if (!task || task.attemptId !== feedback.attemptId) {
      return { run, attention: this.openInvalidAttention(feedback, run, "Capability feedback attempt is not the current objective frontier.") };
    }
    if (!["running", "completed"].includes(task.state)) {
      return { run, attention: this.openInvalidAttention(feedback, run, "Capability feedback success cannot advance a non-running objective task.") };
    }
    const otherTasksComplete = run.tasks.every((record) => record.task.id === task.task.id || record.state === "completed" || record.state === "superseded");
    if (!otherTasksComplete) {
      return { run, attention: this.openInvalidAttention(feedback, run, "Capability feedback claims objective completion while another task remains unfinished.") };
    }
    if (task.state === "completed") {
      if (run.state === "succeeded") return { run, attention: null };
      try {
        return {
          run: this.options.runtime.checkpoint(run.runId, {
            eventCursor: Math.max(maxEvidenceCursor(feedback), this.latestCheckpointCursor(run)),
            reason: `Capability feedback ${feedback.id} finalized the completed objective attempt.`,
            requestKey,
          }, this.options.authority),
          attention: null,
        };
      } catch (error) {
        return { run, attention: this.openInvalidAttention(feedback, run, error instanceof Error ? error.message : String(error)) };
      }
    }
    try {
      return {
        run: this.options.runtime.checkpoint(run.runId, {
          eventCursor: Math.max(maxEvidenceCursor(feedback), this.latestCheckpointCursor(run)),
          taskUpdates: [{ taskId: task.task.id, state: "completed", attemptId: feedback.attemptId, output: resultOutput(feedback.result) }],
          reason: `Capability feedback ${feedback.id} was accepted and reduced to finish.`,
          requestKey,
        }, this.options.authority),
        attention: null,
      };
    } catch (error) {
      return { run, attention: this.openInvalidAttention(feedback, run, error instanceof Error ? error.message : String(error)) };
    }
  }

  private prepareFailedAttempt(
    feedback: CapabilityResultFeedbackRecord,
    run: ObjectiveRunRecord,
    requestKey: string,
  ): { run: ObjectiveRunRecord; attention: ObjectiveAttentionRecord | null } {
    const task = run.tasks.find((candidate) => candidate.task.id === feedback.nodeId);
    if (!task || task.attemptId !== feedback.attemptId) {
      return { run, attention: this.openInvalidAttention(feedback, run, "Capability feedback attempt is not the current objective frontier.") };
    }
    if (task.state === "completed" || task.state === "superseded") {
      return { run, attention: this.openInvalidAttention(feedback, run, "A failed capability result does not match the already-completed objective task.") };
    }
    if (task.state === "failed" || task.state === "blocked") return { run, attention: null };
    try {
      return {
        run: this.options.runtime.checkpoint(run.runId, {
          eventCursor: Math.max(maxEvidenceCursor(feedback), this.latestCheckpointCursor(run)),
          taskUpdates: [{ taskId: task.task.id, state: "failed", attemptId: feedback.attemptId, error: feedback.summary ?? "Capability result failed." }],
          reason: `Capability feedback ${feedback.id} recorded a failed attempt before approval.`,
          requestKey,
        }, this.options.authority),
        attention: null,
      };
    } catch (error) {
      return { run, attention: this.openInvalidAttention(feedback, run, error instanceof Error ? error.message : String(error)) };
    }
  }

  private latestCheckpointCursor(run: ObjectiveRunRecord): number {
    if (!run.latestCheckpointId) return 0;
    return this.options.objectiveRepository.getObjectiveCheckpoint(run.runId, run.latestCheckpointId)?.eventCursor ?? 0;
  }

  private feedbackOperationApplied(
    reduced: ObjectiveFeedbackDecision,
    run: ObjectiveRunRecord,
    requestKey: string,
  ): boolean {
    if (this.options.objectiveRepository.getObjectiveActionReceipt(requestKey) !== null) return true;
    if (reduced.kind !== "wait-for-approval") return false;
    // Completion preparation can itself create the policy-driven approval and
    // has a separate checkpoint receipt. Keep that marker after approval
    // resolution so replay cannot reopen a settled request.
    if (this.options.objectiveRepository.getObjectiveActionReceipt(`${reduced.feedbackId}:approval:prepare`) !== null) return true;
    if (run.pendingApprovalId === null) return false;
    const approval = this.options.objectiveRepository.getObjectiveApproval(run.runId, run.pendingApprovalId);
    return approval?.status === "requested" && approval.kind === (reduced.approvalKind === "completion" ? "completion" : "plan");
  }

  private openInvalidAttention(feedback: CapabilityResultFeedbackRecord, run: ObjectiveRunRecord, reason: string): ObjectiveAttentionRecord {
    return this.openAttention(feedback, {
      version: 1,
      kind: "attention",
      decisionId: hash({ feedbackId: feedback.id, reason }),
      requestKey: feedback.id,
      feedbackId: feedback.id,
      objectiveId: feedback.objectiveId,
      runId: feedback.runId,
      reason,
      evidence: { eventCursor: maxEvidenceCursor(feedback), eventIds: [], observationIds: [], artifactIds: [], checkpointIds: [], sources: [] },
      charterCitations: { valueIds: [], tradeoffIds: [] },
      idempotencyKey: feedback.id,
      replay: { deliveryKey: feedback.id, status: "new", idempotent: true },
      code: "invalid-feedback",
      risk: "high",
      blockedOn: [feedback.attemptId, feedback.nodeId],
    }, run);
  }

  private openAttention(feedback: CapabilityResultFeedbackRecord, reduced: Extract<ObjectiveFeedbackDecision, { kind: "attention" }>, run: ObjectiveRunRecord): ObjectiveAttentionRecord {
    if (!this.attentionRegistry) throw new Error("Objective feedback attention requires an ObjectiveAttentionRegistry.");
    const requestKey = `objective-feedback-attention:${feedback.id}`;
    const id = `attention:${hash(requestKey)}`;
    const existing = this.attentionRegistry.get(run.runId, id);
    if (existing) return existing;
    return this.attentionRegistry.create({
      objectiveId: run.objectiveId,
      runId: run.runId,
      operationId: requestKey,
      nodeId: feedback.nodeId,
      attemptId: feedback.attemptId,
      requestKey,
      requestedBy: { type: "system", id: "objective-supervisor" },
      now: this.now(),
      id,
    }, {
      reason: reduced.reason,
      consequence: "The capability result cannot advance the objective without explicit supervision.",
      risk: reduced.risk,
      urgency: reduced.risk === "critical" ? "critical" : "high",
      confidence: 1,
      blockedResource: { kind: "capability", id: feedback.capabilityAdmissionId },
      proposedAction: "Review the accepted capability result and resolve the bounded objective attention item.",
      alternatives: ["Provide corrected evidence", "Reject the capability result"],
      authorityBoundary: {
        permission: run.policy?.effectivePermission ?? this.options.authority.permissionCeiling,
        sideEffectClass: run.policy?.sideEffectClassCeiling ?? "local",
        capability: feedback.capabilityAdmissionId,
        resource: `${run.objectiveId}:${feedback.nodeId}`,
        description: "Resolution is bounded to this objective run and cannot widen its authority.",
      },
      evidenceRefs: feedback.evidenceRefs.map(toAttentionEvidence),
      assignee: null,
      expiresAt: null,
      escalation: { at: null, to: null, policy: "none", reason: null },
    });
  }
}

function toReducerInput(feedback: CapabilityResultFeedbackRecord, statusOverride?: ReducerStatus): ObjectiveFeedbackInputRecord {
  const result = feedback.result;
  const resultObject = result !== null && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, JsonValue>
    : null;
  const rawStatus = resultObject?.status;
  const status: ReducerStatus = statusOverride ?? (rawStatus === "succeeded" || rawStatus === "success" || rawStatus === "failed" || rawStatus === "failure" || rawStatus === "unknown"
    ? rawStatus
    : "unknown");
  const output = resultObject && "output" in resultObject ? resultObject.output ?? null : result;
  const evidence = {
    eventCursor: maxEvidenceCursor(feedback),
    eventIds: feedback.evidenceRefs.filter((ref) => ref.kind === "event").map((ref) => ref.id),
    observationIds: feedback.evidenceRefs.filter((ref) => ref.kind === "observation").map((ref) => ref.id),
    artifactIds: feedback.evidenceRefs.filter((ref) => ref.kind === "artifact").map((ref) => ref.id),
    checkpointIds: feedback.evidenceRefs.filter((ref) => ref.kind === "checkpoint").map((ref) => ref.id),
    sources: feedback.evidenceRefs.map((ref) => ({ id: ref.id, kind: ref.kind === "trace" || ref.kind === "file" ? "external" : ref.kind, ...(ref.cursor === undefined ? {} : { cursor: ref.cursor }) })),
  };
  return ObjectiveFeedbackInputRecordSchema.parse({
    version: 1,
    feedbackId: feedback.id,
    requestKey: feedback.idempotencyKey,
    objectiveId: feedback.objectiveId,
    runId: feedback.runId,
    taskId: feedback.nodeId,
    attemptId: feedback.attemptId,
    capabilityId: feedback.capabilityAdmissionId,
    capabilityVersion: 1,
    contentHash: feedback.capabilityAdmissionHash,
    status,
    result,
    output,
    error: status === "failed" ? feedback.summary : null,
    evidence,
    criteria: [],
    violations: { hardConstraintIds: [], antiGoalIds: [] },
    hardConstraintViolations: [],
    antiGoalViolations: [],
  });
}

function resultOutput(result: JsonValue): JsonValue {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const output = (result as Record<string, JsonValue>).output;
    if (output !== undefined) return output;
  }
  return result;
}

function assessmentFor(decision: ObjectiveFeedbackDecision): CapabilityResultEvaluationRecord["assessment"] {
  if (decision.kind === "continue" || decision.kind === "finish") return "pass";
  if (decision.kind === "replan" || decision.kind === "attention") return "fail";
  return "inconclusive";
}

function scoreFor(decision: ObjectiveFeedbackDecision): number | null {
  if (decision.kind === "continue" || decision.kind === "finish") return 1;
  if (decision.kind === "replan" || decision.kind === "attention") return 0;
  return null;
}

function toAttentionEvidence(ref: CapabilityResultEvidenceRef): string | { kind: "event" | "artifact" | "checkpoint" | "trace" | "observation" | "file" | "other"; id: string; cursor?: number } {
  const kind = ref.kind === "agent-output" || ref.kind === "external" ? "other" : ref.kind;
  return { kind, id: ref.id, ...(ref.cursor === undefined ? {} : { cursor: ref.cursor }) };
}

function maxEvidenceCursor(feedback: CapabilityResultFeedbackRecord): number {
  return feedback.evidenceRefs.reduce((max, ref) => Math.max(max, ref.cursor ?? 0), 0);
}

function evaluationKey(id: string): string { return `objective-feedback-evaluation:${id}`; }
function decisionKey(id: string): string { return `objective-feedback-decision:${id}`; }
function hash(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
