import { describe, expect, it } from "vitest";
import {
  CapabilityResultDecisionRecordSchema,
  CapabilityResultEvaluationRecordSchema,
  CapabilityResultFeedbackRecordSchema,
  capabilityResultDecisionHash,
  capabilityResultEvaluationHash,
  capabilityResultFeedbackHash,
  isCapabilityResultFeedbackHashValid,
  withCapabilityResultDecisionHash,
  withCapabilityResultEvaluationHash,
  withCapabilityResultFeedbackHash,
} from "./capability-result-feedback.js";

const identity = {
  version: 1 as const,
  objectiveId: "objective-1",
  runId: "run-1",
  nodeId: "node-1",
  attemptId: "attempt-1",
  capabilityAdmissionId: "admission-1",
  capabilityAdmissionHash: "a".repeat(64),
  agentId: "agent-1",
  nativeAgentId: "native-agent-1",
  nativeSessionId: "session-1",
  nativeRunId: "native-run-1",
  evidenceRefs: [{ kind: "event" as const, id: "event-1", cursor: 4, hash: "b".repeat(64) }],
  charterCitation: { revision: 2, hash: "c".repeat(64), valueIds: ["correctness"], tradeoffIds: [], antiGoalIds: [], hardConstraintIds: [], evidenceExpectationIds: [] },
  idempotencyKey: "feedback-request-1",
  createdAt: "2026-09-01T00:00:00.000Z",
};

describe("capability-result feedback protocol", () => {
  it("creates stable, content-addressed feedback/evaluation/decision records", () => {
    const feedback = withCapabilityResultFeedbackHash({ ...identity, id: "feedback-1", status: "received", result: { z: 1, a: "ok" }, summary: null });
    const reordered = withCapabilityResultFeedbackHash({ ...identity, id: "feedback-1", status: "received", result: { a: "ok", z: 1 }, summary: null });
    expect(feedback.hash).toBe(capabilityResultFeedbackHash(feedback));
    expect(reordered.hash).toBe(feedback.hash);
    expect(isCapabilityResultFeedbackHashValid(feedback)).toBe(true);

    const evaluation = withCapabilityResultEvaluationHash({ ...identity, id: "evaluation-1", feedbackId: feedback.id, status: "completed", assessment: "pass", score: 1, findings: ["The result met the contract."], evaluation: { passed: true } });
    const decision = withCapabilityResultDecisionHash({ ...identity, id: "decision-1", feedbackId: feedback.id, evaluationId: evaluation.id, status: "proposed", decision: "continue", reason: "The evaluated result is sufficient." });
    expect(evaluation.hash).toBe(capabilityResultEvaluationHash(evaluation));
    expect(decision.hash).toBe(capabilityResultDecisionHash(decision));
    expect(CapabilityResultDecisionRecordSchema.parse(decision).decision).toBe("continue");
  });

  it("keeps control outcomes closed and JSON payloads bounded", () => {
    expect(() => CapabilityResultDecisionRecordSchema.parse({
      ...identity, id: "decision-1", feedbackId: "feedback-1", evaluationId: "evaluation-1", status: "proposed", decision: "launch", reason: "invalid", hash: "d".repeat(64),
    })).toThrow();
    expect(() => CapabilityResultFeedbackRecordSchema.parse({
      ...identity, id: "feedback-1", status: "received", result: "x".repeat(513 * 1024), summary: null, hash: "d".repeat(64),
    })).toThrow(/512 KiB/iu);
    expect(() => CapabilityResultEvaluationRecordSchema.parse({
      ...identity, id: "evaluation-1", feedbackId: "feedback-1", status: "completed", assessment: "pass", score: 1, findings: [], evaluation: null, hash: "d".repeat(64), extra: true,
    })).toThrow();
  });
});
