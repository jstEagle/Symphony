import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ObjectiveAggregateRecordSchema,
  ObjectiveRevisionRecordSchema,
  ObjectiveRunOccurrenceRecordSchema,
  ObjectiveRunRecordSchema,
} from "../packages/protocol/src/index.js";
import { createStore } from "../packages/storage/src/index.js";
import { startDaemon } from "../apps/daemon/src/index.js";

const temporary: string[] = [];
const timestamp = "2026-09-01T00:00:00.000Z";

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function objectiveRun(state: "executing" | "succeeded" = "executing") {
  return ObjectiveRunRecordSchema.parse({
    version: 1,
    runId: "run-1",
    objectiveId: "objective-1",
    objectiveRevision: 1,
    workflowId: "manual-objective-1@1",
    workflowRevision: 1,
    workflowHash: "manual-workflow-objective-1",
    conductorAgentId: null,
    spec: { id: "objective-1", statement: "Ship the objective.", criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 1 },
    state,
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [],
    context: {},
    output: state === "succeeded" ? { ok: true } : null,
    error: null,
    requestKey: "objective-create-1",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: state === "succeeded" ? timestamp : null,
  });
}

describe("objective aggregate storage", () => {
  it("keeps immutable revisions and run occurrences above compatible run records", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-objective-aggregate-"));
    temporary.push(root);
    const store = createStore(join(root, ".symphony"));
    const aggregate = ObjectiveAggregateRecordSchema.parse({
      version: 1,
      id: "objective:objective-1",
      objectiveId: "objective-1",
      activeRevision: 1,
      state: "active",
      latestRunId: null,
      latestOutcome: null,
      workspace: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const revision = ObjectiveRevisionRecordSchema.parse({
      version: 1,
      id: "objective-revision:objective-1:1",
      objectiveId: "objective-1",
      revision: 1,
      spec: objectiveRun().spec,
      workspace: null,
      createdBy: { type: "user", id: "local-user" },
      requestKey: "objective-create-1",
      createdAt: timestamp,
    });
    const occurrence = ObjectiveRunOccurrenceRecordSchema.parse({
      version: 1,
      id: "objective-occurrence:run-1",
      objectiveId: "objective-1",
      runId: "run-1",
      objectiveRevision: 1,
      kind: "recurring",
      occurrenceKey: "daily:2026-09-01",
      triggerId: "daily",
      parentOccurrenceId: null,
      parentRunId: null,
      forkedFromOccurrenceId: null,
      forkedFromRunId: null,
      supersedesOccurrenceId: null,
      supersedesRunId: null,
      input: { date: "2026-09-01" },
      outcome: "running",
      output: null,
      error: null,
      scheduledAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    store.durableTransaction(() => {
      expect(store.saveObjectiveAggregate(aggregate)).toBe(true);
      expect(store.saveObjectiveRevision(revision)).toBe(true);
      expect(store.saveObjectiveRun(objectiveRun())).toBe(true);
      expect(store.saveObjectiveRunOccurrence(occurrence)).toBe(true);
      store.appendEvent({ type: "objective.created", workflowId: "manual-objective-1@1", runId: "run-1", agentId: null, occurredAt: timestamp, payload: { objectiveId: "objective-1" }, provenance: { source: "daemon" } });
    });

    expect(store.saveObjectiveRevision(revision)).toBe(false);
    expect(store.saveObjectiveRunOccurrence(occurrence)).toBe(false);
    const snapshot = store.objectiveAggregateSnapshot("objective-1");
    expect(snapshot).toMatchObject({
      objective: { objectiveId: "objective-1", activeRevision: 1, latestRunId: "run-1", latestOutcome: "running" },
      revisions: [{ revision: 1 }],
      occurrences: [{ kind: "recurring", occurrenceKey: "daily:2026-09-01" }],
      currentRuns: [{ runId: "run-1", objectiveRevision: 1 }],
      eventCursor: 1,
    });
    expect(snapshot?.events).toHaveLength(1);
    expect(snapshot?.attempts).toEqual([]);
    expect(snapshot?.budgets).toEqual({ ledgers: [], reservations: [], debits: [] });

    store.updateObjectiveRun({ ...objectiveRun("succeeded"), updatedAt: "2026-09-01T00:01:00.000Z", finishedAt: "2026-09-01T00:01:00.000Z" }, { expectedActivePlanRevision: 0 });
    expect(store.objectiveAggregateSnapshot("objective-1")?.objective).toMatchObject({ state: "achieved", latestOutcome: "succeeded" });
    store.close();

    const restarted = createStore(join(root, ".symphony"));
    expect(restarted.objectiveAggregateSnapshot("objective-1")?.revisions).toHaveLength(1);
    expect(restarted.getObjectiveRunOccurrence("run-1")?.outcome).toBe("succeeded");
    restarted.close();
  });

  it("admits independent runs under one aggregate and serves one fenced snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-objective-aggregate-api-"));
    temporary.push(root);
    const portServer = createServer();
    await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const address = portServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const config = {
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      conductor: { harness: "codex", model: "fixture" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", recoveryTimeoutMs: 1_000 },
      harnesses: { codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false }, opencode: { enabled: false }, pi: { enabled: false }, acp: [] },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" }, plugins: { watch: false }, workflows: { triggersEnabled: false },
    };
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(join(root, "symphony.config.json"), JSON.stringify(config)));
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    const base = `http://127.0.0.1:${port}`;
    const create = async (key: string, runId: string, statement: string, occurrence: Record<string, unknown>) => fetch(`${base}/v1/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ runId, workflowId: "manual-objective-aggregate-api", workflowRevision: 1, workflowHash: "manual-workflow-objective-aggregate-api", spec: { id: "objective-aggregate-api", statement, criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 1 }, occurrence }),
    });
    try {
      const first = await create("aggregate-create-1", "aggregate-run-1", "Keep the objective durable.", { kind: "recurring", occurrenceKey: "daily:1", triggerId: "daily" });
      expect(first.status).toBe(201);
      expect((await create("aggregate-create-2", "aggregate-run-2", "Keep the objective durable.", { kind: "fork", forkedFromRunId: "aggregate-run-1" })).status).toBe(201);
      expect((await create("aggregate-create-3", "aggregate-run-3", "Keep the objective more durable.", { kind: "supersede", supersedesRunId: "aggregate-run-2" })).status).toBe(201);
      const response = await fetch(`${base}/v1/objectives/objective-aggregate-api/snapshot`);
      expect(response.status).toBe(200);
      const snapshot = await response.json() as {
        eventCursor: number;
        objective: { activeRevision: number; statement?: string };
        revisions: Array<{ revision: number }>;
        occurrences: Array<{ kind: string; objectiveRevision: number }>;
        runs: Array<{ runId: string; objectiveRevision?: number }>;
        currentRuns: unknown[];
        frontierProjection: { eventCursor: number; runs: Array<{ runId: string }>; counts: { total: number }; summary: string };
        runline: { eventCursor: number; runs: Array<{ runId: string }>; summary: string };
      };
      expect(snapshot.eventCursor).toBeGreaterThan(0);
      expect(snapshot.objective).toMatchObject({ activeRevision: 2, statement: "Keep the objective more durable." });
      expect(snapshot.revisions.map((entry) => entry.revision)).toEqual([1, 2]);
      expect(snapshot.occurrences.map((entry) => entry.kind)).toEqual(["recurring", "fork", "supersede"]);
      expect(snapshot.runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: "aggregate-run-1", objectiveRevision: 1 }),
        expect.objectContaining({ runId: "aggregate-run-3", objectiveRevision: 2 }),
      ]));
      expect(snapshot.currentRuns).toHaveLength(3);
      expect(snapshot.frontierProjection.eventCursor).toBe(snapshot.eventCursor);
      expect(snapshot.frontierProjection.runs.map((entry) => entry.runId)).toEqual([
        "aggregate-run-1", "aggregate-run-2", "aggregate-run-3",
      ]);
      expect(snapshot.frontierProjection.counts.total).toBe(0);
      expect(snapshot.frontierProjection.summary).toContain("No executable work");
      expect(snapshot.runline.eventCursor).toBe(snapshot.eventCursor);
      expect(snapshot.runline.runs.map((entry) => entry.runId)).toEqual([
        "aggregate-run-1", "aggregate-run-2", "aggregate-run-3",
      ]);
    } finally {
      await daemon.close();
    }
  });
});
