import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CapabilityResultDecisionRecordSchema,
  CapabilityResultEvaluationRecordSchema,
  CapabilityResultFeedbackRecordSchema,
  isCapabilityResultDecisionHashValid,
  isCapabilityResultEvaluationHashValid,
  isCapabilityResultFeedbackHashValid,
  type CapabilityResultDecisionRecord,
  type CapabilityResultEvaluationRecord,
  type CapabilityResultFeedbackRecord,
} from "@symphony/protocol";

type Row = Record<string, unknown>;
type FeedbackRecord = CapabilityResultFeedbackRecord | CapabilityResultEvaluationRecord | CapabilityResultDecisionRecord;
type RecordKind = "feedback" | "evaluation" | "decision";

/**
 * Isolated append-only SQLite repository for capability-result feedback.
 *
 * This repository is intentionally isolated from the broad SymphonyStore
 * schema. The daemon owns its lifecycle and API boundary, while identity
 * columns are indexed for bounded reads and the validated JSON record remains
 * the immutable source of truth.
 */
export class CapabilityResultFeedbackRepository {
  readonly path: string;
  readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS capability_result_feedback_records (
        record_kind TEXT NOT NULL,
        id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        feedback_id TEXT,
        evaluation_id TEXT,
        capability_admission_id TEXT NOT NULL,
        capability_admission_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (record_kind, id),
        UNIQUE (record_kind, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS capability_result_feedback_identity
        ON capability_result_feedback_records(objective_id, run_id, node_id, attempt_id, created_at);
      CREATE INDEX IF NOT EXISTS capability_result_feedback_admission
        ON capability_result_feedback_records(capability_admission_id, capability_admission_hash, created_at);
    `);
  }

  transaction<T>(callback: () => T): T {
    if (this.database.isTransaction) return callback();
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

  durableTransaction<T>(callback: () => T): T {
    if (this.database.isTransaction) return callback();
    const previous = Number((this.database.prepare("PRAGMA synchronous").get() as Row).synchronous ?? 1);
    this.database.exec("PRAGMA synchronous = FULL");
    try { return this.transaction(callback); }
    finally { this.database.exec(`PRAGMA synchronous = ${Number.isInteger(previous) ? previous : 1}`); }
  }

  close(): void { this.database.close(); }

  saveFeedback(recordInput: CapabilityResultFeedbackRecord): boolean {
    const record = CapabilityResultFeedbackRecordSchema.parse(recordInput);
    if (!isCapabilityResultFeedbackHashValid(record)) throw new Error(`Invalid capability feedback hash: ${record.id}`);
    return this.insert("feedback", record);
  }

  saveEvaluation(recordInput: CapabilityResultEvaluationRecord): boolean {
    const record = CapabilityResultEvaluationRecordSchema.parse(recordInput);
    if (!isCapabilityResultEvaluationHashValid(record)) throw new Error(`Invalid capability evaluation hash: ${record.id}`);
    this.assertParentIdentity("feedback", record.feedbackId, record);
    return this.insert("evaluation", record);
  }

  saveDecision(recordInput: CapabilityResultDecisionRecord): boolean {
    const record = CapabilityResultDecisionRecordSchema.parse(recordInput);
    if (!isCapabilityResultDecisionHashValid(record)) throw new Error(`Invalid capability decision hash: ${record.id}`);
    this.assertParentIdentity("feedback", record.feedbackId, record);
    this.assertParentIdentity("evaluation", record.evaluationId, record);
    return this.insert("decision", record);
  }

  getFeedback(id: string): CapabilityResultFeedbackRecord | null {
    return this.get("feedback", id) as CapabilityResultFeedbackRecord | null;
  }

  getEvaluation(id: string): CapabilityResultEvaluationRecord | null {
    return this.get("evaluation", id) as CapabilityResultEvaluationRecord | null;
  }

  getDecision(id: string): CapabilityResultDecisionRecord | null {
    return this.get("decision", id) as CapabilityResultDecisionRecord | null;
  }

  getByIdempotencyKey(kind: RecordKind, key: string): FeedbackRecord | null {
    const row = this.database.prepare(
      "SELECT record_json FROM capability_result_feedback_records WHERE record_kind = ? AND idempotency_key = ?",
    ).get(kind, key) as Row | undefined;
    return row ? parseByKind(kind, row.record_json) : null;
  }

  listFeedback(options: ListOptions = {}): CapabilityResultFeedbackRecord[] {
    return this.list("feedback", options) as CapabilityResultFeedbackRecord[];
  }

  listEvaluations(options: ListOptions = {}): CapabilityResultEvaluationRecord[] {
    return this.list("evaluation", options) as CapabilityResultEvaluationRecord[];
  }

  listDecisions(options: ListOptions = {}): CapabilityResultDecisionRecord[] {
    return this.list("decision", options) as CapabilityResultDecisionRecord[];
  }

  private insert(kind: RecordKind, record: FeedbackRecord): boolean {
    const existingById = this.database.prepare(
      "SELECT record_json FROM capability_result_feedback_records WHERE record_kind = ? AND id = ?",
    ).get(kind, record.id) as Row | undefined;
    const existingByKey = this.database.prepare(
      "SELECT record_json FROM capability_result_feedback_records WHERE record_kind = ? AND idempotency_key = ?",
    ).get(kind, record.idempotencyKey) as Row | undefined;
    const collisions = [existingById, existingByKey].filter((row): row is Row => row !== undefined);
    if (collisions.length > 0) {
      if (collisions.every((row) => stableJson(JSON.parse(String(row.record_json))) === stableJson(record))) return false;
      throw new Error(`Capability ${kind} idempotency conflict: ${record.id}`);
    }
    try {
      const result = this.database.prepare(`
        INSERT INTO capability_result_feedback_records(
          record_kind, id, objective_id, run_id, node_id, attempt_id, feedback_id,
          evaluation_id, capability_admission_id, capability_admission_hash,
          idempotency_key, status, record_hash, record_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        kind,
        record.id,
        record.objectiveId,
        record.runId,
        record.nodeId,
        record.attemptId,
        "feedbackId" in record ? record.feedbackId : null,
        "evaluationId" in record ? record.evaluationId : null,
        record.capabilityAdmissionId,
        record.capabilityAdmissionHash,
        record.idempotencyKey,
        record.status,
        record.hash,
        JSON.stringify(record),
        record.createdAt,
      );
      return Number(result.changes ?? 0) === 1;
    } catch (error) {
      // The preflight checks above make the common replay path cheap, while
      // this race-safe fallback handles another daemon generation winning
      // the unique key between those reads and INSERT.
      if (!isConstraintError(error)) throw error;
      const winnerById = this.database.prepare(
        "SELECT record_json FROM capability_result_feedback_records WHERE record_kind = ? AND id = ?",
      ).get(kind, record.id) as Row | undefined;
      const winnerByKey = this.database.prepare(
        "SELECT record_json FROM capability_result_feedback_records WHERE record_kind = ? AND idempotency_key = ?",
      ).get(kind, record.idempotencyKey) as Row | undefined;
      const winner = winnerById ?? winnerByKey;
      if (winner && stableJson(JSON.parse(String(winner.record_json))) === stableJson(record)) return false;
      throw new Error(`Capability ${kind} idempotency conflict: ${record.id}`);
    }
  }

  private assertParentIdentity(kind: RecordKind, id: string, child: FeedbackRecord): void {
    const row = this.database.prepare(
      "SELECT objective_id, run_id, node_id, attempt_id, capability_admission_id, capability_admission_hash FROM capability_result_feedback_records WHERE record_kind = ? AND id = ?",
    ).get(kind, id) as Row | undefined;
    if (!row) return;
    const fields: Array<[string, string]> = [
      ["objectiveId", String(row.objective_id)],
      ["runId", String(row.run_id)],
      ["nodeId", String(row.node_id)],
      ["attemptId", String(row.attempt_id)],
      ["capabilityAdmissionId", String(row.capability_admission_id)],
      ["capabilityAdmissionHash", String(row.capability_admission_hash)],
    ];
    for (const [field, value] of fields) {
      if (child[field as keyof FeedbackRecord] !== value) throw new Error(`Capability ${kind} identity mismatch on ${field}: ${id}`);
    }
  }

  private get(kind: RecordKind, id: string): FeedbackRecord | null {
    const row = this.database.prepare(
      "SELECT record_json FROM capability_result_feedback_records WHERE record_kind = ? AND id = ?",
    ).get(kind, id) as Row | undefined;
    return row ? parseByKind(kind, row.record_json) : null;
  }

  private list(kind: RecordKind, options: ListOptions): FeedbackRecord[] {
    const clauses = ["record_kind = ?"];
    const params: Array<string | number> = [kind];
    if (options.objectiveId) { clauses.push("objective_id = ?"); params.push(options.objectiveId); }
    if (options.runId) { clauses.push("run_id = ?"); params.push(options.runId); }
    if (options.nodeId) { clauses.push("node_id = ?"); params.push(options.nodeId); }
    if (options.attemptId) { clauses.push("attempt_id = ?"); params.push(options.attemptId); }
    if (options.status?.length) {
      clauses.push(`status IN (${options.status.map(() => "?").join(",")})`);
      params.push(...options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 2_000);
    const rows = this.database.prepare(
      `SELECT record_json FROM capability_result_feedback_records WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).all(...params, limit) as Row[];
    return rows.map((row) => parseByKind(kind, row.record_json));
  }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/u.test(error.message);
}

export type CapabilityResultFeedbackListOptions = ListOptions;
type ListOptions = Readonly<{
  objectiveId?: string;
  runId?: string;
  nodeId?: string;
  attemptId?: string;
  status?: readonly string[];
  limit?: number;
}>;

// Naming aliases keep the repository discoverable for callers that use
// "store" rather than "repository" while retaining one implementation.
export const CapabilityResultFeedbackStore = CapabilityResultFeedbackRepository;
export const CapabilityResultRepository = CapabilityResultFeedbackRepository;

function parseByKind(kind: RecordKind, value: unknown): FeedbackRecord {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  if (kind === "feedback") return CapabilityResultFeedbackRecordSchema.parse(raw);
  if (kind === "evaluation") return CapabilityResultEvaluationRecordSchema.parse(raw);
  return CapabilityResultDecisionRecordSchema.parse(raw);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
