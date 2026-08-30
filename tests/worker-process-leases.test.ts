import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProcessIdentitySchema,
  WorkerProcessLeaseSchema,
  type ProcessIdentity,
  type WorkerProcessLease,
} from "../packages/protocol/src/index.js";
import { SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function processIdentity(pid = 42): ProcessIdentity {
  return ProcessIdentitySchema.parse({
    pid,
    processGroupId: pid,
    platform: "linux",
    capturedAt: "2026-08-31T00:00:01.000Z",
    executable: "/usr/bin/codex",
    startToken: "boot-id:12345",
    verification: "strong",
  });
}

function workerLease(overrides: Partial<WorkerProcessLease> = {}): WorkerProcessLease {
  return WorkerProcessLeaseSchema.parse({
    id: "lease-1",
    daemonOwnerId: "daemon-owner-1",
    agentId: "agent-1",
    attemptId: "attempt-1",
    driver: "codex",
    role: "adapter",
    command: "codex",
    args: ["app-server"],
    cwd: "/tmp/project",
    workspacePath: "/tmp/project",
    permission: "full-access",
    adapterVersion: "1.2.3",
    identity: null,
    nativeSessionId: null,
    nativeRunId: null,
    activeTurnId: null,
    lastEventCursor: null,
    state: "reserved",
    reservedAt: "2026-08-31T00:00:00.000Z",
    attachedAt: null,
    updatedAt: "2026-08-31T00:00:00.000Z",
    releasedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    revision: 0,
    ...overrides,
  });
}

describe("worker process lease storage", () => {
  it("migrates through v7 and preserves validated process identity across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-worker-leases-"));
    temporary.push(directory);
    const path = join(directory, "state.sqlite");

    const legacy = new SymphonyStore(path);
    legacy.database.exec("DROP TABLE worker_process_leases; DELETE FROM schema_migrations WHERE version IN (6, 7);");
    legacy.close();

    const migrated = new SymphonyStore(path);
    expect(migrated.database.prepare("SELECT version FROM schema_migrations WHERE version = 6").get()).toEqual({
      version: 6,
    });
    expect(migrated.database.prepare("SELECT version FROM schema_migrations WHERE version = 7").get()).toEqual({
      version: 7,
    });
    expect(
      migrated.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_process_leases'")
        .get(),
    ).toEqual({ name: "worker_process_leases" });
    const attached = workerLease({
      identity: processIdentity(),
      state: "running",
      attachedAt: "2026-08-31T00:00:01.000Z",
      updatedAt: "2026-08-31T00:00:01.000Z",
      revision: 1,
    });
    migrated.saveWorkerProcessLease(attached);
    migrated.close();

    const reopened = new SymphonyStore(path);
    expect(reopened.getWorkerProcessLease(attached.id)).toEqual(attached);
    expect(reopened.listWorkerProcessLeases({ daemonOwnerId: attached.daemonOwnerId })).toEqual([attached]);
    expect(reopened.listWorkerProcessLeases({ agentId: attached.agentId, states: ["running"] })).toEqual([
      attached,
    ]);
    expect(reopened.listWorkerProcessLeases({ states: ["exited"] })).toEqual([]);
    reopened.close();
  });

  it("adopts a hosted transport with an exact owner/revision compare-and-set", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-worker-lease-adopt-"));
    temporary.push(directory);
    const store = new SymphonyStore(join(directory, "state.sqlite"));
    const hostIdentity = processIdentity(84);
    const running = workerLease({
      state: "running",
      identity: hostIdentity,
      attachedAt: "2026-08-31T00:00:01.000Z",
      transport: {
        kind: "worker-host",
        protocolVersion: 1,
        endpoint: join(directory, "lease-1.sock"),
        spoolPath: join(directory, "lease-1.jsonl"),
        hostInstanceId: "host-instance-1",
        hostIdentity,
        workerIdentity: null,
        controllerOwnerId: "stable-controller",
        ownerEpoch: 1,
        processedOutputSeq: 8,
        ackedOutputSeq: 7,
        producedOutputSeq: 9,
        spoolBytes: 512,
        spoolState: "healthy",
      },
      revision: 1,
    });
    store.saveWorkerProcessLease(running);

    const adopted = store.adoptWorkerProcessLease(
      running.id,
      running.revision,
      "daemon-owner-2",
      { ...running.transport, ownerEpoch: 2, producedOutputSeq: 12 },
    );
    expect(adopted).toMatchObject({
      daemonOwnerId: "daemon-owner-2",
      revision: 2,
      transport: { kind: "worker-host", ownerEpoch: 2, processedOutputSeq: 8, ackedOutputSeq: 7, producedOutputSeq: 12 },
    });
    expect(store.adoptWorkerProcessLease(
      running.id,
      running.revision,
      "stale-owner",
      running.transport,
    )).toBeNull();
    expect(store.database.prepare(
      "SELECT transport_kind, transport_endpoint, owner_epoch, processed_output_seq, acked_output_seq FROM worker_process_leases WHERE id = ?",
    ).get(running.id)).toEqual({
      transport_kind: "worker-host",
      transport_endpoint: join(directory, "lease-1.sock"),
      owner_epoch: 2,
      processed_output_seq: 8,
      acked_output_seq: 7,
    });
    store.close();
  });

  it("uses state and revision guards for transitions and rejects stale saves", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-worker-lease-cas-"));
    temporary.push(directory);
    const store = new SymphonyStore(join(directory, "state.sqlite"));
    const reserved = workerLease();
    expect(store.saveWorkerProcessLease(reserved)).toEqual(reserved);

    const running = store.transitionWorkerProcessLease(reserved.id, ["reserved"], {
      state: "running",
      identity: processIdentity(),
      attachedAt: "2026-08-31T00:00:01.000Z",
    });
    expect(running).toMatchObject({ state: "running", revision: 1, identity: { pid: 42 } });
    expect(
      store.transitionWorkerProcessLease(reserved.id, ["reserved"], {
        state: "orphaned",
        error: "stale owner",
      }),
    ).toBeNull();

    const touched = store.touchWorkerProcessLease(reserved.id, {
      nativeSessionId: "native-session-1",
      nativeRunId: "native-run-1",
      activeTurnId: "turn-1",
      lastEventCursor: 17,
    });
    expect(touched).toMatchObject({
      state: "running",
      revision: 2,
      nativeSessionId: "native-session-1",
      nativeRunId: "native-run-1",
      activeTurnId: "turn-1",
      lastEventCursor: 17,
    });

    expect(store.saveWorkerProcessLease(reserved)).toMatchObject({ state: "running", revision: 2 });
    const exited = store.transitionWorkerProcessLease(reserved.id, ["running"], {
      state: "exited",
      releasedAt: "2026-08-31T00:00:02.000Z",
      exitCode: 0,
      signal: null,
      error: null,
    });
    expect(exited).toMatchObject({ state: "exited", revision: 3, exitCode: 0 });
    expect(store.getWorkerProcessLease(reserved.id)).toEqual(exited);
    expect(store.touchWorkerProcessLease("missing", { lastEventCursor: 18 })).toBeNull();
    store.close();
  });

  it("composes lease updates inside a native-event transaction and rolls them back atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-worker-lease-nested-"));
    temporary.push(directory);
    const store = new SymphonyStore(join(directory, "state.sqlite"));
    store.saveWorkerProcessLease(workerLease());

    store.transaction(() => {
      expect(store.claimNativeDriverEvent({
        agentId: "agent-1",
        eventKind: "run.completed",
        nativeEventId: "turn-1",
      })).toBe(true);
      expect(store.touchWorkerProcessLease("lease-1", {
        activeTurnId: null,
        lastEventCursor: 17,
      })).toMatchObject({ revision: 1, lastEventCursor: 17 });
    });
    expect(store.getWorkerProcessLease("lease-1")).toMatchObject({ revision: 1, lastEventCursor: 17 });

    expect(() => store.transaction(() => {
      store.touchWorkerProcessLease("lease-1", { lastEventCursor: 18 });
      store.durableTransaction(() => store.setMetadata("nested-durable", { accepted: true }));
      throw new Error("rollback nested projection");
    })).toThrow("rollback nested projection");
    expect(store.getWorkerProcessLease("lease-1")).toMatchObject({ revision: 1, lastEventCursor: 17 });
    expect(store.getMetadata("nested-durable")).toBeNull();
    store.close();
  });
});
