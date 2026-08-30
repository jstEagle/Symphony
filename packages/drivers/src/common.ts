import { randomUUID } from "node:crypto";
import {
  nowIso,
  type DriverCapability,
  type DriverEvent,
  type DriverSession,
  type JsonValue,
  type ResolvedHarness,
} from "@symphony/protocol";

export type Emit = (event: DriverEvent) => void;

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
  consumer({
    kind,
    occurredAt: nowIso(),
    payload: toJson(payload),
    ...(nativeEventId ? { nativeEventId } : {}),
  });
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
