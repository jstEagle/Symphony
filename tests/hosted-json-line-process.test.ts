import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedJsonLineProcess } from "../packages/drivers/src/hosted-process.js";
import { JsonLineProcess } from "../packages/drivers/src/process.js";
import {
  WorkerProcessLeaseSchema,
  type DriverProcessLeaseUpdate,
  type DriverProcessSpec,
  type DriverProcessSupervisor,
  type ProcessIdentity,
  type WorkerProcessLease,
} from "../packages/protocol/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

class HostedSupervisor implements DriverProcessSupervisor {
  lease: WorkerProcessLease | null = null;
  retirementRequests: Array<{ leaseId: string; reason: string; error: string | null | undefined }> = [];
  generation = 1;
  readonly root: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "symphony-hosted-jsonl-"));
    temporary.push(this.root);
  }

  reserveProcess(spec: DriverProcessSpec): WorkerProcessLease {
    if (this.lease) return this.lease;
    const now = new Date().toISOString();
    this.lease = WorkerProcessLeaseSchema.parse({
      id: `lease-${randomUUID()}`,
      daemonOwnerId: "daemon-1",
      agentId: "agent-hosted-jsonl",
      attemptId: "attempt-1",
      driver: "codex",
      role: spec.role,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      workspacePath: this.root,
      permission: "read-only",
      adapterVersion: spec.adapterVersion,
      transport: {
        kind: "worker-host",
        protocolVersion: 1,
        endpoint: join(this.root, "worker.sock"),
        spoolPath: join(this.root, "worker.jsonl"),
        hostInstanceId: `host-${randomUUID()}`,
        hostIdentity: null,
        workerIdentity: null,
        controllerOwnerId: "fixture-controller",
        ownerEpoch: this.generation,
        processedOutputSeq: 0,
        ackedOutputSeq: 0,
        producedOutputSeq: 0,
        spoolBytes: 0,
        spoolState: "healthy",
      },
      identity: null,
      nativeSessionId: null,
      nativeRunId: null,
      activeTurnId: null,
      lastEventCursor: null,
      state: "reserved",
      reservedAt: now,
      attachedAt: null,
      updatedAt: now,
      releasedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      revision: 0,
    });
    return this.lease;
  }

  attachProcess(leaseId: string, identity: ProcessIdentity): WorkerProcessLease {
    const lease = this.require(leaseId);
    this.lease = WorkerProcessLeaseSchema.parse({
      ...lease,
      identity,
      state: "running",
      attachedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: lease.revision + 1,
    });
    return this.lease;
  }

  adoptProcess(
    leaseId: string,
    expectedRevision: number,
    transport: WorkerProcessLease["transport"],
  ): WorkerProcessLease {
    const lease = this.require(leaseId);
    if (lease.revision !== expectedRevision || lease.state !== "running") {
      throw new Error(`Fixture lease adoption compare-and-swap failed (expected=${expectedRevision}, actual=${lease.revision}, state=${lease.state}).`);
    }
    this.lease = WorkerProcessLeaseSchema.parse({
      ...lease,
      daemonOwnerId: `daemon-${this.generation}`,
      transport,
      updatedAt: new Date().toISOString(),
      revision: lease.revision + 1,
    });
    return this.lease;
  }

  updateProcess(leaseId: string, patch: DriverProcessLeaseUpdate): WorkerProcessLease {
    const lease = this.require(leaseId);
    this.lease = WorkerProcessLeaseSchema.parse({
      ...lease,
      ...patch,
      updatedAt: new Date().toISOString(),
      revision: lease.revision + 1,
    });
    return this.lease;
  }

  releaseProcess(
    leaseId: string,
    result: { exitCode: number | null; signal: string | null; error?: string | null },
  ): WorkerProcessLease {
    const lease = this.require(leaseId);
    this.lease = WorkerProcessLeaseSchema.parse({
      ...lease,
      state: "exited",
      releasedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      signal: result.signal,
      error: result.error ?? null,
      revision: lease.revision + 1,
    });
    return this.lease;
  }

  requestProcessRetirement(
    leaseId: string,
    request: { reason: "controller-lost"; error?: string | null },
  ): WorkerProcessLease {
    const lease = this.require(leaseId);
    this.retirementRequests.push({ leaseId, reason: request.reason, error: request.error });
    this.lease = WorkerProcessLeaseSchema.parse({
      ...lease,
      retirementRequestedAt: new Date().toISOString(),
      retirementReason: request.reason,
      error: request.error ?? lease.error,
      updatedAt: new Date().toISOString(),
      revision: lease.revision + 1,
    });
    return this.lease;
  }

  workerHostPlan(leaseId: string) {
    const lease = this.require(leaseId);
    if (lease.transport.kind !== "worker-host") return null;
    const sourceEntry = resolve("apps/worker-host/src/index.ts");
    return {
      mode: lease.state === "reserved" ? "launch" as const : "reconnect" as const,
      protocolVersion: 1 as const,
      hostCommand: process.execPath,
      hostArgs: ["--import", "tsx", sourceEntry],
      capability: "fixture-capability-that-remains-stable",
      controllerOwnerId: lease.transport.controllerOwnerId,
      ownerEpoch: this.generation,
      endpoint: lease.transport.endpoint,
      spoolPath: lease.transport.spoolPath,
      afterSeq: lease.transport.processedOutputSeq,
      maxSpoolBytes: 256 * 1_024,
      maxSpoolFrames: 256,
    };
  }

  private require(leaseId: string): WorkerProcessLease {
    if (!this.lease || this.lease.id !== leaseId) throw new Error(`Unknown lease ${leaseId}`);
    return this.lease;
  }
}

describe("hosted JSONL process", () => {
  it("releases a reserved lease when the native worker cannot start", async () => {
    const supervisor = new HostedSupervisor();
    const unexpected: Error[] = [];
    const transport = new HostedJsonLineProcess({
      command: join(supervisor.root, "missing-native-worker"),
      args: [],
      cwd: supervisor.root,
      env: process.env,
      processSupervisor: supervisor,
      processRole: "cursor-sdk-host",
    }, {
      onNotification: () => undefined,
      onUnexpectedExit: (error: Error) => unexpected.push(error),
    });

    await expect(transport.activate()).rejects.toThrow(/worker|identity|ready/iu);
    await expect.poll(() => supervisor.lease?.state).toBe("exited");
    expect(supervisor.lease?.error).toMatch(/worker|identity|ready/iu);
    expect(unexpected).toHaveLength(1);
  });

  it("scrubs the daemon root from direct and worker-hosted native child environments", async () => {
    const environment = {
      ...process.env,
      SYMPHONY_DAEMON_SECRET: "d".repeat(64),
      SYMPHONY_AGENT_TOKEN: "fixture-agent-token",
    };
    const direct = new JsonLineProcess({
      command: process.execPath,
      args: [resolve("tests/fixtures/worker-host-child.mjs")],
      cwd: process.cwd(),
      env: environment,
    }, () => undefined);
    const directResponse = await direct.request("fixture/echo", { transport: "direct" });
    expect(directResponse).toMatchObject({ daemonSecretPresent: false });
    await direct.close();

    const supervisor = new HostedSupervisor();
    const hosted = new HostedJsonLineProcess({
      command: process.execPath,
      args: [resolve("tests/fixtures/worker-host-child.mjs")],
      cwd: process.cwd(),
      env: environment,
      processSupervisor: supervisor,
      processRole: "codex-app-server",
    }, { onNotification: () => undefined });
    await hosted.activate();
    const hostedResponse = await hosted.request("fixture/echo", { transport: "worker-host" });
    expect(hostedResponse).toMatchObject({ daemonSecretPresent: false });
    await hosted.close();
    await expect.poll(() => supervisor.lease?.state, { timeout: 3_000 }).toBe("exited");
  });

  it("does not advertise a native worker that has exited as reusable", async () => {
    const supervisor = new HostedSupervisor();
    const unexpected: Error[] = [];
    const spec = {
      command: process.execPath,
      args: [resolve("tests/fixtures/worker-host-child.mjs")],
      cwd: process.cwd(),
      env: process.env,
      processSupervisor: supervisor,
      processRole: "codex-app-server",
    };
    const transport = new HostedJsonLineProcess(spec, {
      onNotification: () => undefined,
      onUnexpectedExit: (error: Error) => unexpected.push(error),
    });
    await transport.activate();
    const response = await transport.request("fixture/echo", { value: "before-worker-exit" });
    const workerPid = (response as { pid: number }).pid;
    const hostPid = supervisor.lease?.transport.kind === "worker-host"
      ? supervisor.lease.transport.hostIdentity?.pid
      : null;
    expect(transport.isReusable()).toBe(true);

    process.kill(workerPid, "SIGKILL");
    await expect.poll(() => ({ reusable: transport.isReusable(), lease: supervisor.lease?.state }), {
      timeout: 3_000,
      interval: 25,
    }).toEqual({ reusable: false, lease: "exited" });
    // The lease is released as soon as the durable exit frame is observed,
    // while the driver callback is emitted only after that frame is projected
    // and acknowledged. Wait for both sides of that ordering contract.
    await expect.poll(() => unexpected, { timeout: 3_000, interval: 25 }).toHaveLength(1);
    await expect.poll(() => {
      try {
        process.kill(hostPid as number, 0);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 3_000, interval: 25 }).toBe(false);
  });

  it("reattaches to the same worker after controller detach", async () => {
    const supervisor = new HostedSupervisor();
    const notifications: Array<Record<string, unknown>> = [];
    const callbacks = { onNotification: (message: Record<string, unknown>) => notifications.push(message) };
    const spec = {
      command: process.execPath,
      args: [resolve("tests/fixtures/worker-host-child.mjs")],
      cwd: process.cwd(),
      env: process.env,
      processSupervisor: supervisor,
      processRole: "codex-app-server",
    };

    const first = new HostedJsonLineProcess(spec, callbacks);
    expect(first.mode).toBe("spawned");
    await first.activate();
    const firstResponse = await first.request("fixture/echo", { value: 1 });
    const workerPid = (firstResponse as { pid: number }).pid;
    expect(workerPid).toBeGreaterThan(0);
    expect(supervisor.lease).toMatchObject({
      state: "running",
      identity: { pid: workerPid },
      transport: {
        kind: "worker-host",
        hostIdentity: { pid: expect.any(Number) },
        workerIdentity: { pid: workerPid },
        processedOutputSeq: expect.any(Number),
        ackedOutputSeq: expect.any(Number),
      },
    });
    const hostPid = supervisor.lease?.transport.kind === "worker-host"
      ? supervisor.lease.transport.hostIdentity?.pid
      : null;
    expect(hostPid).toBeGreaterThan(0);

    await first.detach();
    expect(() => process.kill(workerPid, 0)).not.toThrow();
    expect(() => process.kill(hostPid as number, 0)).not.toThrow();
    await wait(20);

    supervisor.generation += 1;
    const second = new HostedJsonLineProcess(spec, callbacks);
    expect(second.mode).toBe("reconnected");
    await second.activate();
    const secondResponse = await second.request("fixture/echo", { value: 2 });
    expect(secondResponse).toMatchObject({ pid: workerPid, params: { value: 2 } });
    expect(supervisor.lease?.transport).toMatchObject({ ownerEpoch: 2 });

    await second.close();
    await expect.poll(() => supervisor.lease?.state, { timeout: 3_000 }).toBe("exited");
    await wait(20);
    expect(() => process.kill(workerPid, 0)).toThrow();
    expect(() => process.kill(hostPid as number, 0)).toThrow();
    expect(notifications.some((message) => message.type === "fixture.ready")).toBe(true);
  });

  it("recovers an in-flight native request after the active controller socket is lost", async () => {
    const supervisor = new HostedSupervisor();
    const notifications: Array<Record<string, unknown>> = [];
    const unexpected: Error[] = [];
    const transport = new HostedJsonLineProcess({
      command: process.execPath,
      args: [resolve("tests/fixtures/worker-host-child.mjs")],
      cwd: process.cwd(),
      env: process.env,
      processSupervisor: supervisor,
      processRole: "codex-app-server",
    }, {
      onNotification: (message: Record<string, unknown>) => notifications.push(message),
      onUnexpectedExit: (error: Error) => unexpected.push(error),
    });

    await transport.activate();
    const before = await transport.request("fixture/echo", { phase: "before-controller-loss" });
    const workerPid = (before as { pid: number }).pid;
    const hostPid = supervisor.lease?.transport.kind === "worker-host"
      ? supervisor.lease.transport.hostIdentity?.pid
      : null;
    expect(workerPid).toBeGreaterThan(0);
    expect(hostPid).toBeGreaterThan(0);

    const inFlight = transport.requestWithId(
      "fixture-controller-loss-request",
      "fixture/delayed-response",
      { delayMs: 250, phase: "during-controller-loss" },
      5_000,
    );
    await expect.poll(
      () => notifications.some((message) => (
        message.type === "fixture.request-accepted"
        && message.requestId === "fixture-controller-loss-request"
      )),
      { timeout: 3_000, interval: 10 },
    ).toBe(true);

    const activeConnection = (transport as unknown as {
      connection: { socket: { destroy: () => void } } | null;
    }).connection;
    if (!activeConnection) throw new Error("Hosted controller connection was not available for the loss fixture.");
    activeConnection.socket.destroy();

    await expect(inFlight).resolves.toMatchObject({
      method: "fixture/delayed-response",
      params: { phase: "during-controller-loss" },
      pid: workerPid,
      count: 1,
    });
    const after = await transport.request("fixture/echo", { phase: "after-controller-loss" });
    expect(after).toMatchObject({ pid: workerPid, params: { phase: "after-controller-loss" } });
    expect(supervisor.lease?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: workerPid },
    });
    expect(transport.isReusable()).toBe(true);
    expect(unexpected).toEqual([]);
    expect(() => process.kill(workerPid, 0)).not.toThrow();
    expect(() => process.kill(hostPid as number, 0)).not.toThrow();
    await expect.poll(() => {
      const lease = supervisor.lease;
      if (lease?.transport.kind !== "worker-host") return false;
      return lease.transport.producedOutputSeq === lease.transport.processedOutputSeq
        && lease.transport.processedOutputSeq === lease.transport.ackedOutputSeq;
    }, { timeout: 3_000, interval: 20 }).toBe(true);

    await transport.close();
    await expect.poll(() => supervisor.lease?.state, { timeout: 3_000 }).toBe("exited");
    await wait(20);
    expect(() => process.kill(workerPid, 0)).toThrow();
    expect(() => process.kill(hostPid as number, 0)).toThrow();
  });

  it("persists a controller-lost retirement intent when reconnect grace is exhausted", async () => {
    const supervisor = new HostedSupervisor();
    const unexpected: Error[] = [];
    const transport = new HostedJsonLineProcess({
      command: process.execPath,
      args: [resolve("tests/fixtures/worker-host-child.mjs")],
      cwd: process.cwd(),
      env: process.env,
      processSupervisor: supervisor,
      processRole: "codex-app-server",
    }, {
      onNotification: () => undefined,
      onUnexpectedExit: (error: Error) => unexpected.push(error),
    });

    await transport.activate();
    const response = await transport.request("fixture/echo", { phase: "before-reconnect-exhaustion" });
    const workerPid = (response as { pid: number }).pid;
    const hostPid = supervisor.lease?.transport.kind === "worker-host"
      ? supervisor.lease.transport.hostIdentity?.pid
      : null;
    expect(workerPid).toBeGreaterThan(0);
    expect(hostPid).toBeGreaterThan(0);

    const internals = transport as unknown as {
      connection: { socket: { destroy: () => void } } | null;
      connectionOptions: { socketPath: string };
    };
    internals.connectionOptions.socketPath = join(supervisor.root, "missing-controller.sock");
    const initialNow = Date.now();
    let nowCalls = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls <= 1 ? initialNow : initialNow + 10_000;
    });
    internals.connection?.socket.destroy();
    await expect.poll(() => supervisor.retirementRequests.length, { timeout: 3_000, interval: 10 }).toBe(1);
    now.mockRestore();

    expect(supervisor.retirementRequests[0]).toMatchObject({ reason: "controller-lost" });
    expect(supervisor.lease).toMatchObject({
      state: "running",
      retirementReason: "controller-lost",
      retirementRequestedAt: expect.any(String),
    });
    expect(unexpected).toHaveLength(1);
    expect(() => process.kill(workerPid, 0)).not.toThrow();

    try {
      process.kill(-(hostPid as number), "SIGKILL");
    } catch {
      // The host-side controller grace may have already retired the group.
    }
  });

  it("rejects adoption when the worker host has acknowledged output beyond the durable projection", async () => {
    const supervisor = new HostedSupervisor();
    const unexpected: Error[] = [];
    const callbacks = {
      onNotification: () => undefined,
      onUnexpectedExit: (error: Error) => unexpected.push(error),
    };
    const spec = {
      command: process.execPath,
      args: [resolve("tests/fixtures/worker-host-child.mjs")],
      cwd: process.cwd(),
      env: process.env,
      processSupervisor: supervisor,
      processRole: "codex-app-server",
    };

    const first = new HostedJsonLineProcess(spec, callbacks);
    await first.activate();
    const response = await first.request("fixture/echo", { value: "before-detach" });
    const workerPid = (response as { pid: number }).pid;
    const revisionAfterResponse = supervisor.lease?.revision ?? -1;
    await expect.poll(() => {
      const lease = supervisor.lease;
      const transport = lease?.transport;
      return Boolean(
        lease
        && lease.revision > revisionAfterResponse
        && transport?.kind === "worker-host"
        && transport.processedOutputSeq === transport.producedOutputSeq
        && transport.ackedOutputSeq === transport.processedOutputSeq,
      );
    }).toBe(true);
    await first.detach();
    await wait(20);
    const validLease = WorkerProcessLeaseSchema.parse(supervisor.lease);
    if (validLease.transport.kind !== "worker-host") throw new Error("Fixture expected worker-host transport.");
    const hostPid = validLease.transport.hostIdentity?.pid;
    expect(hostPid).toBeGreaterThan(0);
    expect(validLease.transport.ackedOutputSeq).toBeGreaterThan(0);

    const cursorBehindHost = validLease.transport.ackedOutputSeq - 1;
    supervisor.lease = WorkerProcessLeaseSchema.parse({
      ...validLease,
      transport: {
        ...validLease.transport,
        processedOutputSeq: cursorBehindHost,
        ackedOutputSeq: cursorBehindHost,
      },
      revision: validLease.revision + 1,
    });
    supervisor.generation += 1;

    const invalidAdoption = new HostedJsonLineProcess(spec, callbacks);
    expect(invalidAdoption.mode).toBe("reconnected");
    await expect(invalidAdoption.activate()).rejects.toThrow(
      "Worker host compacted output that the durable ledger cannot prove was projected.",
    );
    expect(() => process.kill(workerPid, 0)).not.toThrow();
    expect(() => process.kill(hostPid as number, 0)).not.toThrow();
    expect(unexpected).toHaveLength(1);

    const adoptedInvalidLease = WorkerProcessLeaseSchema.parse(supervisor.lease);
    if (adoptedInvalidLease.transport.kind !== "worker-host") throw new Error("Fixture expected worker-host transport.");
    supervisor.lease = WorkerProcessLeaseSchema.parse({
      ...adoptedInvalidLease,
      transport: {
        ...validLease.transport,
        ownerEpoch: supervisor.generation,
      },
      revision: adoptedInvalidLease.revision + 1,
    });
    supervisor.generation += 1;

    const cleanup = new HostedJsonLineProcess(spec, callbacks);
    await cleanup.activate();
    await cleanup.close();
    await expect.poll(() => supervisor.lease?.state, { timeout: 3_000 }).toBe("exited");
    await wait(20);
    expect(() => process.kill(workerPid, 0)).toThrow();
    expect(() => process.kill(hostPid as number, 0)).toThrow();
  });

  it("responds independently to repeated native server-request JSON-RPC ids", async () => {
    const supervisor = new HostedSupervisor();
    const notifications: Array<Record<string, unknown>> = [];
    const requests: Array<Record<string, unknown>> = [];
    const callbacks = {
      onNotification: (message: Record<string, unknown>) => notifications.push(message),
      onRequest: async (message: Record<string, unknown>) => {
        requests.push(message);
        return {
          method: message.method,
          ordinal: (message.params as { ordinal?: number } | undefined)?.ordinal ?? null,
        };
      },
    };
    const spec = {
      command: process.execPath,
      args: [resolve("tests/fixtures/worker-host-child.mjs")],
      cwd: process.cwd(),
      env: process.env,
      processSupervisor: supervisor,
      processRole: "codex-app-server",
    };

    const processTransport = new HostedJsonLineProcess(spec, callbacks);
    await processTransport.activate();
    await processTransport.request("fixture/request-reused-server-id");
    await expect.poll(
      () => notifications.find((message) => message.type === "fixture.reused-server-responses"),
      { timeout: 3_000 },
    ).toMatchObject({
      responses: [
        { result: { method: "fixture/server-question-one", ordinal: 1 }, error: null },
        { result: { method: "fixture/server-question-two", ordinal: 2 }, error: null },
      ],
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((message) => message.id)).toEqual([
      "fixture-reused-server-request",
      "fixture-reused-server-request",
    ]);
    expect(new Set(requests.map((message) => message.__symphonyHostEventId)).size).toBe(2);

    await processTransport.close();
    await expect.poll(() => supervisor.lease?.state, { timeout: 3_000 }).toBe("exited");
  });
});
