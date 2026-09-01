import { z } from "zod";
// Keep this module dependency-free from index.ts. index.ts re-exports this
// module, and importing its declarations back here would create a runtime
// cycle for browser consumers.
const IdSchema = z.string().min(1);
const IsoDateSchema = z.iso.datetime({ offset: true });
const JsonValueSchema = z.json();
const PermissionSchema = z.enum(["read-only", "full-access"]);
const ObjectiveSideEffectClassSchema = z.enum(["read", "local", "external", "irreversible"]);
const ObjectiveActorSchema = z.object({ type: z.enum(["user", "agent", "system"]), id: IdSchema }).strict();

/** Consequence of leaving an attention item unresolved. */
export const ObjectiveAttentionRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type ObjectiveAttentionRisk = z.infer<typeof ObjectiveAttentionRiskSchema>;

/** How quickly a decision is expected to be made. */
export const ObjectiveAttentionUrgencySchema = z.enum(["low", "normal", "high", "critical"]);
export type ObjectiveAttentionUrgency = z.infer<typeof ObjectiveAttentionUrgencySchema>;

export const ObjectiveAttentionStatusSchema = z.enum(["open", "resolved", "expired", "cancelled"]);
export type ObjectiveAttentionStatus = z.infer<typeof ObjectiveAttentionStatusSchema>;

/** A resource whose state prevents the bound node/attempt from progressing. */
export const ObjectiveAttentionBlockedResourceSchema = z.union([
  IdSchema,
  z.object({
    kind: z.enum(["workspace", "file", "artifact", "external", "capability", "agent", "other"]),
    id: IdSchema,
    description: z.string().max(2_000).optional(),
  }).strict(),
]);
export type ObjectiveAttentionBlockedResource = z.infer<typeof ObjectiveAttentionBlockedResourceSchema>;

/** A compact, durable reference into the daemon event/evidence history. */
export const ObjectiveAttentionEvidenceRefSchema = z.union([
  IdSchema,
  z.object({
    kind: z.enum(["event", "artifact", "checkpoint", "trace", "observation", "file", "other"]),
    id: IdSchema,
    cursor: z.number().int().nonnegative().optional(),
    description: z.string().max(2_000).optional(),
  }).strict(),
]);
export type ObjectiveAttentionEvidenceRef = z.infer<typeof ObjectiveAttentionEvidenceRefSchema>;

export const ObjectiveAttentionAlternativeSchema = z.union([
  z.string().min(1).max(2_000),
  z.object({
    id: IdSchema,
    label: z.string().min(1).max(500),
    description: z.string().max(2_000).optional(),
    consequence: z.string().max(2_000).optional(),
  }).strict(),
]);
export type ObjectiveAttentionAlternative = z.infer<typeof ObjectiveAttentionAlternativeSchema>;

/** The exact authority/policy boundary a decision would cross. */
export const ObjectiveAttentionAuthorityBoundarySchema = z
  .object({
    permission: PermissionSchema,
    sideEffectClass: ObjectiveSideEffectClassSchema,
    capability: IdSchema.nullable().default(null),
    resource: z.string().min(1).max(2_000).nullable().default(null),
    description: z.string().min(1).max(2_000),
  })
  .strict();
export type ObjectiveAttentionAuthorityBoundary = z.infer<typeof ObjectiveAttentionAuthorityBoundarySchema>;

/** Escalation is data, not a scheduler instruction. The daemon may project it. */
export const ObjectiveAttentionEscalationSchema = z
  .object({
    at: IsoDateSchema.nullable().default(null),
    to: ObjectiveActorSchema.nullable().default(null),
    policy: z.enum(["none", "notify", "reassign", "expire"]).default("none"),
    reason: z.string().max(2_000).nullable().default(null),
  })
  .strict();
export type ObjectiveAttentionEscalation = z.infer<typeof ObjectiveAttentionEscalationSchema>;

/** Receipt for the one command that settled an attention item. */
export const ObjectiveAttentionResolutionReceiptSchema = z
  .object({
    receiptId: IdSchema,
    requestKey: z.string().min(8),
    status: z.enum(["resolved", "expired", "cancelled"]),
    decision: JsonValueSchema.nullable().default(null),
    resolvedBy: ObjectiveActorSchema,
    resolvedAt: IsoDateSchema,
    evidenceRefs: z.array(ObjectiveAttentionEvidenceRefSchema).max(128).default([]),
  })
  .strict();
export type ObjectiveAttentionResolutionReceipt = z.infer<typeof ObjectiveAttentionResolutionReceiptSchema>;

/**
 * Immutable identity and decision record for one request for human or
 * governing-agent attention. Node and attempt are nullable only for an
 * objective/run-level decision; when present they fence resolution to the
 * exact execution frontier that raised the request.
 */
export const ObjectiveAttentionRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    /** Stable operation identity across daemon restarts and retries. */
    operationId: IdSchema,
    objectiveId: IdSchema,
    runId: IdSchema,
    nodeId: IdSchema.nullable().default(null),
    attemptId: IdSchema.nullable().default(null),
    reason: z.string().min(1).max(20_000),
    consequence: z.string().min(1).max(20_000),
    risk: ObjectiveAttentionRiskSchema,
    urgency: ObjectiveAttentionUrgencySchema,
    confidence: z.number().finite().min(0).max(1),
    blockedResource: ObjectiveAttentionBlockedResourceSchema.nullable().default(null),
    proposedAction: z.string().min(1).max(20_000),
    alternatives: z.array(ObjectiveAttentionAlternativeSchema).max(32).default([]),
    authorityBoundary: ObjectiveAttentionAuthorityBoundarySchema,
    evidenceRefs: z.array(ObjectiveAttentionEvidenceRefSchema).max(128).default([]),
    assignee: ObjectiveActorSchema.nullable().default(null),
    expiresAt: IsoDateSchema.nullable().default(null),
    escalation: ObjectiveAttentionEscalationSchema.default({ at: null, to: null, policy: "none", reason: null }),
    status: ObjectiveAttentionStatusSchema,
    resolution: ObjectiveAttentionResolutionReceiptSchema.nullable().default(null),
    requestKey: z.string().min(8),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status === "open" && item.resolution !== null) {
      context.addIssue({ code: "custom", path: ["resolution"], message: "Open attention items cannot have a resolution receipt" });
    }
    if (item.status !== "open" && item.resolution === null) {
      context.addIssue({ code: "custom", path: ["resolution"], message: "Settled attention items require a resolution receipt" });
    }
    if (item.resolution !== null && item.resolution.status !== item.status) {
      context.addIssue({ code: "custom", path: ["resolution", "status"], message: "Resolution receipt status must match the attention status" });
    }
    if (item.escalation.at !== null && item.expiresAt !== null && Date.parse(item.escalation.at) > Date.parse(item.expiresAt)) {
      context.addIssue({ code: "custom", path: ["escalation", "at"], message: "Escalation cannot occur after expiry" });
    }
  });
export type ObjectiveAttentionRecord = z.infer<typeof ObjectiveAttentionRecordSchema>;

/** Network input. The daemon supplies id, objective/run binding, actor, and request key. */
export const ObjectiveAttentionRequestSchema = z
  .object({
    /** Optional on network requests; the daemon/runner derives it when omitted. */
    operationId: IdSchema.optional(),
    nodeId: IdSchema.nullable().optional(),
    attemptId: IdSchema.nullable().optional(),
    reason: z.string().min(1).max(20_000),
    consequence: z.string().min(1).max(20_000),
    risk: ObjectiveAttentionRiskSchema,
    urgency: ObjectiveAttentionUrgencySchema,
    confidence: z.number().finite().min(0).max(1),
    blockedResource: ObjectiveAttentionBlockedResourceSchema.nullable().optional(),
    proposedAction: z.string().min(1).max(20_000),
    alternatives: z.array(ObjectiveAttentionAlternativeSchema).max(32).default([]),
    authorityBoundary: ObjectiveAttentionAuthorityBoundarySchema,
    evidenceRefs: z.array(ObjectiveAttentionEvidenceRefSchema).max(128).default([]),
    assignee: ObjectiveActorSchema.nullable().optional(),
    expiresAt: IsoDateSchema.nullable().optional(),
    escalation: ObjectiveAttentionEscalationSchema.optional(),
  })
  .strict();
export type ObjectiveAttentionRequest = z.infer<typeof ObjectiveAttentionRequestSchema>;

export const ObjectiveAttentionResolveRequestSchema = z
  .object({
    status: z.enum(["resolved", "expired", "cancelled"]),
    decision: JsonValueSchema.nullable().optional(),
    evidenceRefs: z.array(ObjectiveAttentionEvidenceRefSchema).max(128).default([]),
  })
  .strict();
export type ObjectiveAttentionResolveRequest = z.infer<typeof ObjectiveAttentionResolveRequestSchema>;

export const ObjectiveAttentionListQuerySchema = z
  .object({
    objectiveId: IdSchema.optional(),
    runId: IdSchema.optional(),
    nodeId: IdSchema.optional(),
    attemptId: IdSchema.optional(),
    status: z.array(ObjectiveAttentionStatusSchema).max(4).optional(),
    assigneeId: IdSchema.optional(),
    includeExpired: z.boolean().default(true),
    limit: z.number().int().min(1).max(2_000).default(200),
  })
  .strict();
export type ObjectiveAttentionListQuery = z.infer<typeof ObjectiveAttentionListQuerySchema>;
