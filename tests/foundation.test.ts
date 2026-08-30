import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkOrderSchema, resolveChildPermission, type EventEnvelope } from "../packages/protocol/src/index.js";
import { SymphonyStore, type AgentListCursor } from "../packages/storage/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("protocol and durable storage", () => {
  it("defaults agents to full access but never widens a read-only parent", () => {
    const order = AgentWorkOrderSchema.parse({
      workflowId: "workflow",
      runId: "run",
      depth: 0,
      mission: { id: "mission", revision: 1, hash: "12345678", statement: "Ship the feature." },
      objective: "Implement the bounded change and verify it.",
      outputSchema: { type: "object" },
      workspace: { path: "/tmp" },
    });
    expect(order.permissions).toBe("full-access");
    expect(resolveChildPermission("read-only", "full-access")).toBe("read-only");
    expect(resolveChildPermission("full-access")).toBe("full-access");
  });

  it("persists monotonic events, idempotent receipts, and chat groups", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-store-"));
    temporary.push(directory);
    const store = new SymphonyStore(join(directory, "state.sqlite"));
    const synchronousMode = () => Number(Object.values(store.database.prepare("PRAGMA synchronous").get() ?? {})[0]);
    expect(synchronousMode()).toBe(1);
    store.durableTransaction(() => store.setMetadata("durable-fence", { accepted: true }));
    expect(store.getMetadata("durable-fence")).toEqual({ accepted: true });
    expect(synchronousMode()).toBe(1);
    expect(() => store.durableTransaction(() => { throw new Error("rollback"); })).toThrow("rollback");
    expect(synchronousMode()).toBe(1);
    const first = store.appendEvent({ type: "test.first", workflowId: null, runId: null, agentId: "agent-a", occurredAt: new Date().toISOString(), payload: { value: 1 }, provenance: { source: "daemon" } });
    const second = store.appendEvent({ type: "test.second", workflowId: null, runId: null, agentId: "agent-b", occurredAt: new Date().toISOString(), payload: { value: 2 }, provenance: { source: "daemon" } });
    expect(second.cursor).toBe(first.cursor + 1);
    expect(store.eventsAfter(first.cursor)).toHaveLength(1);
    expect(store.eventsAfter(0, { types: ["test.second"] }).map((event) => event.id)).toEqual([second.id]);
    expect(store.recentEvents({ types: ["test.first"], limit: 1 }).map((event) => event.id)).toEqual([first.id]);
    expect(store.recentEvents({ agentId: "agent-a", limit: 1 }).map((event) => event.id)).toEqual([first.id]);
    store.saveCommandReceipt({ idempotencyKey: "same-command", accepted: true, state: "settled", result: { ok: true }, createdAt: new Date().toISOString() });
    store.saveCommandReceipt({ idempotencyKey: "same-command", accepted: false, state: "settled", result: { ok: false }, createdAt: new Date().toISOString() });
    expect(store.getCommandReceipt("same-command")?.accepted).toBe(true);
    expect(store.claimCommandReceipt({ idempotencyKey: "same-command", accepted: false, state: "dispatching", result: {}, createdAt: new Date().toISOString() })).toBe(false);
    const replacement = { idempotencyKey: "replacement-command", accepted: false, state: "dispatching" as const, result: {}, createdAt: new Date().toISOString() };
    expect(store.claimCommandReceipt(replacement)).toBe(true);
    store.replaceCommandReceipt({ ...replacement, accepted: true, state: "settled", result: { ok: true }, updatedAt: new Date().toISOString() });
    expect(store.getCommandReceipt("replacement-command")).toMatchObject({ accepted: true, state: "settled", result: { ok: true } });
    const nativeEvent = { agentId: "agent-a", eventKind: "tool.started", nativeEventId: "native-tool-1" };
    expect(store.claimNativeDriverEvent(nativeEvent)).toBe(true);
    expect(store.claimNativeDriverEvent(nativeEvent)).toBe(false);
    expect(store.claimNativeDriverEvent({ ...nativeEvent, eventKind: "tool.completed" })).toBe(true);
    store.saveThread({ id: "thread", title: "Grouped chat", groupId: "project", conductorAgentId: null, mission: {}, workspacePath: directory, archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    expect(store.listThreads({ groupId: "project" })).toHaveLength(1);
    store.close();
    const reopened = new SymphonyStore(join(directory, "state.sqlite"));
    expect(reopened.claimNativeDriverEvent(nativeEvent)).toBe(false);
    reopened.appendEvent({
      type: "driver.tool.started",
      workflowId: null,
      runId: null,
      agentId: "legacy-agent",
      occurredAt: new Date().toISOString(),
      payload: { toolCallId: "legacy-tool" },
      provenance: { source: "driver", driver: "codex", nativeEventId: "legacy-native-tool" },
    });
    reopened.database.exec("DROP TABLE native_driver_events; DELETE FROM schema_migrations WHERE version = 5;");
    reopened.close();
    const migrated = new SymphonyStore(join(directory, "state.sqlite"));
    expect(migrated.claimNativeDriverEvent({
      agentId: "legacy-agent",
      eventKind: "tool.started",
      nativeEventId: "legacy-native-tool",
    })).toBe(false);
    migrated.close();
  });

  it("publishes only committed events to listeners and preserves cursor order during reentrant delivery", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-store-events-"));
    temporary.push(directory);
    const store = new SymphonyStore(join(directory, "state.sqlite"));
    const seen: EventEnvelope[] = [];
    let everyDeliveredEventWasCommitted = true;
    const occurredAt = new Date().toISOString();
    const stop = store.onEvent((event) => {
      seen.push(event);
      everyDeliveredEventWasCommitted &&= store.eventsAfter(event.cursor - 1).some((stored) => stored.id === event.id);
      if (event.type === "test.transaction.first") {
        store.appendEvent({
          type: "test.transaction.reentrant",
          workflowId: null,
          runId: null,
          agentId: null,
          occurredAt,
          payload: {},
        });
      }
    });

    expect(() => store.transaction(() => {
      store.appendEvent({
        type: "test.transaction.rolled-back",
        workflowId: null,
        runId: null,
        agentId: null,
        occurredAt,
        payload: {},
      });
      expect(seen).toEqual([]);
      throw new Error("rollback event");
    })).toThrow("rollback event");
    expect(seen).toEqual([]);
    expect(store.eventsAfter(0, { types: ["test.transaction.rolled-back"] })).toEqual([]);

    store.transaction(() => {
      store.appendEvent({
        type: "test.transaction.first",
        workflowId: null,
        runId: null,
        agentId: null,
        occurredAt,
        payload: {},
      });
      store.transaction(() => store.appendEvent({
        type: "test.transaction.second",
        workflowId: null,
        runId: null,
        agentId: null,
        occurredAt,
        payload: {},
      }));
      expect(seen).toEqual([]);
    });

    expect(everyDeliveredEventWasCommitted).toBe(true);
    expect(seen.map((event) => event.type)).toEqual([
      "test.transaction.first",
      "test.transaction.second",
      "test.transaction.reentrant",
    ]);
    expect(seen.map((event) => event.cursor)).toEqual([...seen].map((event) => event.cursor).sort((a, b) => a - b));
    stop();
    store.close();
  });

  it("paginates agents deterministically when their update timestamps are identical", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-store-agent-pages-"));
    temporary.push(directory);
    const store = new SymphonyStore(join(directory, "state.sqlite"));
    const timestamp = new Date().toISOString();
    for (let index = 0; index < 7; index += 1) {
      const id = `agent-${String(index).padStart(2, "0")}`;
      store.saveAgent({
        id,
        logicalAgentId: `logical-${id}`,
        workflowId: "workflow",
        runId: "run",
        parentAgentId: null,
        depth: 0,
        objective: `Exercise agent page ${index}.`,
        missionHash: "12345678",
        requestedHarness: "codex",
        requestedModel: "fixture",
        harness: "codex",
        model: "fixture",
        permissions: "read-only",
        status: "completed",
        nativeSessionId: `native-${id}`,
        nativeRunId: `native-run-${id}`,
        workspacePath: directory,
        output: {},
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        finishedAt: timestamp,
      });
    }

    const ids: string[] = [];
    let cursor: AgentListCursor | undefined;
    do {
      const page = store.listAgentPage({ limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.agents.length).toBeLessThanOrEqual(3);
      ids.push(...page.agents.map((agent) => agent.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(ids).toEqual(["agent-06", "agent-05", "agent-04", "agent-03", "agent-02", "agent-01", "agent-00"]);
    expect(new Set(ids).size).toBe(7);
    store.close();
  });
});
