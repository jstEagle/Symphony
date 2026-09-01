import { z } from "zod";

/**
 * Durable suspension is a protocol value, never a callback or a process
 * handle.  The daemon owns all of the identity fields and persists this
 * record alongside the control-plan execution it suspends.
 */
const IdSchema = z.string().min(1).max(256);
const NodeIdSchema = IdSchema.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const SignalKeySchema = IdSchema.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u);
const IsoDateSchema = z.iso.datetime({ offset: true });
const JsonValueSchema = z.json();

export const ObjectiveControlTimerSpecSchema = z
  .object({
    /** Relative delay; the daemon turns this into the authoritative dueAt. */
    durationMs: z.number().int().positive().max(31_536_000_000),
    /** Optional relative expiry window, also interpreted by the daemon. */
    expiresAfterMs: z.number().int().positive().max(31_536_000_000).nullable().default(null),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.expiresAfterMs !== null && spec.expiresAfterMs < spec.durationMs) {
      context.addIssue({ code: "custom", path: ["expiresAfterMs"], message: "Timer expiry must be at or after due time." });
    }
  });
export type ObjectiveControlTimerSpec = z.infer<typeof ObjectiveControlTimerSpecSchema>;

export const ObjectiveControlSignalSpecSchema = z
  .object({
    /** Stable semantic topic. It is not executable code or a subscription callback. */
    signalKey: SignalKeySchema,
    /** Relative expiry window; null means the wait is indefinite. */
    expiresAfterMs: z.number().int().positive().max(31_536_000_000).nullable().default(null),
    /** JSON shape checked by the daemon before delivery; no executable payloads. */
    payloadSchema: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict();
export type ObjectiveControlSignalSpec = z.infer<typeof ObjectiveControlSignalSpecSchema>;

export const ObjectiveControlSuspensionExecutionSchema = z
  .object({ nodeId: NodeIdSchema, iterationKey: z.string().min(1).max(2_000) })
  .strict();
export type ObjectiveControlSuspensionExecution = z.infer<typeof ObjectiveControlSuspensionExecutionSchema>;

export const ObjectiveControlSuspensionStatusSchema = z.enum([
  "waiting",
  "ready",
  "delivered",
  "cancelled",
  "expired",
]);
export type ObjectiveControlSuspensionStatus = z.infer<typeof ObjectiveControlSuspensionStatusSchema>;

const ObjectiveControlSuspensionBaseSchema = z.object({
  version: z.literal(1),
  objectiveId: IdSchema,
  runId: IdSchema,
  nodeId: NodeIdSchema,
  execution: ObjectiveControlSuspensionExecutionSchema,
  /** Daemon-created attempt identity; signal delivery is scoped to it. */
  attemptId: IdSchema,
  since: IsoDateSchema,
  expiresAt: IsoDateSchema.nullable(),
  status: ObjectiveControlSuspensionStatusSchema,
  terminalReason: z.enum(["delivered", "due", "cancelled", "expired"]).nullable(),
  settledAt: IsoDateSchema.nullable(),
}).strict();

export const ObjectiveControlTimerSuspensionSchema = ObjectiveControlSuspensionBaseSchema.extend({
  kind: z.literal("timer"),
  dueAt: IsoDateSchema,
}).strict();
export type ObjectiveControlTimerSuspension = z.infer<typeof ObjectiveControlTimerSuspensionSchema>;

export const ObjectiveControlSignalSuspensionSchema = ObjectiveControlSuspensionBaseSchema.extend({
  kind: z.literal("signal"),
  signalKey: SignalKeySchema,
  subscriptionKey: IdSchema.max(512),
  deliveryId: IdSchema.nullable(),
  deliveredAt: IsoDateSchema.nullable(),
  payload: JsonValueSchema.nullable(),
}).strict();
export type ObjectiveControlSignalSuspension = z.infer<typeof ObjectiveControlSignalSuspensionSchema>;

export const ObjectiveControlSuspensionRecordSchema = z.discriminatedUnion("kind", [
  ObjectiveControlTimerSuspensionSchema,
  ObjectiveControlSignalSuspensionSchema,
]);
export type ObjectiveControlSuspensionRecord = z.infer<typeof ObjectiveControlSuspensionRecordSchema>;

/** Wire input for the authoritative daemon signal-delivery endpoint. */
export const ObjectiveControlSignalDeliveryInputSchema = z
  .object({
    signalKey: SignalKeySchema,
    subscriptionKey: IdSchema.max(512).optional(),
    /** Stable producer receipt. Reusing it with different data is rejected. */
    deliveryId: IdSchema,
    payload: JsonValueSchema,
    attemptId: IdSchema.optional(),
    occurredAt: IsoDateSchema.optional(),
  })
  .strict();
export type ObjectiveControlSignalDeliveryInput = z.infer<typeof ObjectiveControlSignalDeliveryInputSchema>;

export const ObjectiveControlSignalDeliveryRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    objectiveId: IdSchema,
    runId: IdSchema,
    nodeId: NodeIdSchema,
    execution: ObjectiveControlSuspensionExecutionSchema,
    attemptId: IdSchema,
    signalKey: SignalKeySchema,
    subscriptionKey: IdSchema.max(512),
    deliveryId: IdSchema,
    payload: JsonValueSchema,
    deliveredAt: IsoDateSchema,
    deliveredBy: z.object({ type: z.enum(["user", "agent", "system"]), id: IdSchema }).strict(),
  })
  .strict();
export type ObjectiveControlSignalDeliveryRecord = z.infer<typeof ObjectiveControlSignalDeliveryRecordSchema>;

export type ObjectiveControlSuspensionIdentity = Readonly<{
  objectiveId: string;
  runId: string;
  nodeId: string;
  execution: ObjectiveControlSuspensionExecution;
  attemptId: string;
  signalKey: string;
}>;

/** Stable key used by subscriptions, indexes, APIs, and reconnecting producers. */
export function objectiveControlSubscriptionKey(identity: ObjectiveControlSuspensionIdentity): string {
  return [
    "objective-signal",
    identity.objectiveId,
    identity.runId,
    identity.nodeId,
    identity.execution.iterationKey,
    identity.attemptId,
    identity.signalKey,
  ].join(":");
}

export function objectiveControlSuspensionExecutionId(execution: ObjectiveControlSuspensionExecution): string {
  return `${execution.nodeId}@${execution.iterationKey}`;
}

export function isTerminalObjectiveControlSuspension(status: ObjectiveControlSuspensionStatus): boolean {
  return status === "delivered" || status === "cancelled" || status === "expired";
}
