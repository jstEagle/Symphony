import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectiveRuntime, type ObjectiveRuntimeAuthority } from "../packages/workflow/src/objective-runtime.js";
import { ObjectiveStoreRepository } from "../packages/workflow/src/objective-store-repository.js";
import { ObjectiveSupervisor } from "../packages/workflow/src/objective-supervisor.js";
import { SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const authority: ObjectiveRuntimeAuthority = {
  actor: { type: "agent", id: "conductor" },
  permissionCeiling: "full-access",
};

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "symphony-objective-adapter-"));
  temporary.push(directory);
  const path = join(directory, "state.sqlite");
  const store = new SymphonyStore(path);
  const repository = new ObjectiveStoreRepository(store, { planAuthor: authority.actor });
  let sequence = 0;
  const runtime = new ObjectiveRuntime(repository, {
    id: () => `objective-id-${++sequence}`,
    now: () => `2026-09-01T00:00:0${++sequence}.000Z`,
  });
  return { path, store, repository, runtime };
}

function task(id: string, dependsOn: string[] = []) {
  return {
    id,
    objective: `Complete ${id}`,
    dependsOn,
    outputSchema: {},
    model: "auto",
    harness: "auto" as const,
    permissions: "read-only" as const,
    inputs: [],
    requiresApproval: false,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    runId: "objective-run-1",
    objectiveId: "objective-1",
    workflowId: "workflow-1",
    workflowRevision: 1,
    workflowHash: "workflow-hash-1",
    spec: {
      id: "objective-1",
      statement: "Ship the change and prove it works.",
      criteria: [{ id: "verified", description: "Verified", path: "verification.passed", op: "equals" as const, value: true }],
      approvalPolicy: { mode: "never" as const },
      maxReplans: 1,
    },
    requestKey: "create-request-1",
    ...overrides,
  };
}

describe("ObjectiveStoreRepository", () => {
  it("persists runs, initial plans, receipts, checkpoints, and replays after reopening", () => {
    const first = setup();
    const created = first.runtime.create(input({ tasks: [task("build"), task("verify", ["build"]) ] }), authority);
    expect(first.store.getObjectivePlanRevision(created.runId, 0)).toBeNull();

    const afterBuild = first.runtime.checkpoint(created.runId, {
      eventCursor: 3,
      taskUpdates: [{ taskId: "build", state: "completed" }],
      context: { verification: { passed: false } },
      reason: "Build completed.",
      requestKey: "checkpoint-request-1",
    }, authority);
    expect(afterBuild.state).toBe("executing");
    expect(first.store.listObjectiveCheckpoints(created.runId)).toHaveLength(1);
    first.store.close();

    const reopenedStore = new SymphonyStore(first.path);
    const reopenedRepository = new ObjectiveStoreRepository(reopenedStore, { planAuthor: authority.actor });
    const reopened = new ObjectiveRuntime(reopenedRepository, {
      id: () => "unused-id",
      now: () => "2026-09-01T00:00:09.000Z",
    });
    expect(reopened.get(created.runId)).toEqual(afterBuild);
    expect(reopened.create(input({ tasks: [task("build"), task("verify", ["build"]) ] }), authority)).toEqual(afterBuild);
    expect(reopened.checkpoint(created.runId, {
      eventCursor: 3,
      taskUpdates: [{ taskId: "build", state: "completed" }],
      context: { verification: { passed: false } },
      reason: "Build completed.",
      requestKey: "checkpoint-request-1",
    }, authority)).toEqual(afterBuild);
    reopenedStore.close();
  });

  it("atomically appends plan revisions and refuses foreign receipt collisions", () => {
    const { store, repository, runtime } = setup();
    const created = runtime.create(input({ tasks: [task("build")] }), authority);
    const revised = runtime.commitPlan(created.runId, {
      expectedPlanRevision: 0,
      tasks: [task("verify", ["build"])],
      requestKey: "plan-request-1",
    }, authority);
    expect(revised.activePlanRevision).toBe(1);
    expect(store.listObjectivePlanRevisions(created.runId).map((plan) => plan.planRevision)).toEqual([1]);

    store.claimCommandReceipt({
      idempotencyKey: "foreign-request-1",
      accepted: true,
      state: "settled",
      result: { otherCommand: true },
      createdAt: "2026-09-01T00:00:09.000Z",
    });
    expect(repository.getObjectiveActionReceipt("foreign-request-1")).toBeNull();
    const structuredReceipt = {
      requestKey: "structured-request-1",
      kind: "objective.checkpoint.commit" as const,
      fingerprint: "fingerprint-structured",
      result: { checkpointId: "checkpoint-1", evidence: ["event-1", "event-2"] },
      createdAt: "2026-09-01T00:00:10.000Z",
    };
    expect(repository.saveObjectiveActionReceipt(structuredReceipt)).toBe(true);
    expect(repository.getObjectiveActionReceipt(structuredReceipt.requestKey)).toEqual(structuredReceipt);
    expect(repository.saveObjectiveActionReceipt({
      requestKey: "foreign-request-1",
      kind: "objective.create",
      fingerprint: "fingerprint-1",
      result: "objective-run-1",
      createdAt: "2026-09-01T00:00:10.000Z",
    })).toBe(false);
    expect(store.getCommandReceipt("foreign-request-1")?.result).toEqual({ otherCommand: true });
    store.close();
  });

  it("replays an acknowledgement semantic event after a crash between commit and publication", () => {
    const first = setup();
    const created = first.runtime.create(input({ tasks: [task("build")] }), authority);
    const supervisor = new ObjectiveSupervisor(first.runtime, first.repository, {
      authority,
      // This models a process dying after SQLite commits the acknowledgement,
      // receipt, and outbox intent but before post-commit delivery starts.
      afterAcknowledgementCommit: () => { throw new Error("injected crash after acknowledgement commit"); },
    });
    const dispatch = supervisor.next(created.runId);
    expect(dispatch.kind).toBe("dispatch");
    if (dispatch.kind !== "dispatch") throw new Error("expected dispatch intent");
    const acknowledgement = {
      kind: "dispatch" as const,
      intentId: dispatch.intentId,
      requestKey: "objective-ack-crash-1",
      eventCursor: 0,
      taskUpdates: [{ taskId: "build", state: "completed" as const }],
    };
    expect(() => supervisor.acknowledge(created.runId, acknowledgement)).toThrow("injected crash");
    expect(first.store.getObjectiveRun(created.runId)?.state).toBe("replanning");
    expect(first.store.listObjectiveEventOutbox({ state: "pending" })).toHaveLength(1);
    expect(first.store.recentEvents({ runId: created.runId, types: ["objective.supervisor.acknowledged"] })).toHaveLength(0);

    first.store.close();
    const reopenedStore = new SymphonyStore(first.path);
    const reopenedRepository = new ObjectiveStoreRepository(reopenedStore, { planAuthor: authority.actor });
    const reopenedRuntime = new ObjectiveRuntime(reopenedRepository, { now: () => "2026-09-01T00:00:09.000Z" });
    const delivered: string[] = [];
    reopenedStore.onEvent((event) => {
      if (event.type === "objective.supervisor.acknowledged") delivered.push(event.id);
    });
    const restartedSupervisor = new ObjectiveSupervisor(reopenedRuntime, reopenedRepository, { authority });
    expect(restartedSupervisor.acknowledge(created.runId, acknowledgement).state).toBe("replanning");
    expect(reopenedStore.listObjectiveEventOutbox({ state: "pending" })).toHaveLength(0);
    expect(reopenedStore.listObjectiveEventOutbox({ state: "published" })).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(reopenedStore.recentEvents({ runId: created.runId, types: ["objective.supervisor.acknowledged"] })).toHaveLength(1);

    // A replayed acknowledgement is a no-op and cannot publish a duplicate.
    restartedSupervisor.acknowledge(created.runId, acknowledgement);
    expect(reopenedStore.recentEvents({ runId: created.runId, types: ["objective.supervisor.acknowledged"] })).toHaveLength(1);
    reopenedStore.close();
  });

  it("drains the complete semantic backlog in bounded batches", () => {
    const { store } = setup();
    store.durableTransaction(() => {
      for (let index = 0; index < 501; index += 1) {
        store.appendObjectiveEventIntent({
          eventKey: `objective-backlog-${index}`,
          eventId: `objective-backlog-event-${index}`,
          event: {
            type: "objective.test.backlog",
            workflowId: "workflow-1",
            runId: "objective-run-1",
            agentId: null,
            occurredAt: "2026-09-01T00:00:00.000Z",
            payload: { index },
            provenance: { source: "daemon" },
          },
        });
      }
    });
    expect(store.listObjectiveEventOutbox({ state: "pending", limit: 600 })).toHaveLength(501);
    expect(store.drainObjectiveEventOutbox({ batchSize: 7 })).toBe(501);
    expect(store.listObjectiveEventOutbox({ state: "pending" })).toHaveLength(0);
    expect(store.listObjectiveEventOutbox({ state: "published", limit: 600 })).toHaveLength(501);
    expect(store.recentEvents({ runId: "objective-run-1", types: ["objective.test.backlog"], limit: 600 })).toHaveLength(501);
    expect(store.drainObjectiveEventOutbox({ batchSize: 7 })).toBe(0);
    store.close();
  });

  it("publishes nested outbox events only after the outer transaction commits", () => {
    const { store } = setup();
    const eventKey = "objective-nested-publication-1";
    store.appendObjectiveEventIntent({
      eventKey,
      eventId: "objective-nested-publication-event-1",
      event: {
        type: "objective.test.nested-publication",
        workflowId: "workflow-1",
        runId: "objective-run-1",
        agentId: null,
        occurredAt: "2026-09-01T00:00:00.000Z",
        payload: { committed: true },
        provenance: { source: "daemon" },
      },
    });
    const published: string[] = [];
    store.onEvent((event) => {
      if (event.type === "objective.test.nested-publication") published.push(event.id);
    });

    store.durableTransaction(() => {
      expect(store.drainObjectiveEventOutbox({ batchSize: 1 })).toBe(1);
      expect(published).toEqual([]);
      expect(store.getObjectiveEventOutbox(eventKey)?.state).toBe("published");
    });

    expect(published).toEqual(["objective-nested-publication-event-1"]);
    store.close();
  });
});
