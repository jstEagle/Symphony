import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ObjectiveAttentionRecordSchema,
  type ObjectiveAttentionRecord,
  type ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { ObjectiveAttentionRegistry, SymphonyStore } from "../packages/storage/src/index.js";

const roots: string[] = [];
const timestamp = "2026-09-01T00:00:00.000Z";

function makeStore(): SymphonyStore {
  const root = mkdtempSync(join(tmpdir(), "symphony-attention-"));
  roots.push(root);
  return new SymphonyStore(join(root, "state.sqlite"));
}

function run(runId: string, objectiveId = runId): ObjectiveRunRecord {
  return {
    version: 1,
    runId,
    objectiveId,
    workflowId: "attention-workflow",
    workflowRevision: 1,
    workflowHash: "attention-workflow-hash",
    conductorAgentId: "conductor-1",
    spec: { id: objectiveId, statement: "Test durable attention.", criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 1 },
    state: "executing",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [],
    context: {},
    output: null,
    error: null,
    requestKey: `${runId}-request`,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
  };
}

function attention(runId: string, objectiveId = runId, id = `attention-${runId}`): ObjectiveAttentionRecord {
  return ObjectiveAttentionRecordSchema.parse({
    version: 1,
    id,
    operationId: `${id}-operation`,
    objectiveId,
    runId,
    nodeId: "node-1",
    attemptId: "attempt-1",
    reason: "A protected boundary was reached.",
    consequence: "Work cannot continue until the choice is recorded.",
    risk: "high",
    urgency: "high",
    confidence: 0.9,
    blockedResource: { kind: "workspace", id: "/repo" },
    proposedAction: "Allow the bounded local operation.",
    alternatives: ["Reject and stop", { id: "wait", label: "Wait", consequence: "The run remains blocked." }],
    authorityBoundary: { permission: "full-access", sideEffectClass: "local", capability: "write", resource: "/repo", description: "Write authority is outside the current grant." },
    evidenceRefs: [{ kind: "event", id: "event-1", cursor: 1 }],
    assignee: { type: "user", id: "local-user" },
    expiresAt: null,
    escalation: { at: null, to: null, policy: "none", reason: null },
    status: "open",
    resolution: null,
    requestKey: `${id}-request`,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable objective attention registry", () => {
  it("is idempotent, rejects stale settlement, and isolates objective bindings", () => {
    const store = makeStore();
    store.saveObjectiveRun(run("run-a", "objective-a"));
    store.saveObjectiveRun(run("run-b", "objective-b"));
    const first = attention("run-a", "objective-a");
    expect(store.saveObjectiveAttention(first)).toBe(true);
    expect(store.saveObjectiveAttention(first)).toBe(false);
    expect(() => store.saveObjectiveAttention({ ...first, reason: "forged" })).toThrow(/idempotency conflict|immutable/);

    const registry = new ObjectiveAttentionRegistry(store);
    const resolved = registry.resolve("run-a", first.id, {
      request: { status: "resolved", decision: { approved: true }, evidenceRefs: [] },
      resolvedBy: { type: "user", id: "local-user" },
      now: "2026-09-01T00:00:01.000Z",
      requestKey: "resolve-run-a-1",
    });
    expect(resolved.resolution?.requestKey).toBe("resolve-run-a-1");
    expect(() => registry.resolve("run-a", first.id, {
      request: { status: "cancelled", evidenceRefs: [] },
      resolvedBy: { type: "user", id: "local-user" },
      now: "2026-09-01T00:00:02.000Z",
      requestKey: "resolve-run-a-2",
    })).toThrow(/already resolved/);
    expect(store.getObjectiveAttention(first.id, "run-b")).toBeNull();
    store.close();
  });

  it("expires due records durably and survives a store restart", () => {
    const store = makeStore();
    store.saveObjectiveRun(run("run-expiry", "objective-expiry"));
    const item = ObjectiveAttentionRecordSchema.parse({ ...attention("run-expiry", "objective-expiry"), expiresAt: "2026-09-01T00:00:05.000Z" });
    store.saveObjectiveAttention(item);
    const registry = new ObjectiveAttentionRegistry(store);
    expect(registry.expire("2026-09-01T00:00:04.000Z")).toHaveLength(0);
    expect(registry.expire("2026-09-01T00:00:05.000Z")).toHaveLength(1);
    expect(store.getObjectiveAttention(item.id)?.status).toBe("expired");
    const path = store.path;
    store.close();
    const reopened = new SymphonyStore(path);
    expect(reopened.getObjectiveAttention(item.id)?.resolution?.status).toBe("expired");
    expect(reopened.listObjectiveAttentions({ status: ["expired"] })).toHaveLength(1);
    reopened.close();
  });

  it("orders the global inbox by consequence before applying its page limit", () => {
    const store = makeStore();
    store.saveObjectiveRun(run("run-order"));
    const low = attention("run-order", "run-order", "attention-low");
    const critical = ObjectiveAttentionRecordSchema.parse({
      ...attention("run-order", "run-order", "attention-critical"),
      risk: "critical",
      urgency: "critical",
      createdAt: "2026-09-01T00:01:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
    });
    store.saveObjectiveAttention(low);
    store.saveObjectiveAttention(critical);
    expect(store.listObjectiveAttentions({ runId: "run-order", limit: 1 })[0]?.id).toBe("attention-critical");
    store.close();
  });
});
