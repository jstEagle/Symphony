import {
  AgentMessageInputSchema,
  type AgentMessageDecision,
  type AgentMessageInput,
  type AgentMessageReceipt,
  type AgentMessageReceiptInput,
  type AgentMessageRecord,
  type AgentMessageSnapshot,
} from "@symphony/protocol";
import {
  AgentMessageStore,
  type AgentMessageAppendResult,
  type AgentMessageStorageTarget,
  type AgentMessageListOptions,
  type AgentMessageReceiptResult,
} from "@symphony/storage";

/**
 * This is intentionally a small, transport-neutral boundary. HTTP, MCP, the
 * CLI, and a future worker-host adapter can all bind their authenticated
 * principal to `actorId` before entering this service. Message sender IDs are
 * data supplied by the caller and are never used as authentication.
 */
export type AgentMessageApiAuthority = Readonly<{
  canAppend?: (actorId: string, input: AgentMessageInput) => boolean | void;
  /** Alias kept for parity with the workflow bus authority boundary. */
  canSend?: (actorId: string, input: AgentMessageInput) => boolean | void;
  canRead?: (actorId: string, message: AgentMessageRecord) => boolean | void;
  canHandle?: (actorId: string, message: AgentMessageRecord, decision: AgentMessageDecision) => boolean | void;
  canCancel?: (actorId: string, message: AgentMessageRecord) => boolean | void;
  canExpire?: (actorId: string, message: AgentMessageRecord) => boolean | void;
}>;

export type AgentMessageApiActor = string | Readonly<{ actorId: string }>;

export type AgentMessageApiRequest = Readonly<{
  input: AgentMessageInput;
  actorId: string;
}>;

type AgentMessageApiMessageRequest = Readonly<{
  message: AgentMessageInput;
  actorId: string;
}>;

export type AgentMessageApiReceiptOptions = Readonly<{
  requestKey: string;
  actorId: string;
  recordedAt: string;
  reason?: string | null;
}>;

export type AgentMessageApiDeliveryOptions = AgentMessageApiReceiptOptions & Readonly<{
  state?: "delivered" | "failed";
}>;

export type AgentMessageApiUnknownOptions = AgentMessageApiReceiptOptions & Readonly<{
  reason: string;
}>;

export type AgentMessageApiHandleOptions = AgentMessageApiReceiptOptions & Readonly<{
  decision: AgentMessageDecision;
}>;

export type AgentMessageApiCursorSnapshot = Readonly<{
  messageCursor: number;
  receiptCursor: number;
}>;

export class AgentMessageApiAuthorizationError extends Error {
  constructor(message = "Agent message operation is not authorized.") {
    super(message);
    this.name = "AgentMessageApiAuthorizationError";
  }
}

export class AgentMessageApiClosedError extends Error {
  constructor() {
    super("Agent message API is closed.");
    this.name = "AgentMessageApiClosedError";
  }
}

export type AgentMessageApiOptions = Readonly<{
  store?: AgentMessageStore;
  storage?: AgentMessageStorageTarget;
  authority: AgentMessageApiAuthority;
  /** A supplied store remains caller-owned unless this is explicitly true. */
  closeStore?: boolean;
}>;

type ReadOptions = AgentMessageListOptions & { actorId: string };

function actorIdOf(actor: AgentMessageApiActor | undefined): string {
  const actorId = typeof actor === "string" ? actor : actor?.actorId;
  if (!actorId || actorId.trim().length === 0) {
    throw new AgentMessageApiAuthorizationError("An explicit actorId is required for agent message operations.");
  }
  return actorId;
}

function requestKeyOf(requestKey: string): string {
  if (typeof requestKey !== "string" || requestKey.trim().length === 0) {
    throw new Error("An explicit requestKey is required for agent message operations.");
  }
  return requestKey;
}

/**
 * Daemon-neutral API adapter for the typed, durable agent message bus.
 *
 * The adapter deliberately returns the store's `committed`, `replayed`, and
 * `conflict` statuses unchanged. In particular, an `unknown` delivery is a
 * durable receipt state and is never presented as successful delivery.
 */
export class AgentMessageApiAdapter {
  readonly store: AgentMessageStore;
  readonly authority: AgentMessageApiAuthority;
  private readonly closeStore: boolean;
  private closed = false;

  constructor(store: AgentMessageStore, authority: AgentMessageApiAuthority, closeStore?: boolean);
  constructor(options: AgentMessageApiOptions);
  constructor(
    storeOrOptions: AgentMessageStore | AgentMessageApiOptions,
    authority?: AgentMessageApiAuthority,
    closeStore = false,
  ) {
    if (storeOrOptions instanceof AgentMessageStore) {
      this.store = storeOrOptions;
      this.authority = authority ?? {};
      this.closeStore = closeStore;
    } else {
      this.store = storeOrOptions.store ?? new AgentMessageStore(storeOrOptions.storage ?? ":memory:");
      this.authority = storeOrOptions.authority;
      this.closeStore = storeOrOptions.closeStore ?? !storeOrOptions.store;
    }
  }

  append(input: AgentMessageInput, actor: AgentMessageApiActor): AgentMessageAppendResult;
  append(request: AgentMessageApiRequest | AgentMessageApiMessageRequest): AgentMessageAppendResult;
  append(inputOrRequest: AgentMessageInput | AgentMessageApiRequest | AgentMessageApiMessageRequest, actor?: AgentMessageApiActor): AgentMessageAppendResult {
    this.assertOpen();
    const request = "input" in inputOrRequest
      ? inputOrRequest
      : "message" in inputOrRequest
        ? { input: inputOrRequest.message, actorId: inputOrRequest.actorId }
      : { input: inputOrRequest, actorId: actorIdOf(actor) };
    const actorId = actorIdOf(request.actorId);
    const input = AgentMessageInputSchema.parse(request.input);
    this.authorizeAppend(actorId, input);
    return this.store.append(input);
  }

  send(input: AgentMessageInput, actor: AgentMessageApiActor): AgentMessageAppendResult {
    return this.append(input, actor);
  }

  get(messageId: string, actor: AgentMessageApiActor): AgentMessageSnapshot | null {
    this.assertOpen();
    const message = this.store.getMessage(messageId);
    if (!message) return null;
    this.authorizeRead(actorIdOf(actor), message);
    return this.store.getSnapshot(messageId);
  }

  getMessage(messageId: string, actor: AgentMessageApiActor): AgentMessageRecord | null {
    this.assertOpen();
    const message = this.store.getMessage(messageId);
    if (!message) return null;
    this.authorizeRead(actorIdOf(actor), message);
    return message;
  }

  list(actor: AgentMessageApiActor, options?: AgentMessageListOptions): AgentMessageRecord[];
  list(options: ReadOptions): AgentMessageRecord[];
  list(actorOrOptions: AgentMessageApiActor | ReadOptions, options: AgentMessageListOptions = {}): AgentMessageRecord[] {
    this.assertOpen();
    const actorId = typeof actorOrOptions === "object" && "actorId" in actorOrOptions
      ? actorIdOf(actorOrOptions)
      : actorIdOf(actorOrOptions as AgentMessageApiActor);
    const listOptions = typeof actorOrOptions === "object" && "actorId" in actorOrOptions
      ? { ...actorOrOptions } as AgentMessageListOptions
      : options;
    return this.store.list(listOptions).map((message) => {
      this.authorizeRead(actorId, message);
      return message;
    });
  }

  listMessages(actor: AgentMessageApiActor, options?: AgentMessageListOptions): AgentMessageRecord[] {
    return this.list(actor, options);
  }

  replay(afterCursor: number, actor: AgentMessageApiActor, options: Omit<AgentMessageListOptions, "afterCursor"> = {}): { messages: AgentMessageRecord[]; cursor: number; hasMore: boolean } {
    const messages = this.list(actor, { ...options, afterCursor });
    const cursor = messages.at(-1)?.cursor ?? afterCursor;
    const limit = options.limit ?? 500;
    return { messages, cursor, hasMore: messages.length >= limit };
  }

  deliver(messageId: string, options: AgentMessageApiDeliveryOptions): AgentMessageReceiptResult {
    this.assertOpen();
    const message = this.requireMessage(messageId);
    const actorId = actorIdOf(options.actorId);
    requestKeyOf(options.requestKey);
    this.authorizeRead(actorId, message);
    return this.store.markDelivered(messageId, {
      version: 1,
      requestKey: options.requestKey,
      recipientId: message.recipientId,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? null,
      decision: null,
      state: options.state ?? "delivered",
    });
  }

  markDelivered(messageId: string, options: AgentMessageApiDeliveryOptions): AgentMessageReceiptResult {
    return this.deliver(messageId, options);
  }

  failed(messageId: string, options: AgentMessageApiReceiptOptions): AgentMessageReceiptResult {
    return this.deliver(messageId, { ...options, state: "failed" });
  }

  markDeliveryFailed(messageId: string, options: AgentMessageApiReceiptOptions): AgentMessageReceiptResult {
    return this.failed(messageId, options);
  }

  unknown(messageId: string, options: AgentMessageApiUnknownOptions): AgentMessageReceiptResult {
    this.assertOpen();
    const message = this.requireMessage(messageId);
    const actorId = actorIdOf(options.actorId);
    requestKeyOf(options.requestKey);
    this.authorizeRead(actorId, message);
    return this.store.markDeliveryUnknown(messageId, {
      version: 1,
      requestKey: options.requestKey,
      recipientId: message.recipientId,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason,
      decision: null,
    });
  }

  markDeliveryUnknown(messageId: string, options: AgentMessageApiUnknownOptions): AgentMessageReceiptResult {
    return this.unknown(messageId, options);
  }

  markUnknownDelivery(messageId: string, options: AgentMessageApiUnknownOptions): AgentMessageReceiptResult {
    return this.unknown(messageId, options);
  }

  read(messageId: string, options: AgentMessageApiReceiptOptions): AgentMessageReceiptResult {
    this.assertOpen();
    const message = this.requireMessage(messageId);
    const actorId = actorIdOf(options.actorId);
    requestKeyOf(options.requestKey);
    this.authorizeRead(actorId, message);
    return this.store.markRead(messageId, {
      version: 1,
      requestKey: options.requestKey,
      recipientId: message.recipientId,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? null,
      decision: null,
    });
  }

  markRead(messageId: string, options: AgentMessageApiReceiptOptions): AgentMessageReceiptResult {
    return this.read(messageId, options);
  }

  handled(messageId: string, options: AgentMessageApiHandleOptions): AgentMessageReceiptResult {
    this.assertOpen();
    const message = this.requireMessage(messageId);
    const actorId = actorIdOf(options.actorId);
    requestKeyOf(options.requestKey);
    const callback = this.authority.canHandle;
    if (!callback) throw new AgentMessageApiAuthorizationError("An explicit canHandle authority callback is required.");
    if (callback(actorId, message, options.decision) === false) {
      throw new AgentMessageApiAuthorizationError("Agent message handling is not authorized for this parent/objective.");
    }
    return this.store.markHandled(messageId, {
      version: 1,
      requestKey: options.requestKey,
      recipientId: message.recipientId,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? null,
      decision: options.decision,
    });
  }

  handle(messageId: string, options: AgentMessageApiHandleOptions): AgentMessageReceiptResult {
    return this.handled(messageId, options);
  }

  markHandled(messageId: string, options: AgentMessageApiHandleOptions): AgentMessageReceiptResult {
    return this.handled(messageId, options);
  }

  cancel(messageId: string, options: AgentMessageApiReceiptOptions): AgentMessageReceiptResult {
    this.assertOpen();
    const message = this.requireMessage(messageId);
    const actorId = actorIdOf(options.actorId);
    requestKeyOf(options.requestKey);
    const callback = this.authority.canCancel ?? ((id: string, record: AgentMessageRecord) => this.authority.canHandle?.(id, record, "cancelled"));
    if (!callback) throw new AgentMessageApiAuthorizationError("An explicit canCancel authority callback is required.");
    if (callback(actorId, message) === false) throw new AgentMessageApiAuthorizationError("Agent message cancellation is not authorized.");
    return this.store.cancelMessage(messageId, {
      version: 1,
      requestKey: options.requestKey,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? "Message cancellation requested.",
      decision: "cancelled",
    });
  }

  expire(messageId: string, options: AgentMessageApiReceiptOptions): AgentMessageReceiptResult {
    this.assertOpen();
    const message = this.requireMessage(messageId);
    const actorId = actorIdOf(options.actorId);
    requestKeyOf(options.requestKey);
    const callback = this.authority.canExpire;
    if (!callback) throw new AgentMessageApiAuthorizationError("An explicit canExpire authority callback is required.");
    if (callback(actorId, message) === false) throw new AgentMessageApiAuthorizationError("Agent message expiry is not authorized.");
    return this.store.expireMessage(messageId, {
      version: 1,
      requestKey: options.requestKey,
      actorId,
      recordedAt: options.recordedAt,
      reason: options.reason ?? "Message expiry reached.",
      decision: null,
    });
  }

  expireDue(now: string, options: Readonly<{ actorId: string; requestPrefix: string; limit?: number }>): AgentMessageReceipt[] {
    this.assertOpen();
    const actorId = actorIdOf(options.actorId);
    requestKeyOf(options.requestPrefix);
    const limit = Math.max(1, Math.min(options.limit ?? 500, 10_000));
    const due = this.store.list({ limit: 10_000 })
      .filter((message) => message.expiresAt !== null && message.expiresAt <= now)
      .filter((message) => {
        const state = this.store.messageState(message.id);
        return state !== "expired" && state !== "cancelled" && state !== "handled";
      })
      .slice(0, limit);
    const receipts: AgentMessageReceipt[] = [];
    for (const message of due) {
      const result = this.expire(message.id, {
        actorId,
        requestKey: `${options.requestPrefix}:${message.id}`,
        recordedAt: now,
        reason: "Message expiry reached.",
      });
      if (result.receipt) receipts.push(result.receipt);
    }
    return receipts;
  }

  sweepExpired(now: string, options: Readonly<{ actorId: string; requestPrefix: string; limit?: number }>): AgentMessageReceipt[] {
    return this.expireDue(now, options);
  }

  receipt(input: AgentMessageReceiptInput, actor?: AgentMessageApiActor): AgentMessageReceiptResult {
    this.assertOpen();
    const actorId = actorIdOf(actor ?? input.actorId ?? undefined);
    requestKeyOf(input.requestKey);
    const message = this.requireMessage(input.messageId);
    if (input.actorId !== null && input.actorId !== actorId) {
      throw new AgentMessageApiAuthorizationError("Receipt actorId must match the authenticated actor.");
    }
    if (input.kind === "handled") {
      const callback = this.authority.canHandle;
      if (!callback) throw new AgentMessageApiAuthorizationError("An explicit canHandle authority callback is required.");
      if (callback(actorId, message, input.decision as AgentMessageDecision) === false) throw new AgentMessageApiAuthorizationError("Agent message handling is not authorized.");
    } else if (input.kind === "expiry") {
      const callback = this.authority.canExpire;
      if (!callback) throw new AgentMessageApiAuthorizationError("An explicit canExpire authority callback is required.");
      if (callback(actorId, message) === false) throw new AgentMessageApiAuthorizationError("Agent message expiry is not authorized.");
    } else if (input.kind === "cancellation") {
      const callback = this.authority.canCancel;
      if (!callback) throw new AgentMessageApiAuthorizationError("An explicit canCancel authority callback is required.");
      if (callback(actorId, message) === false) throw new AgentMessageApiAuthorizationError("Agent message cancellation is not authorized.");
    } else {
      this.authorizeRead(actorId, message);
    }
    return this.store.appendReceipt({ ...input, actorId });
  }

  cursorSnapshot(): AgentMessageApiCursorSnapshot {
    this.assertOpen();
    return { messageCursor: this.store.latestCursor(), receiptCursor: this.store.latestReceiptCursor() };
  }

  getCursorSnapshot(): AgentMessageApiCursorSnapshot {
    return this.cursorSnapshot();
  }

  snapshot(): AgentMessageApiCursorSnapshot {
    return this.cursorSnapshot();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeStore) this.store.close();
  }

  private authorizeAppend(actorId: string, input: AgentMessageInput): void {
    const callback = this.authority.canAppend ?? this.authority.canSend;
    if (!callback) throw new AgentMessageApiAuthorizationError("An explicit canAppend authority callback is required.");
    if (callback(actorId, input) === false) throw new AgentMessageApiAuthorizationError("Agent message append is not authorized for this objective/run.");
  }

  private authorizeRead(actorId: string, message: AgentMessageRecord): void {
    const callback = this.authority.canRead;
    if (!callback) throw new AgentMessageApiAuthorizationError("An explicit canRead authority callback is required.");
    if (callback(actorId, message) === false) throw new AgentMessageApiAuthorizationError("Agent message inspection is not authorized.");
  }

  private requireMessage(messageId: string): AgentMessageRecord {
    const message = this.store.getMessage(messageId);
    if (!message) throw new Error(`Agent message not found: ${messageId}`);
    return message;
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentMessageApiClosedError();
  }
}

export { AgentMessageApiAdapter as AgentMessageService };
