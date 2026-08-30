import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkOrderSchema, resolveChildPermission } from "../packages/protocol/src/index.js";
import { SymphonyStore } from "../packages/storage/src/index.js";

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
    const first = store.appendEvent({ type: "test.first", workflowId: null, runId: null, agentId: null, occurredAt: new Date().toISOString(), payload: { value: 1 }, provenance: { source: "daemon" } });
    const second = store.appendEvent({ type: "test.second", workflowId: null, runId: null, agentId: null, occurredAt: new Date().toISOString(), payload: { value: 2 }, provenance: { source: "daemon" } });
    expect(second.cursor).toBe(first.cursor + 1);
    expect(store.eventsAfter(first.cursor)).toHaveLength(1);
    expect(store.eventsAfter(0, { types: ["test.second"] }).map((event) => event.id)).toEqual([second.id]);
    expect(store.recentEvents({ types: ["test.first"], limit: 1 }).map((event) => event.id)).toEqual([first.id]);
    store.saveCommandReceipt({ idempotencyKey: "same-command", accepted: true, result: { ok: true }, createdAt: new Date().toISOString() });
    store.saveCommandReceipt({ idempotencyKey: "same-command", accepted: false, result: { ok: false }, createdAt: new Date().toISOString() });
    expect(store.getCommandReceipt("same-command")?.accepted).toBe(true);
    store.saveThread({ id: "thread", title: "Grouped chat", groupId: "project", conductorAgentId: null, mission: {}, workspacePath: directory, archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    expect(store.listThreads({ groupId: "project" })).toHaveLength(1);
    store.close();
  });
});
