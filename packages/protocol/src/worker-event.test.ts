import { describe, expect, it } from "vitest";
import {
  WorkerEventEnvelopeSchema,
  WORKER_EVENT_PERSISTED_MAX_BYTES,
  boundWorkerEventRaw,
  normalizeDriverEvent,
  normalizeWorkerEvent,
  projectWorkerEvent,
} from "./worker-event.js";

const context = {
  objectiveId: "objective-1",
  runId: "run-1",
  attemptId: "attempt-1",
  agentId: "agent-1",
  nativeSessionId: "native-session-1",
  leaseId: "lease-1",
};

describe("worker event envelope", () => {
  it("normalizes explicit lineage, cursor, timestamp, and replay identity", () => {
    const event = normalizeWorkerEvent({
      source: "worker-host",
      stream: "stdout",
      kind: "native.stdout",
      payload: { data: "hello" },
      cursor: 7,
      timestamp: "2026-09-01T00:00:00.000Z",
      nativeEventId: "host:lease-1:7:1",
      context,
    });

    expect(event).toMatchObject({
      version: 1,
      eventClass: "activity",
      objectiveId: "objective-1",
      runId: "run-1",
      attemptId: "attempt-1",
      agentId: "agent-1",
      nativeSessionId: "native-session-1",
      leaseId: "lease-1",
      cursor: 7,
      timestamp: "2026-09-01T00:00:00.000Z",
      nativeEventId: "host:lease-1:7:1",
      dedupeKey: "host:lease-1:7:1",
    });
    expect(event.replayKey).toContain("lease-1:7");
    expect(WorkerEventEnvelopeSchema.parse(event)).toEqual(event);
  });

  it("keeps raw evidence separate from bounded display activity", () => {
    const event = normalizeDriverEvent({
      kind: "tool.completed",
      occurredAt: "2026-09-01T00:00:00.000Z",
      nativeEventId: "native-tool-1",
      payload: { toolCallId: "tool-1", result: { output: "secretly useful" }, status: "completed" },
    }, context);
    const projection = projectWorkerEvent(event);

    expect(projection.eventClass).toBe("evidence");
    expect(projection.evidence.payload).toMatchObject({ result: { output: "secretly useful" } });
    expect(projection.activity).toMatchObject({ kind: "tool.completed", status: "completed" });
    expect(projection.activity).not.toHaveProperty("payload");
    expect(projection.activity).not.toHaveProperty("rawProvenance");
  });

  it("bounds and redacts the persisted payload while keeping provider data transient", () => {
    const large = {
      output: "x".repeat(1_000_000),
      apiKey: "sk-provider-secret-that-must-not-persist",
      entries: Array.from({ length: 300 }, (_, index) => ({ index })),
      evidence: { status: "completed", summary: "ordinary evidence survives" },
    };
    const bounded = boundWorkerEventRaw(large);
    expect(new TextEncoder().encode(JSON.stringify(bounded.value)).byteLength).toBeLessThanOrEqual(WORKER_EVENT_PERSISTED_MAX_BYTES);
    expect(bounded.truncated).toBe(true);
    expect(JSON.stringify(bounded.value)).not.toContain("sk-provider-secret");

    const event = normalizeWorkerEvent({ source: "driver", kind: "log", payload: large, context });
    expect(event.rawProvenance.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(event.payload)).byteLength).toBeLessThanOrEqual(WORKER_EVENT_PERSISTED_MAX_BYTES);
    expect(JSON.stringify(event)).not.toContain("sk-provider-secret");
    expect(event.payload).toMatchObject({ evidence: { status: "completed", summary: "ordinary evidence survives" } });
  });

  it("retains compatibility for events with no native or objective identity", () => {
    const first = normalizeWorkerEvent({
      source: "driver",
      kind: "run.failed",
      payload: { error: "failed" },
      context: { runId: "run-legacy", agentId: "agent-legacy" },
    });
    const second = normalizeWorkerEvent({
      source: "driver",
      kind: "run.failed",
      payload: { error: "failed" },
      context: { runId: "run-legacy", agentId: "agent-legacy" },
    });
    expect(first.attemptId).toBe("legacy:agent-legacy:run-legacy");
    expect(first.objectiveId).toBeNull();
    expect(first.eventId).toBe(second.eventId);
    expect(first.eventClass).toBe("error");
  });
});
