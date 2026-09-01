import { describe, expect, it } from "vitest";
import {
  reduceObjectiveFeedback,
  type ObjectiveFeedbackInputRecord,
  type ObjectiveFeedbackContext,
} from "./objective-feedback.js";

const baseFeedback = (overrides: Partial<ObjectiveFeedbackInputRecord> = {}): ObjectiveFeedbackInputRecord => ({
  version: 1,
  feedbackId: "feedback-1",
  requestKey: "feedback-request-1",
  objectiveId: "objective-1",
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  capabilityId: "capability.test",
  capabilityVersion: 1,
  contentHash: "capability-content-hash-1",
  status: "succeeded",
  result: { ok: true },
  output: null,
  error: null,
  evidence: { eventCursor: 4, eventIds: ["event-1"], observationIds: [], artifactIds: [], checkpointIds: [], sources: [] },
  criteria: [],
  violations: { hardConstraintIds: [], antiGoalIds: [] },
  hardConstraintViolations: [],
  antiGoalViolations: [],
  ...overrides,
});

const baseContext = (overrides: Partial<ObjectiveFeedbackContext> = {}): ObjectiveFeedbackContext => ({
  objectiveId: "objective-1",
  runId: "run-1",
  expectedPlanRevision: 3,
  replanCount: 0,
  maxReplans: 2,
  objectiveComplete: false,
  criteriaSatisfied: true,
  charter: null,
  evidence: { eventCursor: 4, eventIds: [], observationIds: [], artifactIds: [], checkpointIds: [], sources: [] },
  approvalPolicy: "never",
  approval: { required: false },
  ...overrides,
});

const charter = {
  version: 1 as const,
  revision: 2,
  values: [{ id: "correctness", label: "Correctness", priority: 1 }],
  tradeoffs: [],
  antiGoals: [{ id: "unsafe", statement: "Do not produce unsafe output." }],
  hardConstraints: [{ id: "constraint", statement: "Must stay within scope." }],
  evidenceExpectations: [{ id: "proof", statement: "Retain a proof event.", sourceKinds: ["event" as const], minimumSources: 1, required: true }],
};

describe("objective feedback reducer", () => {
  it("continues after a successful partial capability result", () => {
    const result = reduceObjectiveFeedback(baseFeedback(), baseContext());
    expect(result.kind).toBe("continue");
    expect(result.replay).toMatchObject({ deliveryKey: "feedback-request-1", status: "new", idempotent: true });
  });

  it("finishes a complete result, or waits for completion approval", () => {
    const complete = baseContext({ objectiveComplete: true });
    expect(reduceObjectiveFeedback(baseFeedback(), complete)).toMatchObject({ kind: "finish", state: "succeeded" });
    expect(reduceObjectiveFeedback(baseFeedback(), { ...complete, approvalPolicy: "before-completion" })).toMatchObject({
      kind: "wait-for-approval", approvalKind: "completion", resumes: "finish",
    });
  });

  it("fails closed on hard constraints and anti-goals", () => {
    expect(reduceObjectiveFeedback(baseFeedback({ violations: { hardConstraintIds: ["constraint"], antiGoalIds: [] } }), baseContext({ charter }))).toMatchObject({ kind: "attention", code: "hard-constraint-violation", risk: "critical" });
    expect(reduceObjectiveFeedback(baseFeedback({ antiGoalViolations: ["unsafe"] }), baseContext({ charter }))).toMatchObject({ kind: "attention", code: "anti-goal-violation" });
  });

  it("requires evidence before reducing a charter-bound result", () => {
    const result = reduceObjectiveFeedback(baseFeedback({ evidence: { eventCursor: 0, eventIds: [], observationIds: [], artifactIds: [], checkpointIds: [], sources: [] } }), baseContext({ charter }));
    expect(result).toMatchObject({ kind: "attention", code: "missing-evidence", blockedOn: ["proof"] });
  });

  it("does not guess when the native result is unknown", () => {
    const result = reduceObjectiveFeedback(baseFeedback({ status: "unknown" }), baseContext());
    expect(result).toMatchObject({ kind: "attention", code: "unknown-result" });
  });

  it("requests one CAS replan and carries valid charter citations", () => {
    const result = reduceObjectiveFeedback(baseFeedback({ status: "failed", error: "failed" }), baseContext({ charter, charterCitations: { valueIds: ["correctness"], tradeoffIds: [] } }));
    expect(result).toMatchObject({
      kind: "replan",
      cas: { operation: "objective.plan.commit", expectedPlanRevision: 3 },
      nextReplanCount: 1,
      charterCitations: { valueIds: ["correctness"], tradeoffIds: [] },
    });
    expect(reduceObjectiveFeedback(baseFeedback({ status: "failed" }), baseContext({ charter, charterCitations: { valueIds: ["correctness"], tradeoffIds: [] }, approvalPolicy: "on-replan" }))).toMatchObject({ kind: "wait-for-approval", approvalKind: "replan" });
  });

  it("returns the same decision on duplicate delivery and marks an explicit replay", () => {
    const feedback = baseFeedback();
    const context = baseContext();
    const first = reduceObjectiveFeedback(feedback, context);
    const duplicate = reduceObjectiveFeedback(feedback, context);
    expect(duplicate).toEqual(first);
    expect(reduceObjectiveFeedback(feedback, { ...context, priorDecision: { requestKey: feedback.requestKey, decisionId: first.decisionId, fingerprint: first.decisionId } })).toMatchObject({ replay: { status: "replay" } });
  });
});
