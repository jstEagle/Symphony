import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, SecretStore } from "@symphony/config";
import {
  DriverStartRequestSchema,
  WorkerProcessLeaseSchema,
  type DriverEvent,
  type DriverProcessLeaseUpdate,
  type DriverProcessSpec,
  type DriverProcessSupervisor,
  type DriverSession,
  type ProcessIdentity,
  type WorkerProcessLease,
} from "@symphony/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  createOpencodeClient: vi.fn(),
}));

vi.mock("@opencode-ai/sdk", () => sdk);

import { OpenCodeDriver } from "./opencode.js";

const temporary: string[] = [];
const hostedSupervisors: HostedSupervisor[] = [];
const SERVICE_MASTER = Buffer.alloc(32, 0x5a).toString("base64url");

class MemorySecretStore extends SecretStore {
  value: string | null;

  constructor(initial: string | null) {
    super("dev.symphony.test", { platform: "linux" });
    this.value = initial;
  }

  override get(): string | null { return this.value; }
  override set(_key: string, value: string): void { this.value = value; }
  override delete(): boolean { this.value = null; return true; }
  override describeLocation(): string { return this.value ? "memory" : "missing"; }
}

function memorySecrets(initial: string | null = SERVICE_MASTER): MemorySecretStore {
  return new MemorySecretStore(initial);
}

function openCodeDriver(
  config: typeof defaultConfig.harnesses.opencode,
  secrets: SecretStore = memorySecrets(),
): OpenCodeDriver {
  return new OpenCodeDriver(config, secrets);
}

function expectedAuthorization(agentId: string): string {
  const password = expectedPassword(agentId);
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

function expectedPassword(agentId: string): string {
  return createHmac("sha256", Buffer.from(SERVICE_MASTER, "base64url"))
    .update(`symphony-opencode-basic:v1:${agentId}`)
    .digest("base64url");
}

class HostedSupervisor implements DriverProcessSupervisor {
  lease: WorkerProcessLease | null = null;
  generation = 1;
  retainedProcess = false;
  readonly root: string;

  constructor(private readonly agentId = "agent-opencode") {
    this.root = mkdtempSync(join(tmpdir(), "symphony-opencode-hosted-"));
    temporary.push(this.root);
    hostedSupervisors.push(this);
  }

  reserveProcess(spec: DriverProcessSpec): WorkerProcessLease {
    if (this.lease) {
      const exact = this.lease.role === spec.role
        && this.lease.command === spec.command
        && JSON.stringify(this.lease.args) === JSON.stringify(spec.args)
        && this.lease.cwd === spec.cwd;
      if (!exact) throw new Error(`Retained worker-host lease ${this.lease.id} does not match the requested native process.`);
      return this.lease;
    }
    const now = new Date().toISOString();
    this.lease = WorkerProcessLeaseSchema.parse({
      id: `lease-${randomUUID()}`,
      daemonOwnerId: "daemon-1",
      agentId: this.agentId,
      attemptId: "attempt-1",
      driver: "opencode",
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
      adapterState: {},
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

  workerHostPlan(leaseId: string) {
    const lease = this.require(leaseId);
    if (lease.transport.kind !== "worker-host") return null;
    return {
      mode: lease.state === "reserved" ? "launch" as const : "reconnect" as const,
      protocolVersion: 1 as const,
      hostCommand: process.execPath,
      hostArgs: ["--import", "tsx", resolve("apps/worker-host/src/index.ts")],
      capability: "opencode-fixture-capability",
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

class ControlledStream {
  returnCount = 0;
  private readonly queued: IteratorResult<unknown>[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<unknown>) => void;
    reject: (error: unknown) => void;
  }> = [];

  next(): Promise<IteratorResult<unknown>> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  push(value: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.queued.push({ done: false, value });
  }

  end(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: true, value: undefined });
    else this.queued.push({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.reject(error);
    else throw new Error("The controlled stream has no active reader.");
  }

  return(): Promise<IteratorResult<unknown>> {
    this.returnCount += 1;
    this.end();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): ControlledStream {
    return this;
  }
}

function request(workspacePath = process.cwd(), agentId = "agent-opencode") {
  return DriverStartRequestSchema.parse({
    agentId,
    workOrder: {
      workflowId: "workflow-opencode",
      runId: "run-opencode",
      depth: 1,
      mission: {
        id: "mission-opencode",
        revision: 1,
        hash: "12345678",
        statement: "Exercise the native OpenCode lifecycle.",
      },
      objective: "Inspect the workspace without changing it.",
      permissions: "read-only",
      outputSchema: {},
      workspace: { path: workspacePath },
    },
    resolvedModel: "auto",
    coordination: {
      daemonUrl: "http://127.0.0.1:3210",
      token: "test-token",
      mcpCommand: "symphony-mcp",
      mcpArgs: [],
      canCreate: false,
      maxDepth: 3,
    },
  });
}

function fakeClient(stream: ControlledStream) {
  return {
    path: { get: vi.fn().mockResolvedValue({ data: { directory: "/tmp" } }) },
    mcp: {
      status: vi.fn().mockResolvedValue({ data: {} }),
      add: vi.fn().mockResolvedValue({ data: true }),
    },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "native-opencode" } }),
      get: vi.fn().mockResolvedValue({ data: { id: "native-opencode" } }),
      status: vi.fn().mockResolvedValue({ data: { "native-opencode": { type: "busy" } } }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      promptAsync: vi.fn().mockResolvedValue({ data: true }),
      abort: vi.fn().mockResolvedValue({ data: true }),
    },
    event: {
      subscribe: vi.fn().mockResolvedValue({ stream }),
    },
  };
}

function externalDriver(client: ReturnType<typeof fakeClient>): OpenCodeDriver {
  sdk.createOpencodeClient.mockReturnValue(client);
  return openCodeDriver({ ...defaultConfig.harnesses.opencode, autoStart: false });
}

function nativeSession(): DriverSession {
  return {
    driver: "opencode",
    nativeSessionId: "native-opencode",
    nativeRunId: null,
    state: "running",
    startedAt: new Date().toISOString(),
    metadata: {},
  };
}

function completedNativeTranscript(): Array<{ info: Record<string, unknown>; parts: unknown[] }> {
  return [
    {
      info: {
        id: "message-user-1",
        sessionID: "native-opencode",
        role: "user",
        time: { created: 1_000 },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
      },
      parts: [{ id: "part-user-1", sessionID: "native-opencode", messageID: "message-user-1", type: "text", text: "Do the work." }],
    },
    {
      info: {
        id: "message-assistant-1",
        sessionID: "native-opencode",
        role: "assistant",
        parentID: "message-user-1",
        time: { created: 1_100, completed: 1_200 },
        modelID: "gpt-test",
        providerID: "openai",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0.1,
        tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
        finish: "tool-calls",
      },
      parts: [
        { id: "part-reasoning-1", sessionID: "native-opencode", messageID: "message-assistant-1", type: "reasoning", text: "Inspecting.", time: { start: 1_110, end: 1_120 } },
        {
          id: "part-tool-1",
          sessionID: "native-opencode",
          messageID: "message-assistant-1",
          type: "tool",
          callID: "call-1",
          tool: "read",
          state: { status: "completed", input: { path: "README.md" }, output: "contents", title: "Read README", metadata: {}, time: { start: 1_120, end: 1_130 } },
        },
      ],
    },
    {
      info: {
        id: "message-assistant-2",
        sessionID: "native-opencode",
        role: "assistant",
        parentID: "message-user-1",
        time: { created: 1_300, completed: 1_400 },
        modelID: "gpt-test",
        providerID: "openai",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0.2,
        tokens: { input: 20, output: 10, reasoning: 2, cache: { read: 4, write: 0 } },
        finish: "stop",
      },
      parts: [
        { id: "part-text-1", sessionID: "native-opencode", messageID: "message-assistant-2", type: "text", text: "Done.", time: { start: 1_310, end: 1_390 } },
        { id: "part-patch-1", sessionID: "native-opencode", messageID: "message-assistant-2", type: "patch", hash: "patch-1", files: ["README.md"] },
      ],
    },
  ];
}

describe("OpenCode driver lifecycle", () => {
  beforeEach(() => {
    sdk.createOpencodeClient.mockReset();
  });

  afterEach(() => {
    for (const supervisor of hostedSupervisors.splice(0)) {
      const hostPid = supervisor.lease?.transport.kind === "worker-host"
        ? supervisor.lease.transport.hostIdentity?.pid
        : null;
      if (hostPid) {
        try {
          if (process.platform === "win32") process.kill(hostPid, "SIGKILL");
          else process.kill(-hostPid, "SIGKILL");
        } catch {
          // The focused test already retired its owned host.
        }
      }
    }
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("reattaches to an auto-started hosted service using its retained endpoint and detaches on recovery failure", async () => {
    const supervisor = new HostedSupervisor();
    const readinessUrl = "http://127.0.0.1:4312";
    const processArgs = [
      "-e",
      `console.log("opencode server listening on ${readinessUrl}"); setInterval(() => {}, 1000);`,
    ];
    const config = {
      ...defaultConfig.harnesses.opencode,
      autoStart: true,
      baseUrl: "http://127.0.0.1:4096",
      process: { command: process.execPath, args: processArgs },
    };
    const external = fakeClient(new ControlledStream());
    external.path.get.mockRejectedValue(new Error("not running"));
    const firstClient = fakeClient(new ControlledStream());
    sdk.createOpencodeClient
      .mockReturnValueOnce(external)
      .mockReturnValueOnce(firstClient);
    const firstDriver = openCodeDriver(config);
    const firstSession = await firstDriver.start(request(), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    });
    const firstLease = WorkerProcessLeaseSchema.parse(supervisor.lease);
    expect(firstLease).toMatchObject({
      state: "running",
      command: process.execPath,
      args: processArgs,
      nativeSessionId: "native-opencode",
      activeTurnId: "initial:agent-opencode",
      adapterState: {
        endpoint: readinessUrl,
        initialTurn: { id: "initial:agent-opencode", state: "accepted" },
      },
    });
    const nativePid = firstLease.transport.kind === "worker-host"
      ? firstLease.transport.workerIdentity?.pid
      : null;
    expect(nativePid).toBeGreaterThan(0);

    await firstDriver.detach(firstSession);
    expect(() => process.kill(nativePid as number, 0)).not.toThrow();

    supervisor.generation += 1;
    supervisor.retainedProcess = true;
    const retainedLease = WorkerProcessLeaseSchema.parse(supervisor.lease);
    supervisor.lease = WorkerProcessLeaseSchema.parse({
      ...retainedLease,
      adapterState: {
        endpoint: readinessUrl,
        initialTurn: { id: "initial:agent-opencode", state: "dispatching" },
      },
      revision: retainedLease.revision + 1,
    });
    const ambiguousClient = fakeClient(new ControlledStream());
    ambiguousClient.session.status.mockResolvedValue({ data: { "native-opencode": { type: "idle" } } });
    sdk.createOpencodeClient.mockReturnValueOnce(ambiguousClient);
    const ambiguousDriver = openCodeDriver(config);
    const ambiguous = await ambiguousDriver.resume({ ...firstSession, state: "idle" }, request(), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    });
    expect(ambiguous.state).toBe("unknown");
    await ambiguousDriver.detach(ambiguous);

    supervisor.generation += 1;
    const ambiguousLease = WorkerProcessLeaseSchema.parse(supervisor.lease);
    supervisor.lease = WorkerProcessLeaseSchema.parse({
      ...ambiguousLease,
      adapterState: { endpoint: "http://0.0.0.0:4999" },
      revision: ambiguousLease.revision + 1,
    });
    const invalidEndpointDriver = openCodeDriver(config);
    await expect(invalidEndpointDriver.resume(firstSession, request(), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    })).rejects.toThrow("not a plain private loopback HTTP endpoint");
    expect(() => process.kill(nativePid as number, 0)).not.toThrow();
    const invalidLease = WorkerProcessLeaseSchema.parse(supervisor.lease);
    supervisor.lease = WorkerProcessLeaseSchema.parse({
      ...invalidLease,
      adapterState: { endpoint: readinessUrl },
      revision: invalidLease.revision + 1,
    });

    supervisor.generation += 1;
    const failedRecoveryClient = fakeClient(new ControlledStream());
    failedRecoveryClient.session.status.mockResolvedValue({ error: { message: "status unavailable" } });
    sdk.createOpencodeClient.mockReturnValueOnce(failedRecoveryClient);
    const failedRecoveryDriver = openCodeDriver(config);
    await expect(failedRecoveryDriver.resume(firstSession, request(), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    })).rejects.toThrow("session status failed");
    expect(() => process.kill(nativePid as number, 0)).not.toThrow();
    expect(supervisor.lease?.state).toBe("running");

    supervisor.generation += 1;
    const recoveredClient = fakeClient(new ControlledStream());
    recoveredClient.session.status.mockResolvedValue({ data: { "native-opencode": { type: "idle" } } });
    sdk.createOpencodeClient.mockReturnValueOnce(recoveredClient);
    const recoveredDriver = openCodeDriver(config);
    const recoveredSession = await recoveredDriver.resume({ ...firstSession, state: "idle" }, request(), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    });
    expect(recoveredSession.state).toBe("idle");
    expect(sdk.createOpencodeClient).toHaveBeenLastCalledWith({
      baseUrl: readinessUrl,
      directory: process.cwd(),
      headers: { Authorization: expectedAuthorization("agent-opencode") },
    });
    expect(supervisor.lease?.transport).toMatchObject({ workerIdentity: { pid: nativePid }, ownerEpoch: 5 });

    await recoveredDriver.forceTerminate(recoveredSession);
    await expect.poll(() => supervisor.lease?.state, { timeout: 3_000 }).toBe("exited");
  });

  it("overrides configured serve bind flags for new leases while adopting a historical exact process spec", async () => {
    const supervisor = new HostedSupervisor();
    const config = {
      ...defaultConfig.harnesses.opencode,
      autoStart: true,
      baseUrl: "http://127.0.0.1:4312",
      process: {
        command: resolve("tests/fixtures/opencode-isolated-command.mjs"),
        args: ["serve", "--hostname", "0.0.0.0", "--port=4096"],
      },
    };
    const external = fakeClient(new ControlledStream());
    external.path.get.mockRejectedValue(new Error("not running"));
    const firstClient = fakeClient(new ControlledStream());
    const recoveredClient = fakeClient(new ControlledStream());
    recoveredClient.session.status.mockResolvedValue({ data: { "native-opencode": { type: "idle" } } });
    sdk.createOpencodeClient
      .mockReturnValueOnce(external)
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(recoveredClient);

    const firstDriver = openCodeDriver(config);
    const firstSession = await firstDriver.start(request(), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    });
    const firstLease = WorkerProcessLeaseSchema.parse(supervisor.lease);
    const nativePid = firstLease.transport.kind === "worker-host" ? firstLease.transport.workerIdentity?.pid : null;
    expect(firstLease.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=0"]);
    expect(firstLease.adapterState).toMatchObject({ endpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u) });

    await firstDriver.detach(firstSession);
    supervisor.generation += 1;
    supervisor.retainedProcess = true;
    supervisor.lease = WorkerProcessLeaseSchema.parse({
      ...firstLease,
      // Simulate a durable lease created before Symphony normalized owned
      // OpenCode bind flags. The running PID must be adopted, not replaced.
      args: config.process.args,
      revision: firstLease.revision + 1,
    });

    const recoveredDriver = openCodeDriver(config);
    const recovered = await recoveredDriver.resume({ ...firstSession, state: "idle" }, request(), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    });
    const recoveredLease = WorkerProcessLeaseSchema.parse(supervisor.lease);
    expect(recovered.state).toBe("idle");
    expect(recoveredLease.args).toEqual(config.process.args);
    expect(recoveredLease.transport).toMatchObject({ workerIdentity: { pid: nativePid } });
    expect(() => process.kill(nativePid as number, 0)).not.toThrow();

    await recoveredDriver.forceTerminate(recovered);
    await expect.poll(() => supervisor.lease?.state, { timeout: 3_000 }).toBe("exited");
  });

  it("gives two auto-started agents independent hosted services and stopping one leaves its peer alive", async () => {
    const config = {
      ...defaultConfig.harnesses.opencode,
      autoStart: true,
      // This is only the external discovery address. Owned services must not
      // bind it or converge on one another.
      baseUrl: "http://127.0.0.1:4312",
      process: { command: resolve("tests/fixtures/opencode-isolated-command.mjs"), args: ["serve"] },
    };
    const external = fakeClient(new ControlledStream());
    external.path.get.mockRejectedValue(new Error("no external service"));
    const hostedClients = new Map<string, ReturnType<typeof fakeClient>>();
    sdk.createOpencodeClient.mockImplementation((options: { baseUrl?: string; headers?: Record<string, string> }) => {
      const endpoint = options.baseUrl ?? config.baseUrl;
      if (endpoint === config.baseUrl) return external;
      const existing = hostedClients.get(endpoint);
      if (existing) return existing;
      const client = fakeClient(new ControlledStream());
      const ordinal = hostedClients.size + 1;
      client.session.create.mockResolvedValue({ data: { id: `native-opencode-${ordinal}` } });
      hostedClients.set(endpoint, client);
      return client;
    });

    const firstSupervisor = new HostedSupervisor("agent-opencode-1");
    const secondSupervisor = new HostedSupervisor("agent-opencode-2");
    const firstDriver = openCodeDriver(config);
    const secondDriver = openCodeDriver(config);
    const firstSession = await firstDriver.start(request(process.cwd(), "agent-opencode-1"), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: firstSupervisor,
    });
    const secondSession = await secondDriver.start(request(process.cwd(), "agent-opencode-2"), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: secondSupervisor,
    });

    const firstLease = WorkerProcessLeaseSchema.parse(firstSupervisor.lease);
    const secondLease = WorkerProcessLeaseSchema.parse(secondSupervisor.lease);
    const firstEndpoint = (firstLease.adapterState as { endpoint: string }).endpoint;
    const secondEndpoint = (secondLease.adapterState as { endpoint: string }).endpoint;
    const firstPid = firstLease.transport.kind === "worker-host" ? firstLease.transport.workerIdentity?.pid : null;
    const secondPid = secondLease.transport.kind === "worker-host" ? secondLease.transport.workerIdentity?.pid : null;

    expect(firstLease.id).not.toBe(secondLease.id);
    expect(firstLease.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=0"]);
    expect(secondLease.args).toEqual(firstLease.args);
    expect(firstEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(secondEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(firstEndpoint).not.toBe(secondEndpoint);
    expect(firstPid).toBeGreaterThan(0);
    expect(secondPid).toBeGreaterThan(0);
    expect(firstPid).not.toBe(secondPid);
    const ownedClientOptions = sdk.createOpencodeClient.mock.calls
      .map(([options]) => options as { baseUrl?: string; headers?: Record<string, string> })
      .filter((options) => options.baseUrl !== config.baseUrl);
    expect(ownedClientOptions.map((options) => options.headers?.Authorization)).toEqual([
      expectedAuthorization("agent-opencode-1"),
      expectedAuthorization("agent-opencode-2"),
    ]);
    expect(ownedClientOptions[0]?.headers?.Authorization).not.toBe(ownedClientOptions[1]?.headers?.Authorization);
    const durableLeaseText = JSON.stringify([firstLease, secondLease]);
    expect(durableLeaseText).not.toContain(SERVICE_MASTER);
    expect(durableLeaseText).not.toContain(expectedPassword("agent-opencode-1"));
    expect(durableLeaseText).not.toContain(expectedAuthorization("agent-opencode-1"));
    await expect(fetch(firstEndpoint)).resolves.toMatchObject({ ok: true });
    await expect(fetch(secondEndpoint)).resolves.toMatchObject({ ok: true });

    await firstDriver.forceTerminate(firstSession);
    await expect.poll(() => firstSupervisor.lease?.state, { timeout: 3_000 }).toBe("exited");
    await expect.poll(() => {
      try {
        process.kill(firstPid as number, 0);
        return false;
      } catch {
        return true;
      }
    }, { timeout: 3_000 }).toBe(true);
    expect(() => process.kill(secondPid as number, 0)).not.toThrow();
    await expect(fetch(secondEndpoint)).resolves.toMatchObject({ ok: true });
    expect(secondSupervisor.lease?.state).toBe("running");

    await secondDriver.forceTerminate(secondSession);
    await expect.poll(() => secondSupervisor.lease?.state, { timeout: 3_000 }).toBe("exited");
  });

  it("uses a reachable external server without reserving or terminating a hosted lease", async () => {
    const supervisor = new HostedSupervisor();
    const stream = new ControlledStream();
    const client = fakeClient(stream);
    sdk.createOpencodeClient.mockReturnValue(client);
    const driver = openCodeDriver({
      ...defaultConfig.harnesses.opencode,
      autoStart: true,
      baseUrl: "http://127.0.0.1:4312",
    });

    const session = await driver.start(request(), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    });
    await driver.forceTerminate(session);

    expect(supervisor.lease).toBeNull();
    expect(stream.returnCount).toBe(1);
    expect(sdk.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4312",
      directory: process.cwd(),
    });
  });

  it("turns an unexpected event-stream EOF into a terminal failure instead of stranding the run", async () => {
    const stream = new ControlledStream();
    const client = fakeClient(stream);
    const driver = externalDriver(client);
    const events: DriverEvent[] = [];

    const session = await driver.start(request(), (event) => events.push(event));
    stream.end();

    await vi.waitFor(() => {
      expect(events.find((event) => event.kind === "run.failed")?.payload).toMatchObject({
        error: "OpenCode event stream ended unexpectedly.",
        source: "event-stream",
      });
    });
    await driver.cancel(session);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
  });

  it("reports a thrown stream failure once and releases the dead session", async () => {
    const stream = new ControlledStream();
    const client = fakeClient(stream);
    const driver = externalDriver(client);
    const events: DriverEvent[] = [];

    const session = await driver.start(request(), (event) => events.push(event));
    stream.fail(new Error("socket reset"));

    await vi.waitFor(() => {
      expect(events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
      expect(events.find((event) => event.kind === "run.failed")?.payload).toMatchObject({ error: "socket reset" });
    });
    await driver.forceTerminate(session);
    expect(stream.returnCount).toBe(0);
  });

  it("fails closed instead of using the unauthenticated direct SDK auto-start fallback", async () => {
    const external = fakeClient(new ControlledStream());
    external.path.get.mockRejectedValue(new Error("not running"));
    sdk.createOpencodeClient.mockReturnValue(external);
    const driver = openCodeDriver({
      ...defaultConfig.harnesses.opencode,
      autoStart: true,
      baseUrl: "http://127.0.0.1:4312",
    });

    await expect(driver.start(request(), () => undefined)).rejects.toThrow(
      "requires the authenticated worker-host supervisor",
    );
    expect(sdk.createOpencodeClient).toHaveBeenCalledTimes(1);
  });

  it("never auto-starts a local server for an unavailable external base URL", async () => {
    const external = fakeClient(new ControlledStream());
    external.path.get.mockRejectedValue(new Error("unreachable"));
    sdk.createOpencodeClient.mockReturnValue(external);
    const driver = openCodeDriver({
      ...defaultConfig.harnesses.opencode,
      autoStart: true,
      baseUrl: "https://opencode.example.test",
    });

    await expect(driver.start(request(), () => undefined)).rejects.toThrow("requires a loopback http baseUrl");
  });

  it("fails before reserving a hosted service when the headless master key is missing", async () => {
    const external = fakeClient(new ControlledStream());
    external.path.get.mockRejectedValue(new Error("not running"));
    sdk.createOpencodeClient.mockReturnValue(external);
    const supervisor = new HostedSupervisor();
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const driver = openCodeDriver(
      { ...defaultConfig.harnesses.opencode, autoStart: true },
      memorySecrets(null),
    );

    await expect(driver.start(request(), () => undefined, {
      signal: new AbortController().signal,
      processSupervisor: supervisor,
    })).rejects.toThrow("SYMPHONY_OPENCODE_SERVICE_KEY");
    expect(supervisor.lease).toBeNull();
    platform.mockRestore();
  });

  it("lazily creates a 32-byte master in the macOS secret store", async () => {
    const external = fakeClient(new ControlledStream());
    external.path.get.mockRejectedValue(new Error("not running"));
    sdk.createOpencodeClient.mockReturnValue(external);
    const secrets = memorySecrets(null);
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const driver = openCodeDriver({ ...defaultConfig.harnesses.opencode, autoStart: true }, secrets);

    const result = await driver.doctor();

    expect(result.available).toBe(true);
    expect(secrets.value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(secrets.value as string, "base64url")).toHaveLength(32);
    platform.mockRestore();
  });

  it("does not start a temporary owned service while listing models", async () => {
    const client = fakeClient(new ControlledStream()) as ReturnType<typeof fakeClient> & {
      provider: { list: ReturnType<typeof vi.fn> };
    };
    client.provider = { list: vi.fn().mockRejectedValue(new Error("not running")) };
    sdk.createOpencodeClient.mockReturnValue(client);
    const driver = openCodeDriver({ ...defaultConfig.harnesses.opencode, autoStart: true });

    await expect(driver.listModels()).resolves.toEqual([]);
    expect(sdk.createOpencodeClient).toHaveBeenCalledTimes(1);
    expect(client.provider.list).toHaveBeenCalledTimes(1);
  });

  it("imports a native turn that completed entirely while the daemon was offline", async () => {
    const stream = new ControlledStream();
    const client = fakeClient(stream);
    client.session.status.mockResolvedValue({ data: { "native-opencode": { type: "idle" } } });
    client.session.messages.mockResolvedValue({ data: completedNativeTranscript() });
    const driver = externalDriver(client);
    const events: DriverEvent[] = [];

    const recovered = await driver.resume(nativeSession(), request(), (event) => events.push(event));

    expect(recovered.state).toBe("completed");
    expect(events.filter((event) => event.kind === "output.completed")).toEqual([
      expect.objectContaining({
        nativeEventId: "opencode:native-opencode:turn:message-user-1:output",
        payload: expect.objectContaining({ text: "Done.", recovered: true }),
      }),
    ]);
    expect(events.filter((event) => event.kind === "run.completed")).toEqual([
      expect.objectContaining({
        nativeEventId: "opencode:native-opencode:turn:message-user-1:completed",
      }),
    ]);
    expect(events.filter((event) => event.kind === "usage.recorded")).toHaveLength(2);
    expect(events.find((event) => event.kind === "tool.started")).toMatchObject({
      nativeEventId: "opencode:native-opencode:part:part-tool-1:tool-started",
      payload: expect.objectContaining({ toolCallId: "call-1", toolName: "read" }),
    });
    expect(events.find((event) => event.kind === "tool.completed")).toMatchObject({
      nativeEventId: "opencode:native-opencode:part:part-tool-1:tool-completed",
      payload: expect.objectContaining({ result: "contents", isError: false }),
    });
    expect(events.find((event) => event.kind === "file.changed")).toMatchObject({
      payload: expect.objectContaining({ path: "README.md", recovered: true }),
    });
    expect(client.session.promptAsync).not.toHaveBeenCalled();

    await driver.forceTerminate(recovered);
  });

  it("reports an unknown outcome instead of continuing when the persisted transcript is unavailable", async () => {
    const client = fakeClient(new ControlledStream());
    client.session.status.mockResolvedValue({ data: { "native-opencode": { type: "idle" } } });
    client.session.messages.mockRejectedValue(new Error("transcript database locked"));
    const driver = externalDriver(client);
    const events: DriverEvent[] = [];

    const recovered = await driver.resume(nativeSession(), request(), (event) => events.push(event));

    expect(recovered.state).toBe("unknown");
    expect(events.find((event) => event.kind === "log")?.payload).toMatchObject({
      source: "transcript-recovery",
      message: expect.stringContaining("transcript database locked"),
    });
    expect(events.some((event) => event.kind === "output.completed" || event.kind === "run.completed")).toBe(false);

    await driver.forceTerminate(recovered);
  });

  it("keeps a previously active turn unknown when the native transcript ends in a dangling assistant frame", async () => {
    const transcript = completedNativeTranscript();
    transcript.push({
      info: {
        id: "message-assistant-dangling",
        sessionID: "native-opencode",
        role: "assistant",
        parentID: "message-user-1",
        time: { created: 1_500 },
        modelID: "gpt-test",
        providerID: "openai",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    });
    const client = fakeClient(new ControlledStream());
    client.session.status.mockResolvedValue({ data: { "native-opencode": { type: "idle" } } });
    client.session.messages.mockResolvedValue({ data: transcript });
    const driver = externalDriver(client);
    const events: DriverEvent[] = [];

    const recovered = await driver.resume(nativeSession(), request(), (event) => events.push(event));

    expect(recovered.state).toBe("unknown");
    expect(events.some((event) => event.kind === "output.completed" || event.kind === "run.completed")).toBe(false);

    await driver.forceTerminate(recovered);
  });

  it("replays the same stable terminal evidence without duplicating already projected output", async () => {
    const transcript = completedNativeTranscript();
    const claimed = new Set<string>();
    const accepted: DriverEvent[] = [];
    const consume = (event: DriverEvent) => {
      if (event.nativeEventId) {
        const key = `${event.kind}:${event.nativeEventId}`;
        if (claimed.has(key)) return;
        claimed.add(key);
      }
      accepted.push(event);
    };

    const liveStream = new ControlledStream();
    const liveClient = fakeClient(liveStream);
    liveClient.session.messages.mockResolvedValue({ data: transcript });
    const liveDriver = externalDriver(liveClient);
    const liveSession = await liveDriver.start(request(), consume);
    liveStream.push({ type: "session.idle", properties: { sessionID: liveSession.nativeSessionId } });
    await vi.waitFor(() => {
      expect(accepted.filter((event) => event.kind === "run.completed")).toHaveLength(1);
    });
    await liveDriver.detach(liveSession);

    const recoveryStream = new ControlledStream();
    const recoveryClient = fakeClient(recoveryStream);
    recoveryClient.session.status.mockResolvedValue({ data: { "native-opencode": { type: "idle" } } });
    recoveryClient.session.messages.mockResolvedValue({ data: transcript });
    const recoveryDriver = externalDriver(recoveryClient);
    const recovered = await recoveryDriver.resume(nativeSession(), request(), consume);

    expect(recovered.state).toBe("completed");
    expect(accepted.filter((event) => event.kind === "output.completed")).toHaveLength(1);
    expect(accepted.filter((event) => event.kind === "run.completed")).toHaveLength(1);
    expect(accepted.filter((event) => event.kind === "usage.recorded")).toHaveLength(2);
    expect(accepted.filter((event) => event.kind === "tool.completed")).toHaveLength(1);

    await recoveryDriver.forceTerminate(recovered);
  });

  it("coalesces cancellation and closes subscriptions idempotently without owning external infrastructure", async () => {
    const stream = new ControlledStream();
    const client = fakeClient(stream);
    let acknowledgeCancellation: (() => void) | undefined;
    client.session.abort.mockImplementation(() => new Promise((resolve) => {
      acknowledgeCancellation = () => resolve({ data: true });
    }));
    const driver = externalDriver(client);
    const events: DriverEvent[] = [];
    const session = await driver.start(request(), (event) => events.push(event));

    const first = driver.cancel(session);
    const second = driver.cancel(session);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    acknowledgeCancellation?.();
    await Promise.all([first, second]);
    await driver.cancel(session);
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    stream.push({ type: "session.idle", properties: { sessionID: session.nativeSessionId } });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.kind === "run.cancelled")).toHaveLength(1);
    });
    expect(events.some((event) => event.kind === "run.completed")).toBe(false);

    await driver.forceTerminate(session);
    await driver.forceTerminate(session);
    await driver.dispose();
    expect(stream.returnCount).toBe(1);
  });

  it("rejects an unacknowledged cancellation without retrying the same cancel operation", async () => {
    const stream = new ControlledStream();
    const client = fakeClient(stream);
    client.session.abort.mockResolvedValue({ data: false });
    const driver = externalDriver(client);
    const session = await driver.start(request(), () => undefined);

    await expect(driver.cancel(session)).rejects.toThrow("cancellation failed");
    await expect(driver.cancel(session)).rejects.toThrow("cancellation failed");
    expect(client.session.abort).toHaveBeenCalledTimes(1);

    await driver.forceTerminate(session);
  });
});
