import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nowIso, type JsonValue } from "../packages/protocol/src/index.js";
import { SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function storeFixture(): { store: SymphonyStore; path: string } {
  const root = mkdtempSync(join(tmpdir(), "symphony-objective-command-ledger-"));
  temporary.push(root);
  const path = join(root, "symphony.sqlite");
  return { store: new SymphonyStore(path), path };
}

const input = {
  requestKey: "objective-command-ledger-1",
  operation: "objective.control.revise",
  fingerprint: "a".repeat(64),
  actor: { type: "user" as const, id: "local-user" },
  objectiveId: "objective-1",
  runId: "run-1",
};

describe("objective command ledger", () => {
  it("commits projection and receipt atomically, then replays after restart", () => {
    const { store, path } = storeFixture();
    let executions = 0;
    const first = store.executeObjectiveCommand(input, () => {
      executions += 1;
      store.setMetadata("objective-command-projection", { committed: true });
      return { status: "committed", result: { revision: 1 } };
    });

    expect(first.status).toBe("committed");
    expect(first.record.outcome).toEqual({ status: "committed", result: { revision: 1 } });
    expect(store.getMetadata("objective-command-projection")).toEqual({ committed: true });
    store.close();

    const restarted = new SymphonyStore(path);
    const replay = restarted.executeObjectiveCommand(input, () => {
      executions += 1;
      throw new Error("replay must not execute the command");
    });
    expect(replay.status).toBe("replayed");
    expect(replay.result).toEqual({ revision: 1 });
    expect(executions).toBe(1);
    restarted.close();
  });

  it("returns a conflict for a request key bound to different evidence", () => {
    const { store } = storeFixture();
    store.executeObjectiveCommand(input, () => ({ status: "committed", result: null }));
    const conflict = store.executeObjectiveCommand({ ...input, fingerprint: "b".repeat(64) }, () => ({
      status: "committed",
      result: { unexpected: true },
    }));
    expect(conflict.status).toBe("conflict");
    expect(conflict.reason).toContain("different immutable evidence");
    expect(conflict.record.outcome).toEqual({ status: "committed", result: null });
    store.close();
  });

  it("persists rejected outcomes and replays them without rerunning", () => {
    const { store } = storeFixture();
    let executions = 0;
    const rejected = store.executeObjectiveCommand(input, () => {
      executions += 1;
      return { status: "rejected", result: { currentRevision: 4 }, reason: "stale compare-and-swap revision" };
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toBe("stale compare-and-swap revision");
    const replay = store.executeObjectiveCommand(input, () => {
      executions += 1;
      return { status: "committed", result: null };
    });
    expect(replay.status).toBe("rejected");
    expect(replay.result).toEqual({ currentRevision: 4 });
    expect(executions).toBe(1);
    store.close();
  });

  it("fails closed as unknown when the projection callback throws", () => {
    const { store } = storeFixture();
    const failed = store.executeObjectiveCommand(input, () => {
      store.setMetadata("must-roll-back", { written: true });
      throw new Error("projection process stopped after an uncertain boundary");
    });
    expect(failed.status).toBe("unknown");
    expect(failed.result).toBeNull();
    expect(failed.record.outcome.status).toBe("unknown");
    expect(store.getMetadata("must-roll-back")).toBeNull();

    const replay = store.executeObjectiveCommand(input, () => {
      throw new Error("unknown outcomes must not be guessed or retried");
    });
    expect(replay.status).toBe("unknown");
    expect(replay.reason).toContain("projection process stopped");
    store.close();
  });

  it("keeps the committed ledger when post-commit event delivery fails", () => {
    const { store } = storeFixture();
    store.onEvent(() => {
      throw new Error("simulated SSE listener failure");
    });
    const committed = store.executeObjectiveCommand(input, () => {
      store.appendEvent({
        type: "objective.control-plan.changed",
        workflowId: "workflow-1",
        runId: input.runId,
        agentId: null,
        occurredAt: nowIso(),
        payload: { requestKey: input.requestKey } as JsonValue,
        provenance: { source: "daemon" },
      });
      return { status: "committed", result: { event: "durable" } };
    });
    expect(committed.status).toBe("replayed");
    expect(committed.record.outcome).toEqual({ status: "committed", result: { event: "durable" } });
    expect(store.getObjectiveCommandLedger(input.requestKey)?.outcome.status).toBe("committed");
    expect(store.latestCursor()).toBe(1);
    store.close();
  });
});
