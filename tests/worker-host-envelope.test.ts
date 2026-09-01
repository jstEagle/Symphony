import { describe, expect, it } from "vitest";
import { normalizeWorkerHostFrame, type WorkerHostFrame } from "../apps/worker-host/src/index.js";

describe("worker-host canonical event boundary", () => {
  it("normalizes a spool cursor while retaining only bounded raw provenance", () => {
    const frame: WorkerHostFrame = {
      seq: 12,
      stream: "stdout",
      payload: { data: JSON.stringify({ type: "native.update", text: "hello" }) },
      occurredAt: "2026-09-01T00:00:00.000Z",
    };
    const event = normalizeWorkerHostFrame(frame, {
      objectiveId: "objective-1",
      runId: "run-1",
      attemptId: "attempt-1",
      agentId: "agent-1",
      nativeSessionId: "session-1",
      leaseId: "lease-1",
    });
    expect(event).toMatchObject({
      eventClass: "activity",
      kind: "worker-host.stdout",
      cursor: 12,
      timestamp: "2026-09-01T00:00:00.000Z",
      objectiveId: "objective-1",
      runId: "run-1",
      attemptId: "attempt-1",
      agentId: "agent-1",
      nativeSessionId: "session-1",
      leaseId: "lease-1",
      replayKey: "worker-host:lease-1:12",
    });
    expect(event.rawProvenance).toMatchObject({ source: "worker-host", stream: "stdout", cursor: 12 });
  });

  it("marks a failed native exit as error evidence", () => {
    const event = normalizeWorkerHostFrame({
      seq: 2,
      stream: "exit",
      payload: { code: 1, signal: null },
      occurredAt: "2026-09-01T00:00:00.000Z",
    }, { runId: "run-1", agentId: "agent-1", leaseId: "lease-1" });
    expect(event.eventClass).toBe("error");
    expect(event.kind).toBe("worker-host.exit");
  });
});
