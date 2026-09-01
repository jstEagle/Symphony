import { z } from "zod";

/**
 * The worker event envelope is the narrow seam between a native harness and
 * Symphony.  Native providers may keep their own event vocabulary; this
 * record only adds durable Symphony identity and bounded provenance.
 */
export const WORKER_EVENT_ENVELOPE_VERSION = 1 as const;
export const WORKER_EVENT_RAW_MAX_BYTES = 16 * 1024;
export const WORKER_EVENT_RAW_MAX_DEPTH = 8;
export const WORKER_EVENT_RAW_MAX_ENTRIES = 128;
/** Maximum serialized size of a provider payload retained in durable events. */
export const WORKER_EVENT_PERSISTED_MAX_BYTES = WORKER_EVENT_RAW_MAX_BYTES;
export const WORKER_EVENT_PERSISTED_MAX_DEPTH = WORKER_EVENT_RAW_MAX_DEPTH;
export const WORKER_EVENT_PERSISTED_MAX_ENTRIES = WORKER_EVENT_RAW_MAX_ENTRIES;

const IdSchema = z.string().min(1).max(512);
const IsoDateSchema = z.iso.datetime({ offset: true });
const JsonSchema = z.json();

export const WorkerEventClassSchema = z.enum([
  "lifecycle",
  "activity",
  "evidence",
  "usage",
  "error",
]);
export type WorkerEventClass = z.infer<typeof WorkerEventClassSchema>;

/** Identity is deliberately flat so every consumer can filter without guessing nested fields. */
export const WorkerEventIdentitySchema = z.object({
  objectiveId: IdSchema.nullable(),
  runId: IdSchema,
  attemptId: IdSchema,
  agentId: IdSchema,
  nativeSessionId: IdSchema.nullable(),
  leaseId: IdSchema.nullable(),
}).strict();
export type WorkerEventIdentity = z.infer<typeof WorkerEventIdentitySchema>;

/**
 * The retained native value is an excerpt, not a transcript.  In particular,
 * this record is safe to put in the durable event log without allowing one
 * malformed provider line to grow the log without bound.
 */
export const WorkerEventRawProvenanceSchema = z.object({
  source: z.string().min(1).max(128),
  stream: z.string().min(1).max(128),
  kind: z.string().min(1).max(256),
  cursor: z.number().int().nonnegative(),
  nativeEventId: IdSchema.nullable(),
  payload: JsonSchema,
  truncated: z.boolean(),
}).strict().superRefine((raw, context) => {
  if (byteLength(raw.payload) > WORKER_EVENT_RAW_MAX_BYTES) {
    context.addIssue({ code: "custom", path: ["payload"], message: "Raw worker-event provenance exceeds the retained byte limit." });
  }
});
export type WorkerEventRawProvenance = z.infer<typeof WorkerEventRawProvenanceSchema>;

export const WorkerEventEnvelopeSchema = z.object({
  version: z.literal(WORKER_EVENT_ENVELOPE_VERSION),
  eventId: IdSchema,
  eventClass: WorkerEventClassSchema,
  kind: z.string().min(1).max(256),
  objectiveId: IdSchema.nullable(),
  runId: IdSchema,
  attemptId: IdSchema,
  agentId: IdSchema,
  nativeSessionId: IdSchema.nullable(),
  leaseId: IdSchema.nullable(),
  cursor: z.number().int().nonnegative(),
  timestamp: IsoDateSchema,
  /** Stable identity used to claim a semantic event exactly once. */
  dedupeKey: IdSchema,
  /** Stable identity for replaying one source cursor through a new controller. */
  replayKey: IdSchema,
  nativeEventId: IdSchema.nullable(),
  payload: JsonSchema,
  rawProvenance: WorkerEventRawProvenanceSchema,
}).strict();
export type WorkerEventEnvelope = Readonly<z.infer<typeof WorkerEventEnvelopeSchema>>;
/** Compatibility aliases for callers that refer to the normalized record as a worker event. */
export const WorkerEventSchema = WorkerEventEnvelopeSchema;
export type WorkerEvent = WorkerEventEnvelope;

/** Display activity contains only bounded, human-facing fields. Raw payload is never copied here. */
export const WorkerEventDisplayActivitySchema = z.object({
  eventId: IdSchema,
  cursor: z.number().int().nonnegative(),
  timestamp: IsoDateSchema,
  kind: z.string().min(1).max(256),
  summary: z.string().max(512),
  text: z.string().max(4_000).nullable(),
  status: z.string().max(128).nullable(),
}).strict();
export type WorkerEventDisplayActivity = z.infer<typeof WorkerEventDisplayActivitySchema>;
export const WorkerEventActivitySchema = WorkerEventDisplayActivitySchema;
export type WorkerEventActivity = WorkerEventDisplayActivity;

/** Evidence retains the normalized value and its bounded source pointer separately from display activity. */
export const WorkerEventEvidenceSchema = z.object({
  eventId: IdSchema,
  cursor: z.number().int().nonnegative(),
  timestamp: IsoDateSchema,
  kind: z.string().min(1).max(256),
  eventClass: WorkerEventClassSchema,
  payload: JsonSchema,
  rawProvenance: WorkerEventRawProvenanceSchema,
}).strict();
export type WorkerEventEvidence = z.infer<typeof WorkerEventEvidenceSchema>;

export const WorkerEventProjectionSchema = z.object({
  version: z.literal(WORKER_EVENT_ENVELOPE_VERSION),
  eventId: IdSchema,
  cursor: z.number().int().nonnegative(),
  timestamp: IsoDateSchema,
  eventClass: WorkerEventClassSchema,
  objectiveId: IdSchema.nullable(),
  runId: IdSchema,
  attemptId: IdSchema,
  agentId: IdSchema,
  nativeSessionId: IdSchema.nullable(),
  leaseId: IdSchema.nullable(),
  dedupeKey: IdSchema,
  replayKey: IdSchema,
  activity: WorkerEventDisplayActivitySchema.nullable(),
  evidence: WorkerEventEvidenceSchema,
}).strict();
export type WorkerEventProjection = z.infer<typeof WorkerEventProjectionSchema>;

export type WorkerEventContext = {
  objectiveId?: string | null;
  runId: string;
  attemptId?: string | null;
  agentId: string;
  nativeSessionId?: string | null;
  leaseId?: string | null;
  /** Runtime turn fence for native streams that reuse one session id. */
  runtimeTurnId?: string | null;
};

export type WorkerEventInput = {
  source: string;
  stream?: string;
  kind: string;
  payload: unknown;
  timestamp?: string;
  cursor?: number;
  eventClass?: WorkerEventClass;
  eventId?: string;
  dedupeKey?: string;
  replayKey?: string;
  nativeEventId?: string | null;
  rawProvenance?: Partial<Omit<WorkerEventRawProvenance, "payload" | "truncated">> & {
    payload?: unknown;
    truncated?: boolean;
  };
  context: WorkerEventContext;
};

export type BoundValueResult = { value: unknown; truncated: boolean };

const REDACTED_VALUE = "[redacted]";
// Reserve space for object keys, array delimiters, and truncation markers.
// Charging only child values would otherwise let a payload with many long
// keys exceed the serialized byte fence after traversal.
const BOUND_OVERHEAD_RESERVE_BYTES = 4_096;
const SENSITIVE_KEY_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "authtoken",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "setcookie",
  "signingkey",
  "token",
  "webhooksecret",
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return SENSITIVE_KEY_NAMES.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password");
}

/** Redact common bearer/token literals even when a provider uses an opaque key. */
function redactSensitiveString(value: string): string {
  return /^(?:bearer\s+|basic\s+|sk-[a-z0-9]|gh[pousr]_[a-z0-9]|xox[baprs]-)/iu.test(value.trim())
    ? REDACTED_VALUE
    : value;
}

/** Convert arbitrary native values to JSON before applying the byte/depth/entry bounds. */
function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
}

function boundValue(value: unknown, depth: number, budget: { bytes: number }, sensitive = false): BoundValueResult {
  if (depth > WORKER_EVENT_PERSISTED_MAX_DEPTH || budget.bytes <= 0) return { value: "[truncated]", truncated: true };
  const normalized = jsonValue(value);
  if (sensitive) {
    budget.bytes -= byteLength(REDACTED_VALUE);
    return { value: REDACTED_VALUE, truncated: false };
  }
  if (typeof normalized === "string") {
    const redacted = redactSensitiveString(normalized);
    if (redacted !== normalized) {
      budget.bytes -= byteLength(redacted);
      return { value: redacted, truncated: false };
    }
    const available = Math.max(0, Math.min(budget.bytes, WORKER_EVENT_PERSISTED_MAX_BYTES) - BOUND_OVERHEAD_RESERVE_BYTES);
    if (byteLength(normalized) <= available) {
      budget.bytes -= byteLength(normalized);
      return { value: normalized, truncated: false };
    }
    const maxChars = Math.max(0, available - 32);
    const excerpt = normalized.slice(0, maxChars);
    budget.bytes = 0;
    return { value: `${excerpt}[truncated]`, truncated: true };
  }
  if (normalized === null || typeof normalized === "number" || typeof normalized === "boolean") {
    const size = byteLength(normalized);
    if (size > budget.bytes) return { value: "[truncated]", truncated: true };
    budget.bytes -= size;
    return { value: normalized, truncated: false };
  }
  if (Array.isArray(normalized)) {
    const values: unknown[] = [];
    let truncated = false;
    for (const item of normalized.slice(0, WORKER_EVENT_PERSISTED_MAX_ENTRIES)) {
      const child = boundValue(item, depth + 1, budget);
      values.push(child.value);
      truncated ||= child.truncated;
      if (budget.bytes <= 0) {
        truncated = true;
        break;
      }
    }
    if (normalized.length > values.length) truncated = true;
    return { value: values, truncated };
  }
  const objectValue = normalized as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let truncated = false;
  const keys = Object.keys(objectValue)
    .slice(0, WORKER_EVENT_PERSISTED_MAX_ENTRIES)
    // Keep small structural evidence available even when a provider puts a
    // megabyte-sized transcript field first in the object.
    .sort((left, right) => {
      const priority = (key: string): number => {
        if (isSensitiveKey(key)) return 0;
        const candidate = objectValue[key];
        return typeof candidate === "string" && candidate.length > 1_024 ? 2 : 1;
      };
      return priority(left) - priority(right);
    });
  for (const key of keys) {
    if (budget.bytes <= 0) {
      truncated = true;
      break;
    }
    const child = boundValue(objectValue[key], depth + 1, budget, isSensitiveKey(key));
    result[key.slice(0, 256)] = child.value;
    truncated ||= child.truncated;
  }
  if (Object.keys(objectValue).length > Object.keys(result).length) truncated = true;
  return { value: result, truncated };
}

export function boundWorkerEventRaw(value: unknown, maxBytes = WORKER_EVENT_PERSISTED_MAX_BYTES): BoundValueResult {
  const limit = Math.max(1, Math.min(maxBytes, WORKER_EVENT_PERSISTED_MAX_BYTES));
  const budget = { bytes: limit };
  const result = boundValue(value, 0, budget);
  // Object keys and punctuation are deliberately not charged to child
  // values while traversing. Apply a final hard fence so pathological keys
  // cannot defeat the retained-byte contract.
  if (byteLength(result.value) > limit) {
    const marker = "[truncated]";
    return { value: marker.slice(0, Math.max(0, limit - 2)), truncated: true };
  }
  return result;
}

/**
 * Return the only provider payload shape allowed to cross a durable or API
 * boundary. The input is intentionally unknown: native adapters may receive
 * provider-specific objects that are not part of the public protocol.
 */
export function projectWorkerEventPayload(value: unknown): unknown {
  return boundWorkerEventRaw(value).value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Runtime-neutral deterministic digest. Node drivers may supply a SHA-256
// nativeEventId; this fallback only needs to be stable in browser/test runtimes.
function stableDigest(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

function nonEmpty(value: string | null | undefined, fallback: string): string {
  const resolved = value && value.length > 0 ? value : fallback;
  if (resolved.length <= 512) return resolved;
  return `${resolved.slice(0, 480)}:${stableDigest(resolved)}`;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function payloadString(payload: unknown, ...keys: string[]): string | null {
  const record = payloadRecord(payload);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function workerEventClassForKind(kind: string, payload: unknown = null): WorkerEventClass {
  if (kind === "usage.recorded") return "usage";
  if (kind === "run.failed" || kind === "error" || kind.endsWith(".error")) return "error";
  if (["session.started", "run.started", "message.completed", "run.cancelled", "worker-host.exit"].includes(kind)) return "lifecycle";
  if (["output.completed", "tool.completed", "file.changed", "command.completed", "approval.requested", "worker-host.control"].includes(kind)) return "evidence";
  if (kind === "log" && payloadString(payload, "error", "message")?.toLowerCase().includes("error")) return "error";
  return "activity";
}

export function normalizeWorkerEvent(input: WorkerEventInput): WorkerEventEnvelope {
  if (!input.context.runId) throw new Error("Worker event normalization requires runId.");
  if (!input.context.agentId) throw new Error("Worker event normalization requires agentId.");
  const cursor = input.cursor ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Worker event cursor must be a non-negative safe integer.");
  const attemptId = nonEmpty(input.context.attemptId, `legacy:${input.context.agentId}:${input.context.runId}`);
  const objectiveId = input.context.objectiveId ?? null;
  const nativeSessionId = input.context.nativeSessionId ?? null;
  const leaseId = input.context.leaseId ?? null;
  const runtimeTurnId = input.context.runtimeTurnId ?? null;
  // DriverEvent predates this contract and only required a string. Preserve
  // valid provider timestamps verbatim, while making malformed legacy values
  // explicit and usable at the new boundary instead of dropping the event.
  const candidateTimestamp = input.timestamp ?? new Date().toISOString();
  const timestamp = IsoDateSchema.safeParse(candidateTimestamp).success
    ? candidateTimestamp
    : new Date().toISOString();
  const nativeEventId = input.nativeEventId ?? null;
  const boundedPayload = boundWorkerEventRaw(input.payload);
  const identitySource = stableJson({
    source: input.source,
    kind: input.kind,
    cursor,
    objectiveId,
    runId: input.context.runId,
    attemptId,
    agentId: input.context.agentId,
    nativeSessionId,
    leaseId,
    runtimeTurnId,
    nativeEventId,
    payload: boundedPayload.value,
  });
  const digest = stableDigest(identitySource);
  const eventId = nonEmpty(input.eventId, nativeEventId ?? `worker:${input.source}:${digest}`);
  const dedupeKey = nonEmpty(input.dedupeKey, nativeEventId ?? `worker:${input.source}:${input.kind}:${digest}`);
  const replayKey = nonEmpty(input.replayKey, `worker:${leaseId ?? "unleased"}:${cursor}:${eventId}`);
  const bounded = boundWorkerEventRaw(input.rawProvenance?.payload ?? input.payload);
  const rawProvenance = WorkerEventRawProvenanceSchema.parse({
    source: input.rawProvenance?.source ?? input.source,
    stream: input.rawProvenance?.stream ?? input.stream ?? input.source,
    kind: input.rawProvenance?.kind ?? input.kind,
    cursor: input.rawProvenance?.cursor ?? cursor,
    nativeEventId: input.rawProvenance?.nativeEventId ?? nativeEventId,
    payload: bounded.value,
    truncated: Boolean(input.rawProvenance?.truncated) || bounded.truncated,
  });
  return WorkerEventEnvelopeSchema.parse({
    version: WORKER_EVENT_ENVELOPE_VERSION,
    eventId,
    eventClass: input.eventClass ?? workerEventClassForKind(input.kind, input.payload),
    kind: input.kind,
    objectiveId,
    runId: input.context.runId,
    attemptId,
    agentId: input.context.agentId,
    nativeSessionId,
    leaseId,
    cursor,
    timestamp,
    dedupeKey,
    replayKey,
    nativeEventId,
    // Provider payloads are transient at this boundary. Only the bounded,
    // redacted projection is retained in the normalized envelope.
    payload: boundedPayload.value,
    rawProvenance,
  });
}

export function projectWorkerEvent(event: WorkerEventEnvelope): WorkerEventProjection {
  const parsed = WorkerEventEnvelopeSchema.parse(event);
  const text = payloadString(parsed.payload, "text", "delta", "message");
  const error = payloadString(parsed.payload, "error", "detail");
  const status = payloadString(parsed.payload, "status", "state", "stopReason");
  const summary = (error ?? text ?? parsed.kind).replace(/\s+/gu, " ").trim().slice(0, 512);
  const activity = {
    eventId: parsed.eventId,
    cursor: parsed.cursor,
    timestamp: parsed.timestamp,
    kind: parsed.kind,
    summary,
    text: text?.slice(0, 4_000) ?? null,
    status: status?.slice(0, 128) ?? null,
  };
  return WorkerEventProjectionSchema.parse({
    version: WORKER_EVENT_ENVELOPE_VERSION,
    eventId: parsed.eventId,
    cursor: parsed.cursor,
    timestamp: parsed.timestamp,
    eventClass: parsed.eventClass,
    objectiveId: parsed.objectiveId,
    runId: parsed.runId,
    attemptId: parsed.attemptId,
    agentId: parsed.agentId,
    nativeSessionId: parsed.nativeSessionId,
    leaseId: parsed.leaseId,
    dedupeKey: parsed.dedupeKey,
    replayKey: parsed.replayKey,
    activity,
    evidence: {
      eventId: parsed.eventId,
      cursor: parsed.cursor,
      timestamp: parsed.timestamp,
      kind: parsed.kind,
      eventClass: parsed.eventClass,
      payload: parsed.payload,
      rawProvenance: parsed.rawProvenance,
    },
  });
}

export function normalizeDriverEvent(input: {
  kind: string;
  occurredAt: string;
  payload: unknown;
  nativeEventId?: string | null;
}, context: WorkerEventContext): WorkerEventEnvelope {
  return normalizeWorkerEvent({
    source: "driver",
    stream: "driver",
    kind: input.kind,
    payload: input.payload,
    timestamp: input.occurredAt,
    ...(input.nativeEventId ? { nativeEventId: input.nativeEventId } : {}),
    context,
  });
}
