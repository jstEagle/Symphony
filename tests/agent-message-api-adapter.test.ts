import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AgentMessageApiAdapter, AgentMessageApiAuthorizationError } from "../apps/daemon/src/agent-message-api.js";
import { AgentMessageStore } from "../packages/storage/src/agent-message.js";

const createdAt = "2026-09-01T00:00:00.000Z";

function input(requestKey: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    requestKey,
    kind: "finding" as const,
    senderId: "agent:worker",
    recipientId: "agent:parent",
    parentId: "parent:1",
    parentAgentId: "agent:parent",
    objectiveId: "objective:1",
    runId: "run:1",
    attemptId: "attempt:1",
    correlationId: null,
    replyToId: null,
    payload: { claim: "semantic result" },
    summary: "A semantic result",
    artifactRefs: [{ id: "artifact:one", hash: null, mediaType: "text/plain", uri: "artifact://one" }],
    evidenceRefs: [{ id: "event:one", kind: "event", hash: null, cursor: 7, uri: "event://one" }],
    createdAt,
    expiresAt: null,
    ...overrides,
  };
}

function authority() {
  return {
    canAppend: (actorId: string, value: { senderId: string }) => actorId === value.senderId,
    canRead: (actorId: string, value: { recipientId: string }) => actorId === value.recipientId,
    canHandle: (actorId: string) => actorId === "agent:parent",
    canCancel: (actorId: string) => actorId === "agent:parent",
    canExpire: (actorId: string) => actorId === "system:expiry",
  };
}

describe("daemon-neutral agent message API adapter", () => {
  it("keeps semantic refs, transcript boundaries, and truthful idempotency statuses", () => {
    const store = new AgentMessageStore();
    const api = new AgentMessageApiAdapter(store, authority());
    const first = api.append(input("message:request"), "agent:worker");
    expect(first.status).toBe("committed");
    expect(first.message?.artifactRefs[0]?.uri).toBe("artifact://one");
    expect(first.message).not.toHaveProperty("transcript");

    const replay = api.append(input("message:request"), "agent:worker");
    expect(replay.status).toBe("replayed");
    const conflict = api.append(input("message:request", { payload: { changed: true } }), "agent:worker");
    expect(conflict.status).toBe("conflict");
    expect(api.get(first.message!.id, "agent:parent")?.state).toBe("pending");
    expect(api.cursorSnapshot()).toEqual({ messageCursor: 1, receiptCursor: 0 });
    api.close();
    store.close();
  });

  it("persists delivery uncertainty and receipt transitions across a clean restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-agent-api-"));
    const path = join(directory, "agent-messages.sqlite");
    try {
      const firstStore = new AgentMessageStore(path);
      const firstApi = new AgentMessageApiAdapter(firstStore, authority(), true);
      const appended = firstApi.append(input("message:restart", {
        id: "message:restart",
        expiresAt: "2026-09-01T00:10:00.000Z",
      }), "agent:worker");
      expect(appended.message).not.toBeNull();
      expect(firstApi.unknown("message:restart", {
        requestKey: "receipt:unknown",
        actorId: "agent:parent",
        recordedAt: "2026-09-01T00:01:00.000Z",
        reason: "daemon stopped after dispatch",
      }).status).toBe("committed");
      firstApi.close();

      const secondApi = new AgentMessageApiAdapter({ storage: path, authority: authority() });
      try {
        expect(secondApi.deliver("message:restart", {
          requestKey: "receipt:delivery",
          actorId: "agent:parent",
          recordedAt: "2026-09-01T00:02:00.000Z",
          reason: "provider reconciliation proved delivery",
        }).status).toBe("committed");
        expect(secondApi.read("message:restart", {
          requestKey: "receipt:read",
          actorId: "agent:parent",
          recordedAt: "2026-09-01T00:03:00.000Z",
        }).status).toBe("committed");
        expect(secondApi.handled("message:restart", {
          requestKey: "receipt:handled",
          actorId: "agent:parent",
          recordedAt: "2026-09-01T00:04:00.000Z",
          decision: "accepted",
        }).status).toBe("committed");
        expect(secondApi.get("message:restart", "agent:parent")?.state).toBe("handled");
        expect(secondApi.getCursorSnapshot()).toMatchObject({ messageCursor: 1, receiptCursor: 4 });
      } finally {
        secondApi.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires an authenticated actor and does not leak messages through reads", () => {
    const api = new AgentMessageApiAdapter(new AgentMessageStore(), authority());
    const appended = api.append(input("message:auth"), "agent:worker");
    expect(() => api.get(appended.message!.id, "agent:other")).toThrow(AgentMessageApiAuthorizationError);
    expect(() => api.append(input("message:missing-actor"), "")).toThrow(/actorId/);
    expect(() => api.read(appended.message!.id, {
      requestKey: "receipt:forbidden",
      actorId: "agent:other",
      recordedAt: createdAt,
    })).toThrow(/not authorized/);
    api.close();
  });

  it("records known failure, cancellation, and explicit expiry sweeps", () => {
    const api = new AgentMessageApiAdapter(new AgentMessageStore(), authority());
    const failed = api.append(input("message:failed", { id: "message:failed" }), "agent:worker");
    expect(api.failed(failed.message!.id, {
      requestKey: "receipt:failed",
      actorId: "agent:parent",
      recordedAt: createdAt,
      reason: "provider rejected the packet",
    }).receipt?.state).toBe("failed");
    const cancelled = api.append(input("message:cancelled", { id: "message:cancelled" }), "agent:worker");
    expect(api.cancel(cancelled.message!.id, {
      requestKey: "receipt:cancelled",
      actorId: "agent:parent",
      recordedAt: createdAt,
    }).receipt?.state).toBe("cancelled");
    const expiring = api.append(input("message:expiring", {
      id: "message:expiring",
      expiresAt: "2026-09-01T00:01:00.000Z",
    }), "agent:worker");
    const expiryOptions = {
      actorId: "system:expiry",
      requestPrefix: "expiry",
    };
    expect(api.expireDue("2026-09-01T00:02:00.000Z", expiryOptions).map((receipt) => receipt.messageId)).toEqual([expiring.message!.id]);
    expect(api.expireDue("2026-09-01T00:02:00.000Z", expiryOptions)).toEqual([]);
    api.close();
  });
});
