import type {
  ChatAttachment,
  ConversationMessage,
} from "./contracts";

export const CHAT_OUTBOX_STORAGE_KEY = "symphony.chat-outbox.v1";

export type PendingChatSend = {
  version: 1;
  messageId: string;
  threadId: string;
  content: string;
  attachments: ChatAttachment[];
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
};

type ReadableStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "length" | "key">>;
type WritableStorage = ReadableStorage & Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">>;

export function createPendingChatSend(input: {
  messageId: string;
  threadId: string;
  content: string;
  attachments: ChatAttachment[];
  createdAt?: string;
}): PendingChatSend {
  return {
    version: 1,
    messageId: input.messageId,
    threadId: input.threadId,
    content: input.content,
    attachments: input.attachments,
    createdAt: input.createdAt ?? new Date().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  };
}

export function readPendingChatSends(
  storage: ReadableStorage | null = browserStorage(),
): PendingChatSend[] {
  if (!storage) return [];
  const byId = new Map<string, PendingChatSend>();
  try {
    const legacy = JSON.parse(storage.getItem(CHAT_OUTBOX_STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(legacy)) {
      for (const entry of legacy) if (isPendingChatSend(entry)) byId.set(entry.messageId, entry);
    }
  } catch {
    // Ignore a malformed legacy aggregate and continue with per-message keys.
  }
  if (typeof storage.length === "number" && typeof storage.key === "function") {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(`${CHAT_OUTBOX_STORAGE_KEY}:`)) continue;
      try {
        const entry = JSON.parse(storage.getItem(key) ?? "null") as unknown;
        if (isPendingChatSend(entry)) byId.set(entry.messageId, entry);
      } catch {
        // One corrupt window entry must not hide unrelated pending turns.
      }
    }
  }
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function writePendingChatSends(
  sends: readonly PendingChatSend[],
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CHAT_OUTBOX_STORAGE_KEY, JSON.stringify({ version: 1, storage: "per-message" }));
    for (const pending of sends) storage.setItem(pendingChatSendStorageKey(pending.messageId), JSON.stringify(pending));
  } catch {
    // A blocked or full browser store must not prevent the daemon request. The
    // current page still retains the optimistic entry in React state.
  }
}

export function writePendingChatSend(
  pending: PendingChatSend,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(pendingChatSendStorageKey(pending.messageId), JSON.stringify(pending));
  } catch {
    // Preserve the in-memory optimistic state when browser storage is blocked.
  }
}

export function deletePendingChatSend(
  messageId: string,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage?.removeItem) return;
  try {
    storage.removeItem(pendingChatSendStorageKey(messageId));
  } catch {
    // A later reconciliation pass can still remove the stale visual entry.
  }
}

export function putPendingChatSend(
  sends: readonly PendingChatSend[],
  pending: PendingChatSend,
): PendingChatSend[] {
  const existing = sends.find((entry) => entry.messageId === pending.messageId);
  if (existing && pendingPayload(existing) !== pendingPayload(pending)) {
    throw new Error(`Pending message id ${pending.messageId} is already bound to another chat payload.`);
  }
  return existing
    ? sends.map((entry) => entry.messageId === pending.messageId ? existing : entry)
    : [...sends, pending].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function removePendingChatSend(
  sends: readonly PendingChatSend[],
  messageId: string,
): PendingChatSend[] {
  return sends.filter((entry) => entry.messageId !== messageId);
}

export function markPendingChatSendAttempt(
  sends: readonly PendingChatSend[],
  messageId: string,
  error: unknown,
  attemptedAt = new Date().toISOString(),
): PendingChatSend[] {
  return sends.map((entry) => entry.messageId === messageId
    ? {
        ...entry,
        attempts: entry.attempts + 1,
        lastAttemptAt: attemptedAt,
        lastError: error instanceof Error ? error.message : String(error),
      }
    : entry);
}

export function pendingChatSendToConversationMessage(pending: PendingChatSend): ConversationMessage {
  return {
    id: pending.messageId,
    threadId: pending.threadId,
    role: "user",
    parts: [
      ...(pending.content.trim() ? [{ type: "text", text: pending.content }] : []),
      ...pending.attachments.map((attachment) => ({
        type: "attachment",
        id: attachment.id,
        name: attachment.name,
        attachmentType: attachment.type,
        contentType: attachment.contentType ?? null,
        content: attachment.content,
      })),
    ],
    createdAt: pending.createdAt,
  };
}

export type PendingChatSendReconciliation =
  | { status: "acknowledged" }
  | { status: "retry"; error: unknown }
  | { status: "rejected"; error: unknown };

/**
 * Reconcile against the daemon's persisted thread before retrying. A client
 * that lost the POST response must never invent a second message id.
 */
export async function reconcilePendingChatSend(
  pending: PendingChatSend,
  dependencies: {
    fetchThread: (threadId: string) => Promise<{ messages: ConversationMessage[] }>;
    send: (threadId: string, input: Pick<PendingChatSend, "messageId" | "content" | "attachments">) => Promise<{ messageId: string }>;
    isRetryableError: (error: unknown) => boolean;
  },
): Promise<PendingChatSendReconciliation> {
  try {
    const detail = await dependencies.fetchThread(pending.threadId);
    if (detail.messages.some((message) => message.id === pending.messageId)) {
      return { status: "acknowledged" };
    }
  } catch (error) {
    return { status: "retry", error };
  }

  try {
    const receipt = await dependencies.send(pending.threadId, {
      messageId: pending.messageId,
      content: pending.content,
      attachments: pending.attachments,
    });
    if (receipt.messageId !== pending.messageId) {
      return {
        status: "retry",
        error: new Error(`The daemon acknowledged ${receipt.messageId} instead of ${pending.messageId}.`),
      };
    }
    return { status: "acknowledged" };
  } catch (error) {
    return dependencies.isRetryableError(error)
      ? { status: "retry", error }
      : { status: "rejected", error };
  }
}

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function pendingPayload(pending: PendingChatSend): string {
  return JSON.stringify([pending.threadId, pending.content, pending.attachments]);
}

function pendingChatSendStorageKey(messageId: string): string {
  return `${CHAT_OUTBOX_STORAGE_KEY}:${encodeURIComponent(messageId)}`;
}

function isPendingChatSend(value: unknown): value is PendingChatSend {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PendingChatSend>;
  return candidate.version === 1
    && typeof candidate.messageId === "string"
    && candidate.messageId.length > 0
    && typeof candidate.threadId === "string"
    && candidate.threadId.length > 0
    && typeof candidate.content === "string"
    && Array.isArray(candidate.attachments)
    && candidate.attachments.every(isChatAttachment)
    && typeof candidate.createdAt === "string"
    && Number.isInteger(candidate.attempts)
    && Number(candidate.attempts) >= 0
    && (candidate.lastAttemptAt === null || typeof candidate.lastAttemptAt === "string")
    && (candidate.lastError === null || typeof candidate.lastError === "string");
}

function isChatAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ChatAttachment>;
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.name === "string"
    && candidate.name.length > 0
    && typeof candidate.type === "string"
    && candidate.type.length > 0
    && (candidate.contentType === undefined || typeof candidate.contentType === "string")
    && Array.isArray(candidate.content);
}
