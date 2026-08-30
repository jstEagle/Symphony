import { describe, expect, it, vi } from "vitest";
import {
  CHAT_OUTBOX_STORAGE_KEY,
  createPendingChatSend,
  deletePendingChatSend,
  markPendingChatSendAttempt,
  pendingChatSendToConversationMessage,
  putPendingChatSend,
  readPendingChatSends,
  reconcilePendingChatSend,
  removePendingChatSend,
  writePendingChatSends,
  writePendingChatSend,
} from "../apps/web/src/lib/symphony/chat-outbox.js";

const isRetryableError = (error: unknown) => !(
  error instanceof Error
  && "status" in error
  && typeof error.status === "number"
  && error.status >= 400
  && error.status < 500
);

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    values,
  };
}

const pending = createPendingChatSend({
  messageId: "client-message-1",
  threadId: "thread-1",
  content: "Continue the durable run.",
  attachments: [{
    id: "attachment-1",
    name: "context.txt",
    type: "document",
    contentType: "text/plain",
    content: [{ type: "text", text: "Relevant context" }],
  }],
  createdAt: "2026-08-31T00:00:00.000Z",
});

describe("web durable chat outbox", () => {
  it("restores the exact pending send identity and retry payload after a reload", () => {
    const storage = memoryStorage();
    writePendingChatSends([pending], storage);

    expect(readPendingChatSends(storage)).toEqual([pending]);
    expect(storage.values.has(`${CHAT_OUTBOX_STORAGE_KEY}:client-message-1`)).toBe(true);
  });

  it("keeps concurrent sends from separate browser windows independently addressable", () => {
    const storage = memoryStorage();
    const second = createPendingChatSend({
      messageId: "client-message-2",
      threadId: "thread-2",
      content: "A second window sends independently.",
      attachments: [],
      createdAt: "2026-08-31T00:00:01.000Z",
    });

    writePendingChatSend(pending, storage);
    writePendingChatSend(second, storage);
    expect(readPendingChatSends(storage)).toEqual([pending, second]);

    deletePendingChatSend(pending.messageId, storage);
    expect(readPendingChatSends(storage)).toEqual([second]);
  });

  it("ignores corrupt entries without discarding valid pending sends", () => {
    const storage = memoryStorage();
    storage.setItem(CHAT_OUTBOX_STORAGE_KEY, JSON.stringify([
      { ...pending, attempts: -1 },
      pending,
      { version: 1, messageId: "partial" },
    ]));

    expect(readPendingChatSends(storage)).toEqual([pending]);
  });

  it("never rebinds a client message id to a different payload", () => {
    expect(() => putPendingChatSend([pending], { ...pending, content: "Different request" }))
      .toThrow("already bound to another chat payload");
  });

  it("projects the restored send as the same user message id", () => {
    expect(pendingChatSendToConversationMessage(pending)).toMatchObject({
      id: "client-message-1",
      threadId: "thread-1",
      role: "user",
      createdAt: "2026-08-31T00:00:00.000Z",
      parts: [
        { type: "text", text: "Continue the durable run." },
        { type: "attachment", id: "attachment-1", name: "context.txt" },
      ],
    });
  });

  it("accepts the daemon thread as authoritative and does not resend an acknowledged message", async () => {
    const send = vi.fn();
    const result = await reconcilePendingChatSend(pending, {
      fetchThread: vi.fn(async () => ({
        messages: [pendingChatSendToConversationMessage(pending)],
      })),
      send,
      isRetryableError,
    });

    expect(result).toEqual({ status: "acknowledged" });
    expect(send).not.toHaveBeenCalled();
  });

  it("retries a missing send with the original message id and exact payload", async () => {
    const send = vi.fn(async () => ({ messageId: pending.messageId }));
    const result = await reconcilePendingChatSend(pending, {
      fetchThread: vi.fn(async () => ({ messages: [] })),
      send,
      isRetryableError,
    });

    expect(result).toEqual({ status: "acknowledged" });
    expect(send).toHaveBeenCalledWith("thread-1", {
      messageId: "client-message-1",
      content: "Continue the durable run.",
      attachments: pending.attachments,
    });
  });

  it("retains transport failures for a later reload but drops definitive daemon rejections", async () => {
    const transportError = new TypeError("fetch failed");
    const retry = await reconcilePendingChatSend(pending, {
      fetchThread: vi.fn(async () => ({ messages: [] })),
      send: vi.fn(async () => { throw transportError; }),
      isRetryableError,
    });
    expect(retry).toEqual({ status: "retry", error: transportError });

    const rejection = Object.assign(new Error("A turn is already in progress."), { status: 409 });
    const rejected = await reconcilePendingChatSend(pending, {
      fetchThread: vi.fn(async () => ({ messages: [] })),
      send: vi.fn(async () => { throw rejection; }),
      isRetryableError,
    });
    expect(rejected).toEqual({ status: "rejected", error: rejection });
  });

  it("tracks an ambiguous attempt without changing its payload and removes only its acknowledgement", () => {
    const attempted = markPendingChatSendAttempt([pending], pending.messageId, new Error("connection reset"), "2026-08-31T00:00:01.000Z");
    expect(attempted[0]).toMatchObject({
      messageId: pending.messageId,
      content: pending.content,
      attachments: pending.attachments,
      attempts: 1,
      lastAttemptAt: "2026-08-31T00:00:01.000Z",
      lastError: "connection reset",
    });
    expect(removePendingChatSend(attempted, pending.messageId)).toEqual([]);
  });
});
