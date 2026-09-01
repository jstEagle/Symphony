import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ulid } from "ulid";
import {
  AgentMessageReceiptInputSchema,
  AgentMessageReceiptSchema,
  AgentMessageRecordSchema,
  AgentMessageSnapshotSchema,
  assertAgentMessageJsonBounds,
  agentMessageStableStringify,
  sanitizeAgentMessageInput,
  type AgentMessageDecision,
  type AgentMessageDeliveryState,
  type AgentMessageInput,
  type AgentMessageReceipt,
  type AgentMessageReceiptInput,
  type AgentMessageRecord,
  type AgentMessageSnapshot,
} from "@symphony/protocol";

type Row = Record<string, unknown>;
type DatabaseOwner = { database: DatabaseSync };
export type AgentMessageStorageTarget = string | DatabaseSync | DatabaseOwner;

function agentMessageFingerprint(value: unknown): string {
  return createHash("sha256").update(agentMessageStableStringify(value), "utf8").digest("hex");
}

export type AgentMessageAppendResult = Readonly<{
  status: "committed" | "replayed" | "conflict";
  message: AgentMessageRecord | null;
  reason?: string;
}>;

export type AgentMessageReceiptResult = Readonly<{
  status: "committed" | "replayed" | "conflict";
  receipt: AgentMessageReceipt | null;
  reason?: string;
}>;

export type AgentMessageListOptions = Readonly<{
  afterCursor?: number;
  beforeCursor?: number;
  senderId?: string;
  recipientId?: string;
  objectiveId?: string;
  runId?: string;
  kind?: AgentMessageRecord["kind"];
  limit?: number;
}>;

/**
 * SQLite-backed append-only records for the typed inter-agent bus.
 *
 * This class deliberately owns tables prefixed with `agent_bus_`; it can be
 * opened against the existing Symphony database later without taking over the
 * legacy `agent_messages` projection. Message rows are never updated or
 * deleted. Delivery/read/handled/expiry/cancellation are separate immutable
 * receipt rows, which makes a restart and an outcome-unknown delivery visible.
 */
export class AgentMessageStore {
  readonly database: DatabaseSync;
  readonly path: string;
  private readonly ownsDatabase: boolean;

  constructor(target: AgentMessageStorageTarget = ":memory:") {
    if (typeof target === "string") {
      this.path = target === ":memory:" ? target : resolve(target);
      if (target !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
      this.database = new DatabaseSync(this.path);
      this.ownsDatabase = true;
    } else {
      this.database = "database" in target ? target.database : target;
      this.path = ":attached:";
      this.ownsDatabase = false;
    }
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_bus_messages (
        cursor INTEGER PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        id TEXT NOT NULL UNIQUE,
        request_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        sender_id TEXT,
        recipient_id TEXT,
        objective_id TEXT,
        run_id TEXT,
        kind TEXT
      );
    `);
    // Older development databases may have been created by the first draft
    // without denormalized filter columns. Add them without rewriting records.
    const columns = new Set((this.database.prepare("PRAGMA table_info(agent_bus_messages)").all() as Row[]).map((row) => String(row.name)));
    for (const [name, definition] of [["sender_id", "TEXT"], ["recipient_id", "TEXT"], ["objective_id", "TEXT"], ["run_id", "TEXT"], ["kind", "TEXT"]] as const) {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE agent_bus_messages ADD COLUMN ${name} ${definition}`);
    }
    this.backfillMessageIdentityColumns();
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS agent_bus_messages_recipient_cursor ON agent_bus_messages(recipient_id, cursor);
      CREATE INDEX IF NOT EXISTS agent_bus_messages_sender_cursor ON agent_bus_messages(sender_id, cursor);
      CREATE INDEX IF NOT EXISTS agent_bus_messages_objective_cursor ON agent_bus_messages(objective_id, cursor);
      CREATE INDEX IF NOT EXISTS agent_bus_messages_run_cursor ON agent_bus_messages(run_id, cursor);
      CREATE TABLE IF NOT EXISTS agent_bus_receipts (
        cursor INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        request_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        message_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        actor_id TEXT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        reason TEXT,
        decision TEXT,
        record_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES agent_bus_messages(id)
      );
      `);
    const receiptColumns = new Set((this.database.prepare("PRAGMA table_info(agent_bus_receipts)").all() as Row[]).map((row) => String(row.name)));
    if (!receiptColumns.has("actor_id")) this.database.exec("ALTER TABLE agent_bus_receipts ADD COLUMN actor_id TEXT");
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS agent_bus_receipts_message_cursor
        ON agent_bus_receipts(message_id, cursor);
    `);
  }

  /**
   * The first message table stored identity only inside record_json. Populate
   * filter columns from that durable value when opening such a database. A
   * malformed legacy row is left untouched so migration cannot invent an
   * identity or make an unsafe guess.
   */
  private backfillMessageIdentityColumns(): void {
    const rows = this.database.prepare(`
      SELECT cursor, record_json, sender_id, recipient_id, objective_id, run_id, kind
      FROM agent_bus_messages
      WHERE sender_id IS NULL OR sender_id = '' OR recipient_id IS NULL OR recipient_id = ''
        OR objective_id IS NULL OR objective_id = '' OR run_id IS NULL OR run_id = '' OR kind IS NULL OR kind = ''
    `).all() as Row[];
    if (rows.length === 0) return;
    const validKinds = new Set(["finding", "question", "status", "handoff", "control-request"]);
    const read = (record: Record<string, unknown>, ...keys: string[]): string | null => {
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0 && value.length <= 512) return value;
      }
      return null;
    };
    const update = this.database.prepare(`
      UPDATE agent_bus_messages
      SET sender_id = COALESCE(NULLIF(sender_id, ''), ?), recipient_id = COALESCE(NULLIF(recipient_id, ''), ?),
          objective_id = COALESCE(NULLIF(objective_id, ''), ?), run_id = COALESCE(NULLIF(run_id, ''), ?), kind = COALESCE(NULLIF(kind, ''), ?)
      WHERE cursor = ?
    `);
    for (const row of rows) {
      let record: Record<string, unknown>;
      try {
        const decoded = JSON.parse(String(row.record_json)) as unknown;
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) continue;
        record = decoded as Record<string, unknown>;
      } catch {
        continue;
      }
      const sender = read(record, "senderId", "sender");
      const recipient = read(record, "recipientId", "recipient");
      const objective = read(record, "objectiveId", "objective");
      const run = read(record, "runId", "run");
      const kindValue = read(record, "kind", "messageKind", "type");
      const kind = kindValue && validKinds.has(kindValue) ? kindValue : null;
      const existing = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;
      update.run(
        existing(row.sender_id) ?? sender,
        existing(row.recipient_id) ?? recipient,
        existing(row.objective_id) ?? objective,
        existing(row.run_id) ?? run,
        existing(row.kind) ?? kind,
        Number(row.cursor),
      );
    }
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }

  transaction<T>(callback: () => T): T {
    if (this.database.isTransaction) return callback();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Use FULL synchronous mode for the dispatch fence and its receipts. */
  durableTransaction<T>(callback: () => T): T {
    if (this.database.isTransaction) return callback();
    const row = this.database.prepare("PRAGMA synchronous").get() as Row;
    const previous = Number(row.synchronous ?? 1);
    this.database.exec("PRAGMA synchronous = FULL");
    try {
      return this.transaction(callback);
    } finally {
      this.database.exec(`PRAGMA synchronous = ${Number.isInteger(previous) ? previous : 1}`);
    }
  }

  append(input: AgentMessageInput): AgentMessageAppendResult {
    const parsed = sanitizeAgentMessageInput(input);
    const fingerprint = agentMessageFingerprint(parsed);
    return this.durableTransaction(() => {
      const byRequest = this.database.prepare("SELECT * FROM agent_bus_messages WHERE request_key = ?").get(parsed.requestKey) as Row | undefined;
      if (byRequest) {
        const existing = this.parseMessage(byRequest);
        if (String(byRequest.fingerprint) === fingerprint) return { status: "replayed", message: existing };
        return { status: "conflict", message: existing, reason: `Request key is bound to a different message: ${parsed.requestKey}` };
      }
      if (parsed.id) {
        const byId = this.database.prepare("SELECT * FROM agent_bus_messages WHERE id = ?").get(parsed.id) as Row | undefined;
        if (byId) {
          const existing = this.parseMessage(byId);
          return {
            status: "conflict",
            message: existing,
            reason: `Message id is already bound to a different request: ${parsed.id}`,
          };
        }
      }
      const sequenceRow = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_bus_messages").get() as Row;
      const sequence = Number(sequenceRow.sequence ?? 0) + 1;
      const cursorRow = this.database.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM agent_bus_messages").get() as Row;
      const cursor = Number(cursorRow.cursor ?? 0) + 1;
      const record = AgentMessageRecordSchema.parse({
        ...parsed,
        id: parsed.id ?? `agent-message:${ulid()}`,
        sequence,
        cursor,
      });
      // AgentMessageRecordSchema enforces the same bounds, but this explicit
      // check documents that the exact serialized durable record is bounded.
      assertAgentMessageJsonBounds(record, { label: "Agent message record", maxBytes: 256 * 1024 });
      const result = this.database.prepare(`
        INSERT INTO agent_bus_messages(
          cursor, sequence, id, request_key, fingerprint, record_json, created_at,
          expires_at, sender_id, recipient_id, objective_id, run_id, kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.cursor,
        record.sequence,
        record.id,
        record.requestKey,
        fingerprint,
        agentMessageStableStringify(record),
        record.createdAt,
        record.expiresAt,
        record.senderId,
        record.recipientId,
        record.objectiveId,
        record.runId,
        record.kind,
      );
      if (Number(result.changes) !== 1) throw new Error(`Agent message append failed: ${record.id}`);
      return { status: "committed", message: record };
    });
  }

  appendMessage(input: AgentMessageInput): AgentMessageAppendResult {
    return this.append(input);
  }

  appendOrThrow(input: AgentMessageInput): AgentMessageRecord {
    const result = this.append(input);
    if (result.status === "conflict" || !result.message) throw new Error(result.reason ?? "Agent message idempotency conflict");
    return result.message;
  }

  getMessage(id: string): AgentMessageRecord | null {
    const row = this.database.prepare("SELECT * FROM agent_bus_messages WHERE id = ?").get(id) as Row | undefined;
    return row ? this.parseMessage(row) : null;
  }

  get(id: string): AgentMessageRecord | null {
    return this.getMessage(id);
  }

  getByRequestKey(requestKey: string): AgentMessageRecord | null {
    const row = this.database.prepare("SELECT * FROM agent_bus_messages WHERE request_key = ?").get(requestKey) as Row | undefined;
    return row ? this.parseMessage(row) : null;
  }

  list(options: AgentMessageListOptions = {}): AgentMessageRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.afterCursor !== undefined) { clauses.push("cursor > ?"); values.push(options.afterCursor); }
    if (options.beforeCursor !== undefined) { clauses.push("cursor < ?"); values.push(options.beforeCursor); }
    if (options.senderId !== undefined) { clauses.push("sender_id = ?"); values.push(options.senderId); }
    if (options.recipientId !== undefined) { clauses.push("recipient_id = ?"); values.push(options.recipientId); }
    if (options.objectiveId !== undefined) { clauses.push("objective_id = ?"); values.push(options.objectiveId); }
    if (options.runId !== undefined) { clauses.push("run_id = ?"); values.push(options.runId); }
    if (options.kind !== undefined) { clauses.push("kind = ?"); values.push(options.kind); }
    const limit = Math.max(1, Math.min(options.limit ?? 500, 10_000));
    const sql = `SELECT * FROM agent_bus_messages${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY cursor ASC LIMIT ?`;
    values.push(limit);
    return (this.database.prepare(sql).all(...values) as Row[]).map((row) => this.parseMessage(row));
  }

  messagesAfter(cursor: number, options: Omit<AgentMessageListOptions, "afterCursor"> = {}): AgentMessageRecord[] {
    return this.list({ ...options, afterCursor: cursor });
  }

  listMessages(options: AgentMessageListOptions = {}): AgentMessageRecord[] {
    return this.list(options);
  }

  replay(cursor = 0, options: Omit<AgentMessageListOptions, "afterCursor"> = {}): AgentMessageRecord[] {
    return this.messagesAfter(cursor, options);
  }

  latestCursor(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM agent_bus_messages").get() as Row;
    return Number(row.cursor ?? 0);
  }

  latestSequence(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_bus_messages").get() as Row;
    return Number(row.sequence ?? 0);
  }

  latestReceiptCursor(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM agent_bus_receipts").get() as Row;
    return Number(row.cursor ?? 0);
  }

  appendReceipt(input: AgentMessageReceiptInput): AgentMessageReceiptResult {
    const parsed = AgentMessageReceiptInputSchema.parse(input);
    if (parsed.state === "unknown" && parsed.kind === "delivery" && !parsed.reason) {
      return { status: "conflict", receipt: null, reason: "Unknown delivery requires an explicit reason." };
    }
    const fingerprint = agentMessageFingerprint(parsed);
    return this.durableTransaction(() => {
      const existingRequest = this.database.prepare("SELECT * FROM agent_bus_receipts WHERE request_key = ?").get(parsed.requestKey) as Row | undefined;
      if (existingRequest) {
        const existing = this.parseReceipt(existingRequest);
        if (String(existingRequest.fingerprint) === fingerprint) return { status: "replayed", receipt: existing };
        return { status: "conflict", receipt: existing, reason: `Receipt request key is bound to a different receipt: ${parsed.requestKey}` };
      }
      const message = this.getMessage(parsed.messageId);
      if (!message) return { status: "conflict", receipt: null, reason: `Message does not exist: ${parsed.messageId}` };
      if (parsed.recipientId !== message.recipientId && parsed.kind !== "cancellation") {
        return { status: "conflict", receipt: null, reason: "Receipt recipient does not match the message recipient." };
      }
      const snapshot = this.getSnapshot(parsed.messageId);
      const current = snapshot?.receipts.filter((receipt) => receipt.kind === parsed.kind).at(-1) ?? null;
      if (
        snapshot
        && ((["expiry", "cancellation"].includes(parsed.kind) && ["handled", "expired", "cancelled"].includes(snapshot.state))
          || (parsed.kind === "delivery" && ["handled", "expired", "cancelled"].includes(snapshot.state)))
      ) {
        return { status: "conflict", receipt: current, reason: `Message is already ${snapshot.state}.` };
      }
      if (parsed.kind === "delivery" && current && current.state !== "unknown") {
        return { status: "conflict", receipt: current, reason: `Delivery outcome is already ${current.state}.` };
      }
      if (parsed.kind === "handled" && current) {
        return { status: "conflict", receipt: current, reason: "A parent decision is already recorded for this message." };
      }
      if (parsed.kind === "delivery" && current?.state === "unknown" && parsed.state === "unknown") {
        return { status: "conflict", receipt: current, reason: "An unknown delivery outcome is already recorded; reconcile it explicitly." };
      }
      if ((parsed.kind === "read" || parsed.kind === "handled") && (!snapshot?.delivery || snapshot.delivery.state !== "delivered")) {
        return { status: "conflict", receipt: null, reason: "A message must have a proven delivered receipt before it can be read or handled." };
      }
      if (parsed.kind === "read" && snapshot?.state && ["expired", "cancelled"].includes(snapshot.state)) {
        return { status: "conflict", receipt: null, reason: `Message is already ${snapshot.state}.` };
      }
      if (parsed.kind === "handled" && snapshot?.state && ["expired", "cancelled"].includes(snapshot.state)) {
        return { status: "conflict", receipt: null, reason: `Message is already ${snapshot.state}.` };
      }
      const receipt = AgentMessageReceiptSchema.parse({
        ...parsed,
        id: parsed.id ?? `agent-message-receipt:${ulid()}`,
        cursor: Number((this.database.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM agent_bus_receipts").get() as Row).cursor ?? 0) + 1,
      });
      assertAgentMessageJsonBounds(receipt, { label: "Agent message receipt", maxBytes: 256 * 1024 });
      const result = this.database.prepare(`
        INSERT INTO agent_bus_receipts(
          cursor, id, request_key, fingerprint, message_id, recipient_id, actor_id,
          kind, state, reason, decision, record_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.cursor,
        receipt.id,
        receipt.requestKey,
        fingerprint,
        receipt.messageId,
        receipt.recipientId,
        parsed.actorId,
        receipt.kind,
        receipt.state,
        receipt.reason,
        receipt.decision,
        agentMessageStableStringify(receipt),
        receipt.recordedAt,
      );
      if (Number(result.changes) !== 1) throw new Error(`Agent message receipt append failed: ${receipt.id}`);
      return { status: "committed", receipt };
    });
  }

  recordReceipt(input: AgentMessageReceiptInput): AgentMessageReceiptResult {
    return this.appendReceipt(input);
  }

  appendReceiptOrThrow(input: AgentMessageReceiptInput): AgentMessageReceipt {
    const result = this.appendReceipt(input);
    if (result.status === "conflict" || !result.receipt) throw new Error(result.reason ?? "Agent message receipt idempotency conflict");
    return result.receipt;
  }

  markDelivered(messageId: string, input: Omit<AgentMessageReceiptInput, "version" | "messageId" | "kind" | "state"> & { version?: 1; state?: Extract<AgentMessageDeliveryState, "delivered" | "failed"> }): AgentMessageReceiptResult {
    return this.appendReceipt({ ...input, version: 1, messageId, kind: "delivery", state: input.state ?? "delivered" });
  }

  markDeliveryUnknown(messageId: string, input: Omit<AgentMessageReceiptInput, "version" | "messageId" | "kind" | "state" | "reason"> & { version?: 1; reason: string }): AgentMessageReceiptResult {
    return this.appendReceipt({ ...input, version: 1, messageId, kind: "delivery", state: "unknown", reason: input.reason });
  }

  markRead(messageId: string, input: Omit<AgentMessageReceiptInput, "version" | "messageId" | "kind" | "state"> & { version?: 1 }): AgentMessageReceiptResult {
    return this.appendReceipt({ ...input, version: 1, messageId, kind: "read", state: "read" });
  }

  markHandled(messageId: string, input: Omit<AgentMessageReceiptInput, "version" | "messageId" | "kind" | "state"> & { version?: 1; decision: AgentMessageDecision }): AgentMessageReceiptResult {
    return this.appendReceipt({ ...input, version: 1, messageId, kind: "handled", state: "handled" });
  }

  expireMessage(messageId: string, input: Omit<AgentMessageReceiptInput, "version" | "messageId" | "kind" | "state" | "recipientId"> & { version?: 1; recordedAt: string }): AgentMessageReceiptResult {
    const message = this.getMessage(messageId);
    if (!message) return { status: "conflict", receipt: null, reason: `Message does not exist: ${messageId}` };
    return this.appendReceipt({ ...input, version: 1, messageId, recipientId: message.recipientId, kind: "expiry", state: "expired" });
  }

  cancelMessage(messageId: string, input: Omit<AgentMessageReceiptInput, "version" | "messageId" | "kind" | "state" | "recipientId"> & { version?: 1; actorId?: string | null; recordedAt: string }): AgentMessageReceiptResult {
    const message = this.getMessage(messageId);
    if (!message) return { status: "conflict", receipt: null, reason: `Message does not exist: ${messageId}` };
    return this.appendReceipt({ ...input, version: 1, messageId, recipientId: message.recipientId, kind: "cancellation", state: "cancelled" });
  }

  expireDue(now: string, options: { limit?: number; requestPrefix?: string } = {}): AgentMessageReceipt[] {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 10_000));
    const due = (this.database.prepare(`
      SELECT id, recipient_id FROM agent_bus_messages
      WHERE expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY cursor ASC LIMIT ?
    `).all(now, limit) as Row[]);
    const receipts: AgentMessageReceipt[] = [];
    for (const row of due) {
      const messageId = String(row.id);
      const snapshot = this.getSnapshot(messageId);
      if (!snapshot || snapshot.state === "expired" || snapshot.state === "cancelled" || snapshot.state === "handled") continue;
      const result = this.expireMessage(messageId, {
        version: 1,
        requestKey: `${options.requestPrefix ?? "agent-message-expiry"}:${messageId}`,
        recordedAt: now,
        reason: "Message expiry reached.",
        decision: null,
        actorId: "system:agent-message-expiry",
      });
      if (result.receipt) receipts.push(result.receipt);
    }
    return receipts;
  }

  getReceipts(messageId: string): AgentMessageReceipt[] {
    return (this.database.prepare("SELECT * FROM agent_bus_receipts WHERE message_id = ? ORDER BY cursor ASC").all(messageId) as Row[]).map((row) => this.parseReceipt(row));
  }

  getSnapshot(messageId: string): AgentMessageSnapshot | null {
    const message = this.getMessage(messageId);
    if (!message) return null;
    const receipts = this.getReceipts(messageId);
    const delivery = receipts.filter((receipt) => receipt.kind === "delivery").at(-1) ?? null;
    const read = receipts.filter((receipt) => receipt.kind === "read").at(-1) ?? null;
    const handled = receipts.filter((receipt) => receipt.kind === "handled").at(-1) ?? null;
    const expiry = receipts.filter((receipt) => receipt.kind === "expiry").at(-1) ?? null;
    const cancellation = receipts.filter((receipt) => receipt.kind === "cancellation").at(-1) ?? null;
    const state = cancellation?.state ?? expiry?.state ?? handled?.state ?? read?.state ?? delivery?.state ?? "pending";
    return AgentMessageSnapshotSchema.parse({ message, receipts, state, delivery, read, handled });
  }

  messageState(messageId: string): AgentMessageDeliveryState | null {
    return this.getSnapshot(messageId)?.state ?? null;
  }

  getState(messageId: string): AgentMessageDeliveryState | null {
    return this.messageState(messageId);
  }

  private parseMessage(row: Row): AgentMessageRecord {
    const record = JSON.parse(String(row.record_json)) as unknown;
    // A migration/import can contain a stale cursor in its JSON; SQLite is
    // authoritative for replay ordering.
    return AgentMessageRecordSchema.parse({ ...(record as Record<string, unknown>), cursor: Number(row.cursor) });
  }

  private parseReceipt(row: Row): AgentMessageReceipt {
    const record = JSON.parse(String(row.record_json)) as unknown;
    return AgentMessageReceiptSchema.parse({ ...(record as Record<string, unknown>), cursor: Number(row.cursor) });
  }
}

// Names used by callers at different architectural layers. They intentionally
// refer to the same implementation and do not imply additional projections.
export { AgentMessageStore as AgentMessageRepository, AgentMessageStore as DurableAgentMessageStore, AgentMessageStore as AgentMessageStorage };
