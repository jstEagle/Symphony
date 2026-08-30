import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentRecordSchema,
  CommandReceiptSchema,
  EventEnvelopeSchema,
  ObservationSchema,
  RoutingTraceSchema,
  UsageEventSchema,
  nowIso,
  type AgentRecord,
  type CommandReceipt,
  type ConversationMessage,
  type EventEnvelope,
  type JsonValue,
  type Observation,
  type ProjectRecord,
  type RoutingTrace,
  type UsageEvent,
} from "@symphony/protocol";
import { ulid } from "ulid";

type Row = Record<string, unknown>;

export type WorkflowRevisionRecord = {
  id: string;
  revision: number;
  mission: JsonValue;
  definition: JsonValue;
  ir: JsonValue;
  hash: string;
  createdAt: string;
};

export type WorkflowRunRecord = {
  id: string;
  workflowId: string;
  workflowRevision: number;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  input: JsonValue;
  output: JsonValue | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
};

export type StepAttemptRecord = {
  id: string;
  runId: string;
  stepId: string;
  iterationKey: string;
  attempt: number;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  input: JsonValue;
  output: JsonValue | null;
  error: string | null;
  idempotencyKey: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type PluginStateRecord = {
  id: string;
  version: string;
  path: string;
  status: "discovered" | "building" | "active" | "failed" | "disabled" | "quarantined";
  activeHash: string | null;
  previousHash: string | null;
  error: string | null;
  manifest: JsonValue;
  updatedAt: string;
};

export type ChatThreadRecord = {
  id: string;
  title: string;
  groupId: string | null;
  conductorAgentId: string | null;
  mission: JsonValue;
  workspacePath: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

const migrations: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        workflow_id TEXT,
        run_id TEXT,
        agent_id TEXT,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        provenance_json TEXT
      );
      CREATE INDEX IF NOT EXISTS events_workflow_cursor ON events(workflow_id, cursor);
      CREATE INDEX IF NOT EXISTS events_run_cursor ON events(run_id, cursor);
      CREATE INDEX IF NOT EXISTS events_agent_cursor ON events(agent_id, cursor);

      CREATE TABLE IF NOT EXISTS workflow_revisions (
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, revision)
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs(status, updated_at);

      CREATE TABLE IF NOT EXISTS step_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        iteration_key TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, step_id, iteration_key, attempt)
      );
      CREATE INDEX IF NOT EXISTS step_attempts_run ON step_attempts(run_id, step_id, iteration_key);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        logical_agent_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        parent_agent_id TEXT,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agents_run ON agents(run_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS agents_parent ON agents(parent_agent_id, updated_at);

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        receipt_id TEXT,
        delivery_state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_messages_agent ON agent_messages(agent_id, created_at);

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        level TEXT NOT NULL,
        event_cursor INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(agent_id, level, event_cursor)
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        agent_id TEXT,
        cost_amount REAL,
        basis TEXT NOT NULL,
        record_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_workflow ON usage_events(workflow_id, recorded_at);
      CREATE INDEX IF NOT EXISTS usage_agent ON usage_events(agent_id, recorded_at);

      CREATE TABLE IF NOT EXISTS routing_traces (
        id TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS command_receipts (
        idempotency_key TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trigger_occurrences (
        trigger_id TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(trigger_id, occurrence_key)
      );

      CREATE TABLE IF NOT EXISTS plugin_states (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_thread ON conversation_messages(thread_id, created_at);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_threads_group ON chat_threads(group_id, archived, updated_at);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_updated ON projects(updated_at DESC);
    `,
  },
];

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("Expected SQLite JSON text");
  return JSON.parse(value) as T;
}

export class SymphonyStore {
  readonly path: string;
  readonly database: DatabaseSync;
  readonly emitter = new EventEmitter();

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    const has = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
    const insert = this.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
    for (const migration of migrations) {
      if (has.get(migration.version)) continue;
      this.transaction(() => {
        this.database.exec(migration.sql);
        insert.run(migration.version, nowIso());
      });
    }
  }

  transaction<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  appendEvent(input: Omit<EventEnvelope, "id" | "cursor"> & { id?: string }): EventEnvelope {
    const id = input.id ?? ulid();
    const result = this.database
      .prepare(
        `INSERT INTO events(id, type, workflow_id, run_id, agent_id, occurred_at, payload_json, provenance_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.workflowId,
        input.runId,
        input.agentId,
        input.occurredAt,
        serialize(input.payload),
        input.provenance ? serialize(input.provenance) : null,
      );
    const event = EventEnvelopeSchema.parse({ ...input, id, cursor: Number(result.lastInsertRowid) });
    this.emitter.emit("event", event);
    return event;
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  latestCursor(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events").get() as Row;
    return Number(row.cursor ?? 0);
  }

  eventsAfter(cursor: number, options: { limit?: number; agentId?: string; runId?: string; types?: readonly string[]; typePrefixes?: readonly string[] } = {}): EventEnvelope[] {
    const limit = Math.min(options.limit ?? 1_000, 10_000);
    let sql = "SELECT * FROM events WHERE cursor > ?";
    const params: Array<string | number> = [cursor];
    if (options.agentId) {
      sql += " AND agent_id = ?";
      params.push(options.agentId);
    }
    if (options.runId) {
      sql += " AND run_id = ?";
      params.push(options.runId);
    }
    const typeClauses: string[] = [];
    if (options.types?.length) {
      typeClauses.push(`type IN (${options.types.map(() => "?").join(",")})`);
      params.push(...options.types);
    }
    if (options.typePrefixes?.length) {
      typeClauses.push(...options.typePrefixes.map(() => "type LIKE ?"));
      params.push(...options.typePrefixes.map((prefix) => `${prefix}%`));
    }
    if (typeClauses.length) sql += ` AND (${typeClauses.join(" OR ")})`;
    sql += " ORDER BY cursor ASC LIMIT ?";
    params.push(limit);
    return (this.database.prepare(sql).all(...params) as Row[]).map((row) =>
      EventEnvelopeSchema.parse({
        id: row.id,
        cursor: row.cursor,
        type: row.type,
        workflowId: row.workflow_id,
        runId: row.run_id,
        agentId: row.agent_id,
        occurredAt: row.occurred_at,
        payload: parseJson(row.payload_json),
        provenance: row.provenance_json ? parseJson(row.provenance_json) : undefined,
      }),
    );
  }

  recentEvents(options: { limit?: number; types?: readonly string[]; typePrefixes?: readonly string[] } = {}): EventEnvelope[] {
    const limit = Math.min(options.limit ?? 500, 10_000);
    let sql = "SELECT * FROM events";
    const params: Array<string | number> = [];
    const typeClauses: string[] = [];
    if (options.types?.length) {
      typeClauses.push(`type IN (${options.types.map(() => "?").join(",")})`);
      params.push(...options.types);
    }
    if (options.typePrefixes?.length) {
      typeClauses.push(...options.typePrefixes.map(() => "type LIKE ?"));
      params.push(...options.typePrefixes.map((prefix) => `${prefix}%`));
    }
    if (typeClauses.length) sql += ` WHERE (${typeClauses.join(" OR ")})`;
    sql += " ORDER BY cursor DESC LIMIT ?";
    params.push(limit);
    return (this.database.prepare(sql).all(...params) as Row[]).reverse().map((row) =>
      EventEnvelopeSchema.parse({
        id: row.id,
        cursor: row.cursor,
        type: row.type,
        workflowId: row.workflow_id,
        runId: row.run_id,
        agentId: row.agent_id,
        occurredAt: row.occurred_at,
        payload: parseJson(row.payload_json),
        provenance: row.provenance_json ? parseJson(row.provenance_json) : undefined,
      }),
    );
  }

  saveWorkflow(record: WorkflowRevisionRecord): void {
    this.database
      .prepare(
        `INSERT INTO workflow_revisions(workflow_id, revision, hash, record_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workflow_id, revision) DO UPDATE SET hash=excluded.hash, record_json=excluded.record_json`,
      )
      .run(record.id, record.revision, record.hash, serialize(record), record.createdAt);
  }

  getWorkflow(id: string, revision?: number): WorkflowRevisionRecord | null {
    const row = revision
      ? this.database.prepare("SELECT record_json FROM workflow_revisions WHERE workflow_id = ? AND revision = ?").get(id, revision)
      : this.database
          .prepare("SELECT record_json FROM workflow_revisions WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1")
          .get(id);
    return row ? parseJson<WorkflowRevisionRecord>((row as Row).record_json) : null;
  }

  listWorkflows(): WorkflowRevisionRecord[] {
    return (this.database
      .prepare(
        `SELECT w.record_json FROM workflow_revisions w
         JOIN (SELECT workflow_id, MAX(revision) revision FROM workflow_revisions GROUP BY workflow_id) latest
         ON latest.workflow_id = w.workflow_id AND latest.revision = w.revision
         ORDER BY w.created_at DESC`,
      )
      .all() as Row[]).map((row) => parseJson<WorkflowRevisionRecord>(row.record_json));
  }

  saveRun(record: WorkflowRunRecord): void {
    this.database
      .prepare(
        `INSERT INTO workflow_runs(id, workflow_id, workflow_revision, status, record_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(record.id, record.workflowId, record.workflowRevision, record.status, serialize(record), record.updatedAt);
  }

  getRun(id: string): WorkflowRunRecord | null {
    const row = this.database.prepare("SELECT record_json FROM workflow_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? parseJson<WorkflowRunRecord>(row.record_json) : null;
  }

  listRuns(options: { status?: WorkflowRunRecord["status"][]; limit?: number } = {}): WorkflowRunRecord[] {
    const limit = Math.min(options.limit ?? 200, 2_000);
    if (options.status?.length) {
      const placeholders = options.status.map(() => "?").join(",");
      return (this.database
        .prepare(`SELECT record_json FROM workflow_runs WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`)
        .all(...options.status, limit) as Row[]).map((row) => parseJson<WorkflowRunRecord>(row.record_json));
    }
    return (this.database.prepare("SELECT record_json FROM workflow_runs ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map(
      (row) => parseJson<WorkflowRunRecord>(row.record_json),
    );
  }

  saveStepAttempt(record: StepAttemptRecord): void {
    this.database
      .prepare(
        `INSERT INTO step_attempts(id, run_id, step_id, iteration_key, attempt, status, idempotency_key, record_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(
        record.id,
        record.runId,
        record.stepId,
        record.iterationKey,
        record.attempt,
        record.status,
        record.idempotencyKey,
        serialize(record),
        record.updatedAt,
      );
  }

  getLatestStepAttempt(runId: string, stepId: string, iterationKey: string): StepAttemptRecord | null {
    const row = this.database
      .prepare(
        `SELECT record_json FROM step_attempts
         WHERE run_id = ? AND step_id = ? AND iteration_key = ? ORDER BY attempt DESC LIMIT 1`,
      )
      .get(runId, stepId, iterationKey) as Row | undefined;
    return row ? parseJson<StepAttemptRecord>(row.record_json) : null;
  }

  listStepAttempts(runId: string): StepAttemptRecord[] {
    return (this.database
      .prepare("SELECT record_json FROM step_attempts WHERE run_id = ? ORDER BY updated_at ASC")
      .all(runId) as Row[]).map((row) => parseJson<StepAttemptRecord>(row.record_json));
  }

  saveAgent(record: AgentRecord): void {
    const parsed = AgentRecordSchema.parse(record);
    this.database
      .prepare(
        `INSERT INTO agents(id, logical_agent_id, workflow_id, run_id, parent_agent_id, status, record_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(
        parsed.id,
        parsed.logicalAgentId,
        parsed.workflowId,
        parsed.runId,
        parsed.parentAgentId,
        parsed.status,
        serialize(parsed),
        parsed.updatedAt,
      );
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.database.prepare("SELECT record_json FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? AgentRecordSchema.parse(parseJson(row.record_json)) : null;
  }

  listAgents(options: { runId?: string; activeOnly?: boolean; parentAgentId?: string; limit?: number } = {}): AgentRecord[] {
    let sql = "SELECT record_json FROM agents WHERE 1 = 1";
    const params: Array<string | number> = [];
    if (options.runId) {
      sql += " AND run_id = ?";
      params.push(options.runId);
    }
    if (options.parentAgentId) {
      sql += " AND parent_agent_id = ?";
      params.push(options.parentAgentId);
    }
    if (options.activeOnly) {
      sql += " AND status IN ('queued','routing','starting','running','idle','waiting','cancel-requested')";
    }
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(Math.min(options.limit ?? 1_000, 10_000));
    return (this.database.prepare(sql).all(...params) as Row[]).map((row) =>
      AgentRecordSchema.parse(parseJson(row.record_json)),
    );
  }

  addAgentMessage(input: {
    agentId: string;
    direction: "to-agent" | "from-agent";
    content: string;
    receiptId?: string;
    deliveryState: "queued" | "delivered" | "unknown" | "failed";
  }): string {
    const id = ulid();
    this.database
      .prepare(
        `INSERT INTO agent_messages(id, agent_id, direction, content, receipt_id, delivery_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.agentId, input.direction, input.content, input.receiptId ?? null, input.deliveryState, nowIso());
    return id;
  }

  listAgentMessages(agentId: string, limit = 500): Row[] {
    return this.database
      .prepare("SELECT * FROM agent_messages WHERE agent_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(agentId, Math.min(limit, 5_000)) as Row[];
  }

  saveObservation(observation: Observation): void {
    const parsed = ObservationSchema.parse(observation);
    this.database
      .prepare(
        `INSERT INTO observations(id, agent_id, level, event_cursor, record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, level, event_cursor) DO UPDATE SET record_json=excluded.record_json`,
      )
      .run(parsed.id, parsed.agentId, parsed.level, parsed.eventCursor, serialize(parsed), parsed.createdAt);
  }

  getObservation(agentId: string, level: Observation["level"], eventCursor: number): Observation | null {
    const row = this.database
      .prepare("SELECT record_json FROM observations WHERE agent_id = ? AND level = ? AND event_cursor = ?")
      .get(agentId, level, eventCursor) as Row | undefined;
    return row ? ObservationSchema.parse(parseJson(row.record_json)) : null;
  }

  recordUsage(usage: UsageEvent): void {
    const parsed = UsageEventSchema.parse(usage);
    this.database
      .prepare(
        `INSERT OR REPLACE INTO usage_events(id, workflow_id, run_id, agent_id, cost_amount, basis, record_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.workflowId,
        parsed.runId,
        parsed.agentId,
        parsed.costAmount,
        parsed.basis,
        serialize(parsed),
        parsed.recordedAt,
      );
  }

  listUsage(options: { workflowId?: string; runId?: string; agentId?: string } = {}): UsageEvent[] {
    let sql = "SELECT record_json FROM usage_events WHERE 1 = 1";
    const params: string[] = [];
    if (options.workflowId) {
      sql += " AND workflow_id = ?";
      params.push(options.workflowId);
    }
    if (options.runId) {
      sql += " AND run_id = ?";
      params.push(options.runId);
    }
    if (options.agentId) {
      sql += " AND agent_id = ?";
      params.push(options.agentId);
    }
    sql += " ORDER BY recorded_at ASC";
    return (this.database.prepare(sql).all(...params) as Row[]).map((row) =>
      UsageEventSchema.parse(parseJson(row.record_json)),
    );
  }

  aggregateCost(options: { workflowId?: string; runId?: string; agentId?: string } = {}): JsonValue {
    const events = this.listUsage(options);
    const byBasis: Record<string, number> = {};
    let knownTotal = 0;
    let unknownEvents = 0;
    for (const event of events) {
      if (event.costAmount === null) {
        unknownEvents += 1;
        continue;
      }
      knownTotal += event.costAmount;
      byBasis[event.basis] = (byBasis[event.basis] ?? 0) + event.costAmount;
    }
    return { currency: "USD", knownTotal, unknownEvents, eventCount: events.length, byBasis };
  }

  saveRoutingTrace(trace: RoutingTrace): void {
    const parsed = RoutingTraceSchema.parse(trace);
    this.database
      .prepare("INSERT OR REPLACE INTO routing_traces(id, work_order_id, record_json, created_at) VALUES (?, ?, ?, ?)")
      .run(parsed.id, parsed.workOrderId, serialize(parsed), parsed.createdAt);
  }

  getCommandReceipt(idempotencyKey: string): CommandReceipt | null {
    const row = this.database
      .prepare("SELECT record_json FROM command_receipts WHERE idempotency_key = ?")
      .get(idempotencyKey) as Row | undefined;
    return row ? CommandReceiptSchema.parse(parseJson(row.record_json)) : null;
  }

  saveCommandReceipt(receipt: CommandReceipt): void {
    const parsed = CommandReceiptSchema.parse(receipt);
    this.database
      .prepare("INSERT OR IGNORE INTO command_receipts(idempotency_key, record_json, created_at) VALUES (?, ?, ?)")
      .run(parsed.idempotencyKey, serialize(parsed), parsed.createdAt);
  }

  claimTriggerOccurrence(triggerId: string, occurrenceKey: string): boolean {
    const result = this.database
      .prepare("INSERT OR IGNORE INTO trigger_occurrences(trigger_id, occurrence_key, created_at) VALUES (?, ?, ?)")
      .run(triggerId, occurrenceKey, nowIso());
    return result.changes === 1;
  }

  attachTriggerRun(triggerId: string, occurrenceKey: string, runId: string): void {
    this.database
      .prepare("UPDATE trigger_occurrences SET run_id = ? WHERE trigger_id = ? AND occurrence_key = ?")
      .run(runId, triggerId, occurrenceKey);
  }

  savePluginState(record: PluginStateRecord): void {
    this.database
      .prepare(
        `INSERT INTO plugin_states(id, status, record_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(record.id, record.status, serialize(record), record.updatedAt);
  }

  listPluginStates(): PluginStateRecord[] {
    return (this.database.prepare("SELECT record_json FROM plugin_states ORDER BY id ASC").all() as Row[]).map((row) =>
      parseJson<PluginStateRecord>(row.record_json),
    );
  }

  appendConversationMessage(message: ConversationMessage): void {
    this.database
      .prepare("INSERT OR REPLACE INTO conversation_messages(id, thread_id, record_json, created_at) VALUES (?, ?, ?, ?)")
      .run(message.id, message.threadId, serialize(message), message.createdAt);
  }

  listConversationMessages(threadId?: string, limit = 1_000): ConversationMessage[] {
    if (threadId) {
      return (this.database
        .prepare("SELECT record_json FROM conversation_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(threadId, limit) as Row[]).map((row) => parseJson<ConversationMessage>(row.record_json));
    }
    return (this.database
      .prepare("SELECT record_json FROM conversation_messages ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Row[]).map((row) => parseJson<ConversationMessage>(row.record_json));
  }

  saveThread(record: ChatThreadRecord): void {
    this.database
      .prepare(
        `INSERT INTO chat_threads(id, group_id, archived, record_json, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id, archived=excluded.archived, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(record.id, record.groupId, record.archived ? 1 : 0, serialize(record), record.updatedAt);
  }

  getThread(id: string): ChatThreadRecord | null {
    const row = this.database.prepare("SELECT record_json FROM chat_threads WHERE id = ?").get(id) as Row | undefined;
    return row ? parseJson<ChatThreadRecord>(row.record_json) : null;
  }

  listThreads(options: { groupId?: string; includeArchived?: boolean; limit?: number } = {}): ChatThreadRecord[] {
    let sql = "SELECT record_json FROM chat_threads WHERE 1 = 1";
    const params: Array<string | number> = [];
    if (options.groupId) {
      sql += " AND group_id = ?";
      params.push(options.groupId);
    }
    if (!options.includeArchived) sql += " AND archived = 0";
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(Math.min(options.limit ?? 500, 5_000));
    return (this.database.prepare(sql).all(...params) as Row[]).map((row) => parseJson<ChatThreadRecord>(row.record_json));
  }

  saveProject(record: ProjectRecord): void {
    this.database
      .prepare(
        `INSERT INTO projects(id, workspace_path, record_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_path) DO UPDATE SET id=excluded.id, record_json=excluded.record_json, updated_at=excluded.updated_at`,
      )
      .run(record.id, record.workspacePath, serialize(record), record.updatedAt);
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.database.prepare("SELECT record_json FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? parseJson<ProjectRecord>(row.record_json) : null;
  }

  getProjectByPath(workspacePath: string): ProjectRecord | null {
    const row = this.database.prepare("SELECT record_json FROM projects WHERE workspace_path = ?").get(workspacePath) as Row | undefined;
    return row ? parseJson<ProjectRecord>(row.record_json) : null;
  }

  listProjects(): ProjectRecord[] {
    return (this.database.prepare("SELECT record_json FROM projects ORDER BY updated_at DESC").all() as Row[]).map((row) =>
      parseJson<ProjectRecord>(row.record_json),
    );
  }

  setMetadata(key: string, value: JsonValue): void {
    this.database
      .prepare(
        `INSERT INTO metadata(key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      )
      .run(key, serialize(value), nowIso());
  }

  getMetadata<T extends JsonValue>(key: string): T | null {
    const row = this.database.prepare("SELECT value_json FROM metadata WHERE key = ?").get(key) as Row | undefined;
    return row ? parseJson<T>(row.value_json) : null;
  }
}

export function createStore(dataDirectory: string): SymphonyStore {
  return new SymphonyStore(resolve(dataDirectory, "symphony.sqlite"));
}
