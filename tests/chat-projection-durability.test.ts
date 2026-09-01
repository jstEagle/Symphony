import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatService, projectStoredBacklog } from "../apps/daemon/src/index.js";
import { loadConfig } from "../packages/config/src/index.js";
import { ConversationMessageSchema, nowIso, type AgentRecord } from "../packages/protocol/src/index.js";
import { createStore, type ChatThreadRecord, type SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "symphony-chat-projector-"));
  temporary.push(root);
  const loaded = loadConfig({ rootDirectory: root });
  return { root, loaded, store: createStore(loaded.dataDirectory) };
}

function service(loaded: ReturnType<typeof loadConfig>, store: SymphonyStore): ChatService {
  // These tests exercise only the store-backed projection path. Agent control
  // and model-backed UI utilities are deliberately outside this boundary.
  return new ChatService(loaded, store, null as never, null as never);
}

function thread(root: string, id: string, agentId: string, timestamp: string): ChatThreadRecord {
  return {
    id,
    title: id,
    groupId: null,
    conductorAgentId: agentId,
    mission: {
      id: `chat:${id}`,
      revision: 1,
      hash: "12345678",
      statement: "Project one durable conductor turn.",
      keyResults: [],
    },
    workspacePath: root,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function unlinkedThread(root: string, id: string, timestamp: string): ChatThreadRecord {
  return { ...thread(root, id, "placeholder-conductor", timestamp), conductorAgentId: null };
}

function agent(root: string, id: string, threadId: string, timestamp: string, output: string): AgentRecord {
  return {
    id,
    logicalAgentId: `logical-${id}`,
    workflowId: `chat:${threadId}`,
    runId: `chat-run:${threadId}`,
    parentAgentId: null,
    depth: 0,
    objective: "Finish the durable chat turn.",
    missionHash: "12345678",
    requestedHarness: "codex",
    requestedModel: "fixture",
    harness: "codex",
    model: "fixture",
    permissions: "full-access",
    status: "completed",
    nativeSessionId: `session-${id}`,
    nativeRunId: `run-${id}`,
    workspacePath: root,
    output: { response: output },
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
  };
}

function saveOutputEvent(store: SymphonyStore, record: AgentRecord, text: string, nativeEventId: string): number {
  let cursor = 0;
  store.transaction(() => {
    store.claimNativeDriverEvent({
      agentId: record.id,
      eventKind: "output.completed",
      nativeEventId,
      claimedAt: record.updatedAt,
    });
    cursor = store.appendEvent({
      type: "driver.output.completed",
      workflowId: record.workflowId,
      runId: record.runId,
      agentId: record.id,
      occurredAt: record.updatedAt,
      payload: { text },
      provenance: { source: "driver", driver: "codex", nativeEventId },
    }).cursor;
    store.appendEvent({
      type: "driver.run.completed",
      workflowId: record.workflowId,
      runId: record.runId,
      agentId: record.id,
      occurredAt: record.updatedAt,
      payload: { status: "completed" },
      provenance: { source: "driver", driver: "codex", nativeEventId: `${nativeEventId}:completed` },
    });
  });
  return cursor;
}

describe("durable chat projection", () => {
  it("rehydrates compact buffered chat events before SSE delivery", () => {
    const { store } = fixture();
    const timestamp = nowIso();
    const message = ConversationMessageSchema.parse({
      id: "buffered-message",
      threadId: "buffered-thread",
      role: "assistant",
      streaming: false,
      parts: [{ type: "text", text: "The durable answer survived the replay boundary." }],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.appendConversationMessage(message);
    const compact = store.appendEvent({
      type: "chat.message.updated",
      workflowId: "chat:buffered-thread",
      runId: "chat-run:buffered-thread",
      agentId: null,
      occurredAt: timestamp,
      payload: { threadId: message.threadId, messageId: message.id },
      provenance: { source: "daemon" },
    });

    const projected = projectStoredBacklog(store, [compact]);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.payload).toEqual({ threadId: message.threadId, message });
    store.close();
  });

  it("projects early text, tools, and output before conductor linkage without leaking across chats", () => {
    const { root, loaded, store } = fixture();
    // Establish the projector cursor, then stop its listener to model the
    // create-conductor window where native events are durable but the chat row
    // has not yet been linked by settleCreatedTurn().
    service(loaded, store).close();
    const timestamp = nowIso();
    const threadId = "early-projection-thread";
    const otherThreadId = "other-projection-thread";
    const record = {
      ...agent(root, "early-projection-agent", threadId, timestamp, "Final answer"),
      status: "running",
      output: null,
      finishedAt: null,
    } as AgentRecord;
    const other = {
      ...agent(root, "other-projection-agent", otherThreadId, timestamp, "Other answer"),
      status: "running",
      output: null,
      finishedAt: null,
    } as AgentRecord;
    store.saveThread(unlinkedThread(root, threadId, timestamp));
    store.saveThread(unlinkedThread(root, otherThreadId, timestamp));
    store.saveAgent(record);
    store.saveAgent(other);
    store.appendEvent({
      type: "driver.message.delta",
      workflowId: record.workflowId,
      runId: record.runId,
      agentId: record.id,
      occurredAt: timestamp,
      payload: { text: "Early response. " },
      provenance: { source: "driver", driver: "codex", nativeEventId: "early-text" },
    });
    store.appendEvent({
      type: "driver.tool.completed",
      workflowId: record.workflowId,
      runId: record.runId,
      agentId: record.id,
      occurredAt: timestamp,
      payload: { toolCallId: "early-tool", toolName: "read_file", args: { path: "README.md" }, result: { ok: true } },
      provenance: { source: "driver", driver: "codex", nativeEventId: "early-tool" },
    });
    store.appendEvent({
      type: "driver.output.completed",
      workflowId: record.workflowId,
      runId: record.runId,
      agentId: record.id,
      occurredAt: timestamp,
      payload: { text: "Final answer" },
      provenance: { source: "driver", driver: "codex", nativeEventId: "early-output" },
    });
    // A similarly shaped event for another chat must remain isolated by the
    // stable workflow/run identity.
    store.appendEvent({
      type: "driver.message.delta",
      workflowId: other.workflowId,
      runId: other.runId,
      agentId: other.id,
      occurredAt: timestamp,
      payload: { text: "Other chat" },
      provenance: { source: "driver", driver: "codex", nativeEventId: "other-text" },
    });
    store.close();

    const recoveredStore = createStore(loaded.dataDirectory);
    const recovered = service(loaded, recoveredStore);
    recovered.recoverProjectionBacklog();
    expect(recoveredStore.listConversationMessages(threadId)).toEqual([
      expect.objectContaining({
        streaming: false,
        parts: [
          { type: "text", text: "Early response. " },
          expect.objectContaining({ type: "tool-call", toolCallId: "early-tool", toolName: "read_file" }),
          { type: "text", text: "Final answer" },
        ],
      }),
    ]);
    expect(recoveredStore.listConversationMessages(otherThreadId)).toEqual([
      expect.objectContaining({
        parts: [{ type: "text", text: "Other chat" }],
      }),
    ]);

    // Link the conductor after replay, as the live create path does.
    recoveredStore.saveThread({ ...unlinkedThread(root, threadId, timestamp), conductorAgentId: record.id });
    recovered.close();
    recoveredStore.close();
  });

  it("restores in-memory stream state when projection storage rolls back", () => {
    const { root, loaded, store } = fixture();
    const projector = service(loaded, store);
    const timestamp = nowIso();
    const threadId = "rollback-thread";
    const agentId = "rollback-agent";
    const record = { ...agent(root, agentId, threadId, timestamp, "Hello"), status: "running", output: null, finishedAt: null } as AgentRecord;
    store.saveThread(thread(root, threadId, agentId, timestamp));
    store.saveAgent(record);

    const append = vi.spyOn(store, "appendConversationMessage");
    append.mockImplementationOnce(() => {
      throw new Error("simulated conversation projection failure");
    });
    store.appendEvent({
      type: "driver.message.delta",
      workflowId: record.workflowId,
      runId: record.runId,
      agentId,
      occurredAt: timestamp,
      payload: { text: "Hello" },
      provenance: { source: "driver", driver: "codex", nativeEventId: "rollback-delta" },
    });
    expect(store.listConversationMessages(threadId)).toEqual([]);

    append.mockRestore();
    projector.recoverProjectionBacklog();
    expect(store.listConversationMessages(threadId)).toEqual([
      expect.objectContaining({
        streaming: true,
        parts: [{ type: "text", text: "Hello" }],
      }),
    ]);
    projector.close();
    store.close();
  });

  it("replays a committed final output exactly once after a crash before conversation projection", () => {
    const { root, loaded, store } = fixture();
    // Establish the projector cursor, then stop its live listener to model a
    // daemon dying after the source transaction but before projection.
    service(loaded, store).close();
    const timestamp = nowIso();
    const threadId = "crash-window-thread";
    const agentId = "crash-window-agent";
    const record = agent(root, agentId, threadId, timestamp, "Complete durable answer.");
    store.saveThread(thread(root, threadId, agentId, timestamp));
    store.saveAgent(record);
    store.appendConversationMessage(ConversationMessageSchema.parse({
      id: "streaming-answer",
      threadId,
      role: "assistant",
      streaming: true,
      parts: [{ type: "text", text: "Partial answer" }],
      createdAt: timestamp,
    }));
    const outputCursor = saveOutputEvent(store, record, "Complete durable answer.", "native-output-1");
    store.close();

    const recoveredStore = createStore(loaded.dataDirectory);
    const recovered = service(loaded, recoveredStore);
    recovered.recoverProjectionBacklog();
    recovered.reconcileInterruptedStreams();
    recovered.recoverProjectionBacklog();

    expect(recoveredStore.listConversationMessages(threadId)).toEqual([
      expect.objectContaining({
        id: "streaming-answer",
        streaming: false,
        parts: [{ type: "text", text: "Complete durable answer." }],
      }),
    ]);
    expect(recoveredStore.eventsAfter(0, { types: ["chat.message.updated"] })).toHaveLength(1);
    expect(recoveredStore.getMetadata<{ cursor: number }>("projection:chat:v1")?.cursor).toBeGreaterThanOrEqual(outputCursor);
    recovered.close();
    recoveredStore.close();
  });

  it("continues one streamed assistant message across a daemon generation", () => {
    const { root, loaded, store } = fixture();
    const projector = service(loaded, store);
    const timestamp = nowIso();
    const threadId = "continued-stream-thread";
    const agentId = "continued-stream-agent";
    const running = {
      ...agent(root, agentId, threadId, timestamp, "Complete answer"),
      status: "running",
      output: null,
      finishedAt: null,
    } as AgentRecord;
    store.saveThread(thread(root, threadId, agentId, timestamp));
    store.saveAgent(running);
    store.appendEvent({
      type: "driver.message.delta",
      workflowId: running.workflowId,
      runId: running.runId,
      agentId,
      occurredAt: timestamp,
      payload: { text: "Before restart. " },
      provenance: { source: "driver", driver: "codex", nativeEventId: "continued-delta-1" },
    });
    const streamId = store.listConversationMessages(threadId)[0]?.id;
    expect(streamId).toBeDefined();
    projector.close();
    store.close();

    const recoveredStore = createStore(loaded.dataDirectory);
    const recovered = service(loaded, recoveredStore);
    recovered.recoverProjectionBacklog();
    recovered.reconcileInterruptedStreams();
    expect(recoveredStore.listConversationMessages(threadId)).toEqual([
      expect.objectContaining({ id: streamId, streaming: true }),
    ]);

    recoveredStore.appendEvent({
      type: "driver.message.delta",
      workflowId: running.workflowId,
      runId: running.runId,
      agentId,
      occurredAt: nowIso(),
      payload: { text: "After restart." },
      provenance: { source: "driver", driver: "codex", nativeEventId: "continued-delta-2" },
    });
    const completed = {
      ...running,
      status: "completed",
      output: { response: "Before restart. After restart." },
      finishedAt: nowIso(),
      updatedAt: nowIso(),
    } as AgentRecord;
    recoveredStore.saveAgent(completed);
    saveOutputEvent(recoveredStore, completed, "Before restart. After restart.", "continued-output");

    expect(recoveredStore.listConversationMessages(threadId)).toEqual([
      expect.objectContaining({
        id: streamId,
        streaming: false,
        parts: [{ type: "text", text: "Before restart. After restart." }],
      }),
    ]);
    recovered.close();
    recoveredStore.close();
  });

  it("replays pre-terminal deltas and tools after the agent has already settled", () => {
    const { root, loaded, store } = fixture();
    service(loaded, store).close();
    const timestamp = nowIso();
    const threadId = "settled-replay-thread";
    const agentId = "settled-replay-agent";
    const record = agent(root, agentId, threadId, timestamp, "Final answer");
    store.saveThread(thread(root, threadId, agentId, timestamp));
    store.saveAgent(record);
    store.appendEvent({
      type: "driver.message.delta",
      workflowId: record.workflowId,
      runId: record.runId,
      agentId,
      occurredAt: timestamp,
      payload: { text: "I checked the workspace." },
      provenance: { source: "driver", driver: "codex", nativeEventId: "settled-delta" },
    });
    store.appendEvent({
      type: "driver.tool.completed",
      workflowId: record.workflowId,
      runId: record.runId,
      agentId,
      occurredAt: timestamp,
      payload: { toolCallId: "tool-1", toolName: "read_file", args: { path: "README.md" }, result: { ok: true } },
      provenance: { source: "driver", driver: "codex", nativeEventId: "settled-tool" },
    });
    saveOutputEvent(store, record, "Final answer", "settled-output");
    store.close();

    const recoveredStore = createStore(loaded.dataDirectory);
    const recovered = service(loaded, recoveredStore);
    recovered.recoverProjectionBacklog();
    expect(recoveredStore.listConversationMessages(threadId)).toEqual([
      expect.objectContaining({
        streaming: false,
        parts: [
          { type: "text", text: "I checked the workspace." },
          expect.objectContaining({ type: "tool-call", toolCallId: "tool-1", toolName: "read_file" }),
          { type: "text", text: "Final answer" },
        ],
      }),
    ]);
    recovered.close();
    recoveredStore.close();
  });

  it("repairs one legacy terminal stream while adopting already-projected history without duplication", () => {
    const { root, loaded, store } = fixture();
    const timestamp = nowIso();
    const historical = agent(root, "historical-agent", "historical-thread", timestamp, "Already projected.");
    store.saveThread(thread(root, "historical-thread", historical.id, timestamp));
    store.saveAgent(historical);
    store.appendConversationMessage(ConversationMessageSchema.parse({
      id: "historical-answer",
      threadId: "historical-thread",
      role: "assistant",
      streaming: false,
      parts: [{ type: "text", text: "Already projected." }],
      createdAt: timestamp,
    }));
    saveOutputEvent(store, historical, "Already projected.", "historical-output");

    const interrupted = agent(root, "legacy-interrupted-agent", "legacy-interrupted-thread", timestamp, "Recovered legacy answer.");
    store.saveThread(thread(root, "legacy-interrupted-thread", interrupted.id, timestamp));
    store.saveAgent(interrupted);
    store.appendConversationMessage(ConversationMessageSchema.parse({
      id: "legacy-stream",
      threadId: "legacy-interrupted-thread",
      role: "assistant",
      streaming: true,
      parts: [{ type: "text", text: "Truncated" }],
      createdAt: timestamp,
    }));
    saveOutputEvent(store, interrupted, "Recovered legacy answer.", "legacy-output");

    const projector = service(loaded, store);
    projector.recoverProjectionBacklog();
    expect(store.listConversationMessages("historical-thread")).toEqual([
      expect.objectContaining({ id: "historical-answer", parts: [{ type: "text", text: "Already projected." }] }),
    ]);
    expect(store.listConversationMessages("legacy-interrupted-thread")).toEqual([
      expect.objectContaining({
        id: "legacy-stream",
        streaming: false,
        parts: [{ type: "text", text: "Recovered legacy answer." }],
      }),
    ]);
    expect(store.eventsAfter(0, { types: ["chat.message.updated"] })).toHaveLength(1);
    projector.close();
    store.close();
  });
});
