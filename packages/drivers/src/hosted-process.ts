import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { environmentWithoutDaemonSecret } from "@symphony/config";
import {
  WorkerHostConnection,
  normalizeWorkerHostFrame,
  type WorkerHostBootstrap,
  type WorkerHostFrame,
} from "@symphony/worker-host";
import type {
  DriverProcessSupervisor,
  JsonValue,
  WorkerEventContext,
  WorkerEventEnvelope,
  WorkerProcessLease,
} from "@symphony/protocol";
import {
  type JsonLineRpcTransport,
  type JsonObject,
  type ProcessSpec,
} from "./process.js";
import { captureProcessIdentity, inspectProcessIdentity } from "./process-identity.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  beforeResolve?: (value: unknown) => void;
  timeout?: NodeJS.Timeout;
};

type WorkerHostConnectionOptions = Parameters<typeof WorkerHostConnection.connect>[0];

type HostedCallbacks = {
  onNotification: (message: JsonObject) => void;
  onRequest?: (message: JsonObject) => Promise<unknown>;
  onStdout?: (line: string, nativeEventId?: string) => void;
  stdoutMode?: "json" | "raw";
  onStderr?: (line: string, nativeEventId?: string) => void;
  onUnexpectedExit?: (error: Error, nativeEventId?: string) => void;
  /** Optional observer for the canonical raw host boundary. Native parsing remains unchanged. */
  onWorkerEvent?: (event: WorkerEventEnvelope, frame: WorkerHostFrame) => void;
  workerEventContext?: Omit<WorkerEventContext, "leaseId">;
};

export type HostedRawLineCallbacks = {
  onStdout?: (line: string, nativeEventId?: string) => void;
  onStderr?: (line: string, nativeEventId?: string) => void;
  onUnexpectedExit?: (error: Error, nativeEventId?: string) => void;
};

const maxNativeLineBytes = 1024 * 1024;
const controllerReconnectWindowMs = 5_000;

function waitForReconnect(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, delayMs);
    timer.unref();
  });
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function commandId(leaseId: string, value: JsonObject, ordinal: number): string {
  const id = typeof value.id === "string" || typeof value.id === "number" ? String(value.id) : null;
  if (id) return `${"method" in value ? "jsonrpc" : "response"}:${leaseId}:${id}`;
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
  return `notification:${leaseId}:${ordinal}:${digest}`;
}

export class HostedJsonLineProcess implements JsonLineRpcTransport {
  readonly mode: "spawned" | "reconnected";
  private readonly supervisor: DriverProcessSupervisor;
  private readonly processLease: WorkerProcessLease;
  private readonly callbacks: HostedCallbacks;
  private readonly connectionPromise: Promise<WorkerHostConnection>;
  private readonly connectionOptions: WorkerHostConnectionOptions;
  private connection: WorkerHostConnection | null = null;
  private reconnectPromise: Promise<WorkerHostConnection> | null = null;
  private connectionGeneration = 0;
  private hostProcess: ChildProcess | null = null;
  private transport: Extract<WorkerProcessLease["transport"], { kind: "worker-host" }>;
  private adapterState: JsonValue;
  private readonly pending = new Map<string | number, Pending>();
  private stdoutBuffer = "";
  private activated = false;
  private activating: Promise<void> | null = null;
  private processing = Promise.resolve();
  private readonly queuedFrames: WorkerHostFrame[] = [];
  private lastProcessedSeq: number;
  private writeOrdinal = 0;
  private closed = false;
  private expectedClosing = false;
  private acceptingFrames = true;
  private detachPromise: Promise<void> | null = null;
  private released = false;
  private retirementRequested = false;
  private workerRunning = true;

  constructor(spec: ProcessSpec & { processSupervisor: DriverProcessSupervisor }, callbacks: HostedCallbacks) {
    this.supervisor = spec.processSupervisor;
    this.callbacks = callbacks;
    this.processLease = this.supervisor.reserveProcess({
      role: spec.processRole ?? "adapter",
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd ?? null,
      adapterVersion: spec.adapterVersion ?? null,
    });
    const plan = this.supervisor.workerHostPlan?.(this.processLease.id);
    if (!plan) throw new Error("Worker-host transport was selected without a host plan.");
    if (this.processLease.transport.kind !== "worker-host") {
      throw new Error("Worker-host plan requires a hosted process lease.");
    }
    this.mode = plan.mode === "launch" ? "spawned" : "reconnected";
    this.transport = this.processLease.transport;
    this.adapterState = this.processLease.adapterState;
    this.lastProcessedSeq = this.transport.processedOutputSeq;
    this.connectionOptions = {
      socketPath: plan.endpoint,
      leaseId: this.processLease.id,
      capability: plan.capability,
      ownerId: plan.controllerOwnerId,
      ownerEpoch: plan.ownerEpoch,
    };
    this.connectionPromise = this.open(spec, plan).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.terminateUnattachedHost();
      // A failed launch owns a newly reserved lease and must settle it. A
      // failed reconnect does not own the retained host, so releasing that
      // running lease would destroy the evidence needed for later recovery.
      if (this.mode === "spawned") this.releaseProcess(null, null, failure.message);
      this.finish(failure);
      throw failure;
    });
  }

  static shouldHost(spec: ProcessSpec): spec is ProcessSpec & { processSupervisor: DriverProcessSupervisor } {
    return Boolean(spec.processSupervisor?.workerHostPlan);
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = randomUUID();
    return this.requestWithId(id, method, params, timeoutMs);
  }

  requestWithId(
    id: string,
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
    beforeResolve?: (value: unknown) => void,
  ): Promise<unknown> {
    const message: JsonObject = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    return this.sendRequest(id, message, timeoutMs, beforeResolve);
  }

  command(type: string, params: JsonObject = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = randomUUID();
    return this.sendRequest(id, { id, type, ...params }, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    const message: JsonObject = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    void this.write(message).catch((error: unknown) => this.finish(error instanceof Error ? error : new Error(String(error))));
  }

  send(value: JsonObject): void {
    void this.write(value).catch((error: unknown) => this.finish(error instanceof Error ? error : new Error(String(error))));
  }

  updateProcessLease(patch: Parameters<DriverProcessSupervisor["updateProcess"]>[1]): void {
    if (this.released) return;
    const updated = this.supervisor.updateProcess(this.processLease.id, patch);
    if (updated.transport.kind === "worker-host") this.transport = updated.transport;
    this.adapterState = updated.adapterState;
  }

  retainedAdapterState(): JsonValue {
    return this.adapterState;
  }

  isReusable(): boolean {
    return !this.closed && this.acceptingFrames && this.workerRunning;
  }

  activate(): Promise<void> {
    this.activating ??= this.activateOnce();
    return this.activating;
  }

  detach(): Promise<void> {
    this.detachPromise ??= this.detachOnce();
    return this.detachPromise;
  }

  private async detachOnce(): Promise<void> {
    if (this.closed) return;
    this.expectedClosing = true;
    // Stop accepting newly delivered frames, but keep the authenticated
    // connection alive until every frame already in the projection chain has
    // been durably persisted and acknowledged. Later frames remain unacked in
    // the host spool for the replacement controller.
    this.acceptingFrames = false;
    const connection = await this.connectionForTeardown();
    await this.processing.catch(() => undefined);
    this.closed = true;
    this.failAll(new Error("Worker-host controller detached."));
    connection?.close();
  }

  async close(signal: NodeJS.Signals = "SIGTERM", graceMs = 2_000): Promise<void> {
    if (this.closed) return;
    this.expectedClosing = true;
    const connection = await this.connectionForTeardown();
    this.closed = true;
    this.failAll(new Error("Hosted process connection closed."));
    if (!connection) return;
    const signalId = `signal:${this.processLease.id}:${signal}`;
    await connection.request({ type: "signal", commandId: signalId, signal }).catch(() => undefined);
    const shutdownId = `shutdown:${this.processLease.id}`;
    const hostClosed = new Promise<"closed">((resolve) => connection.once("close", () => resolve("closed")));
    await connection.request({ type: "shutdown", commandId: shutdownId }).catch(() => undefined);
    const outcome = await Promise.race([
      hostClosed,
      new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), graceMs);
        timer.unref();
      }),
    ]);
    if (outcome === "timeout") connection.close();
    await this.processing;
  }

  private async open(
    spec: ProcessSpec,
    plan: NonNullable<ReturnType<NonNullable<DriverProcessSupervisor["workerHostPlan"]>>>,
  ): Promise<WorkerHostConnection> {
    if (plan.mode === "launch") await this.launchHost(spec, plan);
    else this.verifyPersistedHost();
    const connection = await WorkerHostConnection.connect({
      ...this.connectionOptions,
      after: plan.afterSeq,
    });
    const accepted = connection.accepted ?? {};
    if (accepted.hostInstanceId !== this.transport.hostInstanceId) {
      connection.close();
      throw new Error("Worker host instance identity does not match the durable lease.");
    }
    const workerPid = asNumber(accepted.workerPid);
    if (!workerPid || workerPid === 0) {
      connection.close();
      throw new Error("Worker host did not report its native worker PID.");
    }
    const workerRunning = accepted.workerRunning !== false;
    this.workerRunning = workerRunning;
    if (this.mode === "reconnected" && this.transport.workerIdentity?.pid !== workerPid) {
      connection.close();
      throw new Error(`Worker host reported PID ${workerPid}, but the durable lease belongs to PID ${this.transport.workerIdentity?.pid ?? "unknown"}.`);
    }
    const capturedWorkerIdentity = captureProcessIdentity(workerPid);
    if (workerRunning && !capturedWorkerIdentity) {
      connection.close();
      throw new Error(`Could not capture identity for hosted worker PID ${workerPid}.`);
    }
    const workerIdentity = capturedWorkerIdentity ?? this.transport.workerIdentity;
    if (!workerIdentity) {
      connection.close();
      throw new Error("Worker host has no durable native worker identity.");
    }
    if (this.mode === "reconnected" && workerRunning && this.transport.workerIdentity) {
      const inspection = inspectProcessIdentity(this.transport.workerIdentity);
      if (inspection.status === "dead" || inspection.status === "mismatch") {
        connection.close();
        throw new Error(`Hosted worker identity cannot be adopted: ${inspection.detail}`);
      }
    }
    if (this.mode === "reconnected") {
      if (!this.supervisor.adoptProcess) {
        connection.close();
        throw new Error("Worker-host reconnection requires an atomic lease-adoption callback.");
      }
      const adopted = this.supervisor.adoptProcess(this.processLease.id, this.processLease.revision, {
        ...this.transport,
        ownerEpoch: plan.ownerEpoch,
        workerIdentity,
      });
      if (adopted.transport.kind !== "worker-host") {
        connection.close();
        throw new Error("Adopted process lease lost its worker-host transport metadata.");
      }
      this.transport = adopted.transport;
    }
    if (this.mode === "spawned") {
      this.supervisor.attachProcess(this.processLease.id, workerIdentity);
    }
    const producedOutputSeq = asNumber(accepted.producedOutputSeq) ?? this.transport.producedOutputSeq;
    const hostAckedOutputSeq = asNumber(accepted.ackedOutputSeq) ?? this.transport.ackedOutputSeq;
    const sequenceInvariantError = this.sequenceInvariantError(producedOutputSeq, hostAckedOutputSeq);
    if (sequenceInvariantError) {
      connection.close();
      throw new Error(sequenceInvariantError);
    }
    this.updateTransport({
      ownerEpoch: plan.ownerEpoch,
      workerIdentity,
      producedOutputSeq,
      ackedOutputSeq: Math.max(this.transport.ackedOutputSeq, hostAckedOutputSeq),
      spoolState: accepted.spoolState === "overflow" ? "overflow" : this.transport.spoolState,
    });
    if (this.transport.processedOutputSeq > hostAckedOutputSeq) {
      await this.ackThroughConnection(connection, this.transport.processedOutputSeq);
    }
    if (connection.socket.destroyed || !connection.socket.writable) {
      throw new Error("Worker-host controller connection closed before activation.");
    }
    this.installConnection(connection);
    this.acceptBufferedFrames(connection.takeBufferedFrames());
    return connection;
  }

  private installConnection(connection: WorkerHostConnection): number {
    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    this.connection = connection;
    connection.on("frame", (frame: WorkerHostFrame) => {
      if (this.connection !== connection || this.connectionGeneration !== generation || !this.acceptingFrames) return;
      if (!this.activated) this.queuedFrames.push(frame);
      else this.enqueueFrame(frame);
    });
    connection.on("protocol-error", (error: Error) => {
      this.handleConnectionLoss(connection, generation, error);
    });
    connection.on("close", () => {
      this.handleConnectionLoss(
        connection,
        generation,
        new Error("Worker-host controller connection closed unexpectedly."),
      );
    });
    return generation;
  }

  private acceptBufferedFrames(frames: WorkerHostFrame[]): void {
    if (!this.acceptingFrames) return;
    if (!this.activated) {
      this.queuedFrames.push(...frames);
      return;
    }
    for (const frame of frames) this.enqueueFrame(frame);
  }

  private handleConnectionLoss(
    connection: WorkerHostConnection,
    generation: number,
    cause: Error,
  ): void {
    if (
      this.closed
      || this.expectedClosing
      || this.connection !== connection
      || this.connectionGeneration !== generation
    ) return;
    this.connection = null;
    if (!connection.socket.destroyed) connection.close();
    this.beginReconnect(generation, cause);
  }

  private beginReconnect(lostGeneration: number, cause: Error): Promise<WorkerHostConnection> {
    if (this.reconnectPromise) return this.reconnectPromise;
    const reconnect = this.reconnectWithinWindow(lostGeneration, cause);
    this.reconnectPromise = reconnect;
    void reconnect.catch((error: unknown) => {
      if (
        this.closed
        || this.expectedClosing
        || (this.connection !== null && this.connectionGeneration > lostGeneration)
      ) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.requestProcessRetirement(failure);
      this.finish(failure);
    }).finally(() => {
      if (this.reconnectPromise === reconnect) this.reconnectPromise = null;
    });
    return reconnect;
  }

  private async reconnectWithinWindow(
    lostGeneration: number,
    cause: Error,
  ): Promise<WorkerHostConnection> {
    const deadline = Date.now() + controllerReconnectWindowMs;
    let lastError = cause;
    let delayMs = 25;
    while (Date.now() < deadline) {
      if (this.closed) throw new Error("Hosted process connection closed during controller recovery.");
      if (this.connection && this.connectionGeneration > lostGeneration) return this.connection;
      if (this.connectionGeneration !== lostGeneration) {
        throw new Error("Worker-host controller recovery was superseded without an active connection.");
      }
      let candidate: WorkerHostConnection | null = null;
      try {
        this.verifyPersistedHost();
        candidate = await WorkerHostConnection.connect({
          ...this.connectionOptions,
          after: this.lastProcessedSeq,
        });
        if (this.connectionGeneration !== lostGeneration || this.connection) {
          candidate.close();
          if (this.connection) return this.connection;
          throw new Error("Worker-host controller recovery lost its connection-generation fence.");
        }
        await this.acceptReconnectedConnection(candidate);
        return candidate;
      } catch (error) {
        candidate?.close();
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await waitForReconnect(Math.min(delayMs, remaining));
      delayMs = Math.min(delayMs * 2, 250);
    }
    throw new Error(`Worker-host controller reconnect failed: ${lastError.message}`);
  }

  private async acceptReconnectedConnection(connection: WorkerHostConnection): Promise<void> {
    const accepted = connection.accepted ?? {};
    if (accepted.hostInstanceId !== this.transport.hostInstanceId) {
      throw new Error("Worker host instance identity changed during controller recovery.");
    }
    const workerPid = asNumber(accepted.workerPid);
    if (!workerPid || workerPid === 0 || this.transport.workerIdentity?.pid !== workerPid) {
      throw new Error("Worker host native process identity changed during controller recovery.");
    }
    const workerRunning = accepted.workerRunning !== false;
    const capturedWorkerIdentity = captureProcessIdentity(workerPid);
    if (workerRunning && !capturedWorkerIdentity) {
      throw new Error(`Could not verify hosted worker PID ${workerPid} during controller recovery.`);
    }
    if (workerRunning && this.transport.workerIdentity) {
      const inspection = inspectProcessIdentity(this.transport.workerIdentity);
      if (inspection.status === "dead" || inspection.status === "mismatch") {
        throw new Error(`Hosted worker identity cannot be recovered: ${inspection.detail}`);
      }
    }
    const producedOutputSeq = asNumber(accepted.producedOutputSeq) ?? this.transport.producedOutputSeq;
    const hostAckedOutputSeq = asNumber(accepted.ackedOutputSeq) ?? this.transport.ackedOutputSeq;
    const sequenceInvariantError = this.sequenceInvariantError(producedOutputSeq, hostAckedOutputSeq);
    if (sequenceInvariantError) throw new Error(sequenceInvariantError);
    this.workerRunning = workerRunning;
    this.updateTransport({
      ownerEpoch: this.connectionOptions.ownerEpoch,
      workerIdentity: capturedWorkerIdentity ?? this.transport.workerIdentity,
      producedOutputSeq,
      ackedOutputSeq: Math.max(this.transport.ackedOutputSeq, hostAckedOutputSeq),
      spoolState: accepted.spoolState === "overflow" ? "overflow" : this.transport.spoolState,
    });
    if (this.transport.processedOutputSeq > hostAckedOutputSeq) {
      await this.ackThroughConnection(connection, this.transport.processedOutputSeq);
    }
    if (connection.socket.destroyed || !connection.socket.writable) {
      throw new Error("Worker-host controller connection closed during recovery.");
    }
    this.installConnection(connection);
    this.acceptBufferedFrames(connection.takeBufferedFrames());
  }

  private sequenceInvariantError(producedOutputSeq: number, hostAckedOutputSeq: number): string | null {
    if (this.transport.ackedOutputSeq > this.transport.processedOutputSeq) {
      return "Durable worker-host ledger has acknowledged output beyond its processed projection.";
    }
    if (this.transport.processedOutputSeq > this.transport.producedOutputSeq) {
      return "Durable worker-host ledger has processed output beyond its recorded produced sequence.";
    }
    if (this.transport.processedOutputSeq > producedOutputSeq) {
      return "Worker host produced sequence regressed behind the durable processed cursor.";
    }
    if (hostAckedOutputSeq > producedOutputSeq) {
      return "Worker host acknowledged sequence exceeds its produced sequence.";
    }
    if (hostAckedOutputSeq > this.transport.processedOutputSeq) {
      return "Worker host compacted output that the durable ledger cannot prove was projected.";
    }
    if (hostAckedOutputSeq < this.transport.ackedOutputSeq) {
      return "Worker host acknowledged sequence regressed behind the durable ledger.";
    }
    return null;
  }

  private async launchHost(
    spec: ProcessSpec,
    plan: NonNullable<ReturnType<NonNullable<DriverProcessSupervisor["workerHostPlan"]>>>,
  ): Promise<void> {
    const host = spawn(plan.hostCommand, plan.hostArgs, {
      detached: process.platform !== "win32",
      env: environmentWithoutDaemonSecret(spec.env),
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    this.hostProcess = host;
    const bootstrap: WorkerHostBootstrap = {
      version: 1,
      leaseId: this.processLease.id,
      hostInstanceId: this.transport.hostInstanceId,
      ownerId: plan.controllerOwnerId,
      ownerEpoch: plan.ownerEpoch,
      capability: plan.capability,
      socketPath: plan.endpoint,
      spoolPath: plan.spoolPath,
      maxSpoolBytes: plan.maxSpoolBytes,
      maxSpoolFrames: plan.maxSpoolFrames,
      ...(plan.controllerGraceMs === undefined ? {} : { controllerGraceMs: plan.controllerGraceMs }),
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd ?? null,
    };
    const bootstrapPipe = host.stdio[3] as Writable | null;
    if (!bootstrapPipe) throw new Error("Worker host bootstrap descriptor is unavailable.");
    bootstrapPipe.end(JSON.stringify(bootstrap));
    const ready = await new Promise<JsonObject>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error(`Worker host did not become ready. ${stderr}`)), 5_000);
      timeout.unref();
      host.stdout?.setEncoding("utf8");
      host.stderr?.setEncoding("utf8");
      host.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      host.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(stdout.slice(0, newline)) as JsonObject);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      host.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      host.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Worker host exited before readiness (code=${String(code)}, signal=${String(signal)}). ${stderr}`));
      });
    });
    if (ready.type !== "worker-host.ready" || ready.leaseId !== this.processLease.id || ready.hostInstanceId !== this.transport.hostInstanceId) {
      throw new Error("Worker host readiness identity does not match the durable lease.");
    }
    if (!host.pid) throw new Error("Worker host did not expose a PID.");
    const hostIdentity = captureProcessIdentity(host.pid);
    if (!hostIdentity) throw new Error(`Could not capture identity for worker-host PID ${host.pid}.`);
    this.updateTransport({ hostIdentity });
    host.stdout?.destroy();
    host.stderr?.destroy();
    host.unref();
  }

  private verifyPersistedHost(): void {
    const hostIdentity = this.transport.hostIdentity;
    if (!hostIdentity) throw new Error("Hosted lease is missing the worker-host process identity.");
    const inspection = inspectProcessIdentity(hostIdentity);
    // On Darwin the PID evidence is intentionally weak. It cannot authorize a
    // signal, but the subsequent capability proof plus hostInstanceId fence is
    // the authority for reattachment. A proven death or mismatch still fails.
    if (inspection.status === "dead" || inspection.status === "mismatch") {
      throw new Error(`Worker host identity cannot be adopted: ${inspection.detail}`);
    }
  }

  private async activateOnce(): Promise<void> {
    await this.connectionPromise;
    this.activated = true;
    if (!this.acceptingFrames) return;
    const buffered = this.queuedFrames.splice(0).sort((left, right) => left.seq - right.seq);
    for (const frame of buffered) this.enqueueFrame(frame);
    await this.processing;
  }

  private enqueueFrame(frame: WorkerHostFrame): void {
    this.processing = this.processing
      .then(() => this.processFrame(frame))
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.finish(failure, `host:${this.processLease.id}:${frame.seq}:transport-error`);
        throw failure;
      });
    // Keep the rejected chain observable by activate()/close() without
    // producing a process-level unhandled rejection for live frames.
    void this.processing.catch(() => undefined);
  }

  private async processFrame(frame: WorkerHostFrame): Promise<void> {
    if (frame.seq <= this.lastProcessedSeq) return;
    if (frame.seq !== this.lastProcessedSeq + 1) {
      throw new Error(`Worker-host output sequence gap: expected ${this.lastProcessedSeq + 1}, received ${frame.seq}.`);
    }
    if (this.callbacks.onWorkerEvent && this.callbacks.workerEventContext) {
      const event = normalizeWorkerHostFrame(frame, {
        ...this.callbacks.workerEventContext,
        leaseId: this.processLease.id,
      });
      this.callbacks.onWorkerEvent(event, frame);
    }
    let unexpectedExit: Error | null = null;
    if (frame.stream === "stdout") {
      await this.consume(String(frame.payload.data ?? ""), frame.seq);
    } else if (frame.stream === "stderr") {
      const data = String(frame.payload.data ?? "");
      let ordinal = 0;
      for (const line of data.split(/\r?\n/u)) {
        if (line) this.callbacks.onStderr?.(line, `host:${this.processLease.id}:${frame.seq}:stderr:${++ordinal}`);
      }
    } else if (frame.stream === "control" && frame.payload.type === "spool-overflow") {
      this.callbacks.onStderr?.(
        "[symphony] Worker-host spool overflowed; the native process was terminated fail-closed.",
        `host:${this.processLease.id}:${frame.seq}:spool-overflow`,
      );
    } else if (frame.stream === "exit") {
      this.workerRunning = false;
      const code = typeof frame.payload.code === "number" ? frame.payload.code : null;
      const signal = typeof frame.payload.signal === "string" ? frame.payload.signal : null;
      this.releaseProcess(code, signal, this.expectedClosing ? null : `Hosted process exited (code=${String(code)}, signal=${String(signal)})`);
      if (!this.expectedClosing) unexpectedExit = new Error(`Hosted process exited (code=${String(code)}, signal=${String(signal)})`);
    }
    this.lastProcessedSeq = frame.seq;
    this.updateTransport({ processedOutputSeq: frame.seq, producedOutputSeq: Math.max(this.transport.producedOutputSeq, frame.seq) });
    await this.ackThrough(frame.seq);
    if (unexpectedExit) this.finish(unexpectedExit, `host:${this.processLease.id}:${frame.seq}:exit`);
  }

  private async consume(chunk: string, frameSeq: number): Promise<void> {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > maxNativeLineBytes && !this.stdoutBuffer.includes("\n")) {
      const kind = this.callbacks.stdoutMode === "raw" ? "line" : "JSON line";
      throw new Error(`Native process emitted a ${kind} larger than ${maxNativeLineBytes} bytes.`);
    }
    let ordinal = 0;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      ordinal += 1;
      const nativeEventId = `host:${this.processLease.id}:${frameSeq}:${ordinal}`;
      this.callbacks.onStdout?.(line, nativeEventId);
      if (this.callbacks.stdoutMode === "raw") continue;
      let message: JsonObject;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Native JSONL message must be an object.");
        message = parsed as JsonObject;
      } catch (error) {
        this.callbacks.onNotification({
          type: "protocol-error",
          error: error instanceof Error ? error.message : String(error),
          line,
          __symphonyHostEventId: nativeEventId,
        });
        continue;
      }
      message.__symphonyHostEventId = nativeEventId;
      await this.dispatch(message, frameSeq);
    }
  }

  private async dispatch(message: JsonObject, frameSeq: number): Promise<void> {
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
    const isJsonRpcRequest = id !== undefined && typeof message.method === "string" && !("result" in message) && !("error" in message);
    if (isJsonRpcRequest && this.callbacks.onRequest) {
      try {
        const result = await this.callbacks.onRequest(message);
        await this.write(
          { jsonrpc: "2.0", id, result: result ?? {} },
          `response:${this.processLease.id}:${frameSeq}:${String(id)}`,
        );
      } catch (error) {
        await this.write(
          {
            jsonrpc: "2.0",
            id,
            error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
          },
          `response:${this.processLease.id}:${frameSeq}:${String(id)}`,
        );
      }
      return;
    }
    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else {
          const result = message.result ?? message;
          try {
            // The acceptance checkpoint runs before this retained response can
            // be acknowledged out of the worker-host spool.
            pending.beforeResolve?.(result);
            pending.resolve(result);
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
        return;
      }
    }
    this.callbacks.onNotification(message);
  }

  private sendRequest(
    id: string | number,
    message: JsonObject,
    timeoutMs: number,
    beforeResolve?: (value: unknown) => void,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject, ...(beforeResolve ? { beforeResolve } : {}) };
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for ${String(message.method ?? message.type ?? "request")}`));
        }, timeoutMs);
        pending.timeout.unref();
      }
      this.pending.set(id, pending);
      void this.write(message).catch((error: unknown) => {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async connectionForTeardown(): Promise<WorkerHostConnection | null> {
    if (this.connection) return this.connection;
    const pending = this.reconnectPromise ?? this.connectionPromise;
    await pending.catch(() => null);
    return this.connection;
  }

  private async connectionForCommand(): Promise<WorkerHostConnection> {
    if (this.connection) return this.connection;
    if (this.closed) throw new Error("Hosted process connection is closed.");
    if (this.reconnectPromise) return await this.reconnectPromise;
    await this.connectionPromise;
    if (this.connection) return this.connection;
    return await this.beginReconnect(
      this.connectionGeneration,
      new Error("Worker-host controller connection is unavailable."),
    );
  }

  private async requestHost(
    message: Record<string, unknown> & { commandId: string },
  ): Promise<Record<string, unknown>> {
    let lastError = new Error("Worker-host controller request failed.");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const connection = await this.connectionForCommand();
      try {
        return await connection.request(message);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (this.closed || this.expectedClosing) throw lastError;
        this.handleConnectionLoss(connection, this.connectionGeneration, lastError);
        if (attempt < 2) await this.connectionForCommand();
      }
    }
    throw lastError;
  }

  private async write(value: JsonObject, stableCommandId?: string): Promise<void> {
    if (this.closed) throw new Error("Hosted process connection is closed.");
    const id = stableCommandId ?? commandId(this.processLease.id, value, ++this.writeOrdinal);
    const result = await this.requestHost({
      type: "stdin",
      commandId: id,
      data: `${JSON.stringify(value)}\n`,
    });
    if (result.state !== "applied" && result.state !== "dispatching") {
      throw new Error(asString(result.detail) ?? "Worker host rejected native stdin.");
    }
  }

  private async ackThrough(seq: number): Promise<void> {
    const result = await this.requestHost({
      type: "ack",
      commandId: `ack:${this.processLease.id}:${seq}`,
      through: seq,
    });
    if (result.state !== "applied") throw new Error(asString(result.detail) ?? `Worker host rejected output acknowledgement ${seq}.`);
    this.updateTransport({ ackedOutputSeq: Math.max(this.transport.ackedOutputSeq, seq) });
  }

  private async ackThroughConnection(connection: WorkerHostConnection, seq: number): Promise<void> {
    const result = await connection.request({
      type: "ack",
      commandId: `ack:${this.processLease.id}:${seq}`,
      through: seq,
    });
    if (result.state !== "applied") {
      throw new Error(asString(result.detail) ?? `Worker host rejected output acknowledgement ${seq}.`);
    }
    this.updateTransport({ ackedOutputSeq: Math.max(this.transport.ackedOutputSeq, seq) });
  }

  private updateTransport(
    patch: Partial<Extract<WorkerProcessLease["transport"], { kind: "worker-host" }>>,
  ): void {
    this.transport = { ...this.transport, ...patch };
    const updated = this.supervisor.updateProcess(this.processLease.id, { transport: this.transport });
    if (updated.transport.kind !== "worker-host") throw new Error("Worker process lease lost its hosted transport metadata.");
    this.transport = updated.transport;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private finish(error: Error, nativeEventId?: string): void {
    if (this.closed) return;
    this.acceptingFrames = false;
    this.closed = true;
    this.failAll(error);
    if (!this.expectedClosing) {
      this.connection?.close();
      this.callbacks.onUnexpectedExit?.(error, nativeEventId);
    }
  }

  private requestProcessRetirement(error: Error): void {
    if (this.retirementRequested) return;
    this.retirementRequested = true;
    try {
      this.supervisor.requestProcessRetirement?.(this.processLease.id, {
        reason: "controller-lost",
        error: error.message,
      });
    } catch {
      // The controller has already lost its transport. If the store is
      // unavailable, the worker-host grace timer remains the final fail-closed
      // boundary and a later daemon can retry the durable reconciliation.
    }
  }

  private releaseProcess(exitCode: number | null, signal: string | null, error: string | null): void {
    if (this.released) return;
    this.released = true;
    try {
      this.supervisor.releaseProcess(this.processLease.id, { exitCode, signal, error });
    } catch {
      // The daemon store may already be closing; the host's exit frame remains durable.
    }
  }

  private terminateUnattachedHost(): void {
    const pid = this.hostProcess?.pid;
    if (!pid) return;
    try {
      if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
      else this.hostProcess?.kill("SIGKILL");
    } catch {
      // Setup already failed; the durable lease and startup error are the evidence.
    }
  }
}

type RawLineWaiter<T = unknown> = {
  match: (line: string) => T | null;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

/**
 * A durable worker-host process whose stdout is a line-oriented service log
 * rather than JSON-RPC. The authenticated worker host remains the sole process
 * owner; this facade only adds readiness-line observation and retained state.
 */
export class HostedRawLineProcess {
  readonly mode: "spawned" | "reconnected";
  private readonly transport: HostedJsonLineProcess;
  private readonly lines: string[] = [];
  private readonly waiters = new Set<RawLineWaiter>();

  constructor(
    spec: ProcessSpec & { processSupervisor: DriverProcessSupervisor },
    callbacks: HostedRawLineCallbacks = {},
  ) {
    this.transport = new HostedJsonLineProcess(spec, {
      onNotification: () => undefined,
      stdoutMode: "raw",
      onStdout: (line, nativeEventId) => {
        this.lines.push(line);
        if (this.lines.length > 256) this.lines.shift();
        callbacks.onStdout?.(line, nativeEventId);
        for (const waiter of [...this.waiters]) {
          const value = waiter.match(line);
          if (value === null) continue;
          clearTimeout(waiter.timeout);
          this.waiters.delete(waiter);
          waiter.resolve(value);
        }
      },
      ...(callbacks.onStderr ? { onStderr: callbacks.onStderr } : {}),
      onUnexpectedExit: (error, nativeEventId) => {
        this.rejectWaiters(error);
        callbacks.onUnexpectedExit?.(error, nativeEventId);
      },
    });
    this.mode = this.transport.mode;
  }

  activate(): Promise<void> {
    return this.transport.activate();
  }

  retainedAdapterState(): JsonValue {
    return this.transport.retainedAdapterState();
  }

  updateProcessLease(patch: Parameters<DriverProcessSupervisor["updateProcess"]>[1]): void {
    this.transport.updateProcessLease(patch);
  }

  isReusable(): boolean {
    return this.transport.isReusable();
  }

  async waitForLine<T>(match: (line: string) => T | null, timeoutMs = 5_000): Promise<T> {
    for (const line of this.lines) {
      const value = match(line);
      if (value !== null) return value;
    }
    return await new Promise<T>((resolve, reject) => {
      const waiter: RawLineWaiter<T> = {
        match,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter as RawLineWaiter);
          reject(new Error(`Timed out waiting for hosted service readiness after ${timeoutMs}ms.`));
        }, timeoutMs),
      };
      waiter.timeout.unref();
      this.waiters.add(waiter as RawLineWaiter);
    });
  }

  async detach(): Promise<void> {
    this.rejectWaiters(new Error("Worker-host controller detached."));
    await this.transport.detach();
  }

  async close(signal: NodeJS.Signals = "SIGTERM", graceMs = 2_000): Promise<void> {
    this.rejectWaiters(new Error("Hosted service connection closed."));
    await this.transport.close(signal, graceMs);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

export function openJsonLineRpc(
  spec: ProcessSpec,
  callbacks: HostedCallbacks,
  direct: () => JsonLineRpcTransport,
): JsonLineRpcTransport {
  return HostedJsonLineProcess.shouldHost(spec)
    ? new HostedJsonLineProcess(spec, callbacks)
    : direct();
}
