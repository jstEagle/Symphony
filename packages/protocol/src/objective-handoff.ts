import { z } from "zod";
import { objectiveSha256, stableJsonStringify } from "./index.js";
import { WorkspaceManifestSchema } from "./workspace-manifest.js";

/**
 * A handoff is the portable boundary between Symphony and a native harness.
 * It intentionally carries references and proofs, never a native transcript
 * or process handle.  A receiver can use these facts to start a new native
 * attempt, or resume a proven session when the native driver supports it.
 */
const IdSchema = z.string().min(1).max(256);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IsoDateSchema = z.iso.datetime({ offset: true });
const JsonValueSchema = z.json();

export const ObjectiveHandoffHarnessSchema = z.enum([
  "codex",
  "claude",
  "cursor",
  "opencode",
  "pi",
  "acp",
]);
export type ObjectiveHandoffHarness = z.infer<typeof ObjectiveHandoffHarnessSchema>;

export const ObjectiveHandoffPermissionSchema = z.enum(["read-only", "full-access"]);
export type ObjectiveHandoffPermission = z.infer<typeof ObjectiveHandoffPermissionSchema>;

export const ObjectiveHandoffSideEffectClassSchema = z.enum(["read", "local", "external", "irreversible"]);
export type ObjectiveHandoffSideEffectClass = z.infer<typeof ObjectiveHandoffSideEffectClassSchema>;

export const ObjectiveHandoffActorSchema = z.object({
  type: z.enum(["user", "agent", "system"]),
  id: IdSchema,
}).strict();
export type ObjectiveHandoffActor = z.infer<typeof ObjectiveHandoffActorSchema>;

export const ObjectiveHandoffCriterionSchema = z.object({
  id: IdSchema,
  description: z.string().min(1).max(2_000),
  path: z.string().min(1).max(1_000),
  op: z.enum(["exists", "equals", "not-equals", "contains", "matches", "gt", "gte", "lt", "lte"]),
  value: JsonValueSchema.optional(),
  required: z.boolean().default(true),
}).strict();
export type ObjectiveHandoffCriterion = z.infer<typeof ObjectiveHandoffCriterionSchema>;

export const ObjectiveHandoffEventRefSchema = z.object({
  id: IdSchema,
  cursor: z.number().int().nonnegative(),
  hash: HashSchema,
}).strict();
export type ObjectiveHandoffEventRef = z.infer<typeof ObjectiveHandoffEventRefSchema>;

export const ObjectiveHandoffObservationRefSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  eventCursor: z.number().int().nonnegative(),
  hash: HashSchema,
}).strict();
export type ObjectiveHandoffObservationRef = z.infer<typeof ObjectiveHandoffObservationRefSchema>;

export const ObjectiveHandoffArtifactRefSchema = z.object({
  id: IdSchema,
  hash: HashSchema,
}).strict();
export type ObjectiveHandoffArtifactRef = z.infer<typeof ObjectiveHandoffArtifactRefSchema>;

export const ObjectiveHandoffCheckpointRefSchema = z.object({
  id: IdSchema,
  sequence: z.number().int().positive(),
  hash: HashSchema,
}).strict();
export type ObjectiveHandoffCheckpointRef = z.infer<typeof ObjectiveHandoffCheckpointRefSchema>;

export const ObjectiveHandoffEvidenceSchema = z.object({
  eventCursor: z.number().int().nonnegative(),
  eventRefs: z.array(ObjectiveHandoffEventRefSchema).max(256),
  observationRefs: z.array(ObjectiveHandoffObservationRefSchema).max(256),
  artifactRefs: z.array(ObjectiveHandoffArtifactRefSchema).max(2_000),
  checkpoint: ObjectiveHandoffCheckpointRefSchema,
}).strict();
export type ObjectiveHandoffEvidence = z.infer<typeof ObjectiveHandoffEvidenceSchema>;

export const ObjectiveHandoffWorkspaceSchema = z.object({
  path: z.string().min(1).max(4_096),
  remoteRepository: z.string().url().optional(),
  startingRef: z.string().min(1).max(512).optional(),
  dirtyPolicy: z.enum(["local-only", "require-clean", "explicit-checkpoint"]),
  git: z.object({
    repo: z.string().nullable(),
    ref: z.string().nullable(),
    commit: z.string().nullable(),
    dirty: z.boolean().nullable(),
    patchHash: HashSchema.nullable(),
    worktree: z.string().nullable(),
  }).strict().nullable(),
  dirty: z.boolean().nullable(),
  patchHash: HashSchema.nullable(),
  worktree: z.string().nullable(),
  snapshotHash: HashSchema.nullable(),
  /** Optional full workspace boundary; hashes and metadata only, never file contents or secrets. */
  workspaceManifest: WorkspaceManifestSchema.nullable().optional(),
}).strict();
export type ObjectiveHandoffWorkspace = z.infer<typeof ObjectiveHandoffWorkspaceSchema>;

export const ObjectiveHandoffContinuitySchema = z.object({
  status: z.enum(["proven", "unknown", "unsupported"]),
  sourceHarness: ObjectiveHandoffHarnessSchema,
  sourceAgentId: IdSchema.nullable(),
  nativeSessionId: IdSchema.nullable(),
  nativeRunId: IdSchema.nullable(),
  capabilities: z.array(z.string().min(1).max(128)).max(128),
  evidenceEventIds: z.array(IdSchema).max(256),
  hints: z.array(z.string().min(1).max(500)).max(32),
}).strict();
export type ObjectiveHandoffContinuity = z.infer<typeof ObjectiveHandoffContinuitySchema>;

export const ObjectiveHandoffTargetSchema = z.object({
  harness: ObjectiveHandoffHarnessSchema,
  model: z.string().min(1).max(256),
  agentId: IdSchema.nullable(),
  permission: ObjectiveHandoffPermissionSchema,
  requiredCapabilities: z.array(IdSchema).max(256),
  sideEffectClassCeiling: ObjectiveHandoffSideEffectClassSchema,
}).strict();
export type ObjectiveHandoffTarget = z.infer<typeof ObjectiveHandoffTargetSchema>;

export const ObjectiveHandoffLineageSchema = z.object({
  objectiveId: IdSchema,
  runId: IdSchema,
  nodeId: IdSchema.nullable(),
  taskId: IdSchema.nullable(),
  attemptId: IdSchema.nullable(),
  iterationKey: z.string().min(1).max(2_000).nullable(),
  parentHandoffId: IdSchema.nullable(),
  chain: z.array(IdSchema).max(128),
}).strict();
export type ObjectiveHandoffLineage = z.infer<typeof ObjectiveHandoffLineageSchema>;

export const ObjectiveHandoffSideEffectSchema = z.object({
  operationId: IdSchema,
  idempotencyKey: IdSchema,
  requestHash: z.string().min(8).max(256).nullable(),
  receipt: JsonValueSchema.nullable(),
  status: z.enum(["unresolved", "unknown", "settled"]),
}).strict();
export type ObjectiveHandoffSideEffect = z.infer<typeof ObjectiveHandoffSideEffectSchema>;

export const ObjectiveHandoffAuthoritySchema = z.object({
  permission: ObjectiveHandoffPermissionSchema,
  requiredCapabilities: z.array(IdSchema).max(256),
  sideEffectClassCeiling: ObjectiveHandoffSideEffectClassSchema,
  policySnapshotHash: HashSchema.nullable(),
  configSnapshotHash: HashSchema.nullable(),
}).strict();
export type ObjectiveHandoffAuthority = z.infer<typeof ObjectiveHandoffAuthoritySchema>;

const HandoffProvenanceSchema = z.object({
  source: z.enum(["daemon", "workflow", "driver", "user", "recovery"]),
  actor: ObjectiveHandoffActorSchema,
  requestKey: IdSchema,
  capturedAt: IsoDateSchema,
  evidenceEventIds: z.array(IdSchema).max(512),
}).strict();
export type ObjectiveHandoffProvenance = z.infer<typeof HandoffProvenanceSchema>;

export const ObjectiveHandoffEnvelopeSchema = z.object({
  version: z.literal(1),
  id: IdSchema,
  objectiveId: IdSchema,
  runId: IdSchema,
  objectiveRevision: z.number().int().positive(),
  workflowId: IdSchema,
  workflowRevision: z.number().int().positive(),
  workflowHash: z.string().min(8).max(256),
  lineage: ObjectiveHandoffLineageSchema,
  scope: z.object({
    intent: z.string().min(1).max(20_000),
    taskObjective: z.string().min(1).max(20_000),
    constraints: z.array(JsonValueSchema).max(128),
    acceptanceCriteria: z.array(ObjectiveHandoffCriterionSchema).max(12),
  }).strict(),
  source: z.object({
    harness: ObjectiveHandoffHarnessSchema,
    agentId: IdSchema.nullable(),
    attemptId: IdSchema.nullable(),
    nativeSessionId: IdSchema.nullable(),
    nativeRunId: IdSchema.nullable(),
  }).strict(),
  target: ObjectiveHandoffTargetSchema,
  evidence: ObjectiveHandoffEvidenceSchema,
  workspace: ObjectiveHandoffWorkspaceSchema.nullable(),
  continuity: ObjectiveHandoffContinuitySchema,
  sideEffects: z.array(ObjectiveHandoffSideEffectSchema).max(256),
  authority: ObjectiveHandoffAuthoritySchema,
  createdAt: IsoDateSchema,
  requestKey: IdSchema,
  inputHash: HashSchema,
  contentHash: HashSchema,
  provenance: HandoffProvenanceSchema,
}).strict();
export type ObjectiveHandoffEnvelope = z.infer<typeof ObjectiveHandoffEnvelopeSchema>;

export const ObjectiveHandoffCreateInputSchema = z.object({
  version: z.literal(1).default(1),
  checkpointId: IdSchema,
  taskId: IdSchema.nullable().optional(),
  nodeId: IdSchema.nullable().optional(),
  attemptId: IdSchema.nullable().optional(),
  iterationKey: z.string().min(1).max(2_000).nullable().optional(),
  intent: z.string().min(1).max(20_000),
  taskObjective: z.string().min(1).max(20_000),
  constraints: z.array(JsonValueSchema).max(128).default([]),
  acceptanceCriteria: z.array(ObjectiveHandoffCriterionSchema).max(12).default([]),
  evidenceEventIds: z.array(IdSchema).max(256).default([]),
  observationIds: z.array(IdSchema).max(256).default([]),
  artifactIds: z.array(IdSchema).max(2_000).default([]),
  target: z.object({
    harness: ObjectiveHandoffHarnessSchema,
    model: z.string().min(1).max(256).default("auto"),
    agentId: IdSchema.nullable().default(null),
    permission: ObjectiveHandoffPermissionSchema.optional(),
    requiredCapabilities: z.array(IdSchema).max(256).default([]),
    sideEffectClassCeiling: ObjectiveHandoffSideEffectClassSchema.optional(),
  }).strict(),
  parentHandoffId: IdSchema.nullable().optional(),
}).strict();
export type ObjectiveHandoffCreateInput = z.infer<typeof ObjectiveHandoffCreateInputSchema>;

export const ObjectiveHandoffAcceptanceInputSchema = z.object({
  version: z.literal(1).default(1),
  envelopeId: IdSchema,
  /** Explicitly settle the offer or decline it without creating an execution plan. */
  decision: z.enum(["accepted", "rejected"]).default("accepted"),
  recipientAgentId: IdSchema.nullable().optional(),
  harness: ObjectiveHandoffHarnessSchema.optional(),
  model: z.string().min(1).max(256).optional(),
  permission: ObjectiveHandoffPermissionSchema.optional(),
  capabilities: z.array(IdSchema).max(256).default([]),
  nativeSessionId: IdSchema.nullable().optional(),
  nativeRunId: IdSchema.nullable().optional(),
  continuityStatus: z.enum(["proven", "unknown", "unsupported"]).default("unknown"),
  evidenceEventIds: z.array(IdSchema).max(256).default([]),
  observationIds: z.array(IdSchema).max(256).default([]),
  artifactIds: z.array(IdSchema).max(2_000).default([]),
  reason: z.string().max(2_000).optional(),
  /** Target-side manifest captured by the accepting runtime, when available. */
  workspaceManifest: WorkspaceManifestSchema.nullable().optional(),
}).strict();
export type ObjectiveHandoffAcceptanceInput = z.infer<typeof ObjectiveHandoffAcceptanceInputSchema>;

export const ObjectiveHandoffAcceptanceRecordSchema = z.object({
  version: z.literal(1),
  id: IdSchema,
  envelopeId: IdSchema,
  objectiveId: IdSchema,
  runId: IdSchema,
  recipientAgentId: IdSchema.nullable(),
  target: ObjectiveHandoffTargetSchema,
  capabilities: z.array(IdSchema).max(256),
  nativeSessionId: IdSchema.nullable(),
  nativeRunId: IdSchema.nullable(),
  continuityStatus: z.enum(["proven", "unknown", "unsupported"]),
  evidenceEventIds: z.array(IdSchema).max(256),
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().max(2_000).nullable(),
  requestKey: IdSchema,
  inputHash: HashSchema,
  acceptedAt: IsoDateSchema,
  provenance: HandoffProvenanceSchema,
  contentHash: HashSchema,
  workspaceManifest: WorkspaceManifestSchema.nullable().optional(),
}).strict();
export type ObjectiveHandoffAcceptanceRecord = z.infer<typeof ObjectiveHandoffAcceptanceRecordSchema>;

export function objectiveHandoffHash(value: Omit<ObjectiveHandoffEnvelope, "contentHash"> | ObjectiveHandoffEnvelope): string {
  const { contentHash: _ignored, ...content } = value as ObjectiveHandoffEnvelope;
  return objectiveSha256(stableJsonStringify(content));
}

export function objectiveHandoffAcceptanceHash(value: Omit<ObjectiveHandoffAcceptanceRecord, "contentHash"> | ObjectiveHandoffAcceptanceRecord): string {
  const { contentHash: _ignored, ...content } = value as ObjectiveHandoffAcceptanceRecord;
  return objectiveSha256(stableJsonStringify(content));
}

/** Stable hashes for referenced durable records; the daemon never trusts a caller-supplied hash. */
export function objectiveHandoffReferenceHash(value: unknown): string {
  return objectiveSha256(stableJsonStringify(value));
}

export function isObjectiveHandoffHashValid(value: ObjectiveHandoffEnvelope): boolean {
  return objectiveHandoffHash(value) === value.contentHash;
}

export function isObjectiveHandoffAcceptanceHashValid(value: ObjectiveHandoffAcceptanceRecord): boolean {
  return objectiveHandoffAcceptanceHash(value) === value.contentHash;
}

/**
 * Target compatibility is intentionally strict. A missing capability or a
 * read-only target attempting to accept a full-access handoff is never a
 * best-effort transfer.
 */
export function validateObjectiveHandoffTarget(
  envelope: ObjectiveHandoffEnvelope,
  target: Pick<ObjectiveHandoffTarget, "harness" | "permission" | "requiredCapabilities"> & { capabilities: readonly string[] },
): { ok: true } | { ok: false; reason: string } {
  if (target.harness !== envelope.target.harness) return { ok: false, reason: `Target harness ${target.harness} does not match ${envelope.target.harness}.` };
  if (envelope.target.permission === "full-access" && target.permission !== "full-access") return { ok: false, reason: "The handoff requires full-access authority." };
  const available = new Set(target.capabilities);
  const requiredCapabilities = [...new Set([
    ...envelope.authority.requiredCapabilities,
    ...envelope.target.requiredCapabilities,
  ])];
  const missing = requiredCapabilities.filter((capability) => !available.has(capability));
  if (missing.length > 0) return { ok: false, reason: `Target is missing required capabilities: ${missing.join(", ")}.` };
  if (envelope.continuity.status === "proven" && target.harness !== envelope.continuity.sourceHarness) {
    return { ok: false, reason: "Proven native continuity cannot be claimed across different harnesses; use a new attempt." };
  }
  return { ok: true };
}
