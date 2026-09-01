import { createHash, randomUUID } from "node:crypto";
import {
  nowIso,
  normalizeDriverEvent,
  type DriverCapability,
  type DriverEvent,
  type DriverMessageRequest,
  type DriverSession,
  type JsonValue,
  type ResolvedHarness,
  type WorkerEventContext,
  type WorkerEventEnvelope,
} from "@symphony/protocol";

export type Emit = (event: DriverEvent) => void;

/** Canonical translation helper for adapters that expose raw native events. */
export function normalizeNativeDriverEvent(
  event: DriverEvent,
  context: WorkerEventContext,
): WorkerEventEnvelope {
  return normalizeDriverEvent({
    kind: event.kind,
    occurredAt: event.occurredAt,
    payload: event.payload,
    ...(event.nativeEventId ? { nativeEventId: event.nativeEventId } : {}),
  }, context);
}

/** Resolve the optional durable envelope while preserving old direct callers. */
export function messageRequest(
  message: string,
  request?: DriverMessageRequest,
): DriverMessageRequest {
  const contentHash = createHash("sha256").update(message, "utf8").digest("hex");
  if (request) {
    if (request.contentHash !== contentHash) {
      throw new Error("Native message content hash does not match its durable request identity.");
    }
    return request;
  }
  const legacyId = randomUUID();
  return { attemptId: `legacy:${legacyId}`, requestId: `legacy:${legacyId}`, contentHash };
}

export function withMessageIdentity(payload: unknown, request: DriverMessageRequest | null): unknown {
  if (!request || payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return {
    ...(payload as Record<string, unknown>),
    messageAttemptId: request.attemptId,
    messageRequestId: request.requestId,
    messageContentHash: request.contentHash,
  };
}

const DEDUPED_EVENT_KINDS = new Set<DriverEvent["kind"]>([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "output.completed",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "usage.recorded",
]);

/** Stable canonical identity for providers that do not expose event ids. */
export function canonicalNativeEventId(namespace: string, scope: string, kind: DriverEvent["kind"], payload: unknown): string {
  return `${namespace}:${scope}:${kind}:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

/**
 * Best-effort scope for the shared adapter fallback. Native adapters should
 * pass an explicit provider/host id whenever one exists, but an unscoped
 * payload fingerprint would otherwise collide when one agent/session is
 * reused across turns (or when two sessions report identical usage).
 */
function payloadIdentityScope(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const keys = [
    "nativeSessionId", "native_session_id", "sessionId", "session_id",
    "nativeRunId", "native_run_id", "runId", "run_id",
    "nativeTurnId", "native_turn_id", "turnId", "turn_id",
    "generation", "sequence", "seq",
  ];
  const values = keys.flatMap((key) => {
    const value = record[key];
    return typeof value === "string" || typeof value === "number" ? [`${key}=${String(value)}`] : [];
  });
  return values.length > 0 ? values.join(",") : null;
}

export const capabilities = (
  overrides: Partial<DriverCapability> = {},
): DriverCapability => ({
  streaming: true,
  resume: true,
  steer: true,
  passiveHistory: true,
  usage: true,
  mcp: true,
  local: true,
  cloud: false,
  readOnly: true,
  ...overrides,
});

export function emit(consumer: Emit, kind: DriverEvent["kind"], payload: unknown, nativeEventId?: string): void {
  const scope = payloadIdentityScope(payload);
  const identity = nativeEventId ?? (
    DEDUPED_EVENT_KINDS.has(kind) && scope
      ? canonicalNativeEventId("driver", scope, kind, payload)
      : undefined
  );
  consumer({
    kind,
    occurredAt: nowIso(),
    payload: toJson(payload),
    ...(identity ? { nativeEventId: identity } : {}),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function makeSession(
  driver: ResolvedHarness,
  nativeSessionId: string,
  metadata: Record<string, JsonValue> = {},
  nativeRunId: string | null = null,
): DriverSession {
  return {
    driver,
    nativeSessionId,
    nativeRunId,
    state: "running",
    startedAt: nowIso(),
    metadata,
  };
}

export function receipt(queued: boolean): { receiptId: string; queued: boolean } {
  return { receiptId: randomUUID(), queued };
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function deepString(value: unknown, ...paths: string[][]): string | undefined {
  for (const path of paths) {
    let current: unknown = value;
    for (const segment of path) current = record(current)[segment];
    if (typeof current === "string") return current;
  }
  return undefined;
}
