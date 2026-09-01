import { z } from "zod";
import { objectiveSha256, stableJsonStringify } from "./index.js";

/** Inline JSON is deliberate: this first slice grants no filesystem/blob authority. */
const IdSchema = z.string().min(1).max(256);
const JsonValueSchema = z.json();
const IsoDateSchema = z.iso.datetime({ offset: true });

export const ObjectiveArtifactKindSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._:-]*$/u);
export type ObjectiveArtifactKind = z.infer<typeof ObjectiveArtifactKindSchema>;
export const ObjectiveArtifactReviewStateSchema = z.enum(["pending", "verified", "rejected", "superseded"]);
export type ObjectiveArtifactReviewState = z.infer<typeof ObjectiveArtifactReviewStateSchema>;

export const ObjectiveArtifactEvidenceSchema = z.object({
  eventCursor: z.number().int().nonnegative(),
  eventIds: z.array(IdSchema).max(256).default([]),
  observationIds: z.array(IdSchema).max(256).default([]),
}).strict();
export type ObjectiveArtifactEvidence = z.infer<typeof ObjectiveArtifactEvidenceSchema>;

export const ObjectiveArtifactActorSchema = z.object({
  type: z.enum(["user", "agent", "system"]),
  id: IdSchema,
}).strict();
export type ObjectiveArtifactActor = z.infer<typeof ObjectiveArtifactActorSchema>;

/** Hash, size, actor, and producer identity are all daemon-owned. */
export const ObjectiveArtifactPublishInputSchema = z.object({
  version: z.literal(1).default(1),
  objectiveId: IdSchema.optional(),
  planRevision: z.number().int().nonnegative(),
  kind: ObjectiveArtifactKindSchema,
  name: z.string().min(1).max(500),
  mediaType: z.string().min(1).max(200),
  content: JsonValueSchema,
  evidence: ObjectiveArtifactEvidenceSchema,
  taskId: IdSchema.nullable().optional(),
  attemptId: IdSchema.nullable().optional(),
  controlNodeId: IdSchema.nullable().optional(),
  lineage: z.array(IdSchema).max(128).default([]),
  supersedes: IdSchema.nullable().default(null),
  policyHash: z.string().min(8).max(256).optional(),
}).strict();
export type ObjectiveArtifactPublishInput = z.infer<typeof ObjectiveArtifactPublishInputSchema>;

/** Immutable publication record; review changes are separate append-only rows. */
export const ObjectiveArtifactRecordSchema = z.object({
  version: z.literal(1),
  id: IdSchema,
  objectiveId: IdSchema,
  runId: IdSchema,
  planRevision: z.number().int().nonnegative(),
  taskId: IdSchema.nullable(),
  producerAgentId: IdSchema.nullable(),
  attemptId: IdSchema.nullable(),
  controlNodeId: IdSchema.nullable(),
  kind: ObjectiveArtifactKindSchema,
  name: z.string().min(1).max(500),
  mediaType: z.string().min(1).max(200),
  content: JsonValueSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: z.number().int().nonnegative(),
  evidence: ObjectiveArtifactEvidenceSchema,
  lineage: z.array(IdSchema).max(128),
  supersedes: IdSchema.nullable(),
  reviewState: ObjectiveArtifactReviewStateSchema,
  reviewReason: z.string().max(2_000).nullable(),
  reviewedBy: ObjectiveArtifactActorSchema.nullable(),
  reviewedAt: IsoDateSchema.nullable(),
  publishedBy: ObjectiveArtifactActorSchema,
  publishedAt: IsoDateSchema,
}).strict();
export type ObjectiveArtifactRecord = z.infer<typeof ObjectiveArtifactRecordSchema>;

export const ObjectiveArtifactReviewInputSchema = z.object({
  artifactId: IdSchema,
  state: ObjectiveArtifactReviewStateSchema.exclude(["pending"]),
  reason: z.string().min(1).max(2_000),
}).strict();
export type ObjectiveArtifactReviewInput = z.infer<typeof ObjectiveArtifactReviewInputSchema>;

export const ObjectiveArtifactReviewRecordSchema = z.object({
  version: z.literal(1),
  id: IdSchema,
  artifactId: IdSchema,
  objectiveId: IdSchema,
  runId: IdSchema,
  fromState: ObjectiveArtifactReviewStateSchema,
  state: ObjectiveArtifactReviewStateSchema.exclude(["pending"]),
  actor: ObjectiveArtifactActorSchema,
  reason: z.string().min(1).max(2_000),
  requestKey: z.string().min(8).max(512),
  createdAt: IsoDateSchema,
}).strict();
export type ObjectiveArtifactReviewRecord = z.infer<typeof ObjectiveArtifactReviewRecordSchema>;

/** Hard safety bound for one inline JSON artifact, even with unlimited policy. */
export const OBJECTIVE_ARTIFACT_MAX_INLINE_BYTES = 10 * 1024 * 1024;

export function objectiveArtifactCanonicalContent(content: unknown): string {
  return stableJsonStringify(JsonValueSchema.parse(content));
}

export function objectiveArtifactContentSize(content: unknown): number {
  return new TextEncoder().encode(objectiveArtifactCanonicalContent(content)).byteLength;
}

export function objectiveArtifactContentHash(content: unknown): string {
  return objectiveSha256(objectiveArtifactCanonicalContent(content));
}
