import { describe, expect, it } from "vitest";
import {
  withCapabilityResultDecisionHash,
  withCapabilityResultEvaluationHash,
  withCapabilityResultFeedbackHash,
} from "@symphony/protocol";
import { CapabilityResultFeedbackRepository } from "./capability-result-feedback.js";

const identity = {
  version: 1 as const,
  objectiveId: "objective-1",
  runId: "run-1",
  nodeId: "node-1",
  attemptId: "attempt-1",
  capabilityAdmissionId: "admission-1",
  capabilityAdmissionHash: "a".repeat(64),
  agentId: "agent-1",
  nativeAgentId: null,
  nativeSessionId: "session-1",
  nativeRunId: null,
  evidenceRefs: [],
  charterCitation: null,
  createdAt: "2026-09-01T00:00:00.000Z",
};

describe("capability-result feedback storage", () => {
  it("persists all three records and replays idempotently", () => {
    const repository = new CapabilityResultFeedbackRepository(":memory:");
    try {
      const feedback = withCapabilityResultFeedbackHash({ ...identity, id: "feedback-1", status: "received", result: { ok: true }, summary: null, idempotencyKey: "feedback-key-1" });
      const evaluation = withCapabilityResultEvaluationHash({ ...identity, id: "evaluation-1", feedbackId: feedback.id, status: "completed", assessment: "pass", score: 1, findings: [], evaluation: null, idempotencyKey: "evaluation-key-1" });
      const decision = withCapabilityResultDecisionHash({ ...identity, id: "decision-1", feedbackId: feedback.id, evaluationId: evaluation.id, status: "proposed", decision: "continue", reason: "Continue the bounded plan.", idempotencyKey: "decision-key-1" });
      expect(repository.saveFeedback(feedback)).toBe(true);
      expect(repository.saveFeedback(feedback)).toBe(false);
      expect(repository.saveEvaluation(evaluation)).toBe(true);
      expect(repository.saveDecision(decision)).toBe(true);
      expect(repository.getFeedback(feedback.id)).toEqual(feedback);
      expect(repository.getEvaluation(evaluation.id)).toEqual(evaluation);
      expect(repository.getDecision(decision.id)).toEqual(decision);
      expect(repository.listDecisions({ runId: "run-1" })).toHaveLength(1);
      expect(repository.getByIdempotencyKey("feedback", feedback.idempotencyKey)).toEqual(feedback);
    } finally {
      repository.close();
    }
  });

  it("rejects a conflicting idempotency key and mismatched parent identity", () => {
    const repository = new CapabilityResultFeedbackRepository(":memory:");
    try {
      const feedback = withCapabilityResultFeedbackHash({ ...identity, id: "feedback-1", status: "received", result: { ok: true }, summary: null, idempotencyKey: "feedback-key-1" });
      repository.saveFeedback(feedback);
      const { hash: _hash, ...feedbackContent } = feedback;
      expect(() => repository.saveFeedback(withCapabilityResultFeedbackHash({ ...feedbackContent, result: { ok: false } }))).toThrow(/idempotency conflict/iu);
      const evaluation = withCapabilityResultEvaluationHash({ ...identity, runId: "other-run", id: "evaluation-1", feedbackId: feedback.id, status: "completed", assessment: "fail", score: 0, findings: [], evaluation: null, idempotencyKey: "evaluation-key-1" });
      expect(() => repository.saveEvaluation(evaluation)).toThrow(/identity mismatch/iu);
    } finally {
      repository.close();
    }
  });
});
