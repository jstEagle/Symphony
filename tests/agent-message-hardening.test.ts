import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AGENT_MESSAGE_MAX_DEPTH,
  AGENT_MESSAGE_MAX_PAYLOAD_BYTES,
  AgentMessageInputSchema,
  redactAgentMessageCredentials,
} from "../packages/protocol/src/agent-message.js";
import { AgentMessageStore } from "../packages/storage/src/agent-message.js";
import { AgentMessageBus } from "../packages/workflow/src/agent-message-bus.js";

const base = {
  version: 1 as const,
  requestKey: "hardening:request",
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
  payload: { claim: "safe" },
  summary: "A finding",
  artifactRefs: [],
  evidenceRefs: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  expiresAt: null,
};

describe("agent message protocol/storage hardening", () => {
  it("rejects oversized, deeply nested, and overlarge collection payloads", () => {
    expect(() => AgentMessageInputSchema.parse({ ...base, payload: { text: "x".repeat(AGENT_MESSAGE_MAX_PAYLOAD_BYTES) } })).toThrow(/serialized size/);
    let nested: unknown = "leaf";
    for (let index = 0; index <= AGENT_MESSAGE_MAX_DEPTH + 1; index++) nested = { nested };
    expect(() => AgentMessageInputSchema.parse({ ...base, payload: nested })).toThrow(/maximum depth/);
    expect(() => AgentMessageInputSchema.parse({ ...base, payload: Array.from({ length: 513 }, () => 1) })).toThrow(/collection size/);
  });

  it("redacts credential-shaped payload fields before persistence", () => {
    const store = new AgentMessageStore();
    try {
      const result = store.append({
        ...base,
        payload: { nested: { accessToken: "secret-value", password: "another-secret" }, visible: "kept" },
      });
      expect(result.message?.payload).toEqual({ nested: { accessToken: "[REDACTED]", password: "[REDACTED]" }, visible: "kept" });
      expect(String(store.database.prepare("SELECT record_json FROM agent_bus_messages").get()?.record_json)).not.toContain("secret-value");
    } finally {
      store.close();
    }
    expect(redactAgentMessageCredentials({ api_key: "value", ok: true })).toEqual({ api_key: "[REDACTED]", ok: true });
  });

  it("backfills identity filter columns from legacy record_json safely", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE agent_bus_messages (
        cursor INTEGER PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, id TEXT NOT NULL UNIQUE,
        request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, record_json TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT
      )
    `);
    const legacy = { ...base, id: "message:legacy", sequence: 4, cursor: 9 };
    database.prepare("INSERT INTO agent_bus_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      legacy.cursor,
      legacy.sequence,
      legacy.id,
      legacy.requestKey,
      "fingerprint",
      JSON.stringify(legacy),
      legacy.createdAt,
      null,
    );
    const store = new AgentMessageStore(database);
    try {
      expect(store.database.prepare("SELECT sender_id, recipient_id, objective_id, run_id, kind FROM agent_bus_messages").get()).toEqual({
        sender_id: "agent:worker",
        recipient_id: "agent:parent",
        objective_id: "objective:1",
        run_id: "run:1",
        kind: "finding",
      });
      expect(store.list({ objectiveId: "objective:1" })).toHaveLength(1);
    } finally {
      store.close();
      database.close();
    }
  });

  it("fails closed for direct bus callers without a principal or read authority", () => {
    const store = new AgentMessageStore();
    try {
      const bus = new AgentMessageBus(store, { canSend: () => true });
      expect(() => bus.send(base)).toThrow(/authenticated principal/);
      const authorized = new AgentMessageBus(store, {
        principal: "agent:worker",
        canSend: () => true,
      });
      const sent = authorized.send(base);
      expect(() => authorized.get(sent.message!.id)).toThrow(/canRead authority/);
      expect(() => authorized.replay(0)).toThrow(/canRead authority/);
    } finally {
      store.close();
    }
  });
});
