import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DriverEvent } from "@symphony/protocol";
import { emit, messageRequest, normalizeNativeDriverEvent } from "./common.js";

describe("shared driver event identity fallback", () => {
  it("leaves unscoped terminal evidence to the runtime agent/session fence", () => {
    const events: DriverEvent[] = [];
    emit((event) => events.push(event), "run.failed", { error: "same provider error" });
    emit((event) => events.push(event), "run.failed", { error: "same provider error" });
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.nativeEventId === undefined)).toBe(true);
  });

  it("scopes identical usage payloads when native sessions are available", () => {
    const events: DriverEvent[] = [];
    emit((event) => events.push(event), "usage.recorded", { sessionId: "session-a", usage: { input: 1 } });
    emit((event) => events.push(event), "usage.recorded", { sessionId: "session-b", usage: { input: 1 } });
    expect(events[0]?.nativeEventId).toBeDefined();
    expect(events[1]?.nativeEventId).toBeDefined();
    expect(events[0]?.nativeEventId).not.toBe(events[1]?.nativeEventId);
  });

  it("preserves a durable request id across replay and rejects content drift", () => {
    const message = "Continue the exact persisted turn.";
    const request = {
      attemptId: "attempt-1",
      requestId: "request-1",
      contentHash: createHash("sha256").update(message, "utf8").digest("hex"),
    };
    expect(messageRequest(message, request)).toEqual(request);
    expect(() => messageRequest("A different turn", request)).toThrow("content hash");
  });

  it("translates a native driver event into the shared envelope without changing its payload", () => {
    const envelope = normalizeNativeDriverEvent({
      kind: "message.delta",
      occurredAt: "2026-09-01T00:00:00.000Z",
      payload: { text: "native output" },
      nativeEventId: "native-event-1",
    }, {
      objectiveId: "objective-1",
      runId: "run-1",
      attemptId: "attempt-1",
      agentId: "agent-1",
      nativeSessionId: "session-1",
      leaseId: "lease-1",
    });
    expect(envelope).toMatchObject({
      eventClass: "activity",
      kind: "message.delta",
      objectiveId: "objective-1",
      runId: "run-1",
      attemptId: "attempt-1",
      agentId: "agent-1",
      nativeSessionId: "session-1",
      leaseId: "lease-1",
      payload: { text: "native output" },
      rawProvenance: { source: "driver", payload: { text: "native output" }, truncated: false },
    });
  });
});
