import { createHash } from "node:crypto";
import {
  ObjectiveValueCharterSchema,
  type JsonValue,
  type ObjectiveValueCharter,
  type ObjectiveValueCharterMutationCitation,
} from "@symphony/protocol";
import { z } from "zod";

/**
 * The result boundary used by capability adapters.  Adapters should validate
 * their native result before calling this reducer; parsing here is cheap and
 * makes the pure entry point safe to use after a daemon restart as well.
 * `success`/`failure` are accepted as compatibility spellings for callers
 * that use a shorter status vocabulary.
 */
const IdSchema = z.string().min(1).max(512);
const HashSchema = z.string().min(8).max(256);
const JsonValueSchema = z.json();
const CapabilityResultStatusSchema = z.enum(["succeeded", "success", "failed", "failure", "unknown"]);

export const ObjectiveFeedbackEvidenceSourceSchema = z.object({
  id: IdSchema,
  kind: z.enum(["event", "observation", "artifact", "checkpoint", "agent-output", "workspace", "external"]),
  cursor: z.number().int().nonnegative().optional(),
}).strict();
export type ObjectiveFeedbackEvidenceSource = z.infer<typeof ObjectiveFeedbackEvidenceSourceSchema>;

export const ObjectiveFeedbackEvidenceSchema = z.object({
  eventCursor: z.number().int().nonnegative().default(0),
  eventIds: z.array(IdSchema).max(256).default([]),
  observationIds: z.array(IdSchema).max(256).default([]),
  artifactIds: z.array(IdSchema).max(256).default([]),
  checkpointIds: z.array(IdSchema).max(256).default([]),
  sources: z.array(ObjectiveFeedbackEvidenceSourceSchema).max(512).default([]),
}).strict();
const EMPTY_EVIDENCE = { eventCursor: 0, eventIds: [] as string[], observationIds: [] as string[], artifactIds: [] as string[], checkpointIds: [] as string[], sources: [] as ObjectiveFeedbackEvidenceSource[] };
export type ObjectiveFeedbackEvidence = z.infer<typeof ObjectiveFeedbackEvidenceSchema>;
export const ObjectiveFeedbackEvidenceContextSchema = ObjectiveFeedbackEvidenceSchema;
export type ObjectiveFeedbackEvidenceContext = ObjectiveFeedbackEvidence;

export const ObjectiveFeedbackCriterionResultSchema = z.object({
  criterionId: IdSchema,
  passed: z.boolean(),
  evidenceEventIds: z.array(IdSchema).max(128).default([]),
}).strict();
export type ObjectiveFeedbackCriterionResult = z.infer<typeof ObjectiveFeedbackCriterionResultSchema>;

export const ObjectiveFeedbackCharterViolationSchema = z.object({
  hardConstraintIds: z.array(IdSchema).max(64).default([]),
  antiGoalIds: z.array(IdSchema).max(64).default([]),
}).strict();
export type ObjectiveFeedbackCharterViolation = z.infer<typeof ObjectiveFeedbackCharterViolationSchema>;

/** One immutable, capability-backed observation delivered to the objective loop. */
export const ObjectiveFeedbackInputRecordSchema = z.object({
  version: z.literal(1).default(1),
  feedbackId: IdSchema,
  requestKey: z.string().min(8).max(512),
  objectiveId: IdSchema,
  runId: IdSchema,
  taskId: IdSchema.nullable().default(null),
  attemptId: IdSchema.nullable().default(null),
  capabilityId: IdSchema,
  /** Both names are retained at the boundary because capability records use `version`. */
  capabilityVersion: z.number().int().positive().optional(),
  versionId: z.number().int().positive().optional(),
  contentHash: HashSchema.optional(),
  status: CapabilityResultStatusSchema,
  result: JsonValueSchema.nullable().default(null),
  output: JsonValueSchema.nullable().optional(),
  error: z.string().max(4_000).nullable().default(null),
  evidence: ObjectiveFeedbackEvidenceSchema.default(EMPTY_EVIDENCE),
  criteria: z.array(ObjectiveFeedbackCriterionResultSchema).max(64).default([]),
  violations: ObjectiveFeedbackCharterViolationSchema.default({ hardConstraintIds: [], antiGoalIds: [] }),
  /** Compatibility aliases for adapters that flatten the violation envelope. */
  hardConstraintViolations: z.array(IdSchema).max(64).default([]),
  antiGoalViolations: z.array(IdSchema).max(64).default([]),
}).strict().superRefine((record, context) => {
  if (record.capabilityVersion === undefined && record.versionId === undefined) {
    context.addIssue({ code: "custom", path: ["capabilityVersion"], message: "Capability feedback requires a capability version." });
  }
  if (record.capabilityVersion !== undefined && record.versionId !== undefined && record.capabilityVersion !== record.versionId) {
    context.addIssue({ code: "custom", path: ["versionId"], message: "Capability version aliases must agree." });
  }
  const seen = new Set<string>();
  for (const criterion of record.criteria) {
    if (seen.has(criterion.criterionId)) context.addIssue({ code: "custom", path: ["criteria"], message: `Duplicate criterion ${criterion.criterionId}.` });
    seen.add(criterion.criterionId);
  }
});
export type ObjectiveFeedbackInputRecord = z.infer<typeof ObjectiveFeedbackInputRecordSchema>;

export const ObjectiveFeedbackApprovalContextSchema = z.object({
  required: z.boolean().default(false),
  approvalId: IdSchema.optional(),
}).strict();
export type ObjectiveFeedbackApprovalContext = z.infer<typeof ObjectiveFeedbackApprovalContextSchema>;

export const ObjectiveFeedbackContextSchema = z.object({
  objectiveId: IdSchema,
  runId: IdSchema,
  /** Plan revision used by the capability attempt; this is the CAS fence. */
  expectedPlanRevision: z.number().int().nonnegative(),
  replanCount: z.number().int().nonnegative().default(0),
  maxReplans: z.number().int().nonnegative().default(0),
  objectiveComplete: z.boolean().default(false),
  criteriaSatisfied: z.boolean().default(true),
  charter: ObjectiveValueCharterSchema.nullable().default(null),
  evidence: ObjectiveFeedbackEvidenceSchema.default(EMPTY_EVIDENCE),
  approvalPolicy: z.union([
    z.enum(["never", "on-replan", "before-completion"]),
    z.object({ mode: z.enum(["never", "on-replan", "before-completion"]) }).strict(),
  ]).default("never"),
  approval: ObjectiveFeedbackApprovalContextSchema.default({ required: false }),
  /** Citations are copied onto any replacement-plan request. */
  charterCitations: z.object({
    valueIds: z.array(IdSchema).max(32).default([]),
    tradeoffIds: z.array(IdSchema).max(64).default([]),
  }).strict().optional(),
  /** Prior receipt makes replay state explicit without adding mutable reducer state. */
  priorDecision: z.object({
    requestKey: z.string().min(8),
    decisionId: HashSchema,
    fingerprint: HashSchema,
  }).strict().optional(),
}).strict();
export type ObjectiveFeedbackContext = z.infer<typeof ObjectiveFeedbackContextSchema>;

const DecisionKindSchema = z.enum(["continue", "replan", "wait-for-approval", "finish", "attention"]);
export type ObjectiveFeedbackDecisionKind = z.infer<typeof DecisionKindSchema>;

const DecisionBaseSchema = z.object({
  version: z.literal(1),
  kind: DecisionKindSchema,
  decisionId: HashSchema,
  requestKey: z.string().min(8),
  feedbackId: IdSchema,
  objectiveId: IdSchema,
  runId: IdSchema,
  reason: z.string().min(1).max(4_000),
  evidence: ObjectiveFeedbackEvidenceSchema,
  charterCitations: z.object({ valueIds: z.array(IdSchema), tradeoffIds: z.array(IdSchema) }).strict(),
  idempotencyKey: z.string().min(8),
  replay: z.object({
    deliveryKey: z.string().min(8),
    status: z.enum(["new", "replay"]),
    idempotent: z.literal(true),
  }).strict(),
});
export const ObjectiveFeedbackDecisionSchema = z.discriminatedUnion("kind", [
  DecisionBaseSchema.extend({ kind: z.literal("continue") }),
  DecisionBaseSchema.extend({
    kind: z.literal("replan"),
    cas: z.object({ operation: z.literal("objective.plan.commit"), expectedPlanRevision: z.number().int().nonnegative() }).strict(),
    expectedPlanRevision: z.number().int().nonnegative(),
    nextReplanCount: z.number().int().positive(),
    remainingReplans: z.number().int().nonnegative(),
  }),
  DecisionBaseSchema.extend({
    kind: z.literal("wait-for-approval"),
    approvalKind: z.enum(["replan", "completion"]),
    approvalId: IdSchema.optional(),
    resumes: z.enum(["replan", "finish"]),
  }),
  DecisionBaseSchema.extend({
    kind: z.literal("finish"),
    state: z.enum(["succeeded", "failed"]),
    output: JsonValueSchema.nullable(),
  }),
  DecisionBaseSchema.extend({
    kind: z.literal("attention"),
    code: z.enum(["hard-constraint-violation", "anti-goal-violation", "missing-evidence", "unknown-result", "replan-exhausted", "invalid-feedback"]),
    risk: z.enum(["high", "critical"]),
    blockedOn: z.array(IdSchema),
  }),
]);
export type ObjectiveFeedbackDecision = z.infer<typeof ObjectiveFeedbackDecisionSchema>;
export const ObjectiveFeedbackActionSchema = ObjectiveFeedbackDecisionSchema;

export type ObjectiveFeedbackReduceInput = Readonly<{
  feedback: ObjectiveFeedbackInputRecord;
  context: ObjectiveFeedbackContext;
}>;
export type ObjectiveFeedbackReducerInput = ObjectiveFeedbackReduceInput;

/** A data-only feedback loop reducer. No store, clock, scheduler, or driver is consulted. */
export class ObjectiveFeedbackReducer {
  reduce(input: ObjectiveFeedbackReduceInput): ObjectiveFeedbackDecision {
    return reduceObjectiveFeedback(input.feedback, input.context);
  }

  decide(feedback: ObjectiveFeedbackInputRecord, context: ObjectiveFeedbackContext): ObjectiveFeedbackDecision {
    return reduceObjectiveFeedback(feedback, context);
  }
}

export function reduceObjectiveFeedback(
  rawFeedback: ObjectiveFeedbackInputRecord,
  rawContext: ObjectiveFeedbackContext,
): ObjectiveFeedbackDecision {
  const feedback = ObjectiveFeedbackInputRecordSchema.parse(rawFeedback);
  const context = ObjectiveFeedbackContextSchema.parse(rawContext);
  if (feedback.objectiveId !== context.objectiveId || feedback.runId !== context.runId) {
    return decision(feedback, context, "attention", {
      reason: "Capability feedback is bound to a different objective run.",
      code: "invalid-feedback", risk: "critical", blockedOn: [feedback.objectiveId, feedback.runId],
    });
  }

  const charter = context.charter ? ObjectiveValueCharterSchema.parse(context.charter) : null;
  const citations = validateCitations(charter, context.charterCitations);
  const evidence = mergeEvidence(context.evidence, feedback.evidence);
  const status = feedback.status === "succeeded" || feedback.status === "success" ? "succeeded"
    : feedback.status === "failed" || feedback.status === "failure" ? "failed" : "unknown";
  const violations = mergeIds(
    feedback.violations.hardConstraintIds,
    feedback.hardConstraintViolations,
  );
  const antiGoals = mergeIds(feedback.violations.antiGoalIds, feedback.antiGoalViolations);
  if (violations.length > 0) {
    return decision(feedback, context, "attention", {
      reason: `Hard constraint violation: ${violations.join(", ")}.`,
      code: "hard-constraint-violation", risk: "critical", blockedOn: violations,
    }, evidence, citations);
  }
  if (antiGoals.length > 0) {
    return decision(feedback, context, "attention", {
      reason: `Anti-goal violation: ${antiGoals.join(", ")}.`,
      code: "anti-goal-violation", risk: "critical", blockedOn: antiGoals,
    }, evidence, citations);
  }

  if (status === "unknown") {
    return decision(feedback, context, "attention", {
      reason: "Capability result is unknown; the objective loop cannot infer success or retry safety.",
      code: "unknown-result", risk: "high", blockedOn: [feedback.feedbackId],
    }, evidence, citations);
  }

  const missingEvidence = missingEvidenceIds(charter, evidence);
  if (missingEvidence.length > 0) {
    return decision(feedback, context, "attention", {
      reason: `Required evidence is missing: ${missingEvidence.join(", ")}.`,
      code: "missing-evidence", risk: "high", blockedOn: missingEvidence,
    }, evidence, citations);
  }

  const failedCriteria = feedback.criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.criterionId);
  const successful = status === "succeeded" && context.criteriaSatisfied && failedCriteria.length === 0;
  const approvalPolicy = typeof context.approvalPolicy === "string" ? context.approvalPolicy : context.approvalPolicy.mode;
  if (successful && context.objectiveComplete) {
    if (approvalPolicy === "before-completion" || context.approval.required) {
      return decision(feedback, context, "wait-for-approval", {
        reason: "Objective is complete and requires explicit completion approval.",
        approvalKind: "completion", approvalId: context.approval.approvalId, resumes: "finish",
      }, evidence, citations);
    }
    return decision(feedback, context, "finish", {
      reason: "Capability result satisfies the objective and its criteria.",
      state: "succeeded", output: feedback.output ?? feedback.result,
    }, evidence, citations);
  }
  if (successful) {
    return decision(feedback, context, "continue", {
      reason: "Capability result succeeded; the objective still has work remaining.",
    }, evidence, citations);
  }

  if (context.replanCount >= context.maxReplans) {
    return decision(feedback, context, "attention", {
      reason: "Capability result failed and the bounded replan allowance is exhausted.",
      code: "replan-exhausted", risk: "high", blockedOn: [feedback.feedbackId],
    }, evidence, citations);
  }
  if (charter && !citations) {
    return decision(feedback, context, "attention", {
      reason: "A replacement plan must retain at least one valid objective-charter citation.",
      code: "invalid-feedback", risk: "high", blockedOn: ["charter-citations"],
    }, evidence);
  }
  if (approvalPolicy === "on-replan" || context.approval.required) {
    return decision(feedback, context, "wait-for-approval", {
      reason: "Capability result failed; explicit approval is required before requesting one replacement plan.",
      approvalKind: "replan", approvalId: context.approval.approvalId, resumes: "replan",
    }, evidence, citations);
  }
  return decision(feedback, context, "replan", {
    reason: "Capability result failed; request exactly one compare-and-swap replacement plan.",
    cas: { operation: "objective.plan.commit", expectedPlanRevision: context.expectedPlanRevision },
    expectedPlanRevision: context.expectedPlanRevision,
    nextReplanCount: context.replanCount + 1,
    remainingReplans: context.maxReplans - context.replanCount - 1,
  }, evidence, citations ?? emptyCitations());
}

function decision(
  feedback: ObjectiveFeedbackInputRecord,
  context: ObjectiveFeedbackContext,
  kind: ObjectiveFeedbackDecisionKind,
  details: Record<string, unknown>,
  evidence: ObjectiveFeedbackEvidence = mergeEvidence(context.evidence, feedback.evidence),
  citations: ObjectiveValueCharterMutationCitation | null = validateCitations(context.charter, context.charterCitations),
): ObjectiveFeedbackDecision {
  const charterCitations = citations ?? emptyCitations();
  const identity = { kind, feedbackId: feedback.feedbackId, requestKey: feedback.requestKey, objectiveId: context.objectiveId, runId: context.runId, details, evidence, charterCitations };
  const decisionId = sha256(stable(identity));
  const prior = context.priorDecision;
  if (prior && (prior.requestKey !== feedback.requestKey || prior.decisionId !== decisionId || prior.fingerprint !== sha256(stable(identity)))) {
    throw new Error("Objective feedback replay key was reused for a different decision.");
  }
  const replay = { deliveryKey: feedback.requestKey, status: prior ? "replay" : "new", idempotent: true } as const;
  return ObjectiveFeedbackDecisionSchema.parse({
    version: 1, kind, decisionId, requestKey: feedback.requestKey, feedbackId: feedback.feedbackId,
    objectiveId: context.objectiveId, runId: context.runId, idempotencyKey: feedback.requestKey,
    reason: details.reason ?? "Objective feedback reduced.", evidence, charterCitations, replay,
    ...details,
  });
}

function validateCitations(charter: ObjectiveValueCharter | null, citations: ObjectiveFeedbackContext["charterCitations"]): ObjectiveValueCharterMutationCitation | null {
  if (!citations) return charter ? null : emptyCitations();
  if (!charter) return citations.valueIds.length || citations.tradeoffIds.length ? null : emptyCitations();
  const values = new Set(charter.values.map((value) => value.id));
  const tradeoffs = new Set(charter.tradeoffs.map((tradeoff) => tradeoff.id));
  if (citations.valueIds.some((id) => !values.has(id)) || citations.tradeoffIds.some((id) => !tradeoffs.has(id))) return null;
  if (citations.valueIds.length === 0 && citations.tradeoffIds.length === 0) return null;
  return { valueIds: [...citations.valueIds], tradeoffIds: [...citations.tradeoffIds] };
}

function emptyCitations(): ObjectiveValueCharterMutationCitation {
  return { valueIds: [], tradeoffIds: [] } as ObjectiveValueCharterMutationCitation;
}

function mergeIds(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat())].sort();
}

function mergeEvidence(...entries: readonly ObjectiveFeedbackEvidence[]): ObjectiveFeedbackEvidence {
  const sources = [...entries.flatMap((entry) => entry.sources)];
  const sourceKeys = new Set<string>();
  const uniqueSources = sources.filter((source) => {
    const key = `${source.kind}:${source.id}`;
    if (sourceKeys.has(key)) return false;
    sourceKeys.add(key);
    return true;
  });
  return {
    eventCursor: Math.max(...entries.map((entry) => entry.eventCursor), 0),
    eventIds: mergeIds(...entries.map((entry) => entry.eventIds)),
    observationIds: mergeIds(...entries.map((entry) => entry.observationIds)),
    artifactIds: mergeIds(...entries.map((entry) => entry.artifactIds)),
    checkpointIds: mergeIds(...entries.map((entry) => entry.checkpointIds)),
    sources: uniqueSources.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
  };
}

function missingEvidenceIds(charter: ObjectiveValueCharter | null, evidence: ObjectiveFeedbackEvidence): string[] {
  if (!charter) return [];
  const available = new Map<string, number>();
  for (const source of evidence.sources) available.set(source.kind, (available.get(source.kind) ?? 0) + 1);
  for (const kind of ["event", "observation", "artifact", "checkpoint"] as const) {
    const ids = kind === "event" ? evidence.eventIds : kind === "observation" ? evidence.observationIds : kind === "artifact" ? evidence.artifactIds : evidence.checkpointIds;
    available.set(kind, Math.max(available.get(kind) ?? 0, ids.length));
  }
  return charter.evidenceExpectations.filter((expectation) => expectation.required)
    .filter((expectation) => {
      const matching = expectation.sourceKinds.length === 0
        ? Object.values(Object.fromEntries(available)).reduce((sum, count) => sum + count, 0)
        : expectation.sourceKinds.reduce((sum, kind) => sum + (available.get(kind) ?? 0), 0);
      return matching < Math.max(1, expectation.minimumSources);
    }).map((expectation) => expectation.id);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Compatibility alias for callers that use the shorter result-feedback name. */
export const reduceCapabilityResultFeedback = reduceObjectiveFeedback;
export const ObjectiveCapabilityFeedbackReducer = ObjectiveFeedbackReducer;
export const reduceCapabilityFeedback = reduceObjectiveFeedback;
export type ObjectiveFeedbackAction = ObjectiveFeedbackDecision;
