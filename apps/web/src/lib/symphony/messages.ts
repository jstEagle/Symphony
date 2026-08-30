import type { CompleteAttachment, ThreadMessageLike } from "@assistant-ui/react";
import type { ConversationMessage, JsonValue, RunSnapshot, ConversationSummary } from "./contracts";

export function toThreadMessages(messages: ConversationMessage[]): ThreadMessageLike[] {
  return messages.map((message) => {
    const role = message.role === "tool" ? "assistant" : message.role;
    const attachmentParts = message.parts.filter(isAttachmentPart);
    const contentParts = message.parts.filter((part) => !isAttachmentPart(part));
    const attachments: CompleteAttachment[] = attachmentParts.map((part) => {
      const record = part as Record<string, JsonValue>;
      return {
        id: typeof record.id === "string" ? record.id : crypto.randomUUID(),
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
      content: partsToContent(contentParts),
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

function isAttachmentPart(part: JsonValue): boolean {
  return Boolean(part && typeof part === "object" && !Array.isArray(part) && part.type === "attachment");
}

function partsToContent(parts: JsonValue[]): ThreadMessageLike["content"] {
  if (!parts.length) return "";
  const mapped = parts.map((part) => {
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
      return {
        type: "tool-call" as const,
        toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : crypto.randomUUID(),
        toolName: record.toolName,
        args:
          record.args && typeof record.args === "object" && !Array.isArray(record.args)
            ? (record.args as Record<string, JsonValue>)
            : {},
        result: record.result,
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
