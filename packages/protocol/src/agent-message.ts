import { z } from "zod";

/**
 * The inter-agent bus carries semantic packets, not native harness events.
 * Native transcripts stay owned by their harness and are referenced, when
 * needed, by an evidence or artifact reference.
 */

const IdSchema = z.string().min(1).max(512);
const IsoDateSchema = z.iso.datetime({ offset: true });

/** Bounds applied before a semantic packet is admitted to durable storage. */
export const AGENT_MESSAGE_MAX_PAYLOAD_BYTES = 64 * 1024;
export const AGENT_MESSAGE_MAX_RECORD_BYTES = 256 * 1024;
export const AGENT_MESSAGE_MAX_DEPTH = 16;
export const AGENT_MESSAGE_MAX_RECORD_DEPTH = 24;
export const AGENT_MESSAGE_MAX_COLLECTION_ENTRIES = 512;

const credentialFieldPattern = /(?:pass(?:word|phrase)?|secret|token|api[-_]?key|auth(?:orization)?|credential|private[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token|cookie|session(?:[-_]?id)?)/iu;

/**
 * Inspect JSON without trusting its shape or size. This intentionally counts
 * object members and array items across the complete value, not merely the
 * number of top-level fields.
 */
export function assertAgentMessageJsonBounds(
  value: unknown,
  options: Readonly<{
    label?: string;
    maxBytes?: number;
    maxDepth?: number;
    maxCollectionEntries?: number;
  }> = {},
): void {
  const label = options.label ?? "Agent message JSON";
  const maxBytes = options.maxBytes ?? AGENT_MESSAGE_MAX_PAYLOAD_BYTES;
  const maxDepth = options.maxDepth ?? AGENT_MESSAGE_MAX_DEPTH;
  const maxCollectionEntries = options.maxCollectionEntries ?? AGENT_MESSAGE_MAX_COLLECTION_ENTRIES;
  const seen = new WeakSet<object>();
  let collections = 0;
  const visit = (item: unknown, depth: number): void => {
    if (item === null || typeof item !== "object") return;
    if (depth > maxDepth) throw new Error(`${label} exceeds maximum depth of ${maxDepth}.`);
    if (seen.has(item)) throw new Error(`${label} must not contain cyclic references.`);
    seen.add(item);
    const entries = Array.isArray(item) ? item : Object.entries(item);
    if (entries.length > maxCollectionEntries) {
      throw new Error(`${label} exceeds maximum collection size of ${maxCollectionEntries}.`);
    }
    collections += entries.length;
    if (collections > maxCollectionEntries * 8) {
      throw new Error(`${label} exceeds its maximum collection entry budget.`);
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else {
      for (const [key, child] of entries as Array<[string, unknown]>) {
        if (typeof key !== "string") throw new Error(`${label} contains an invalid object key.`);
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable.`);
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new Error(`${label} exceeds maximum serialized size of ${maxBytes} bytes.`);
  }
}

/** Replace credential-shaped payload fields before callbacks or persistence. */
export function redactAgentMessageCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAgentMessageCredentials(item));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(output, key, {
      value: credentialFieldPattern.test(key) ? "[REDACTED]" : redactAgentMessageCredentials(child),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

export const AgentMessageKindSchema = z.enum([
  "finding",
  "question",
  "status",
  "handoff",
  "control-request",
]);
export type AgentMessageKind = z.infer<typeof AgentMessageKindSchema>;
export const AgentMessageSequenceSchema = z.number().int().positive();
export const AgentMessageCursorSchema = z.number().int().positive();

export const AgentMessageDeliveryStateSchema = z.enum([
  "pending",
  "delivered",
  "read",
  "handled",
  "failed",
  "unknown",
  "expired",
  "cancelled",
]);
export type AgentMessageDeliveryState = z.infer<typeof AgentMessageDeliveryStateSchema>;

export const AgentMessageReceiptKindSchema = z.enum([
  "delivery",
  "read",
  "handled",
  "expiry",
  "cancellation",
]);
export type AgentMessageReceiptKind = z.infer<typeof AgentMessageReceiptKindSchema>;

/** A stable actor identity; it deliberately has no native transcript fields. */
export const AgentMessageActorSchema = z
  .object({
    type: z.enum(["agent", "user", "system"]),
    id: IdSchema,
  })
  .strict();
export type AgentMessageActor = z.infer<typeof AgentMessageActorSchema>;

/** Optional lineage metadata for a message's parent work item. */
export const AgentMessageParentSchema = z
  .object({
    messageId: IdSchema.nullable().default(null),
    agentId: IdSchema.nullable().default(null),
    attemptId: IdSchema.nullable().default(null),
  })
  .strict()
  .superRefine((parent, context) => {
    if (parent.messageId === null && parent.agentId === null && parent.attemptId === null) {
      context.addIssue({ code: "custom", message: "A parent reference must identify a message, agent, or attempt." });
    }
  });
export type AgentMessageParent = z.infer<typeof AgentMessageParentSchema>;

export const AgentMessageArtifactRefSchema = z
  .object({
    id: IdSchema,
    hash: z.string().min(8).max(256).nullable().default(null),
    mediaType: z.string().min(1).max(256).nullable().default(null),
    uri: z.string().min(1).max(4_096).nullable().default(null),
  })
  .strict();
export type AgentMessageArtifactRef = z.infer<typeof AgentMessageArtifactRefSchema>;

export const AgentMessageEvidenceRefSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(["event", "observation", "checkpoint", "artifact", "external"]).default("event"),
    hash: z.string().min(8).max(256).nullable().default(null),
    cursor: z.number().int().nonnegative().nullable().default(null),
    uri: z.string().min(1).max(4_096).nullable().default(null),
  })
  .strict();
export type AgentMessageEvidenceRef = z.infer<typeof AgentMessageEvidenceRefSchema>;

export const AgentMessageDecisionSchema = z.enum([
  "acknowledged",
  "accepted",
  "rejected",
  "deferred",
  "cancelled",
]);
export type AgentMessageDecision = z.infer<typeof AgentMessageDecisionSchema>;

export const AgentMessagePayloadSchema = z.json().superRefine((payload, context) => {
  try {
    assertAgentMessageJsonBounds(payload, { label: "Agent message payload" });
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Agent message payload is out of bounds." });
  }
});
export type AgentMessagePayload = z.infer<typeof AgentMessagePayloadSchema>;

/** Stable graph identity retained on every message, independent of payload. */
export const AgentMessageIdentitySchema = z
  .object({
    senderId: IdSchema,
    recipientId: IdSchema,
    parentId: IdSchema.nullable().default(null),
    parentAgentId: IdSchema.nullable().default(null),
    objectiveId: IdSchema.nullable().default(null),
    runId: IdSchema.nullable().default(null),
    attemptId: IdSchema.nullable().default(null),
    correlationId: IdSchema.nullable().default(null),
    replyToId: IdSchema.nullable().default(null),
  })
  .strict();
export type AgentMessageIdentity = z.infer<typeof AgentMessageIdentitySchema>;
export const AgentMessageLineageSchema = AgentMessageIdentitySchema;
export type AgentMessageLineage = AgentMessageIdentity;

/**
 * Caller input. `requestKey` is the replay fence and must be stable across a
 * retry. IDs are kept explicit instead of inferred from a transcript or from
 * the current parent process.
 */
export const AgentMessageInputSchema = z
  .object({
    version: z.literal(1).default(1),
    id: IdSchema.optional(),
    requestKey: IdSchema,
    kind: AgentMessageKindSchema,
    senderId: IdSchema,
    recipientId: IdSchema,
    parentId: IdSchema.nullable().default(null),
    parentAgentId: IdSchema.nullable().default(null),
    objectiveId: IdSchema.nullable().default(null),
    runId: IdSchema.nullable().default(null),
    attemptId: IdSchema.nullable().default(null),
    correlationId: IdSchema.nullable().default(null),
    replyToId: IdSchema.nullable().default(null),
    payload: AgentMessagePayloadSchema.default({}),
    /** Human-readable semantic summary; this is never a native transcript. */
    summary: z.string().max(20_000).default(""),
    artifactRefs: z.array(AgentMessageArtifactRefSchema).max(2_000).default([]),
    evidenceRefs: z.array(AgentMessageEvidenceRefSchema).max(2_000).default([]),
    createdAt: IsoDateSchema,
    expiresAt: IsoDateSchema.nullable().default(null),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.replyToId !== null && message.correlationId === null) {
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "A reply must retain its correlation identity.",
      });
    }
    if (message.expiresAt !== null && Date.parse(message.expiresAt) < Date.parse(message.createdAt)) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "Message expiry cannot precede creation." });
    }
    if (message.kind === "control-request" && message.summary.length === 0 && message.payload === null) {
      context.addIssue({ code: "custom", path: ["payload"], message: "Control requests need an explicit semantic request." });
    }
  });
export type AgentMessageInput = z.infer<typeof AgentMessageInputSchema>;

/** Parse and sanitize caller input before authorization callbacks inspect it. */
export function sanitizeAgentMessageInput(input: unknown): AgentMessageInput {
  const parsed = AgentMessageInputSchema.parse(input);
  const payload = redactAgentMessageCredentials(parsed.payload) as AgentMessagePayload;
  assertAgentMessageJsonBounds(payload, { label: "Agent message payload" });
  return AgentMessageInputSchema.parse({ ...parsed, payload });
}

/** Immutable message record assigned by the durable bus. */
export const AgentMessageRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    requestKey: IdSchema,
    kind: AgentMessageKindSchema,
    senderId: IdSchema,
    recipientId: IdSchema,
    parentId: IdSchema.nullable(),
    parentAgentId: IdSchema.nullable(),
    objectiveId: IdSchema.nullable(),
    runId: IdSchema.nullable(),
    attemptId: IdSchema.nullable(),
    correlationId: IdSchema.nullable(),
    replyToId: IdSchema.nullable(),
    payload: AgentMessagePayloadSchema,
    summary: z.string().max(20_000),
    artifactRefs: z.array(AgentMessageArtifactRefSchema).max(2_000),
    evidenceRefs: z.array(AgentMessageEvidenceRefSchema).max(2_000),
    createdAt: IsoDateSchema,
    expiresAt: IsoDateSchema.nullable(),
    sequence: z.number().int().positive(),
    cursor: z.number().int().positive(),
  })
  .strict()
  .superRefine((record, context) => {
    try {
      assertAgentMessageJsonBounds(record.payload, { label: "Agent message payload" });
      assertAgentMessageJsonBounds(record, {
        label: "Agent message record",
        maxBytes: AGENT_MESSAGE_MAX_RECORD_BYTES,
        maxDepth: AGENT_MESSAGE_MAX_RECORD_DEPTH,
      });
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Agent message record is out of bounds." });
    }
  });
export type AgentMessageRecord = Readonly<z.infer<typeof AgentMessageRecordSchema>>;
export const AgentMessageSchema = AgentMessageRecordSchema;
export type AgentMessage = AgentMessageRecord;
export const AgentMessageCreateInputSchema = AgentMessageInputSchema;
export type AgentMessageCreateInput = AgentMessageInput;

export const AgentMessageReceiptInputSchema = z
  .object({
    version: z.literal(1).default(1),
    id: IdSchema.optional(),
    requestKey: IdSchema,
    messageId: IdSchema,
    recipientId: IdSchema,
    actorId: IdSchema.nullable().default(null),
    kind: AgentMessageReceiptKindSchema,
    state: AgentMessageDeliveryStateSchema,
    reason: z.string().max(4_000).nullable().default(null),
    decision: AgentMessageDecisionSchema.nullable().default(null),
    recordedAt: IsoDateSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.kind === "handled" && receipt.decision === null) {
      context.addIssue({ code: "custom", path: ["decision"], message: "Handled receipts require an explicit parent decision." });
    }
    if (receipt.kind === "delivery" && !["delivered", "failed", "unknown", "expired", "cancelled"].includes(receipt.state)) {
      context.addIssue({ code: "custom", path: ["state"], message: "Delivery receipts must state delivery outcome explicitly." });
    }
    if (receipt.kind === "read" && receipt.state !== "read") {
      context.addIssue({ code: "custom", path: ["state"], message: "Read receipts must use read state." });
    }
    if (receipt.kind === "handled" && receipt.state !== "handled") {
      context.addIssue({ code: "custom", path: ["state"], message: "Handled receipts must use handled state." });
    }
    if (receipt.kind === "expiry" && receipt.state !== "expired") {
      context.addIssue({ code: "custom", path: ["state"], message: "Expiry receipts must use expired state." });
    }
    if (receipt.kind === "cancellation" && receipt.state !== "cancelled") {
      context.addIssue({ code: "custom", path: ["state"], message: "Cancellation receipts must use cancelled state." });
    }
  });
export type AgentMessageReceiptInput = z.infer<typeof AgentMessageReceiptInputSchema>;

export const AgentMessageReceiptSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    requestKey: IdSchema,
    messageId: IdSchema,
    recipientId: IdSchema,
    actorId: IdSchema.nullable(),
    kind: AgentMessageReceiptKindSchema,
    state: AgentMessageDeliveryStateSchema,
    reason: z.string().max(4_000).nullable(),
    decision: AgentMessageDecisionSchema.nullable(),
    recordedAt: IsoDateSchema,
    cursor: z.number().int().positive(),
  })
  .strict()
  .superRefine((receipt, context) => {
    try {
      assertAgentMessageJsonBounds(receipt, {
        label: "Agent message receipt",
        maxBytes: AGENT_MESSAGE_MAX_RECORD_BYTES,
        maxDepth: AGENT_MESSAGE_MAX_RECORD_DEPTH,
      });
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Agent message receipt is out of bounds." });
    }
  });
export type AgentMessageReceipt = Readonly<z.infer<typeof AgentMessageReceiptSchema>>;
export const AgentMessageDeliveryReceiptSchema = AgentMessageReceiptSchema;
export type AgentMessageDeliveryReceipt = AgentMessageReceipt;

export const AgentMessageSnapshotSchema = z
  .object({
    message: AgentMessageRecordSchema,
    receipts: z.array(AgentMessageReceiptSchema),
    state: AgentMessageDeliveryStateSchema,
    delivery: AgentMessageReceiptSchema.nullable(),
    read: AgentMessageReceiptSchema.nullable(),
    handled: AgentMessageReceiptSchema.nullable(),
  })
  .strict();
export type AgentMessageSnapshot = Readonly<z.infer<typeof AgentMessageSnapshotSchema>>;

/** Stable JSON used for replay fencing; object key order is not significant. */
export function agentMessageStableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(agentMessageStableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${agentMessageStableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

export function isAgentMessageTerminalState(state: AgentMessageDeliveryState): boolean {
  return state === "handled" || state === "failed" || state === "unknown" || state === "expired" || state === "cancelled";
}
