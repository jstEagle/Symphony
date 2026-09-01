import {
  type AgentMessageDecision,
  type AgentMessageInput,
  type AgentMessageReceiptInput,
  type AgentMessageRecord,
  type AgentMessageSnapshot,
  type AgentMessageActor,
  sanitizeAgentMessageInput,
} from "@symphony/protocol";
import {
  AgentMessageStore,
  type AgentMessageAppendResult,
  type AgentMessageListOptions,
  type AgentMessageReceiptResult,
} from "@symphony/storage";

export type AgentMessagePrincipal = string | AgentMessageActor;

export type AgentMessageAuthority = Readonly<{
  /** The daemon/authenticator may bind a principal to this direct bus handle. */
  principal?: AgentMessagePrincipal;
  /** Throw or return false to reject a message before it reaches storage. */
  canSend?: (message: AgentMessageInput, principal: string) => boolean | void;
  canRead?: (message: AgentMessageRecord, principal: string) => boolean | void;
  canHandle?: (message: AgentMessageRecord, principal: string, decision: AgentMessageDecision) => boolean | void;
  canExpire?: (message: AgentMessageRecord, principal: string) => boolean | void;
}>;

export type AgentMessageReceiptOptions = Readonly<{
  requestKey: string;
  /** An authenticated principal is mandatory unless the bus has one bound. */
  actorId?: string | null;
  recordedAt: string;
  reason?: string | null;
}>;

export type AgentMessageDeliveryOptions = AgentMessageReceiptOptions & {
  state?: "delivered" | "failed";
};

export type AgentMessageUnknownOptions = AgentMessageReceiptOptions & { reason: string };

export type AgentMessageHandleOptions = AgentMessageReceiptOptions & { decision: AgentMessageDecision };

export type AgentMessageReplay = Readonly<{
  messages: AgentMessageRecord[];
  cursor: number;
  hasMore: boolean;
}>;

/**
 * Workflow-facing domain service for semantic inter-agent packets.
 *
 * The bus is deliberately a thin authority boundary: it validates lineage,
 * delegates durable replay fencing to AgentMessageStore, and requires an
 * explicit decision when a parent handles a message. It does not synthesize
 * parent decisions from delivery, nor does it project native transcripts into
 * this protocol.
 */
export class AgentMessageBus {
  private readonly boundPrincipal: AgentMessagePrincipal | undefined;

  constructor(
    readonly store: AgentMessageStore,
    readonly authority: AgentMessageAuthority = {},
    principal?: AgentMessagePrincipal,
  ) {
    this.boundPrincipal = principal ?? authority.principal;
  }

  send(input: AgentMessageInput, principal?: AgentMessagePrincipal): AgentMessageAppendResult {
    const message = sanitizeAgentMessageInput(input);
    const actor = this.requirePrincipal(principal);
    const callback = this.authority.canSend;
    if (!callback) throw new Error("An explicit canSend authority callback is required for direct agent message callers.");
    const allowed = callback(message, actor);
    if (allowed === false) throw new Error("Agent message sender is not authorized for this objective/run.");
    return this.store.append(message);
  }

  append(input: AgentMessageInput, principal?: AgentMessagePrincipal): AgentMessageAppendResult {
    return this.send(input, principal);
  }

  sendMessage(input: AgentMessageInput, principal?: AgentMessagePrincipal): AgentMessageAppendResult {
    return this.send(input, principal);
  }

  publish(input: AgentMessageInput, principal?: AgentMessagePrincipal): AgentMessageAppendResult {
    return this.send(input, principal);
  }

  sendFinding(input: Omit<AgentMessageInput, "kind">, principal?: AgentMessagePrincipal): AgentMessageAppendResult {
    return this.send({ ...input, kind: "finding" }, principal);
  }

  sendQuestion(input: Omit<AgentMessageInput, "kind">, principal?: AgentMessagePrincipal): AgentMessageAppendResult {
    return this.send({ ...input, kind: "question" }, principal);
  }

  sendStatus(input: Omit<AgentMessageInput, "kind">, principal?: AgentMessagePrincipal): AgentMessageAppendResult {
    return this.send({ ...input, kind: "status" }, principal);
  }

  sendHandoff(input: Omit<AgentMessageInput, "kind">, principal?: AgentMessagePrincipal): AgentMessageAppendResult {
    return this.send({ ...input, kind: "handoff" }, principal);
  }

  sendControlRequest(input: Omit<AgentMessageInput, "kind">, principal?: AgentMessagePrincipal): AgentMessageAppendResult {
    return this.send({ ...input, kind: "control-request" }, principal);
  }

  get(messageId: string, principal?: AgentMessagePrincipal): AgentMessageSnapshot | null {
    const message = this.store.getMessage(messageId);
    if (!message) return null;
    this.authorizeRead(message, this.requirePrincipal(principal));
    return this.store.getSnapshot(messageId);
  }

  list(optionsOrPrincipal: AgentMessageListOptions | AgentMessagePrincipal = {}, principalOrOptions?: AgentMessagePrincipal | AgentMessageListOptions): AgentMessageRecord[] {
    const firstIsPrincipal = this.isPrincipal(optionsOrPrincipal);
    const actor = this.requirePrincipal(firstIsPrincipal ? optionsOrPrincipal : principalOrOptions as AgentMessagePrincipal | undefined);
    const options = (firstIsPrincipal ? principalOrOptions : optionsOrPrincipal) as AgentMessageListOptions | undefined;
    const messages = this.store.list(options ?? {});
    for (const message of messages) this.authorizeRead(message, actor);
    return messages;
  }

  replay(afterCursor = 0, optionsOrPrincipal: (Omit<AgentMessageListOptions, "afterCursor"> & { limit?: number }) | AgentMessagePrincipal = {}, principalOrOptions?: AgentMessagePrincipal | (Omit<AgentMessageListOptions, "afterCursor"> & { limit?: number })): AgentMessageReplay {
    const firstIsPrincipal = this.isPrincipal(optionsOrPrincipal);
    const principal = firstIsPrincipal ? optionsOrPrincipal : principalOrOptions as AgentMessagePrincipal | undefined;
    const options = (firstIsPrincipal ? principalOrOptions : optionsOrPrincipal) as (Omit<AgentMessageListOptions, "afterCursor"> & { limit?: number }) | undefined;
    const messages = this.list({ ...(options ?? {}), afterCursor }, principal);
    const cursor = messages.at(-1)?.cursor ?? afterCursor;
    const limit = options?.limit ?? 500;
    return { messages, cursor, hasMore: messages.length >= limit };
  }

  deliver(messageId: string, options: AgentMessageDeliveryOptions): AgentMessageReceiptResult {
    const message = this.requireMessage(messageId);
    const actorId = this.requirePrincipal(options.actorId);
    this.authorizeRead(message, actorId);
    return this.store.markDelivered(messageId, {
      requestKey: options.requestKey,
      recipientId: message.recipientId,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? null,
      decision: null,
      state: options.state ?? "delivered",
    });
  }

  markDeliveryUnknown(messageId: string, options: AgentMessageUnknownOptions): AgentMessageReceiptResult {
    const message = this.requireMessage(messageId);
    const actorId = this.requirePrincipal(options.actorId);
    this.authorizeRead(message, actorId);
    return this.store.markDeliveryUnknown(messageId, {
      requestKey: options.requestKey,
      recipientId: message.recipientId,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason,
      decision: null,
    });
  }

  markUnknownDelivery(messageId: string, options: AgentMessageUnknownOptions): AgentMessageReceiptResult {
    return this.markDeliveryUnknown(messageId, options);
  }

  read(messageId: string, options: AgentMessageReceiptOptions): AgentMessageReceiptResult {
    const message = this.requireMessage(messageId);
    const actorId = this.requirePrincipal(options.actorId);
    this.authorizeRead(message, actorId);
    return this.store.markRead(messageId, {
      requestKey: options.requestKey,
      recipientId: message.recipientId,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? null,
      decision: null,
    });
  }

  markRead(messageId: string, options: AgentMessageReceiptOptions): AgentMessageReceiptResult {
    return this.read(messageId, options);
  }

  /** Handling is a parent decision and therefore always requires `decision`. */
  handle(messageId: string, options: AgentMessageHandleOptions): AgentMessageReceiptResult {
    const message = this.requireMessage(messageId);
    const actorId = this.requirePrincipal(options.actorId);
    const callback = this.authority.canHandle;
    if (!callback) throw new Error("An explicit canHandle authority callback is required for direct agent message callers.");
    const allowed = callback(message, actorId, options.decision);
    if (allowed === false) throw new Error("Agent message handler is not authorized for this parent/objective.");
    return this.store.markHandled(messageId, {
      requestKey: options.requestKey,
      recipientId: message.recipientId,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? null,
      decision: options.decision,
    });
  }

  markHandled(messageId: string, options: AgentMessageHandleOptions): AgentMessageReceiptResult {
    return this.handle(messageId, options);
  }

  cancel(messageId: string, options: AgentMessageReceiptOptions): AgentMessageReceiptResult {
    const message = this.requireMessage(messageId);
    const actorId = this.requirePrincipal(options.actorId);
    const callback = this.authority.canHandle;
    if (!callback) throw new Error("An explicit canHandle authority callback is required for direct agent message callers.");
    const allowed = callback(message, actorId, "cancelled");
    if (allowed === false) throw new Error("Agent message cancellation is not authorized.");
    return this.store.cancelMessage(messageId, {
      requestKey: options.requestKey,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? "Message cancellation requested.",
      decision: "cancelled",
    });
  }

  expire(messageId: string, options: AgentMessageReceiptOptions): AgentMessageReceiptResult {
    const message = this.requireMessage(messageId);
    const actorId = this.requirePrincipal(options.actorId);
    const callback = this.authority.canExpire;
    if (!callback) throw new Error("An explicit canExpire authority callback is required for direct agent message callers.");
    if (callback(message, actorId) === false) throw new Error("Agent message expiry is not authorized.");
    return this.store.expireMessage(messageId, {
      requestKey: options.requestKey,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? "Message expiry reached.",
      decision: null,
    });
  }

  expireDue(now: string, options: { limit?: number; requestPrefix?: string; actorId?: string | null } = {}) {
    const actorId = this.requirePrincipal(options.actorId);
    const due = this.store.list({ limit: Math.max(1, Math.min(options.limit ?? 500, 10_000)) })
      .filter((message) => message.expiresAt !== null && message.expiresAt <= now)
      .filter((message) => !["expired", "cancelled", "handled"].includes(this.store.messageState(message.id) ?? ""));
    const receipts: AgentMessageReceiptResult["receipt"][] = [];
    for (const message of due) {
      const result = this.expire(message.id, {
        requestKey: `${options.requestPrefix ?? "agent-message-expiry"}:${message.id}`,
        actorId,
        recordedAt: now,
        reason: "Message expiry reached.",
      });
      if (result.receipt) receipts.push(result.receipt);
    }
    return receipts.filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== null);
  }

  receipt(input: AgentMessageReceiptInput): AgentMessageReceiptResult {
    const message = this.requireMessage(input.messageId);
    const actorId = this.requirePrincipal(input.actorId);
    if (input.kind === "handled") {
      const callback = this.authority.canHandle;
      if (!callback) throw new Error("An explicit canHandle authority callback is required for direct agent message callers.");
      const allowed = callback(message, actorId, input.decision as AgentMessageDecision);
      if (allowed === false) throw new Error("Agent message handler is not authorized for this parent/objective.");
    } else if (input.kind === "expiry") {
      const callback = this.authority.canExpire;
      if (!callback) throw new Error("An explicit canExpire authority callback is required for direct agent message callers.");
      if (callback(message, actorId) === false) throw new Error("Agent message expiry is not authorized.");
    } else if (input.kind === "cancellation") {
      const callback = this.authority.canHandle;
      if (!callback) throw new Error("An explicit canHandle authority callback is required for direct agent message callers.");
      if (callback(message, actorId, "cancelled") === false) throw new Error("Agent message cancellation is not authorized.");
    } else {
      this.authorizeRead(message, actorId);
    }
    return this.store.appendReceipt({ ...input, actorId });
  }

  private requireMessage(messageId: string): AgentMessageRecord {
    const message = this.store.getMessage(messageId);
    if (!message) throw new Error(`Agent message not found: ${messageId}`);
    return message;
  }

  private authorizeRead(message: AgentMessageRecord, actorId: string): void {
    const callback = this.authority.canRead;
    if (!callback) throw new Error("An explicit canRead authority callback is required for direct agent message callers.");
    const allowed = callback(message, actorId);
    if (allowed === false) throw new Error("Agent message recipient is not authorized to inspect this message.");
  }

  private requirePrincipal(principal?: AgentMessagePrincipal | null): string {
    const candidate = principal ?? this.boundPrincipal;
    const id = typeof candidate === "string" ? candidate : candidate?.id;
    if (!id || id.trim().length === 0) throw new Error("An explicit authenticated principal is required for direct agent message callers.");
    return id;
  }

  private isPrincipal(value: unknown): value is AgentMessagePrincipal {
    return typeof value === "string"
      || (typeof value === "object" && value !== null && "id" in value && "type" in value);
  }
}

export { AgentMessageBus as DurableAgentMessageBus };
