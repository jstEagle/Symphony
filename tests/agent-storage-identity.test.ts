import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRecordSchema, nowIso } from "../packages/protocol/src/index.js";
import { createStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function makeAgent() {
  const timestamp = nowIso();
  return AgentRecordSchema.parse({
    id: "agent-storage-identity",
    logicalAgentId: "attempt-storage-identity",
    workflowId: "workflow-storage-identity",
    runId: "run-storage-identity",
    parentAgentId: null,
    depth: 0,
    objective: "Exercise immutable agent storage identity.",
    missionHash: "mission-storage-identity",
    requestedHarness: "codex",
    requestedModel: "fixture",
    harness: null,
    model: null,
    permissions: "read-only",
    status: "queued",
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: process.cwd(),
    output: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
  });
}

describe("agent storage identity", () => {
  it("rejects stale or hostile identity replacement while allowing lifecycle/session updates", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-agent-storage-identity-"));
    temporary.push(root);
    const store = createStore(join(root, "symphony.sqlite"));
    const initial = makeAgent();
    store.saveAgent(initial);

    expect(() => store.saveAgent({
      ...initial,
      workflowId: "foreign-workflow",
      runId: "foreign-run",
      parentAgentId: "foreign-parent",
      depth: 1,
      missionHash: "forged-mission",
      workspacePath: root,
      createdAt: "2020-01-01T00:00:00.000Z",
      status: "completed",
    })).toThrow(/immutable/);
    expect(store.getAgent(initial.id)).toEqual(initial);

    const running = {
      ...initial,
      status: "running" as const,
      harness: "codex" as const,
      model: "fixture",
      nativeSessionId: "native-session-1",
      nativeRunId: "native-run-1",
      output: { progress: true },
      updatedAt: nowIso(),
      startedAt: nowIso(),
    };
    store.saveAgent(running);
    expect(store.getAgent(initial.id)).toMatchObject({
      logicalAgentId: initial.logicalAgentId,
      workflowId: initial.workflowId,
      runId: initial.runId,
      status: "running",
      nativeSessionId: "native-session-1",
      output: { progress: true },
    });
    store.close();
  });
});
