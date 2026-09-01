import { z } from "zod";
import { sha256 } from "./hash.js";

/**
 * Durable contracts for the feedback loop around one capability result.
 *
 * These records are deliberately data-only. They carry enough identity and
 * evidence to make a result replayable and auditable, but contain no callback,
 * expression, prompt, or scheduler instruction.
 */

const IdSchema = z.string().min(1).max(256);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IsoDateSchema = z.iso.datetime({ offset: true });
const JsonValueSchema = z.json();
const BoundedJsonValueSchema = JsonValueSchema.superRefine((value, context) => {
  // Keep one record bounded even when the enclosing SQLite store has no
  // configured quota. This is an encoded-size bound, not a character bound.
  const bytes = new TextEncoder().encode(stableJson(value)).byteLength;
  if (bytes > 512 * 1024) {
    context.addIssue({ code: "custom", message: "JSON value exceeds the 512 KiB feedback bound" });
  }
});

export const CapabilityResultFeedbackStatusSchema = z.enum([
  "received",
  "reported",
  "validated",
  "accepted",
  "rejected",
  "superseded",
]);
export type CapabilityResultFeedbackStatus = z.infer<typeof CapabilityResultFeedbackStatusSchema>;

export const CapabilityResultEvaluationStatusSchema = z.enum([
  "pending",
  "completed",
  "inconclusive",
  "failed",
  "superseded",
]);
export type CapabilityResultEvaluationStatus = z.infer<typeof CapabilityResultEvaluationStatusSchema>;

export const CapabilityResultDecisionStatusSchema = z.enum([
  "proposed",
  "accepted",
  "applied",
  "rejected",
  "superseded",
]);
export type CapabilityResultDecisionStatus = z.infer<typeof CapabilityResultDecisionStatusSchema>;

/** The only control outcomes a feedback evaluation may recommend. */
export const CapabilityResultDecisionSchema = z.enum([
  "continue",
  "replan",
  "wait-for-approval",
  "finish",
  "attention",
]);
export type CapabilityResultDecision = z.infer<typeof CapabilityResultDecisionSchema>;

/** A compact, typed pointer into durable evidence; never embeds evidence content. */
export const CapabilityResultEvidenceRefSchema = z
  .object({
    kind: z.enum(["event", "observation", "artifact", "checkpoint", "trace", "file", "agent-output", "external"]),
    id: IdSchema,
    cursor: z.number().int().nonnegative().optional(),
    hash: HashSchema.optional(),
    description: z.string().max(2_000).optional(),
  })
  .strict();
export type CapabilityResultEvidenceRef = z.infer<typeof CapabilityResultEvidenceRefSchema>;

/** Content-addressed citation to the immutable objective value charter. */
export const CapabilityResultCharterCitationSchema = z
  .object({
    revision: z.number().int().positive().max(1_000_000_000),
    hash: HashSchema,
    valueIds: z.array(IdSchema).max(32).default([]),
    tradeoffIds: z.array(IdSchema).max(64).default([]),
    antiGoalIds: z.array(IdSchema).max(32).default([]),
    hardConstraintIds: z.array(IdSchema).max(64).default([]),
    evidenceExpectationIds: z.array(IdSchema).max(64).default([]),
  })
  .strict()
  .superRefine((citation, context) => {
    const fields = ["valueIds", "tradeoffIds", "antiGoalIds", "hardConstraintIds", "evidenceExpectationIds"] as const;
    const seen = new Set<string>();
    for (const field of fields) {
      for (const [index, id] of citation[field].entries()) {
        if (seen.has(id)) context.addIssue({ code: "custom", path: [field, index], message: `Duplicate charter citation ${id}` });
        seen.add(id);
      }
    }
  });
export type CapabilityResultCharterCitation = z.infer<typeof CapabilityResultCharterCitationSchema>;

const CommonResultIdentitySchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    objectiveId: IdSchema,
    runId: IdSchema,
    nodeId: IdSchema,
    attemptId: IdSchema,
    capabilityAdmissionId: IdSchema,
    capabilityAdmissionHash: HashSchema,
    /** Symphony's durable agent identity, when one was assigned. */
    agentId: IdSchema.nullable().default(null),
    nativeAgentId: IdSchema.nullable().default(null),
    nativeSessionId: IdSchema.nullable().default(null),
    nativeRunId: IdSchema.nullable().default(null),
    evidenceRefs: z.array(CapabilityResultEvidenceRefSchema).max(256).default([]),
    charterCitation: CapabilityResultCharterCitationSchema.nullable().default(null),
    idempotencyKey: z.string().min(8).max(512),
    createdAt: IsoDateSchema,
  })
  .strict();
type CommonResultIdentity = z.infer<typeof CommonResultIdentitySchema>;

/** Immutable observation emitted by a capability-backed attempt. */
export const CapabilityResultFeedbackRecordSchema = CommonResultIdentitySchema
  .extend({
    status: CapabilityResultFeedbackStatusSchema,
    result: BoundedJsonValueSchema,
    summary: z.string().max(4_000).nullable().default(null),
    hash: HashSchema,
  })
  .strict();
export type CapabilityResultFeedbackRecord = z.infer<typeof CapabilityResultFeedbackRecordSchema>;

/** A bounded evaluation of one feedback record. */
export const CapabilityResultEvaluationRecordSchema = CommonResultIdentitySchema
  .extend({
    feedbackId: IdSchema,
    status: CapabilityResultEvaluationStatusSchema,
    assessment: z.enum(["pass", "fail", "mixed", "inconclusive"]),
    score: z.number().finite().min(0).max(1).nullable().default(null),
    findings: z.array(z.string().min(1).max(4_000)).max(128).default([]),
    evaluation: BoundedJsonValueSchema.nullable().default(null),
    hash: HashSchema,
  })
  .strict();
export type CapabilityResultEvaluationRecord = z.infer<typeof CapabilityResultEvaluationRecordSchema>;

/** A durable recommendation derived from an evaluation. */
export const CapabilityResultDecisionRecordSchema = CommonResultIdentitySchema
  .extend({
    feedbackId: IdSchema,
    evaluationId: IdSchema,
    status: CapabilityResultDecisionStatusSchema,
    decision: CapabilityResultDecisionSchema,
    reason: z.string().min(1).max(4_000),
    hash: HashSchema,
  })
  .strict();
export type CapabilityResultDecisionRecord = z.infer<typeof CapabilityResultDecisionRecordSchema>;

// Short aliases are useful to callers that treat the three records as a
// generic result/feedback/evaluation/decision protocol family.
export const CapabilityFeedbackRecordSchema = CapabilityResultFeedbackRecordSchema;
export const CapabilityEvaluationRecordSchema = CapabilityResultEvaluationRecordSchema;
export const CapabilityDecisionRecordSchema = CapabilityResultDecisionRecordSchema;
export type CapabilityFeedbackRecord = CapabilityResultFeedbackRecord;
export type CapabilityEvaluationRecord = CapabilityResultEvaluationRecord;
export type CapabilityDecisionRecord = CapabilityResultDecisionRecord;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordHash(value: CommonResultIdentity & Record<string, unknown>): string {
  const { hash: _ignored, ...content } = value;
  return sha256(stableJson(content));
}

export function capabilityResultFeedbackHash(recordInput: CapabilityResultFeedbackRecord): string {
  return recordHash(CapabilityResultFeedbackRecordSchema.parse(recordInput) as CommonResultIdentity & Record<string, unknown>);
}

export function capabilityResultEvaluationHash(recordInput: CapabilityResultEvaluationRecord): string {
  return recordHash(CapabilityResultEvaluationRecordSchema.parse(recordInput) as CommonResultIdentity & Record<string, unknown>);
}

export function capabilityResultDecisionHash(recordInput: CapabilityResultDecisionRecord): string {
  return recordHash(CapabilityResultDecisionRecordSchema.parse(recordInput) as CommonResultIdentity & Record<string, unknown>);
}

export function isCapabilityResultFeedbackHashValid(recordInput: CapabilityResultFeedbackRecord): boolean {
  const record = CapabilityResultFeedbackRecordSchema.parse(recordInput);
  return record.hash === capabilityResultFeedbackHash(record);
}

export function isCapabilityResultEvaluationHashValid(recordInput: CapabilityResultEvaluationRecord): boolean {
  const record = CapabilityResultEvaluationRecordSchema.parse(recordInput);
  return record.hash === capabilityResultEvaluationHash(record);
}

export function isCapabilityResultDecisionHashValid(recordInput: CapabilityResultDecisionRecord): boolean {
  const record = CapabilityResultDecisionRecordSchema.parse(recordInput);
  return record.hash === capabilityResultDecisionHash(record);
}

/** Fill the content address after validating an incoming data record. */
export function withCapabilityResultFeedbackHash(input: Omit<CapabilityResultFeedbackRecord, "hash">): CapabilityResultFeedbackRecord {
  const content = CapabilityResultFeedbackRecordSchema.omit({ hash: true }).parse(input);
  return CapabilityResultFeedbackRecordSchema.parse({ ...content, hash: recordHash(content as CommonResultIdentity & Record<string, unknown>) });
}

export function withCapabilityResultEvaluationHash(input: Omit<CapabilityResultEvaluationRecord, "hash">): CapabilityResultEvaluationRecord {
  const content = CapabilityResultEvaluationRecordSchema.omit({ hash: true }).parse(input);
  return CapabilityResultEvaluationRecordSchema.parse({ ...content, hash: recordHash(content as CommonResultIdentity & Record<string, unknown>) });
}

export function withCapabilityResultDecisionHash(input: Omit<CapabilityResultDecisionRecord, "hash">): CapabilityResultDecisionRecord {
  const content = CapabilityResultDecisionRecordSchema.omit({ hash: true }).parse(input);
  return CapabilityResultDecisionRecordSchema.parse({ ...content, hash: recordHash(content as CommonResultIdentity & Record<string, unknown>) });
}
