import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CapabilityIdSchema,
  CapabilityVersionRecordSchema,
  type CapabilityId,
  type CapabilityActivation,
  type CapabilityState,
  type CapabilityVersionRecord,
} from "@symphony/protocol";

export type CapabilityLibraryReceipt = Readonly<{
  requestKey: string;
  operation: string;
  fingerprint: string;
  result: unknown;
  createdAt: string;
}>;

type Row = Record<string, unknown>;

/**
 * Isolated durable table abstraction for the optional capability registry.
 * It intentionally does not modify SymphonyStore's schema: adopters can use
 * this repository only when they opt into the capability library.
 */
export class CapabilityLibraryRepository {
  readonly path: string;
  readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    this.database = new DatabaseSync(this.path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS capability_library_versions (
        capability_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        state TEXT NOT NULL,
        hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (capability_id, version)
      );
      CREATE INDEX IF NOT EXISTS capability_library_versions_state
        ON capability_library_versions(capability_id, state, version DESC);
      CREATE TABLE IF NOT EXISTS capability_library_receipts (
        request_key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
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

  getVersion(capabilityId: string, version: number): CapabilityVersionRecord | null {
    const row = this.database.prepare(
      "SELECT record_json FROM capability_library_versions WHERE capability_id = ? AND version = ?",
    ).get(CapabilityIdSchema.parse(capabilityId), version) as Row | undefined;
    return row ? parseRecord(row.record_json) : null;
  }

  listVersions(capabilityId?: string): CapabilityVersionRecord[] {
    const rows = capabilityId === undefined
      ? this.database.prepare("SELECT record_json FROM capability_library_versions ORDER BY capability_id, version").all() as Row[]
      : this.database.prepare("SELECT record_json FROM capability_library_versions WHERE capability_id = ? ORDER BY version").all(CapabilityIdSchema.parse(capabilityId)) as Row[];
    return rows.map((row) => parseRecord(row.record_json));
  }

  getLatestVersion(capabilityId: string): CapabilityVersionRecord | null {
    const row = this.database.prepare(
      "SELECT record_json FROM capability_library_versions WHERE capability_id = ? ORDER BY version DESC LIMIT 1",
    ).get(CapabilityIdSchema.parse(capabilityId)) as Row | undefined;
    return row ? parseRecord(row.record_json) : null;
  }

  getActiveVersion(capabilityId: string): CapabilityVersionRecord | null {
    const row = this.database.prepare(
      "SELECT record_json FROM capability_library_versions WHERE capability_id = ? AND state = 'active' ORDER BY version DESC LIMIT 1",
    ).get(CapabilityIdSchema.parse(capabilityId)) as Row | undefined;
    return row ? parseRecord(row.record_json) : null;
  }

  nextVersion(capabilityId: string): number {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM capability_library_versions WHERE capability_id = ?",
    ).get(CapabilityIdSchema.parse(capabilityId)) as Row;
    return Number(row.version ?? 0) + 1;
  }

  /** Insert only; definitions are immutable after this point. */
  insertVersion(recordInput: CapabilityVersionRecord): boolean {
    const record = CapabilityVersionRecordSchema.parse(recordInput);
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO capability_library_versions
        (capability_id, version, state, hash, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(record.capabilityId, record.version, record.state, record.hash, JSON.stringify(record), record.createdAt, record.updatedAt);
    return Number(result.changes ?? 0) === 1;
  }

  /** State is mutable; all definition/provenance/hash fields remain untouched. */
  transitionState(capabilityId: string, version: number, state: CapabilityState, now: string, activation?: CapabilityActivation): CapabilityVersionRecord | null {
    const current = this.getVersion(capabilityId, version);
    if (!current) return null;
    const next = CapabilityVersionRecordSchema.parse({
      ...current,
      state,
      status: state,
      ...(activation === undefined ? {} : { activation }),
      updatedAt: now,
      activatedAt: state === "active" ? (current.activatedAt ?? now) : current.activatedAt,
      deprecatedAt: state === "active" ? null : state === "deprecated" ? (current.deprecatedAt ?? now) : current.deprecatedAt,
    });
    this.database.prepare(`
      UPDATE capability_library_versions SET state = ?, record_json = ?, updated_at = ?
      WHERE capability_id = ? AND version = ?
    `).run(next.state, JSON.stringify(next), next.updatedAt, next.capabilityId, next.version);
    return next;
  }

  /** Activate one version and retire any other active version for the same id atomically. */
  activateVersion(capabilityId: string, version: number, now: string, activation?: CapabilityActivation): CapabilityVersionRecord | null {
    const current = this.getVersion(capabilityId, version);
    if (!current) return null;
    for (const active of this.listVersions(capabilityId).filter((item) => item.state === "active" && item.version !== version)) {
      this.transitionState(capabilityId, active.version, "deprecated", now);
    }
    return this.transitionState(capabilityId, version, "active", now, activation);
  }

  getReceipt(requestKey: string): CapabilityLibraryReceipt | null {
    const row = this.database.prepare(
      "SELECT request_key, operation, fingerprint, result_json, created_at FROM capability_library_receipts WHERE request_key = ?",
    ).get(requestKey) as Row | undefined;
    if (!row) return null;
    return {
      requestKey: String(row.request_key), operation: String(row.operation), fingerprint: String(row.fingerprint),
      result: JSON.parse(String(row.result_json)), createdAt: String(row.created_at),
    };
  }

  claimReceipt(receipt: CapabilityLibraryReceipt): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO capability_library_receipts
        (request_key, operation, fingerprint, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(receipt.requestKey, receipt.operation, receipt.fingerprint, JSON.stringify(receipt.result), receipt.createdAt);
    return Number(result.changes ?? 0) === 1;
  }
}

/** Naming aliases for callers that model repositories as stores. */
export const CapabilityLibraryStore = CapabilityLibraryRepository;
export const CapabilityStore = CapabilityLibraryRepository;

function parseRecord(value: unknown): CapabilityVersionRecord {
  return CapabilityVersionRecordSchema.parse(JSON.parse(String(value)));
}

export type { CapabilityId };
