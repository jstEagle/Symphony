import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  AgentMessageInputSchema,
  AgentMessageReceiptInputSchema,
} from "../packages/protocol/src/agent-message.js";
import { AgentMessageStore } from "../packages/storage/src/agent-message.js";
import { AgentMessageBus } from "../packages/workflow/src/agent-message-bus.js";

const createdAt = "2026-09-01T00:00:00.000Z";

function message(requestKey: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    requestKey,
    kind: "finding" as const,
    senderId: "agent:researcher",
    recipientId: "agent:conductor",
    parentId: "parent:1",
    parentAgentId: "agent:conductor",
    objectiveId: "objective:1",
    runId: "run:1",
    attemptId: "attempt:1",
    correlationId: null,
    replyToId: null,
    payload: { claim: "A durable result" },
    summary: "A semantic finding",
    artifactRefs: [{ id: "artifact:1", hash: null, mediaType: "text/plain", uri: null }],
    evidenceRefs: [{ id: "event:1", kind: "event", hash: null, cursor: 7, uri: null }],
    createdAt,
    expiresAt: null,
    ...overrides,
  };
}

describe("agent message protocol", () => {
  it("accepts all typed kinds and rejects transcript-shaped fields", () => {
    for (const kind of ["finding", "question", "status", "handoff", "control-request"] as const) {
      expect(AgentMessageInputSchema.parse(message(`request:${kind}`, { kind })).kind).toBe(kind);
    }
    expect(() => AgentMessageInputSchema.parse(message("request:transcript", { transcript: [{ role: "assistant" }] }))).toThrow();
    expect(() => AgentMessageReceiptInputSchema.parse({
      version: 1,
      requestKey: "receipt:missing-decision",
      messageId: "message:1",
      recipientId: "agent:conductor",
      kind: "handled",
      state: "handled",
      reason: null,
      decision: null,
      recordedAt: createdAt,
    })).toThrow(/explicit parent decision/);
  });
});
describe("durable agent message storage", () => {
  it("uses immutable sequence/cursor records and idempotent replay/conflict", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-agent-message-"));
    const path = join(directory, "messages.sqlite");
    const store = new AgentMessageStore(path);
    try {
      const first = store.append(message("request:1"));
      expect(first.status).toBe("committed");
      expect(first.message?.sequence).toBe(1);
      expect(first.message?.cursor).toBe(1);
      const replay = store.append(message("request:1"));
      expect(replay.status).toBe("replayed");
      expect(replay.message?.id).toBe(first.message?.id);
      const conflict = store.append(message("request:1", { payload: { changed: true } }));
      expect(conflict.status).toBe("conflict");
      const second = store.append(message("request:2", { kind: "question", id: "message:2" }));
      expect(second.status).toBe("committed");
      expect(second.message?.sequence).toBe(2);
      expect(store.messagesAfter(0).map((record) => record.cursor)).toEqual([1, 2]);
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM agent_bus_messages").get()).toMatchObject({ count: 2 });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists explicit unknown delivery, receipt transitions, cancellation, and expiry across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-agent-message-restart-"));
    const path = join(directory, "messages.sqlite");
    const store = new AgentMessageStore(path);
    const first = store.append(message("request:restart", {
      id: "message:restart",
      expiresAt: "2026-09-01T00:10:00.000Z",
    }));
    expect(first.message).not.toBeNull();
    const unknown = store.markDeliveryUnknown("message:restart", {
      version: 1,
      requestKey: "receipt:unknown",
      recipientId: "agent:conductor",
      actorId: "agent:conductor",
      recordedAt: "2026-09-01T00:01:00.000Z",
      reason: "The daemon stopped after dispatch; provider outcome is unknown.",
      decision: null,
    });
    expect(unknown.status).toBe("committed");
    expect(store.messageState("message:restart")).toBe("unknown");
    store.close();

    const restarted = new AgentMessageStore(path);
    try {
      const delivered = restarted.markDelivered("message:restart", {
        version: 1,
        requestKey: "receipt:reconciled",
        recipientId: "agent:conductor",
        actorId: "agent:conductor",
        recordedAt: "2026-09-01T00:02:00.000Z",
        reason: "Provider status query proved delivery.",
        decision: null,
      });
      expect(delivered.status).toBe("committed");
      expect(restarted.markRead("message:restart", {
        version: 1,
        requestKey: "receipt:read",
        recipientId: "agent:conductor",
        actorId: "agent:conductor",
        recordedAt: "2026-09-01T00:03:00.000Z",
        reason: null,
        decision: null,
      }).status).toBe("committed");
      expect(restarted.markHandled("message:restart", {
        version: 1,
        requestKey: "receipt:handled",
        recipientId: "agent:conductor",
        actorId: "agent:conductor",
        recordedAt: "2026-09-01T00:04:00.000Z",
        reason: "Parent explicitly accepted the finding.",
        decision: "accepted",
      }).status).toBe("committed");
      expect(restarted.messageState("message:restart")).toBe("handled");
      expect(restarted.getReceipts("message:restart").map((receipt) => receipt.kind)).toEqual(["delivery", "delivery", "read", "handled"]);
    } finally {
      restarted.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records expiry and cancellation as receipts without mutating the message row", () => {
    const store = new AgentMessageStore();
    const expiry = store.append(message("request:expiry", { id: "message:expiry", expiresAt: "2026-09-01T00:01:00.000Z" }));
    expect(expiry.message?.createdAt).toBe(createdAt);
    expect(store.expireDue("2026-09-01T00:02:00.000Z").map((receipt) => receipt.state)).toEqual(["expired"]);
    expect(store.messageState("message:expiry")).toBe("expired");
    const cancelled = store.append(message("request:cancel", { id: "message:cancel" }));
    expect(cancelled.status).toBe("committed");
    expect(store.cancelMessage("message:cancel", {
      version: 1,
      requestKey: "receipt:cancel",
      actorId: "agent:conductor",
      recordedAt: "2026-09-01T00:05:00.000Z",
      reason: "Parent cancelled this branch.",
      decision: "cancelled",
    }).status).toBe("committed");
    expect(store.messageState("message:cancel")).toBe("cancelled");
    store.close();
  });
});

describe("workflow agent message bus", () => {
  it("keeps authority and parent decisions explicit", () => {
    const store = new AgentMessageStore();
    const bus = new AgentMessageBus(store, {
      principal: "agent:researcher",
      canSend: (input, principal) => principal === "agent:researcher" && input.senderId === "agent:researcher",
      canRead: (_message, principal) => principal === "agent:conductor" || principal === "agent:researcher",
      canHandle: (_message, actorId, decision) => actorId === "agent:conductor" && decision === "accepted",
      canExpire: (message, principal) => message.recipientId === principal,
    });
    const sent = bus.sendFinding(message("request:bus"));
    expect(sent.status).toBe("committed");
    const id = sent.message!.id;
    expect(bus.deliver(id, { requestKey: "bus:delivery", actorId: "agent:conductor", recordedAt: createdAt }).status).toBe("committed");
    expect(bus.read(id, { requestKey: "bus:read", actorId: "agent:conductor", recordedAt: createdAt }).status).toBe("committed");
    expect(bus.handle(id, { requestKey: "bus:handle", actorId: "agent:conductor", recordedAt: createdAt, decision: "accepted" }).status).toBe("committed");
    expect(bus.get(id, "agent:conductor")?.state).toBe("handled");
    expect(bus.replay(0, {}, "agent:conductor").messages).toHaveLength(1);
    expect(() => bus.sendFinding(message("request:forbidden", { senderId: "agent:other" }))).toThrow(/not authorized/);
    store.close();
  });
});
