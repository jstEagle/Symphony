import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKER_EVENT_PERSISTED_MAX_BYTES,
  type JsonValue,
} from "../packages/protocol/src/index.js";
import { SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe("worker event persistence boundary", () => {
  it("stores and reloads a bounded, redacted provider projection", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-worker-event-"));
    temporary.push(directory);
    const store = new SymphonyStore(join(directory, "state.sqlite"));
    const payload = {
      text: "ordinary evidence survives",
      authorization: "Bearer provider-secret",
      output: "x".repeat(1_000_000),
      nested: { client_secret: "another-secret", status: "completed" },
    } as unknown as JsonValue;
    const event = store.appendEvent({
      type: "driver.output.completed",
      workflowId: "workflow-1",
      runId: "run-1",
      agentId: "agent-1",
      occurredAt: new Date().toISOString(),
      payload,
      provenance: {
        source: "driver",
        driver: "codex",
        rawProvenance: {
          source: "worker-host",
          stream: "stdout",
          kind: "worker-host.stdout",
          cursor: 1,
          nativeEventId: null,
          payload,
          truncated: false,
        },
      },
    });

    const serialized = JSON.stringify(event);
    expect(new TextEncoder().encode(JSON.stringify(event.payload)).byteLength).toBeLessThanOrEqual(WORKER_EVENT_PERSISTED_MAX_BYTES);
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("another-secret");
    expect(event.payload).toMatchObject({ text: "ordinary evidence survives", nested: { status: "completed" } });

    const reloaded = store.eventsAfter(0, { limit: 1 })[0];
    expect(reloaded).toEqual(event);
    expect(JSON.stringify(reloaded)).not.toContain("provider-secret");
    store.close();
  });
});
