import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretStore } from "@symphony/config";
import {
  AgentWorkOrderSchema,
  WorkerProcessLeaseSchema,
  type DriverEvent,
  type DriverProcessLeaseUpdate,
  type DriverProcessSpec,
  type DriverProcessSupervisor,
  type DriverStartRequest,
  type ProcessIdentity,
  type WorkerProcessLease,
} from "@symphony/protocol";
import { PiDriver } from "./pi.js";

const fixtureRpc = resolve("tests/fixtures/pi-durable-rpc.mjs");
const temporary: string[] = [];
const ownedProcessGroups = new Set<number>();

afterEach(() => {
  for (const processGroup of ownedProcessGroups) {
    try {
      if (process.platform === "win32") process.kill(processGroup, "SIGKILL");
      else process.kill(-processGroup, "SIGKILL");
    } catch {
      // Hosted process already exited.
    }
  }
  ownedProcessGroups.clear();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

class PiHostedSupervisor implements DriverProcessSupervisor {
  lease: WorkerProcessLease | null = null;
  generation = 1;

  constructor(readonly root: string) {}

  reserveProcess(spec: DriverProcessSpec): WorkerProcessLease {
    if (this.lease) return this.lease;
    const now = new Date().toISOString();
    this.lease = WorkerProcessLeaseSchema.parse({
      id: `lease-${randomUUID()}`,
      daemonOwnerId: "daemon-1",
      agentId: "agent-pi-driver",
      attemptId: "attempt-pi-driver",
      driver: "pi",
      role: spec.role,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      workspacePath: this.root,
      permission: "full-access",
      adapterVersion: spec.adapterVersion,
      transport: {
        kind: "worker-host",
        protocolVersion: 1,
        endpoint: join(this.root, "pi-worker.sock"),
        spoolPath: join(this.root, "pi-worker.jsonl"),
        hostInstanceId: `host-${randomUUID()}`,
        hostIdentity: null,
        workerIdentity: null,
        controllerOwnerId: "fixture-controller",
        ownerEpoch: 1,
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
      throw new Error("Fixture Pi lease adoption compare-and-swap failed.");
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

  workerHostPlan(leaseId: string) {
    const lease = this.require(leaseId);
    if (lease.transport.kind !== "worker-host") return null;
    return {
      mode: lease.state === "reserved" ? "launch" as const : "reconnect" as const,
      protocolVersion: 1 as const,
      hostCommand: process.execPath,
      hostArgs: ["--import", "tsx", resolve("apps/worker-host/src/index.ts")],
      capability: "stable-pi-driver-fixture-capability",
      controllerOwnerId: lease.transport.controllerOwnerId,
      ownerEpoch: this.generation,
      endpoint: lease.transport.endpoint,
      spoolPath: lease.transport.spoolPath,
      afterSeq: lease.transport.processedOutputSeq,
      maxSpoolBytes: 512 * 1_024,
      maxSpoolFrames: 512,
    };
  }

  private require(leaseId: string): WorkerProcessLease {
    if (!this.lease || this.lease.id !== leaseId) throw new Error(`Unknown Pi fixture lease ${leaseId}.`);
    return this.lease;
  }
}

function request(root: string): DriverStartRequest {
  return {
    agentId: "agent-pi-driver",
    resolvedModel: "fixture",
    workOrder: AgentWorkOrderSchema.parse({
      id: "pi-driver-order",
      workflowId: "pi-driver-workflow",
      runId: "pi-driver-run",
      parentAgentId: null,
      depth: 0,
      mission: { id: "pi-driver-mission", revision: 1, hash: "12345678", statement: "Exercise Pi durability." },
      objective: "Complete one durable Pi turn.",
      harness: "pi",
      model: "fixture",
      permissions: "full-access",
      outputSchema: {},
      workspace: { path: root },
    }),
    coordination: {
      daemonUrl: "http://127.0.0.1:1",
      token: "fixture-token",
      canCreate: false,
      maxDepth: null,
      mcpCommand: process.execPath,
      mcpArgs: [],
    },
  };
}

function driver(root: string, fixtureArgs: string[] = []): PiDriver {
  return new PiDriver(
    { enabled: true, process: { command: process.execPath, args: [fixtureRpc, "--fixture-root", root, ...fixtureArgs] } },
    new SecretStore("dev.symphony.pi-driver-durability-test"),
  );
}

describe("Pi driver hosted durability", () => {
  it("projects a provider-error terminal message as run.failed rather than run.completed", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-pi-driver-provider-error-"));
    temporary.push(root);
    const events: DriverEvent[] = [];
    const direct = driver(root, ["--provider-error"]);
    const session = await direct.start(request(root), (event) => events.push(event), {
      signal: new AbortController().signal,
    });
    await expect.poll(() => events.some((event) => event.kind === "run.failed")).toBe(true);

    expect(events.filter((event) => event.kind === "output.completed")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(0);
    expect(events.find((event) => event.kind === "run.failed")?.payload).toMatchObject({
      error: expect.stringContaining("only available through the Batch API"),
    });

    await direct.forceTerminate(session);
  });

  it("keeps the native direct-process fallback when no worker-host plan is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-pi-driver-direct-"));
    temporary.push(root);
    const direct = driver(root);
    const session = await direct.start(request(root), () => undefined, {
      signal: new AbortController().signal,
    });
    const nativePid = Number(readFileSync(join(root, ".fixture-pi-launches"), "utf8").trim());
    expect(session).toMatchObject({ driver: "pi", nativeSessionId: `fixture-pi-session-${nativePid}` });
    expect(() => process.kill(nativePid, 0)).not.toThrow();

    await direct.forceTerminate(session);
    await expect.poll(() => {
      try {
        process.kill(nativePid, 0);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 3_000, interval: 25 }).toBe(false);
  });

  it("reattaches the retained RPC stream without switching sessions or resubmitting its prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-pi-driver-hosted-"));
    temporary.push(root);
    const supervisor = new PiHostedSupervisor(root);
    const firstEvents: DriverEvent[] = [];
    const first = driver(root);
    const session = await first.start(request(root), (event) => firstEvents.push(event), {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    });
    const firstLease = WorkerProcessLeaseSchema.parse(supervisor.lease);
    if (firstLease.transport.kind !== "worker-host") throw new Error("Pi fixture did not create a hosted transport.");
    const hostPid = firstLease.transport.hostIdentity?.pid;
    const nativePid = firstLease.transport.workerIdentity?.pid;
    if (!hostPid || !nativePid) throw new Error("Pi fixture did not capture hosted process identities.");
    ownedProcessGroups.add(hostPid);
    expect(readFileSync(join(root, ".fixture-pi-launches"), "utf8").trim()).toBe(String(nativePid));

    await first.dispose();
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(nativePid, 0)).not.toThrow();
    await new Promise((resolveWait) => setTimeout(resolveWait, 4_250));

    supervisor.generation += 1;
    const recoveredEvents: DriverEvent[] = [];
    const second = driver(root);
    const recovered = await second.resume(session, request(root), (event) => recoveredEvents.push(event), {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    });

    expect(recovered.state).toBe("completed");
    expect(supervisor.lease?.transport).toMatchObject({
      kind: "worker-host",
      hostIdentity: { pid: hostPid },
      workerIdentity: { pid: nativePid },
    });
    expect(supervisor.lease?.adapterState).toMatchObject({ running: false, settled: true });
    expect(readFileSync(join(root, ".fixture-pi-launches"), "utf8").trim()).toBe(String(nativePid));
    expect(readFileSync(join(root, ".fixture-pi-native-dispatches"), "utf8").trim().split(/\r?\n/u)).toEqual(["fixture-pi-turn-1"]);
    expect(recoveredEvents.filter((event) => event.kind === "output.completed")).toHaveLength(1);
    expect(recoveredEvents.filter((event) => event.kind === "run.completed")).toHaveLength(1);
    expect(recoveredEvents.filter((event) => ["output.completed", "run.completed"].includes(event.kind)).every((event) => Boolean(event.nativeEventId))).toBe(true);
    expect(new Set(recoveredEvents.map((event) => event.nativeEventId).filter(Boolean)).size)
      .toBe(recoveredEvents.map((event) => event.nativeEventId).filter(Boolean).length);
    expect(firstEvents.filter((event) => event.kind === "run.completed")).toHaveLength(0);
    expect(() => process.kill(hostPid, 0)).not.toThrow();
    expect(() => process.kill(nativePid, 0)).not.toThrow();
    expect(() => readFileSync(join(root, ".fixture-pi-forbidden-switch"), "utf8")).toThrow();

    await second.forceTerminate(recovered);
    await expect.poll(() => {
      try {
        process.kill(nativePid, 0);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 3_000, interval: 25 }).toBe(false);
  }, 12_000);
});
