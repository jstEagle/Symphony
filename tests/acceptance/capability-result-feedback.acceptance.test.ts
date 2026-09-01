import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityVersionRecordSchema,
  CapabilityResultDecisionRecordSchema,
  CapabilityResultEvaluationRecordSchema,
  CapabilityResultFeedbackRecordSchema,
  capabilityVersionContentHash,
  capabilityResultDecisionHash,
  capabilityResultEvaluationHash,
  capabilityResultFeedbackHash,
  normalizeObjectiveValueCharter,
  objectiveValueCharterBinding,
  withCapabilityResultDecisionHash,
  withCapabilityResultEvaluationHash,
  withCapabilityResultFeedbackHash,
} from "../../packages/protocol/src/index.js";
import {
  ObjectiveFeedbackReducer,
  ObjectiveFeedbackInputRecordSchema,
  type ObjectiveFeedbackContext,
  type ObjectiveFeedbackInputRecord,
} from "../../packages/workflow/src/objective-feedback.js";
import {
  ObjectiveRuntime,
  ObjectiveRuntimeError,
  type ObjectiveActionReceipt,
  type ObjectiveRepository,
} from "../../packages/workflow/src/objective-runtime.js";
import type {
  ObjectiveApprovalRecord,
  ObjectiveCheckpointRecord,
  ObjectiveRunRecord,
  ObjectiveTask,
} from "../../packages/protocol/src/index.js";
import { CapabilityResultFeedbackRepository } from "../../packages/storage/src/capability-result-feedback.js";

type FeedbackScenario = {
  id: string;
  status: "pending" | "verified";
  requiredEvidence: string[];
};

type FeedbackManifest = {
  version: number;
  suite: string;
  status: "wired";
  purpose: string;
  adapter: {
    status: "wired";
    wiringNote: string;
    requiredOperations: string[];
  };
  identity: {
    objectiveId: string;
    runId: string;
    workflowId: string;
    workflowRevision: number;
    workflowHash: string;
    nodeId: string;
    attemptId: string;
    admissionId: string;
    capabilityId: string;
    capabilityVersion: number;
    capabilityContentHash: string;
    eventCursor: number;
    eventIds: string[];
    charterRevision: number;
    charterHash: string;
  };
  scenarios: FeedbackScenario[];
  nonClaims: string[];
};

const manifest = JSON.parse(
  readFileSync(new URL("../fixtures/capability-result-feedback-acceptance.json", import.meta.url), "utf8"),
) as FeedbackManifest;

const scenarioIds = [
  "exactly-once-feedback-evaluation",
  "duplicate-replay-and-conflict",
  "restart-survival",
  "evidence-and-charter-identity",
  "at-most-one-cas-replan",
  "fail-closed-attention",
] as const;

const identity = manifest.identity;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Minimal objective repository used only to drive the production plan CAS. */
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
  saveObjectiveApproval(approval: ObjectiveApprovalRecord): boolean { this.approvals.set(approval.id, approval); return true; }
}

function acceptanceCapability() {
  const createdAt = "2026-09-01T00:00:00.000Z";
  const content = {
    schemaVersion: 1 as const,
    capabilityId: identity.capabilityId,
    version: identity.capabilityVersion,
    state: "active" as const,
    status: "active" as const,
    definition: {
      name: "Feedback acceptance capability",
      parameters: {
        type: "object" as const,
        properties: { value: { type: "string" as const } },
        required: ["value"],
        additionalProperties: false,
      },
      triggers: [],
      defaults: { harness: "fixture", permission: "read-only" },
    },
    provenance: { source: "acceptance", actor: "local-user", metadata: {} },
    hash: "0".repeat(64),
    createdAt,
    updatedAt: createdAt,
    activatedAt: createdAt,
    deprecatedAt: null,
  };
  return CapabilityVersionRecordSchema.parse({
    ...content,
    hash: capabilityVersionContentHash(content),
  });
}

function charter() {
  return normalizeObjectiveValueCharter({
    revision: identity.charterRevision,
    values: [{ id: "quality", label: "Quality", priority: 1 }],
    evidenceExpectations: [{
      id: "result-evidence",
      statement: "The feedback result is backed by durable evidence.",
      required: true,
      sourceKinds: ["event"],
      minimumSources: 1,
    }],
  });
}

function evidence() {
  return {
    eventCursor: identity.eventCursor,
    eventIds: [...identity.eventIds],
    observationIds: [],
    artifactIds: [],
    checkpointIds: [],
    sources: identity.eventIds.map((id) => ({ id, kind: "event" as const, cursor: identity.eventCursor })),
  };
}

function feedbackInput(overrides: Partial<ObjectiveFeedbackInputRecord> = {}): ObjectiveFeedbackInputRecord {
  return ObjectiveFeedbackInputRecordSchema.parse({
    version: 1,
    feedbackId: "feedback-1",
    requestKey: "feedback-request-1",
    objectiveId: identity.objectiveId,
    runId: identity.runId,
    taskId: identity.nodeId,
    attemptId: identity.attemptId,
    capabilityId: identity.capabilityId,
    capabilityVersion: identity.capabilityVersion,
    contentHash: identity.capabilityContentHash,
    status: "succeeded",
    result: { verified: true },
    output: { verified: true },
    error: null,
    evidence: evidence(),
    criteria: [{ criterionId: "verified", passed: true, evidenceEventIds: [...identity.eventIds] }],
    violations: { hardConstraintIds: [], antiGoalIds: [] },
    hardConstraintViolations: [],
    antiGoalViolations: [],
    ...overrides,
  });
}

function feedbackContext(overrides: Partial<ObjectiveFeedbackContext> = {}): ObjectiveFeedbackContext {
  return {
    objectiveId: identity.objectiveId,
    runId: identity.runId,
    expectedPlanRevision: 0,
    replanCount: 0,
    maxReplans: 1,
    objectiveComplete: true,
    criteriaSatisfied: true,
    charter: charter(),
    evidence: evidence(),
    approvalPolicy: "never",
    approval: { required: false },
    charterCitations: { valueIds: ["quality"], tradeoffIds: [] },
    ...overrides,
  };
}

function storageIdentity() {
  return {
    version: 1 as const,
    objectiveId: identity.objectiveId,
    runId: identity.runId,
    nodeId: identity.nodeId,
    attemptId: identity.attemptId,
    capabilityAdmissionId: identity.admissionId,
    capabilityAdmissionHash: identity.capabilityContentHash,
    agentId: "agent-feedback",
    nativeAgentId: "native-feedback",
    nativeSessionId: "session-feedback",
    nativeRunId: "native-run-feedback",
    evidenceRefs: identity.eventIds.map((id, index) => ({ kind: "event" as const, id, cursor: identity.eventCursor - identity.eventIds.length + index + 1 })),
    charterCitation: {
      revision: identity.charterRevision,
      hash: identity.charterHash,
      valueIds: ["quality"],
      tradeoffIds: [],
      antiGoalIds: [],
      hardConstraintIds: [],
      evidenceExpectationIds: ["result-evidence"],
    },
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function feedbackRecord(input: ObjectiveFeedbackInputRecord = feedbackInput()) {
  return withCapabilityResultFeedbackHash({
    ...storageIdentity(),
    id: input.feedbackId,
    idempotencyKey: input.requestKey,
    status: "received",
    result: input.result,
    summary: "A bounded capability result.",
  });
}

function evaluationRecord(feedback: ObjectiveFeedbackInputRecord, assessment: "pass" | "fail") {
  return withCapabilityResultEvaluationHash({
    ...storageIdentity(),
    id: "evaluation-1",
    feedbackId: feedback.feedbackId,
    idempotencyKey: "evaluation-request-1",
    status: "completed",
    assessment,
    score: assessment === "pass" ? 1 : 0,
    findings: [assessment === "pass" ? "The result met the criterion." : "The result did not meet the criterion."],
    evaluation: { feedbackId: feedback.feedbackId, assessment },
  });
}

function decisionRecord(feedback: ObjectiveFeedbackInputRecord, evaluationId: string, decision: "continue" | "finish" | "replan" | "attention", reason: string) {
  return withCapabilityResultDecisionHash({
    ...storageIdentity(),
    id: decision === "replan" ? "decision-replan-1" : "decision-1",
    feedbackId: feedback.feedbackId,
    evaluationId,
    idempotencyKey: decision === "replan" ? "decision-replan-request-1" : "decision-request-1",
    status: "proposed",
    decision,
    reason,
  });
}

function objectiveTask(id: string): ObjectiveTask {
  return {
    id,
    objective: `Complete ${id}`,
    dependsOn: [],
    outputSchema: {},
    model: "fixture",
    harness: "auto",
    inputs: [],
    requiresApproval: false,
  };
}

describe("capability-result feedback acceptance contract", () => {
  it("keeps the manifest bounded, explicit, and complete", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.suite).toBe("capability-result-feedback");
    expect(manifest.status).toBe("wired");
    expect(manifest.adapter.status).toBe("wired");
    expect(manifest.adapter.requiredOperations).toEqual([
      "submitFeedback",
      "evaluateFeedback",
      "commitReplan",
      "restart",
      "listEvidence",
      "listAttentions",
    ]);
    expect(manifest.scenarios.map((scenario) => scenario.id)).toEqual(scenarioIds);
    expect(new Set(manifest.scenarios.map((scenario) => scenario.id)).size).toBe(manifest.scenarios.length);
    for (const scenario of manifest.scenarios) {
      expect(scenario.requiredEvidence.length, scenario.id).toBeGreaterThanOrEqual(3);
      expect(scenario.status).toBe("verified");
    }
    expect(manifest.nonClaims.length).toBeGreaterThanOrEqual(3);
  });

  it("anchors the future feedback result to existing admission and charter identity", () => {
    const capability = acceptanceCapability();
    expect(capability.hash).toBe(identity.capabilityContentHash);

    const result = feedbackRecord();
    expect(result).toMatchObject({
      objectiveId: identity.objectiveId,
      runId: identity.runId,
      nodeId: identity.nodeId,
      attemptId: identity.attemptId,
      capabilityAdmissionId: identity.admissionId,
      capabilityAdmissionHash: identity.capabilityContentHash,
      charterCitation: { revision: identity.charterRevision, hash: identity.charterHash },
    });
    expect(result.hash).toBe(capabilityResultFeedbackHash(result));

    const parsedCharter = charter();
    expect(objectiveValueCharterBinding(parsedCharter)).toEqual({
      revision: identity.charterRevision,
      hash: identity.charterHash,
    });
  });

  it("persists one feedback, one evaluation, and one decision for a submitted result", () => {
    const repository = new CapabilityResultFeedbackRepository(":memory:");
    try {
      const reducer = new ObjectiveFeedbackReducer();
      const input = feedbackInput();
      const feedback = feedbackRecord(input);
      const action = reducer.reduce({ feedback: input, context: feedbackContext() });
      expect(action.kind).toBe("finish");
      if (action.kind !== "finish") throw new Error("Expected a finish decision for the passing result.");

      const evaluation = evaluationRecord(input, "pass");
      const decision = decisionRecord(input, evaluation.id, "finish", action.reason);
      expect(repository.saveFeedback(feedback)).toBe(true);
      expect(repository.saveEvaluation(evaluation)).toBe(true);
      expect(repository.saveDecision(decision)).toBe(true);
      expect(repository.listFeedback({ runId: identity.runId })).toHaveLength(1);
      expect(repository.listEvaluations({ runId: identity.runId })).toHaveLength(1);
      expect(repository.listDecisions({ runId: identity.runId })).toHaveLength(1);
      expect(evaluation.hash).toBe(capabilityResultEvaluationHash(evaluation));
      expect(decision.hash).toBe(capabilityResultDecisionHash(decision));
      expect(CapabilityResultFeedbackRecordSchema.parse(repository.getFeedback(feedback.id))).toEqual(feedback);
      expect(CapabilityResultEvaluationRecordSchema.parse(repository.getEvaluation(evaluation.id))).toEqual(evaluation);
      expect(CapabilityResultDecisionRecordSchema.parse(repository.getDecision(decision.id))).toEqual(decision);
    } finally {
      repository.close();
    }
  });

  it("replays an identical submission and rejects changed feedback without side effects", () => {
    const repository = new CapabilityResultFeedbackRepository(":memory:");
    try {
      const reducer = new ObjectiveFeedbackReducer();
      const input = feedbackInput();
      const feedback = feedbackRecord(input);
      const action = reducer.reduce({ feedback: input, context: feedbackContext() });
      if (action.kind !== "finish") throw new Error("Expected a finish decision for the passing result.");
      const evaluation = evaluationRecord(input, "pass");
      const decision = decisionRecord(input, evaluation.id, "finish", action.reason);
      expect(repository.saveFeedback(feedback)).toBe(true);
      expect(repository.saveFeedback(feedback)).toBe(false);
      expect(repository.saveEvaluation(evaluation)).toBe(true);
      expect(repository.saveEvaluation(evaluation)).toBe(false);
      expect(repository.saveDecision(decision)).toBe(true);
      expect(repository.saveDecision(decision)).toBe(false);

      const { hash: _feedbackHash, ...feedbackContent } = feedback;
      const changed = withCapabilityResultFeedbackHash({
        ...feedbackContent,
        result: { verified: false },
      });
      expect(() => repository.saveFeedback(changed)).toThrow(/idempotency conflict/iu);
      expect(repository.listFeedback({ runId: identity.runId })).toHaveLength(1);
      expect(repository.listEvaluations({ runId: identity.runId })).toHaveLength(1);
      expect(repository.listDecisions({ runId: identity.runId })).toHaveLength(1);

      const replay = reducer.reduce({
        feedback: input,
        context: feedbackContext({ priorDecision: { requestKey: action.requestKey, decisionId: action.decisionId, fingerprint: action.decisionId } }),
      });
      expect(replay).toMatchObject({ decisionId: action.decisionId, replay: { status: "replay", idempotent: true } });
      expect(() => reducer.reduce({
        feedback: feedbackInput({ result: { verified: false }, output: { verified: false } }),
        context: feedbackContext({ priorDecision: { requestKey: action.requestKey, decisionId: action.decisionId, fingerprint: action.decisionId } }),
      })).toThrow(/replay key was reused/iu);
    } finally {
      repository.close();
    }
  });

  it("survives SQLite close/reopen and continues to deduplicate", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-feedback-acceptance-"));
    temporary.push(root);
    const path = join(root, "feedback.sqlite");
    const input = feedbackInput();
    const feedback = feedbackRecord(input);
    const evaluation = evaluationRecord(input, "pass");
    const decision = decisionRecord(input, evaluation.id, "finish", "The result is complete.");
    const first = new CapabilityResultFeedbackRepository(path);
    first.saveFeedback(feedback);
    first.saveEvaluation(evaluation);
    first.saveDecision(decision);
    first.close();

    const restarted = new CapabilityResultFeedbackRepository(path);
    try {
      expect(restarted.getFeedback(feedback.id)).toEqual(feedback);
      expect(restarted.getEvaluation(evaluation.id)).toEqual(evaluation);
      expect(restarted.getDecision(decision.id)).toEqual(decision);
      expect(restarted.saveFeedback(feedback)).toBe(false);
      expect(restarted.saveEvaluation(evaluation)).toBe(false);
      expect(restarted.saveDecision(decision)).toBe(false);
      expect(restarted.listDecisions({ runId: identity.runId })).toHaveLength(1);
    } finally {
      restarted.close();
    }
  });

  it("emits at most one CAS replan recommendation for a failed result", () => {
    const repository = new CapabilityResultFeedbackRepository(":memory:");
    try {
      const reducer = new ObjectiveFeedbackReducer();
      const input = feedbackInput({
        feedbackId: "feedback-replan-1",
        requestKey: "feedback-replan-request-1",
        status: "failed",
        result: { verified: false },
        output: null,
        criteria: [{ criterionId: "verified", passed: false, evidenceEventIds: [...identity.eventIds] }],
      });
      const action = reducer.reduce({ feedback: input, context: feedbackContext({ objectiveComplete: false }) });
      expect(action).toMatchObject({ kind: "replan", expectedPlanRevision: 0, nextReplanCount: 1, cas: { operation: "objective.plan.commit", expectedPlanRevision: 0 } });
      if (action.kind !== "replan") throw new Error("Expected a bounded replan decision.");
      const feedback = feedbackRecord(input);
      const evaluation = evaluationRecord(input, "fail");
      const decision = decisionRecord(input, evaluation.id, "replan", action.reason);
      expect(repository.saveFeedback(feedback)).toBe(true);
      expect(repository.saveEvaluation(evaluation)).toBe(true);
      expect(repository.saveDecision(decision)).toBe(true);
      expect(repository.saveDecision(decision)).toBe(false);
      expect(repository.listDecisions({ runId: identity.runId })).toHaveLength(1);

      const exhausted = reducer.reduce({ feedback: input, context: feedbackContext({ objectiveComplete: false, replanCount: 1 }) });
      expect(exhausted).toMatchObject({ kind: "attention", code: "replan-exhausted" });

      // Exercise the real objective plan CAS behind the reducer's recommendation:
      // one initial head, one replacement, and a stale concurrent writer.
      const objectiveRepository = new MemoryObjectiveRepository();
      const runtime = new ObjectiveRuntime(objectiveRepository, { now: () => "2026-09-01T00:00:00.000Z", id: () => "feedback-cas-id" });
      const authority = { actor: { type: "agent" as const, id: "feedback-conductor" }, permissionCeiling: "full-access" as const };
      const run = runtime.create({
        runId: "feedback-cas-run",
        objectiveId: "feedback-cas-objective",
        workflowId: "feedback-cas-workflow",
        workflowRevision: 1,
        workflowHash: "feedback-cas-workflow-hash",
        spec: {
          id: "feedback-cas-objective",
          statement: "Bound one feedback-driven replacement plan.",
          criteria: [],
          approvalPolicy: { mode: "never" },
          maxReplans: 1,
        },
        tasks: [],
        requestKey: "feedback-cas-create",
      }, authority);
      const initial = runtime.commitPlan(run.runId, {
        expectedPlanRevision: 0,
        tasks: [objectiveTask("initial")],
        reason: "Initial plan",
        requestKey: "feedback-cas-initial-plan",
      }, authority);
      expect(initial.activePlanRevision).toBe(1);
      const replacement = runtime.commitPlan(run.runId, {
        expectedPlanRevision: action.expectedPlanRevision + 1,
        tasks: [objectiveTask("replacement")],
        reason: action.reason,
        requestKey: "feedback-cas-replacement-plan",
      }, authority);
      expect(replacement.activePlanRevision).toBe(2);
      expect(replacement.replanCount).toBe(1);
      expect(runtime.commitPlan(run.runId, {
        expectedPlanRevision: action.expectedPlanRevision + 1,
        tasks: [objectiveTask("replacement")],
        reason: action.reason,
        requestKey: "feedback-cas-replacement-plan",
      }, authority)).toEqual(replacement);
      // A different request key at the stale head is a true CAS conflict;
      // the exact retry above is an idempotent receipt replay.
      expect(() => runtime.commitPlan(run.runId, {
        expectedPlanRevision: action.expectedPlanRevision + 1,
        tasks: [objectiveTask("conflicting-replacement")],
        reason: "Conflicting stale replacement",
        requestKey: "feedback-cas-conflict-plan",
      }, authority)).toThrow(ObjectiveRuntimeError);
    } finally {
      repository.close();
    }
  });

  it("fails closed into attention for unknown, missing-evidence, and mismatched feedback", () => {
    const reducer = new ObjectiveFeedbackReducer();
    const unknown = reducer.reduce({
      feedback: feedbackInput({ status: "unknown" }),
      context: feedbackContext(),
    });
    expect(unknown).toMatchObject({ kind: "attention", code: "unknown-result" });

    const missingEvidence = reducer.reduce({
      feedback: feedbackInput({ evidence: { eventCursor: 0, eventIds: [], observationIds: [], artifactIds: [], checkpointIds: [], sources: [] } }),
      context: feedbackContext({ evidence: { eventCursor: 0, eventIds: [], observationIds: [], artifactIds: [], checkpointIds: [], sources: [] } }),
    });
    expect(missingEvidence).toMatchObject({ kind: "attention", code: "missing-evidence" });

    const mismatched = reducer.reduce({
      feedback: feedbackInput({ runId: "other-run" }),
      context: feedbackContext(),
    });
    expect(mismatched).toMatchObject({ kind: "attention", code: "invalid-feedback", risk: "critical" });
  });

  it("rejects persisted child records whose evidence identity crosses runs", () => {
    const repository = new CapabilityResultFeedbackRepository(":memory:");
    try {
      const input = feedbackInput();
      const feedback = feedbackRecord(input);
      repository.saveFeedback(feedback);
      const evaluation = withCapabilityResultEvaluationHash({
        ...storageIdentity(),
        runId: "other-run",
        id: "evaluation-cross-run",
        feedbackId: feedback.id,
        idempotencyKey: "evaluation-cross-run-key",
        status: "completed",
        assessment: "pass",
        score: 1,
        findings: ["Cross-run evidence must fail closed."],
        evaluation: null,
      });
      expect(() => repository.saveEvaluation(evaluation)).toThrow(/identity mismatch/iu);
      const admissionMismatch = withCapabilityResultEvaluationHash({
        ...storageIdentity(),
        capabilityAdmissionHash: "d".repeat(64),
        id: "evaluation-admission-mismatch",
        feedbackId: feedback.id,
        idempotencyKey: "evaluation-admission-mismatch-key",
        status: "completed",
        assessment: "pass",
        score: 1,
        findings: ["Admission identity must remain immutable."],
        evaluation: null,
      });
      expect(() => repository.saveEvaluation(admissionMismatch)).toThrow(/identity mismatch/iu);
      expect(repository.listEvaluations({ runId: identity.runId })).toHaveLength(0);
    } finally {
      repository.close();
    }
  });
});
