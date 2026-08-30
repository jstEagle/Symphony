import type { CompleteAttachment, ThreadMessageLike } from "@assistant-ui/react";
import type { ConversationMessage, JsonValue, RunSnapshot, ConversationSummary } from "./contracts";

export function toThreadMessages(messages: ConversationMessage[]): ThreadMessageLike[] {
  return coalesceConversationTurns(messages).map((message) => {
    const role = message.role === "tool" ? "assistant" : message.role;
    const attachmentParts = message.parts.filter(isAttachmentPart);
    const contentParts = message.parts.filter((part) => !isAttachmentPart(part));
    const attachments: CompleteAttachment[] = attachmentParts.map((part, index) => {
      const record = part as Record<string, JsonValue>;
      return {
        id: typeof record.id === "string" ? record.id : `${message.id}:attachment:${index}`,
        type: typeof record.attachmentType === "string" ? record.attachmentType : "document",
        name: typeof record.name === "string" ? record.name : "Attachment",
        contentType: typeof record.contentType === "string" ? record.contentType : undefined,
        content: Array.isArray(record.content) ? record.content as CompleteAttachment["content"] : [],
        status: { type: "complete" },
      };
    });
    return {
      id: message.id,
      role,
      content: partsToContent(contentParts, message.id),
      createdAt: new Date(message.createdAt),
      ...(role === "user" && attachments.length ? { attachments } : {}),
      ...(role === "assistant"
        ? message.streaming
          ? { status: { type: "running" as const } }
          : { status: { type: "complete" as const, reason: "stop" as const } }
        : {}),
    };
  });
}

/**
 * Native harnesses may expose several assistant items during one user turn,
 * and a daemon generation can reconnect halfway through that same turn. The
 * chat surface must still present one logical assistant response until the
 * next user message arrives.
 */
export function coalesceConversationTurns(messages: ConversationMessage[]): ConversationMessage[] {
  const turns: ConversationMessage[] = [];
  for (const source of messages) {
    if (isInternalRecoveryNotice(source)) continue;
    const message = normalizeConversationMessage(source);
    const previous = turns.at(-1);
    const role = renderRole(message.role);
    if (previous && previous.threadId === message.threadId && renderRole(previous.role) === "assistant" && role === "assistant") {
      turns[turns.length - 1] = normalizeConversationMessage({
        ...previous,
        role: previous.role === "tool" ? "assistant" : previous.role,
        parts: [...previous.parts, ...message.parts],
        streaming: message.streaming,
        updatedAt: message.updatedAt ?? message.createdAt,
      });
      continue;
    }
    turns.push(message);
  }
  return turns;
}

/**
 * Native harnesses can emit a streamed sequence and then repeat the same
 * sequence as a final snapshot. Keep this guard at the projection boundary as
 * well as in the daemon so an already-open browser cannot render a stale,
 * pre-repair event twice.
 */
export function normalizeConversationMessage(message: ConversationMessage): ConversationMessage {
  const parts = collapseRepeatedParts(message.parts);
  return parts === message.parts ? message : { ...message, parts };
}

/**
 * Replaces streamed snapshots without repeatedly normalizing and sorting the
 * entire retained message window. Existing positions are stable because a
 * streamed update keeps its message id and creation time; only genuinely new
 * messages need the final chronological sort.
 */
export function mergeConversationMessageBatch(
  current: ConversationMessage[],
  batch: ConversationMessage[],
): ConversationMessage[] {
  if (batch.length === 0) return current;
  const pending = new Map(batch.map((message) => [message.id, normalizeConversationMessage(message)]));
  const next = current.map((message) => {
    const replacement = pending.get(message.id);
    if (!replacement) return message;
    pending.delete(message.id);
    return replacement;
  });
  if (pending.size === 0) return next;
  next.push(...pending.values());
  return next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Keeps locally submitted messages visible until the daemon acknowledges their
 * client-generated ids. Message text is not an identity: users may intentionally
 * submit the same prompt more than once.
 */
export function mergeProjectedThreadMessages(
  projected: readonly ThreadMessageLike[],
  local: readonly ThreadMessageLike[],
): ThreadMessageLike[] {
  const projectedIds = new Set(projected.map((message) => message.id));
  return [...projected, ...local.filter((message) => !projectedIds.has(message.id))]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTime = left.message.createdAt?.getTime();
      const rightTime = right.message.createdAt?.getTime();
      if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return leftTime - rightTime;
      if (leftTime !== undefined && rightTime === undefined) return -1;
      if (leftTime === undefined && rightTime !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ message }) => message);
}

export function removeThreadMessage(
  messages: readonly ThreadMessageLike[],
  messageId: string,
): ThreadMessageLike[] {
  return messages.filter((message) => message.id !== messageId);
}

/**
 * Agent transcript polling needs to notice content changes even when a native
 * harness reuses its timestamp for multiple snapshots.
 */
export function conversationTranscriptSignature(messages: readonly ConversationMessage[]): string {
  return messages
    .map((message) => JSON.stringify([
      message.id,
      message.role,
      message.createdAt,
      message.updatedAt ?? null,
      message.streaming === true,
      message.parts,
    ]))
    .join("|");
}

function collapseRepeatedParts(parts: JsonValue[]): JsonValue[] {
  if (parts.length < 2) return parts;
  const comparable = parts.map(comparablePart);
  for (let period = 1; period <= Math.floor(parts.length / 2); period += 1) {
    if (parts.length % period !== 0) continue;
    let hasStableIdentity = false;
    const repeated = comparable.every((part, index) => {
      const sourceIndex = index % period;
      if (part !== comparable[sourceIndex]) return false;
      if (index < period) return true;
      const identity = stablePartIdentity(parts[index]);
      if (identity && identity === stablePartIdentity(parts[sourceIndex])) hasStableIdentity = true;
      return true;
    });
    if (repeated && hasStableIdentity) return parts.slice(0, period);
  }
  return parts;
}

function comparablePart(part: JsonValue): string {
  if (!part || typeof part !== "object" || Array.isArray(part)) return JSON.stringify(part);
  if (part.type !== "text" && part.type !== "reasoning") return JSON.stringify(part);
  const { status: _status, ...content } = part;
  return JSON.stringify(content);
}

function stablePartIdentity(part: JsonValue): string | null {
  if (!part || typeof part !== "object" || Array.isArray(part)) return null;
  for (const key of ["nativeMessageId", "toolCallId", "id"] as const) {
    const value = part[key];
    if (typeof value === "string" && value.trim()) return `${key}:${value}`;
  }
  return null;
}

function isAttachmentPart(part: JsonValue): boolean {
  return Boolean(part && typeof part === "object" && !Array.isArray(part) && part.type === "attachment");
}

function renderRole(role: ConversationMessage["role"]): ConversationMessage["role"] {
  return role === "tool" ? "assistant" : role;
}

const INTERNAL_RECOVERY_NOTICES = new Set([
  "Symphony restarted, recovered the native session, and this run is continuing.",
  "Symphony restarted and recovered the native session. It is ready for your next message.",
]);

function isInternalRecoveryNotice(message: ConversationMessage): boolean {
  if (message.role !== "assistant" || message.parts.length !== 1) return false;
  const part = message.parts[0];
  return Boolean(
    part
    && typeof part === "object"
    && !Array.isArray(part)
    && part.type === "text"
    && typeof part.text === "string"
    && INTERNAL_RECOVERY_NOTICES.has(part.text),
  );
}

function partsToContent(parts: JsonValue[], messageId: string): ThreadMessageLike["content"] {
  if (!parts.length) return "";
  const mapped = parts.map((part, index) => {
    if (typeof part === "string") return { type: "text" as const, text: part };
    if (!part || typeof part !== "object" || Array.isArray(part)) return { type: "text" as const, text: String(part) };
    const record = part as Record<string, JsonValue>;
    if (record.type === "text" && typeof record.text === "string") return { type: "text" as const, text: record.text };
    if (record.type === "reasoning" && typeof record.text === "string") {
      const status = record.status && typeof record.status === "object" && !Array.isArray(record.status)
        && (record.status as Record<string, JsonValue>).type === "running"
        ? { type: "running" as const }
        : { type: "complete" as const };
      return { type: "reasoning" as const, text: record.text, status };
    }
    if (record.type === "data" && typeof record.name === "string") {
      return { type: "data" as const, name: record.name, data: record.data ?? {} };
    }
    if (record.type === "generative-ui") {
      return { type: "data" as const, name: "generative-ui", data: record.spec ?? record.data ?? {} };
    }
    if (record.type === "tool-call" && typeof record.toolName === "string") {
      const args = record.args && typeof record.args === "object" && !Array.isArray(record.args)
        ? (record.args as Record<string, JsonValue>)
        : {};
      return {
        type: "tool-call" as const,
        toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : `${messageId}:tool:${index}`,
        toolName: record.toolName,
        args,
        argsText: typeof record.argsText === "string" ? record.argsText : JSON.stringify(args),
        ...(Object.hasOwn(record, "result") ? { result: record.result } : {}),
        ...(record.isError === true ? { isError: true } : {}),
      };
    }
    if (typeof record.text === "string") return { type: "text" as const, text: record.text };
    return { type: "text" as const, text: JSON.stringify(record) };
  });
  if (mapped.length === 1 && mapped[0]?.type === "text") return mapped[0].text;
  return mapped as ThreadMessageLike["content"];
}

export function extractText(content: ThreadMessageLike["content"] | unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function buildPreviewMessages(
  snapshot: RunSnapshot,
  conversation: ConversationSummary,
): readonly ThreadMessageLike[] {
  if (conversation.id !== "symphony-harness") {
    return [];
  }

  return [
    {
      id: "user-1",
      role: "user",
      content:
        "Build Symphony using Create Next App. Keep the interface simple and familiar, but make it possible to understand what the orchestrator and its agents are doing without opening every native session.",
      createdAt: new Date("2026-08-30T01:12:00.000Z"),
    },
    {
      id: "assistant-1",
      role: "assistant",
      createdAt: new Date("2026-08-30T01:12:04.000Z"),
      status: { type: "complete", reason: "stop" },
      content: [
        {
          type: "reasoning",
          text: "Keep the product as one conversation with the conductor. Delegation and runtime activity should appear as compact updates inside that conversation; deeper workflow information stays behind run details.",
          status: { type: "complete" },
        },
        {
          type: "tool-call",
          toolCallId: "tool-create-adapter",
          toolName: "create_agent",
          args: {
            objective: "Implement the native Codex adapter and lifecycle bridge.",
            access: "full-access",
            routingIntent: "Strong coding model in its native OpenAI harness",
            harness: "Codex",
          },
          result: { agentId: "builder", state: "running" },
        },
        {
          type: "tool-call",
          toolCallId: "tool-create-notes",
          toolName: "create_agent",
          args: {
            objective: "Document lifecycle edge cases for adapter consumers.",
            access: "read-only",
            routingIntent: "Clear technical writing with strong code comprehension",
            harness: "Claude Code",
          },
          result: { agentId: "documenter", state: "waiting" },
        },
        {
          type: "text",
          text: "The runtime remains the local source of truth. The browser reads a snapshot, follows the semantic event stream, and sends audited commands. Refreshing the page cannot interrupt a native agent run.",
        },
        {
          type: "tool-call",
          toolCallId: "tool-observe-builder",
          toolName: "observe_agent",
          args: { agentId: "builder", granularity: "paragraph" },
          result: {
            summary:
              "The adapter is translating native lifecycle events without changing the Codex session. Cancellation acknowledgement still needs one correction.",
          },
        },
        {
          type: "text",
          text: `A bounded correction is in progress. The delegated agents remain visible in Symphony and their native sessions have not been restarted.`,
        },
      ],
    },
    {
      id: "user-2",
      role: "user",
      content:
        "Keep the native harness vanilla. Fix only the bridge contract, and keep the lifecycle notes aligned with the implementation.",
      createdAt: new Date("2026-08-30T01:18:00.000Z"),
    },
    {
      id: "assistant-2",
      role: "assistant",
      createdAt: new Date("2026-08-30T01:18:02.000Z"),
      status: { type: "running" },
      content: [
        {
          type: "text",
          text: "I’ve kept the correction scoped to the adapter and preserved the native session.",
        },
        {
          type: "tool-call",
          toolCallId: "tool-message-builder",
          toolName: "send_message",
          args: {
            agentId: "builder",
            message:
              "Repair cancellation acknowledgement only. Preserve the current native session and existing lifecycle translation.",
          },
        },
      ],
    },
  ];
}
