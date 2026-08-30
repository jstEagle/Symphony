import { describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  coalesceConversationTurns,
  conversationTranscriptSignature,
  mergeConversationMessageBatch,
  mergeProjectedThreadMessages,
  normalizeConversationMessage,
  removeThreadMessage,
} from "../apps/web/src/lib/symphony/messages.js";
import type { ConversationMessage } from "../apps/web/src/lib/symphony/contracts.js";

describe("web conversation projection", () => {
  it("collapses a repeated streamed response snapshot before rendering", () => {
    const message: ConversationMessage = {
      id: "assistant-1",
      threadId: "thread-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-30T00:00:00.000Z",
      parts: [
        { type: "reasoning", text: "Think", status: { type: "running" }, nativeMessageId: "reasoning-1" },
        { type: "text", text: "Answer" },
        { type: "reasoning", text: "Think", status: { type: "complete" }, nativeMessageId: "reasoning-1" },
        { type: "text", text: "Answer" },
      ],
    };

    expect(normalizeConversationMessage(message).parts).toEqual([
      { type: "reasoning", text: "Think", status: { type: "running" }, nativeMessageId: "reasoning-1" },
      { type: "text", text: "Answer" },
    ]);
  });

  it("preserves repeated content when native part identities differ", () => {
    const message: ConversationMessage = {
      id: "assistant-distinct-segments",
      threadId: "thread-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-30T00:00:00.000Z",
      parts: [
        { type: "reasoning", text: "Think", status: { type: "running" }, nativeMessageId: "reasoning-1" },
        { type: "text", text: "Answer" },
        { type: "reasoning", text: "Think", status: { type: "complete" }, nativeMessageId: "reasoning-2" },
        { type: "text", text: "Answer" },
      ],
    };

    expect(normalizeConversationMessage(message)).toBe(message);
  });

  it("preserves identical identity-free text parts", () => {
    const message: ConversationMessage = {
      id: "assistant-repeated-prose",
      threadId: "thread-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-30T00:00:00.000Z",
      parts: [
        { type: "text", text: "Again" },
        { type: "text", text: "Again" },
      ],
    };

    expect(normalizeConversationMessage(message)).toBe(message);
  });

  it("preserves distinct ordered response parts", () => {
    const message: ConversationMessage = {
      id: "assistant-2",
      threadId: "thread-1",
      role: "assistant",
      streaming: false,
      createdAt: "2026-08-30T00:00:00.000Z",
      parts: [
        { type: "reasoning", text: "Think", status: { type: "complete" } },
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ],
    };

    expect(normalizeConversationMessage(message)).toBe(message);
  });

  it("replaces streamed snapshots in place and only sorts new messages", () => {
    const first: ConversationMessage = {
      id: "assistant-1",
      threadId: "thread-1",
      role: "assistant",
      streaming: true,
      createdAt: "2026-08-30T00:00:01.000Z",
      parts: [{ type: "text", text: "Hel" }],
    };
    const older: ConversationMessage = {
      id: "user-1",
      threadId: "thread-1",
      role: "user",
      createdAt: "2026-08-30T00:00:00.000Z",
      parts: [{ type: "text", text: "Hello" }],
    };
    const replacement = {
      ...first,
      parts: [{ type: "text", text: "Hello there" }],
    } satisfies ConversationMessage;

    expect(mergeConversationMessageBatch([first], [replacement, older])).toEqual([
      older,
      replacement,
    ]);
  });

  it("does not mutate the retained message array while replacing a token batch", () => {
    const original: ConversationMessage = {
      id: "assistant-1",
      threadId: "thread-1",
      role: "assistant",
      streaming: true,
      createdAt: "2026-08-30T00:00:00.000Z",
      parts: [{ type: "text", text: "A" }],
    };
    const current = [original];
    const next = mergeConversationMessageBatch(current, [{ ...original, parts: [{ type: "text", text: "AB" }] }]);

    expect(current).toEqual([original]);
    expect(next).not.toBe(current);
    expect(next[0]?.parts).toEqual([{ type: "text", text: "AB" }]);
  });

  it("keeps identical optimistic prompts distinct until their ids are acknowledged", () => {
    const persisted: ThreadMessageLike = { id: "persisted", role: "user", content: "Retry" };
    const projected: ThreadMessageLike[] = [persisted];
    const local: ThreadMessageLike[] = [
      persisted,
      { id: "optimistic", role: "user", content: "Retry" },
    ];

    expect(mergeProjectedThreadMessages(projected, local).map((message) => message.id)).toEqual([
      "persisted",
      "optimistic",
    ]);
  });

  it("keeps an optimistic user turn before its later streamed reply", () => {
    const user: ThreadMessageLike = {
      id: "user-1",
      role: "user",
      content: "Prompt",
      createdAt: new Date("2026-08-30T21:13:07.018Z"),
    };
    const assistant: ThreadMessageLike = {
      id: "assistant-1",
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "list_agents",
        args: {},
      }],
      status: { type: "running" },
      createdAt: new Date("2026-08-30T21:13:16.714Z"),
    };

    const merged = mergeProjectedThreadMessages([assistant], [user]);

    expect(merged.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);
    expect(merged.at(-1)?.role).toBe("assistant");
  });

  it("renders resumed assistant segments as one logical turn and hides old restart notices", () => {
    const messages: ConversationMessage[] = [
      {
        id: "user-1",
        threadId: "thread-1",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        createdAt: "2026-08-30T21:13:07.018Z",
      },
      {
        id: "assistant-before-restart",
        threadId: "thread-1",
        role: "assistant",
        parts: [{ type: "text", text: "First segment" }],
        streaming: false,
        createdAt: "2026-08-30T21:13:16.714Z",
      },
      {
        id: "assistant-after-restart",
        threadId: "thread-1",
        role: "assistant",
        parts: [{ type: "tool-call", toolCallId: "tool-1", toolName: "list_agents", args: {} }],
        streaming: true,
        createdAt: "2026-08-30T21:16:00.478Z",
      },
      {
        id: "restart-notice",
        threadId: "thread-1",
        role: "assistant",
        parts: [{ type: "text", text: "Symphony restarted, recovered the native session, and this run is continuing." }],
        createdAt: "2026-08-30T21:16:04.586Z",
      },
    ];

    expect(coalesceConversationTurns(messages)).toEqual([
      messages[0],
      expect.objectContaining({
        id: "assistant-before-restart",
        streaming: true,
        parts: [
          { type: "text", text: "First segment" },
          { type: "tool-call", toolCallId: "tool-1", toolName: "list_agents", args: {} },
        ],
      }),
    ]);
  });

  it("rolls back only the rejected optimistic agent message", () => {
    const messages: ThreadMessageLike[] = [
      { id: "persisted", role: "assistant", content: "Ready" },
      { id: "optimistic", role: "user", content: "Continue" },
    ];

    expect(removeThreadMessage(messages, "optimistic").map((message) => message.id)).toEqual(["persisted"]);
  });

  it("changes the transcript signature when parts change at the same timestamp", () => {
    const first: ConversationMessage = {
      id: "assistant-1",
      threadId: "agent:1",
      role: "assistant",
      streaming: true,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:01.000Z",
      parts: [{ type: "text", text: "Hel" }],
    };

    expect(conversationTranscriptSignature([{ ...first, parts: [{ type: "text", text: "Hello" }] }]))
      .not.toBe(conversationTranscriptSignature([first]));
  });
});
