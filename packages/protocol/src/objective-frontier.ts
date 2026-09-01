import { z } from "zod";
import {
  ObjectiveControlExecutionRecordSchema,
  ObjectiveControlPlanRevisionSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlPlanSnapshotSchema,
  type ObjectiveControlExecutionRecord,
  type ObjectiveControlPlan,
  type ObjectiveControlPlanRevision,
  type ObjectiveControlPlanSnapshot,
} from "./objective-control.js";
import {
  ObjectiveControlSignalSuspensionSchema,
  ObjectiveControlTimerSuspensionSchema,
  ObjectiveControlSuspensionRecordSchema,
  type ObjectiveControlSuspensionRecord,
} from "./objective-suspension.js";
import { ObjectiveAttentionRecordSchema, type ObjectiveAttentionRecord } from "./objective-attention.js";
import { ObjectiveArtifactRecordSchema, type ObjectiveArtifactRecord } from "./objective-artifact.js";

const IdSchema = z.string().min(1).max(512);
const IsoDateSchema = z.iso.datetime({ offset: true });
const JsonValueSchema = z.json();

/** A high-water cursor and references that make a projection auditable. */
export const ObjectiveProjectionEvidenceSchema = z.object({
  eventCursor: z.number().int().nonnegative(),
  eventIds: z.array(IdSchema).max(512),
  attemptIds: z.array(IdSchema).max(512),
  artifactIds: z.array(IdSchema).max(512),
  checkpointIds: z.array(IdSchema).max(512),
  attentionIds: z.array(IdSchema).max(512),
  contextRefs: z.array(IdSchema).max(512),
}).strict();
export type ObjectiveProjectionEvidence = z.infer<typeof ObjectiveProjectionEvidenceSchema>;

export const ObjectiveAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type ObjectiveAttemptStatus = z.infer<typeof ObjectiveAttemptStatusSchema>;

/** The attempt identity retained when a retry replaces native execution. */
export const ObjectiveAttemptLineageSchema = z.object({
  attemptId: IdSchema,
  attemptNumber: z.number().int().positive().nullable(),
  status: ObjectiveAttemptStatusSchema,
  parentAttemptId: IdSchema.nullable(),
  replacementOf: IdSchema.nullable(),
  agentId: IdSchema.nullable(),
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
  evidence: ObjectiveProjectionEvidenceSchema,
}).strict();
export type ObjectiveAttemptLineage = z.infer<typeof ObjectiveAttemptLineageSchema>;

export const ObjectiveFrontierStatusSchema = z.enum([
  "runnable",
  "running",
  "blocked-dependency",
  "waiting-timer",
  "waiting-signal",
  "waiting-attention",
  "retry-scheduled",
  "outcome-unknown",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type ObjectiveFrontierStatus = z.infer<typeof ObjectiveFrontierStatusSchema>;

export const ObjectiveFrontierItemKindSchema = z.enum(["task", "control"]);
export type ObjectiveFrontierItemKind = z.infer<typeof ObjectiveFrontierItemKindSchema>;

export const ObjectiveFrontierEvaluationSummarySchema = z.object({
  id: IdSchema,
  metric: z.string().min(1).max(500).nullable(),
  actual: JsonValueSchema.nullable(),
  target: JsonValueSchema.nullable(),
  operator: z.enum(["exists", "eq", "neq", "gt", "gte", "lt", "lte"]),
  pass: z.boolean(),
}).strict();
export type ObjectiveFrontierEvaluationSummary = z.infer<typeof ObjectiveFrontierEvaluationSummarySchema>;

export const ObjectiveFrontierItemSchema = z.object({
  id: IdSchema,
  kind: ObjectiveFrontierItemKindSchema,
  taskId: IdSchema.nullable(),
  executionId: IdSchema.nullable(),
  nodeId: IdSchema.nullable(),
  iterationKey: IdSchema.nullable(),
  label: z.string().min(1).max(2_000),
  status: ObjectiveFrontierStatusSchema,
  /** The source state is retained where it has a more specific vocabulary. */
  sourceState: z.string().min(1).max(128),
  dependencyIds: z.array(IdSchema).max(512),
  blockedBy: z.array(IdSchema).max(512),
  attemptId: IdSchema.nullable(),
  agentId: IdSchema.nullable(),
  attemptLineage: z.array(ObjectiveAttemptLineageSchema).max(512),
  dueAt: IsoDateSchema.nullable(),
  signalKey: IdSchema.nullable(),
  attentionIds: z.array(IdSchema).max(128),
  retryAt: IsoDateSchema.nullable(),
  unknownReason: z.string().max(2_000).nullable(),
  terminalReason: z.string().max(2_000).nullable(),
  evaluation: ObjectiveFrontierEvaluationSummarySchema.nullable(),
  evidence: ObjectiveProjectionEvidenceSchema,
}).strict();
export type ObjectiveFrontierItem = z.infer<typeof ObjectiveFrontierItemSchema>;

export const ObjectiveFrontierCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  runnable: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  blockedDependency: z.number().int().nonnegative(),
  waitingTimer: z.number().int().nonnegative(),
  waitingSignal: z.number().int().nonnegative(),
  waitingAttention: z.number().int().nonnegative(),
  retryScheduled: z.number().int().nonnegative(),
  outcomeUnknown: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
}).strict();
export type ObjectiveFrontierCounts = z.infer<typeof ObjectiveFrontierCountsSchema>;

export const ObjectiveProjectionStateSchema = z.enum([
  "active",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "outcome-unknown",
]);
export type ObjectiveProjectionState = z.infer<typeof ObjectiveProjectionStateSchema>;

export const ObjectiveFrontierProjectionSchema = z.object({
  version: z.literal(1),
  objectiveId: IdSchema,
  runId: IdSchema,
  asOf: IsoDateSchema,
  eventCursor: z.number().int().nonnegative(),
  state: ObjectiveProjectionStateSchema,
  /** All known work, including terminal records; `frontier` is unfinished work only. */
  items: z.array(ObjectiveFrontierItemSchema).max(4_096),
  frontier: z.array(ObjectiveFrontierItemSchema).max(4_096),
  counts: ObjectiveFrontierCountsSchema,
  summary: z.string().min(1).max(2_000),
  evidence: ObjectiveProjectionEvidenceSchema,
}).strict();
export type ObjectiveFrontierProjection = z.infer<typeof ObjectiveFrontierProjectionSchema>;

export const ObjectiveRunlineEventTypeSchema = z.enum([
  "objective-revision",
  "plan-revised",
  "stage-entered",
  "stage-exited",
  "agent-delegated",
  "agent-settled",
  "agent-failed",
  "branch-selected",
  "loop-iteration",
  "loop-stopped",
  "evaluation",
  "artifact-published",
  "artifact-superseded",
  "checkpoint-committed",
  "retry-scheduled",
  "attention-requested",
  "attention-resolved",
  "suspension-created",
  "suspension-settled",
  "outcome-unknown",
  "reconciliation",
  "run-completed",
  "run-failed",
  "run-cancelled",
  "run-expired",
  "observation",
]);
export type ObjectiveRunlineEventType = z.infer<typeof ObjectiveRunlineEventTypeSchema>;

export const ObjectiveRunlineEntrySchema = z.object({
  version: z.literal(1),
  id: IdSchema,
  type: ObjectiveRunlineEventTypeSchema,
  cursor: z.number().int().nonnegative().nullable(),
  occurredAt: IsoDateSchema,
  subjectId: IdSchema.nullable(),
  subjectKind: z.enum(["objective", "plan", "task", "control", "agent", "attempt", "artifact", "checkpoint", "attention", "run", "native"]).nullable(),
  summary: z.string().min(1).max(2_000),
  /** Number of deterministic records collapsed into this semantic entry. */
  collapsedCount: z.number().int().positive(),
  evidence: ObjectiveProjectionEvidenceSchema,
  attemptLineage: z.array(ObjectiveAttemptLineageSchema).max(512),
}).strict();
export type ObjectiveRunlineEntry = z.infer<typeof ObjectiveRunlineEntrySchema>;

export const ObjectiveRunlineProjectionSchema = z.object({
  version: z.literal(1),
  objectiveId: IdSchema,
  runId: IdSchema,
  eventCursor: z.number().int().nonnegative(),
  entries: z.array(ObjectiveRunlineEntrySchema).max(4_096),
  summary: z.string().min(1).max(2_000),
  evidence: ObjectiveProjectionEvidenceSchema,
}).strict();
export type ObjectiveRunlineProjection = z.infer<typeof ObjectiveRunlineProjectionSchema>;

const ObjectiveAggregateFrontierItemSchema = ObjectiveFrontierItemSchema.extend({ runId: IdSchema }).strict();
export type ObjectiveAggregateFrontierItem = z.infer<typeof ObjectiveAggregateFrontierItemSchema>;

export const ObjectiveAggregateFrontierProjectionSchema = z.object({
  version: z.literal(1),
  objectiveId: IdSchema,
  eventCursor: z.number().int().nonnegative(),
  runs: z.array(z.object({ runId: IdSchema, projection: ObjectiveFrontierProjectionSchema }).strict()).max(4_096),
  frontier: z.array(ObjectiveAggregateFrontierItemSchema).max(4_096),
  counts: ObjectiveFrontierCountsSchema,
  state: ObjectiveProjectionStateSchema,
  summary: z.string().min(1).max(2_000),
  evidence: ObjectiveProjectionEvidenceSchema,
}).strict();
export type ObjectiveAggregateFrontierProjection = z.infer<typeof ObjectiveAggregateFrontierProjectionSchema>;

const ObjectiveAggregateRunlineEntrySchema = ObjectiveRunlineEntrySchema.extend({ runId: IdSchema }).strict();
export type ObjectiveAggregateRunlineEntry = z.infer<typeof ObjectiveAggregateRunlineEntrySchema>;

export const ObjectiveAggregateRunlineProjectionSchema = z.object({
  version: z.literal(1),
  objectiveId: IdSchema,
  eventCursor: z.number().int().nonnegative(),
  runs: z.array(z.object({ runId: IdSchema, projection: ObjectiveRunlineProjectionSchema }).strict()).max(4_096),
  entries: z.array(ObjectiveAggregateRunlineEntrySchema).max(8_192),
  summary: z.string().min(1).max(2_000),
  evidence: ObjectiveProjectionEvidenceSchema,
}).strict();
export type ObjectiveAggregateRunlineProjection = z.infer<typeof ObjectiveAggregateRunlineProjectionSchema>;

/** Legacy workflow attempt shape. Kept strict so imported records cannot smuggle executable data. */
export const ObjectiveFrontierAttemptSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  stepId: IdSchema,
  iterationKey: IdSchema,
  attempt: z.number().int().positive(),
  status: z.enum(["running", "waiting", "completed", "failed", "cancelled"]),
  input: JsonValueSchema,
  output: JsonValueSchema.nullable(),
  error: z.string().nullable(),
  idempotencyKey: IdSchema,
  startedAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
}).strict();
export type ObjectiveFrontierAttempt = z.infer<typeof ObjectiveFrontierAttemptSchema>;

const LegacyTaskDefinitionSchema = z.object({
  id: IdSchema,
  objective: z.string().min(1).max(20_000).optional(),
  dependsOn: z.array(IdSchema).max(512).default([]),
}).passthrough();

export const ObjectiveFrontierTaskSchema = z.object({
  task: LegacyTaskDefinitionSchema,
  state: z.enum(["queued", "waiting-approval", "running", "completed", "failed", "superseded", "blocked"]),
  attemptId: IdSchema.nullable(),
  agentId: IdSchema.nullable(),
  output: JsonValueSchema.nullable(),
  error: z.string().nullable(),
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
}).strict();
export type ObjectiveFrontierTask = z.infer<typeof ObjectiveFrontierTaskSchema>;

const LegacyFlatTaskSchema = z.object({
  id: IdSchema,
  objective: z.string().min(1).max(20_000).optional(),
  dependsOn: z.array(IdSchema).max(512).default([]),
  state: z.enum(["queued", "waiting-approval", "running", "completed", "failed", "superseded", "blocked"]).default("queued"),
  attemptId: IdSchema.nullable().default(null),
  agentId: IdSchema.nullable().default(null),
  output: JsonValueSchema.nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: IsoDateSchema.nullable().default(null),
  finishedAt: IsoDateSchema.nullable().default(null),
}).passthrough();

export const ObjectiveFrontierRetrySchema = z.object({
  id: IdSchema,
  objectiveId: IdSchema.optional(),
  runId: IdSchema.optional(),
  taskId: IdSchema.nullable().default(null),
  executionId: IdSchema.nullable().default(null),
  attemptId: IdSchema.nullable().default(null),
  replacementAttemptId: IdSchema.nullable().default(null),
  retryAt: IsoDateSchema,
  reason: z.string().min(1).max(2_000),
  evidence: ObjectiveProjectionEvidenceSchema.optional(),
}).strict();
export type ObjectiveFrontierRetry = z.infer<typeof ObjectiveFrontierRetrySchema>;

export const ObjectiveFrontierUnknownOutcomeSchema = z.object({
  id: IdSchema,
  objectiveId: IdSchema.optional(),
  runId: IdSchema.optional(),
  taskId: IdSchema.nullable().default(null),
  executionId: IdSchema.nullable().default(null),
  attemptId: IdSchema.nullable().default(null),
  reason: z.string().min(1).max(2_000),
  nativeEventId: IdSchema.nullable().default(null),
  reconciliationId: IdSchema.nullable().default(null),
  evidence: ObjectiveProjectionEvidenceSchema.optional(),
}).strict();
export type ObjectiveFrontierUnknownOutcome = z.infer<typeof ObjectiveFrontierUnknownOutcomeSchema>;

export const ObjectiveFrontierReconciliationSchema = z.object({
  id: IdSchema,
  objectiveId: IdSchema.optional(),
  runId: IdSchema.optional(),
  unknownOutcomeId: IdSchema,
  status: z.enum(["pending", "matched", "not-found", "conflicted"]),
  attemptId: IdSchema.nullable().default(null),
  nativeEventId: IdSchema.nullable().default(null),
  reason: z.string().min(1).max(2_000),
  evidence: ObjectiveProjectionEvidenceSchema.optional(),
}).strict();
export type ObjectiveFrontierReconciliation = z.infer<typeof ObjectiveFrontierReconciliationSchema>;

export const ObjectiveFrontierEvaluationSchema = z.object({
  id: IdSchema,
  nodeId: IdSchema,
  iterationKey: IdSchema,
  metric: z.string().min(1).max(500).nullable().default(null),
  actual: JsonValueSchema.nullable(),
  target: JsonValueSchema.nullable(),
  operator: z.enum(["exists", "eq", "neq", "gt", "gte", "lt", "lte"]),
  pass: z.boolean(),
  eventCursor: z.number().int().nonnegative().default(0),
  evidence: ObjectiveProjectionEvidenceSchema.optional(),
}).strict();
export type ObjectiveFrontierEvaluation = z.infer<typeof ObjectiveFrontierEvaluationSchema>;

/** Input deliberately accepts both current durable records and legacy flat projections. */
export const ObjectiveFrontierInputSchema = z.object({
  version: z.literal(1).default(1),
  objectiveId: IdSchema,
  runId: IdSchema,
  asOf: IsoDateSchema,
  eventCursor: z.number().int().nonnegative().default(0),
  runState: z.string().min(1).max(128).optional(),
  runOutput: JsonValueSchema.nullable().optional(),
  runError: z.string().nullable().optional(),
  /** Optional aggregate/run echo for callers replaying a storage snapshot. */
  run: z.record(z.string(), JsonValueSchema).optional(),
  objective: z.record(z.string(), JsonValueSchema).optional(),
  plan: z.record(z.string(), JsonValueSchema).optional(),
  frontierRecords: z.array(JsonValueSchema).max(4_096).default([]),
  occurrences: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  currentRuns: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  runs: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  agents: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  context: z.record(z.string(), JsonValueSchema).default({}),
  tasks: z.array(z.union([ObjectiveFrontierTaskSchema, LegacyFlatTaskSchema])).max(1_024).default([]),
  legacyTasks: z.array(z.union([ObjectiveFrontierTaskSchema, LegacyFlatTaskSchema])).max(1_024).default([]),
  attempts: z.array(ObjectiveFrontierAttemptSchema).max(4_096).default([]),
  stepAttempts: z.array(ObjectiveFrontierAttemptSchema).max(4_096).default([]),
  controlPlan: z.union([ObjectiveControlPlanSchema, ObjectiveControlPlanRevisionSchema]).optional(),
  controlSnapshot: ObjectiveControlPlanSnapshotSchema.optional(),
  controlExecutions: z.array(ObjectiveControlExecutionRecordSchema).max(4_096).default([]),
  controlExecutionRecords: z.array(ObjectiveControlExecutionRecordSchema).max(4_096).default([]),
  control: z.record(z.string(), JsonValueSchema).optional(),
  suspensions: z.array(ObjectiveControlSuspensionRecordSchema).max(4_096).default([]),
  controlSuspensions: z.array(ObjectiveControlSuspensionRecordSchema).max(4_096).default([]),
  timerSuspensions: z.array(ObjectiveControlTimerSuspensionSchema).max(4_096).default([]),
  signalSuspensions: z.array(ObjectiveControlSignalSuspensionSchema).max(4_096).default([]),
  evaluations: z.array(ObjectiveFrontierEvaluationSchema).max(4_096).default([]),
  evaluationNodes: z.array(ObjectiveFrontierEvaluationSchema).max(4_096).default([]),
  retries: z.array(ObjectiveFrontierRetrySchema).max(4_096).default([]),
  unknownOutcomes: z.array(ObjectiveFrontierUnknownOutcomeSchema).max(4_096).default([]),
  unknownNativeOutcomes: z.array(ObjectiveFrontierUnknownOutcomeSchema).max(4_096).default([]),
  reconciliations: z.array(ObjectiveFrontierReconciliationSchema).max(4_096).default([]),
  reconciliationRecords: z.array(ObjectiveFrontierReconciliationSchema).max(4_096).default([]),
  approvals: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  approvalRecords: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  attentions: z.array(ObjectiveAttentionRecordSchema).max(4_096).default([]),
  attentionRecords: z.array(ObjectiveAttentionRecordSchema).max(4_096).default([]),
  artifacts: z.array(ObjectiveArtifactRecordSchema).max(4_096).default([]),
  artifactRecords: z.array(ObjectiveArtifactRecordSchema).max(4_096).default([]),
  checkpoints: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  checkpointRecords: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  planMutations: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  planChanges: z.array(z.record(z.string(), JsonValueSchema)).max(4_096).default([]),
  mutations: z.record(z.string(), JsonValueSchema).optional(),
  events: z.array(z.record(z.string(), JsonValueSchema)).max(16_384).default([]),
}).strict();
export type ObjectiveFrontierInput = z.infer<typeof ObjectiveFrontierInputSchema>;

// Keep the imported types visible to declaration consumers that use this module
// as the stable projection boundary. These aliases are intentionally read-only.
export type ObjectiveFrontierControlPlan = ObjectiveControlPlan | ObjectiveControlPlanRevision;
export type ObjectiveFrontierControlSnapshot = ObjectiveControlPlanSnapshot;
export type ObjectiveFrontierControlExecution = ObjectiveControlExecutionRecord;
export type ObjectiveFrontierSuspension = ObjectiveControlSuspensionRecord;
export type ObjectiveFrontierAttention = ObjectiveAttentionRecord;
export type ObjectiveFrontierArtifact = ObjectiveArtifactRecord;

export { ObjectiveControlSignalSuspensionSchema, ObjectiveControlTimerSuspensionSchema };
