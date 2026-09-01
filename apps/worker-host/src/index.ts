#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  normalizeWorkerEvent,
  projectWorkerEventPayload,
  type WorkerEventContext,
  type WorkerEventEnvelope,
} from "@symphony/protocol";

export type WorkerHostEventContext = WorkerEventContext;

export type WorkerHostBootstrap = {
  version: 1;
  leaseId: string;
  hostInstanceId: string;
  ownerId: string;
  ownerEpoch: number;
  capability: string;
  socketPath: string;
  spoolPath: string;
  maxSpoolBytes: number;
  maxSpoolFrames: number;
  /** Optional durable-recovery grace supplied by the controlling daemon. */
  controllerGraceMs?: number;
  command: string;
  args: string[];
  cwd: string | null;
};

type WorkerTrampolineBootstrap = Pick<WorkerHostBootstrap, "command" | "args" | "cwd"> & {
  version: 1;
};

export type WorkerHostFrame = {
  seq: number;
  stream: "stdout" | "stderr" | "control" | "exit";
  payload: Record<string, unknown>;
  occurredAt: string;
};

/**
 * Translate one durable host frame without parsing or changing native stdout.
 * The native line remains in raw provenance; drivers can continue to apply
 * their own protocol semantics on top of the frame.
 */
export function normalizeWorkerHostFrame(
  frame: WorkerHostFrame,
  context: WorkerHostEventContext,
): WorkerEventEnvelope {
  const kind = frame.stream === "stdout"
    ? "worker-host.stdout"
    : frame.stream === "stderr"
      ? "worker-host.stderr"
      : frame.stream === "exit"
        ? "worker-host.exit"
        : "worker-host.control";
  const controlType = typeof frame.payload.type === "string" ? frame.payload.type : null;
  const eventClass = frame.stream === "exit"
    ? (frame.payload.code === 0 && frame.payload.signal === null ? "lifecycle" : "error")
    : frame.stream === "control" && controlType === "spool-overflow"
      ? "error"
      : frame.stream === "stderr"
        ? "error"
        : undefined;
  return normalizeWorkerEvent({
    source: "worker-host",
    stream: frame.stream,
    kind,
    payload: frame.payload,
    cursor: frame.seq,
    timestamp: frame.occurredAt,
    ...(eventClass ? { eventClass } : {}),
    replayKey: `worker-host:${context.leaseId ?? "unleased"}:${frame.seq}`,
    context,
    rawProvenance: {
      source: "worker-host",
      stream: frame.stream,
      kind,
      cursor: frame.seq,
      payload: frame.payload,
    },
  });
}

type CommandResult = {
  type: "command.result";
  commandId: string;
  state: "dispatching" | "applied" | "rejected";
  repeated: boolean;
  detail?: string;
};

type PendingCommand = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ControllerState = { socket: Socket; ownerId: string; ownerEpoch: number };

const MAX_CONTROL_LINE_BYTES = 1024 * 1024;
const DAEMON_SECRET_ENVIRONMENT_VARIABLE = "SYMPHONY_DAEMON_SECRET";
// A detached worker host must not retain a privileged native worker forever
// after its controller disappears. Keep this aligned with the driver's
// reconnect window; a successor that arrives in time clears the timer.
const CONTROLLER_GRACE_MS = 5_000;

function controllerGraceMs(bootstrap: WorkerHostBootstrap): number {
  const configured = bootstrap.controllerGraceMs;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : CONTROLLER_GRACE_MS;
}

function environmentWithoutDaemonSecret(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  for (const key of Object.keys(childEnvironment)) {
    if (key.toUpperCase() === DAEMON_SECRET_ENVIRONMENT_VARIABLE) delete childEnvironment[key];
  }
  return childEnvironment;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function ensurePrivateDirectory(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Worker host path is not a private directory: ${path}`);
  if (existed && (stat.mode & 0o077) !== 0) {
    throw new Error(`Worker host directory must not be accessible by group or other users: ${path}`);
  }
  if (!existed) chmodSync(path, 0o700);
}

export function workerHostProof(
  capability: string,
  leaseId: string,
  ownerId: string,
  ownerEpoch: number,
  nonce: string,
): string {
  return createHmac("sha256", capability)
    .update(`worker-host:v1:${leaseId}:${ownerId}:${ownerEpoch}:${nonce}`)
    .digest("hex");
}

function parseBootstrap(value: unknown): WorkerHostBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worker host bootstrap must be an object.");
  const input = value as Record<string, unknown>;
  const requiredStrings = ["leaseId", "hostInstanceId", "ownerId", "capability", "socketPath", "spoolPath", "command"] as const;
  for (const key of requiredStrings) {
    if (typeof input[key] !== "string" || !(input[key] as string).length) throw new Error(`Worker host bootstrap is missing ${key}.`);
  }
  if (input.version !== 1) throw new Error("Unsupported worker host protocol version.");
  if (!Number.isSafeInteger(input.ownerEpoch) || (input.ownerEpoch as number) < 0) throw new Error("Invalid owner epoch.");
  if (!Number.isSafeInteger(input.maxSpoolBytes) || (input.maxSpoolBytes as number) < 1_024) throw new Error("Invalid spool byte limit.");
  if (!Number.isSafeInteger(input.maxSpoolFrames) || (input.maxSpoolFrames as number) < 8) throw new Error("Invalid spool frame limit.");
  if (!Array.isArray(input.args) || !input.args.every((item) => typeof item === "string")) throw new Error("Invalid worker command arguments.");
  if (input.cwd !== null && typeof input.cwd !== "string") throw new Error("Invalid worker cwd.");
  return input as WorkerHostBootstrap;
}

function parseTrampolineBootstrap(value: unknown): WorkerTrampolineBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worker trampoline bootstrap must be an object.");
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.command !== "string" || !input.command.length) {
    throw new Error("Worker trampoline bootstrap is invalid.");
  }
  if (!Array.isArray(input.args) || !input.args.every((item) => typeof item === "string")) {
    throw new Error("Worker trampoline arguments are invalid.");
  }
  if (input.cwd !== null && typeof input.cwd !== "string") throw new Error("Worker trampoline cwd is invalid.");
  return input as WorkerTrampolineBootstrap;
}

export class WorkerHost {
  private readonly server: Server;
  private child: ChildProcessWithoutNullStreams | null = null;
  private controller: ControllerState | null = null;
  private ownerId: string;
  private ownerEpoch: number;
  private sequence = 0;
  private acknowledgedSequence = 0;
  private frames: WorkerHostFrame[] = [];
  private spoolBytes = 0;
  private spoolFd: number | null = null;
  private spoolState: "healthy" | "overflow" = "healthy";
  private readonly commandResults = new Map<string, CommandResult>();
  private readonly acknowledgementWaiters = new Set<() => void>();
  private nativeWorkerPid: number | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closing = false;
  private controllerGraceTimer: NodeJS.Timeout | null = null;

  constructor(readonly bootstrap: WorkerHostBootstrap) {
    this.ownerId = bootstrap.ownerId;
    this.ownerEpoch = bootstrap.ownerEpoch;
    this.server = createServer((socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    const socketDirectory = dirname(this.bootstrap.socketPath);
    const spoolDirectory = dirname(this.bootstrap.spoolPath);
    ensurePrivateDirectory(socketDirectory);
    if (spoolDirectory !== socketDirectory) ensurePrivateDirectory(spoolDirectory);
    if (existsSync(this.bootstrap.socketPath)) throw new Error("Worker host endpoint already exists for this lease.");
    if (existsSync(this.bootstrap.spoolPath)) throw new Error("Worker host spool already exists for this lease.");
    this.spoolFd = openSync(this.bootstrap.spoolPath, "ax", 0o600);
    chmodSync(this.bootstrap.spoolPath, 0o600);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.bootstrap.socketPath, () => {
        this.server.off("error", onError);
        chmodSync(this.bootstrap.socketPath, 0o600);
        resolve();
      });
    });
    await this.spawnWorker();
  }

  async close(terminateWorker = true): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.clearControllerGraceTimer();
    if (terminateWorker && this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.signalWorker("SIGTERM");
      await new Promise<void>((resolve) => {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => {
          this.signalWorker("SIGKILL");
          resolve();
        }, 1_000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await this.waitForProducedOutputAcknowledgement();
    // Preserve the authenticated controller until the native exit frame has
    // been emitted. Otherwise an explicit shutdown can leave the lease marked
    // running even though the host successfully terminated the worker.
    this.controller?.socket.destroy();
    this.controller = null;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.spoolFd !== null) {
      closeSync(this.spoolFd);
      this.spoolFd = null;
    }
    if (existsSync(this.bootstrap.socketPath) && lstatSync(this.bootstrap.socketPath).isSocket()) unlinkSync(this.bootstrap.socketPath);
  }

  private async spawnWorker(): Promise<void> {
    const entry = process.argv[1];
    if (!entry) throw new Error("Worker host entrypoint is unavailable.");
    const child = spawn(process.execPath, [...process.execArgv, entry, "--worker-trampoline"], {
      detached: process.platform !== "win32",
      env: environmentWithoutDaemonSecret(),
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    const bootstrapPipe = child.stdio[3];
    const readyPipe = child.stdio[4];
    if (!(bootstrapPipe instanceof Writable) || !(readyPipe instanceof Readable)) {
      child.kill("SIGKILL");
      throw new Error("Worker trampoline bootstrap or readiness descriptor is unavailable.");
    }
    bootstrapPipe.end(JSON.stringify({
      version: 1,
      command: this.bootstrap.command,
      args: this.bootstrap.args,
      cwd: this.bootstrap.cwd,
    } satisfies WorkerTrampolineBootstrap));
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consumeWorkerOutput("stdout", chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => this.consumeWorkerOutput("stderr", chunk.toString("utf8")));
    child.once("error", (error) => this.appendFrame("control", { type: "worker-error", error: error.message }, true));
    child.once("exit", (code, signal) => {
      this.flushWorkerOutput("stdout");
      this.flushWorkerOutput("stderr");
      this.appendFrame("exit", { code, signal }, true);
    });
    this.nativeWorkerPid = await new Promise<number>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("Worker trampoline did not report the native worker PID.")), 5_000);
      timer.unref();
      readyPipe.setEncoding("utf8");
      readyPipe.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          if (message.type !== "worker-trampoline.ready" || typeof message.pid !== "number" || !Number.isInteger(message.pid) || message.pid <= 0) {
            throw new Error("Worker trampoline reported an invalid native worker identity.");
          }
          resolve(message.pid);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Worker trampoline exited before readiness (code=${String(code)}, signal=${String(signal)}).`));
      });
    });
    readyPipe.destroy();
  }

  private workerRunning(): boolean {
    return Boolean(this.nativeWorkerPid && this.child && this.child.exitCode === null && this.child.signalCode === null);
  }

  private clearControllerGraceTimer(): void {
    if (!this.controllerGraceTimer) return;
    clearTimeout(this.controllerGraceTimer);
    this.controllerGraceTimer = null;
  }

  private armControllerGraceTimer(): void {
    this.clearControllerGraceTimer();
    if (this.closing || this.controller) return;
    const timer = setTimeout(() => {
      this.controllerGraceTimer = null;
      if (this.closing || this.controller) return;
      // There is no authenticated authority left to issue a signal. The host
      // therefore owns the final retirement decision and terminates its
      // process group after the same bounded grace used by controller retry.
      void this.close(true).then(() => process.exit(0), () => process.exit(1));
    }, controllerGraceMs(this.bootstrap));
    timer.unref();
    this.controllerGraceTimer = timer;
  }

  private consumeWorkerOutput(stream: "stdout" | "stderr", chunk: string): void {
    if (this.spoolState === "overflow") return;
    const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
    this[key] += chunk;
    const bufferedBytes = Buffer.byteLength(this[key]);
    if (bufferedBytes > this.bootstrap.maxSpoolBytes && !this[key].includes("\n")) {
      this[key] = "";
      this.spoolState = "overflow";
      this.appendFrame("control", {
        type: "spool-overflow",
        reason: "unterminated-native-line",
        stream,
        bufferedBytes,
        maxSpoolBytes: this.bootstrap.maxSpoolBytes,
        maxSpoolFrames: this.bootstrap.maxSpoolFrames,
      }, true);
      this.signalWorker("SIGTERM");
      const timer = setTimeout(() => this.signalWorker("SIGKILL"), 1_000);
      timer.unref();
      return;
    }
    while (true) {
      const newline = this[key].indexOf("\n");
      if (newline < 0) return;
      const line = this[key].slice(0, newline + 1);
      this[key] = this[key].slice(newline + 1);
      this.appendFrame(stream, { data: line });
    }
  }

  private flushWorkerOutput(stream: "stdout" | "stderr"): void {
    const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
    if (!this[key]) return;
    const data = this[key];
    this[key] = "";
    this.appendFrame(stream, { data }, true);
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_CONTROL_LINE_BYTES && !buffer.includes("\n")) {
        this.send(socket, { type: "error", code: "frame-too-large", message: "Control frame exceeded the byte limit." });
        socket.destroy();
        return;
      }
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES) {
          this.send(socket, { type: "error", code: "frame-too-large", message: "Control frame exceeded the byte limit." });
          socket.destroy();
          return;
        }
        let message: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Control message must be an object.");
          message = parsed as Record<string, unknown>;
        } catch (error) {
          this.send(socket, { type: "error", code: "invalid-json", message: error instanceof Error ? error.message : String(error) });
          socket.destroy();
          return;
        }
        if (!authenticated) {
          authenticated = this.authenticate(socket, message);
          if (!authenticated) return;
        } else {
          this.command(socket, message);
        }
      }
    });
    const release = () => {
      if (this.controller?.socket === socket) {
        this.controller = null;
        this.armControllerGraceTimer();
        for (const wake of this.acknowledgementWaiters) wake();
      }
    };
    socket.once("close", release);
    socket.once("error", release);
  }

  private authenticate(socket: Socket, message: Record<string, unknown>): boolean {
    const ownerId = typeof message.ownerId === "string" ? message.ownerId : "";
    const ownerEpoch = typeof message.ownerEpoch === "number" ? message.ownerEpoch : -1;
    const nonce = typeof message.nonce === "string" ? message.nonce : "";
    const proof = typeof message.proof === "string" ? message.proof : "";
    const after = typeof message.after === "number" && Number.isSafeInteger(message.after) && message.after >= 0 ? message.after : 0;
    const expected = workerHostProof(this.bootstrap.capability, this.bootstrap.leaseId, ownerId, ownerEpoch, nonce);
    if (message.type !== "hello" || !ownerId || !nonce || !secureEqual(proof, expected)) {
      this.send(socket, { type: "error", code: "unauthorized", message: "Worker host authentication failed." });
      socket.end();
      return false;
    }
    const activeController = this.controller && !this.controller.socket.destroyed ? this.controller : null;
    const replacesStaleController = Boolean(
      activeController
      && activeController.ownerId === ownerId
      && ownerEpoch > activeController.ownerEpoch,
    );
    if (activeController && !replacesStaleController) {
      this.send(socket, { type: "error", code: "controller-active", message: "Another controller still owns this worker host." });
      socket.end();
      return false;
    }
    const sameOwner = ownerId === this.ownerId;
    if (ownerEpoch < this.ownerEpoch || (ownerEpoch === this.ownerEpoch && !sameOwner)) {
      this.send(socket, { type: "error", code: "stale-owner", message: "Controller epoch is stale." });
      socket.end();
      return false;
    }
    // A daemon keeps a stable owner id and advances its epoch on every start.
    // Permit that proven successor to fence an old socket immediately instead
    // of waiting for the kernel to deliver the dead daemon's close event.
    if (replacesStaleController) activeController?.socket.destroy();
    this.clearControllerGraceTimer();
    this.ownerId = ownerId;
    this.ownerEpoch = ownerEpoch;
    this.controller = { socket, ownerId, ownerEpoch };
    this.send(socket, {
      type: "hello.accepted",
      leaseId: this.bootstrap.leaseId,
      hostInstanceId: this.bootstrap.hostInstanceId,
      ownerId,
      ownerEpoch,
      producedOutputSeq: this.sequence,
      ackedOutputSeq: this.acknowledgedSequence,
      workerPid: this.nativeWorkerPid,
      workerRunning: this.workerRunning(),
      spoolState: this.spoolState,
    });
    for (const frame of this.frames) if (frame.seq > after) this.send(socket, { type: "frame", frame });
    this.send(socket, { type: "replay.complete", through: this.sequence });
    return true;
  }

  private command(socket: Socket, message: Record<string, unknown>): void {
    if (this.controller?.socket !== socket) {
      this.send(socket, { type: "error", code: "not-controller", message: "Socket no longer owns this worker host." });
      return;
    }
    if (message.type === "status") {
      this.send(socket, {
        type: "status",
        requestId: typeof message.requestId === "string" ? message.requestId : null,
        leaseId: this.bootstrap.leaseId,
        ownerId: this.ownerId,
        ownerEpoch: this.ownerEpoch,
        workerPid: this.nativeWorkerPid,
        workerRunning: this.workerRunning(),
        producedOutputSeq: this.sequence,
        ackedOutputSeq: this.acknowledgedSequence,
        spoolBytes: this.spoolBytes,
        spoolFrames: this.frames.length,
        spoolState: this.spoolState,
      });
      return;
    }
    const commandId = typeof message.commandId === "string" ? message.commandId : "";
    if (!commandId) {
      this.send(socket, { type: "error", code: "missing-command-id", message: "Mutating commands require commandId." });
      return;
    }
    const previous = this.commandResults.get(commandId);
    if (previous) {
      this.send(socket, { ...previous, repeated: true });
      return;
    }
    if (["stdin", "signal", "shutdown"].includes(String(message.type)) && this.retainedMutationCount() >= this.bootstrap.maxSpoolFrames) {
      this.send(socket, {
        type: "command.result",
        commandId,
        state: "rejected",
        repeated: false,
        detail: "Worker-host idempotency ledger is full; refusing an untracked mutation.",
      });
      return;
    }
    if (message.type === "stdin") {
      const data = typeof message.data === "string" ? message.data : "";
      if (!data || Buffer.byteLength(data) > MAX_CONTROL_LINE_BYTES || !this.child?.stdin.writable) {
        const rejected: CommandResult = { type: "command.result", commandId, state: "rejected", repeated: false, detail: "Worker stdin is unavailable or invalid." };
        this.commandResults.set(commandId, rejected);
        this.send(socket, rejected);
        return;
      }
      const dispatching: CommandResult = { type: "command.result", commandId, state: "dispatching", repeated: false };
      this.commandResults.set(commandId, dispatching);
      this.child.stdin.write(data, (error) => {
        const result: CommandResult = error
          ? { type: "command.result", commandId, state: "rejected", repeated: false, detail: error.message }
          : { type: "command.result", commandId, state: "applied", repeated: false };
        this.commandResults.set(commandId, result);
        const controller = this.controller?.socket;
        if (controller && !controller.destroyed) this.send(controller, result);
      });
      return;
    }
    if (message.type === "signal") {
      const signal = typeof message.signal === "string" && ["SIGINT", "SIGTERM", "SIGKILL"].includes(message.signal)
        ? message.signal as NodeJS.Signals
        : null;
      const result: CommandResult = signal
        ? { type: "command.result", commandId, state: this.signalWorker(signal) ? "applied" : "rejected", repeated: false }
        : { type: "command.result", commandId, state: "rejected", repeated: false, detail: "Unsupported signal." };
      this.commandResults.set(commandId, result);
      this.send(socket, result);
      return;
    }
    if (message.type === "ack") {
      const through = typeof message.through === "number" && Number.isSafeInteger(message.through) ? message.through : -1;
      const accepted = through >= this.acknowledgedSequence && through <= this.sequence;
      if (accepted) this.compact(through);
      const result: CommandResult = {
        type: "command.result",
        commandId,
        state: accepted ? "applied" : "rejected",
        repeated: false,
        ...(accepted ? {} : { detail: "Acknowledgement is outside the produced sequence range." }),
      };
      this.commandResults.set(commandId, result);
      this.send(socket, result);
      if (accepted) this.scheduleCloseAfterWorkerExit();
      return;
    }
    if (message.type === "shutdown") {
      const result: CommandResult = { type: "command.result", commandId, state: "applied", repeated: false };
      this.commandResults.set(commandId, result);
      this.send(socket, result);
      void this.close(true).then(() => process.exit(0));
      return;
    }
    const result: CommandResult = { type: "command.result", commandId, state: "rejected", repeated: false, detail: "Unknown command." };
    this.commandResults.set(commandId, result);
    this.send(socket, result);
  }

  private appendFrame(stream: WorkerHostFrame["stream"], payload: Record<string, unknown>, terminal = false): void {
    if (this.closing && !terminal) return;
    // The native line is transient; the spool is durable across controller
    // reconnects and therefore receives only the bounded/redacted projection.
    const persistedPayload = projectWorkerEventPayload(payload);
    const framePayload = persistedPayload !== null && typeof persistedPayload === "object" && !Array.isArray(persistedPayload)
      ? persistedPayload as Record<string, unknown>
      : { value: persistedPayload };
    const frame: WorkerHostFrame = { seq: this.sequence + 1, stream, payload: framePayload, occurredAt: new Date().toISOString() };
    const line = jsonLine(frame);
    const bytes = Buffer.byteLength(line);
    if (!terminal && this.spoolState === "healthy" && (this.frames.length + 1 > this.bootstrap.maxSpoolFrames || this.spoolBytes + bytes > this.bootstrap.maxSpoolBytes)) {
      this.spoolState = "overflow";
      this.appendFrame("control", {
        type: "spool-overflow",
        maxSpoolBytes: this.bootstrap.maxSpoolBytes,
        maxSpoolFrames: this.bootstrap.maxSpoolFrames,
      }, true);
      this.signalWorker("SIGTERM");
      const timer = setTimeout(() => this.signalWorker("SIGKILL"), 1_000);
      timer.unref();
      return;
    }
    if (this.spoolState === "overflow" && !terminal) return;
    this.sequence = frame.seq;
    this.frames.push(frame);
    this.spoolBytes += bytes;
    if (this.spoolFd === null) throw new Error("Worker host spool is closed.");
    writeSync(this.spoolFd, line);
    fsyncSync(this.spoolFd);
    if (this.controller && !this.controller.socket.destroyed) this.send(this.controller.socket, { type: "frame", frame });
  }

  private compact(through: number): void {
    if (through <= this.acknowledgedSequence) return;
    this.acknowledgedSequence = through;
    this.frames = this.frames.filter((frame) => frame.seq > through);
    const content = this.frames.map((frame) => jsonLine(frame)).join("");
    const temporary = `${this.bootstrap.spoolPath}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    const temporaryFd = openSync(temporary, "r+");
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    if (this.spoolFd !== null) closeSync(this.spoolFd);
    renameSync(temporary, this.bootstrap.spoolPath);
    chmodSync(this.bootstrap.spoolPath, 0o600);
    this.spoolFd = openSync(this.bootstrap.spoolPath, "a", 0o600);
    this.spoolBytes = Buffer.byteLength(content);
    const responsePrefix = `response:${this.bootstrap.leaseId}:`;
    for (const commandId of this.commandResults.keys()) {
      if (commandId.startsWith("ack:")) {
        this.commandResults.delete(commandId);
        continue;
      }
      if (!commandId.startsWith(responsePrefix)) continue;
      const sequence = Number(commandId.slice(responsePrefix.length).split(":", 1)[0]);
      if (Number.isSafeInteger(sequence) && sequence <= through) this.commandResults.delete(commandId);
    }
    for (const wake of this.acknowledgementWaiters) wake();
  }

  private retainedMutationCount(): number {
    const responsePrefix = `response:${this.bootstrap.leaseId}:`;
    let count = 0;
    for (const commandId of this.commandResults.keys()) {
      if (!commandId.startsWith("ack:") && !commandId.startsWith(responsePrefix)) count += 1;
    }
    return count;
  }

  private scheduleCloseAfterWorkerExit(): void {
    if (this.closing || this.workerRunning() || this.acknowledgedSequence < this.sequence) return;
    setImmediate(() => {
      if (this.closing || this.workerRunning() || this.acknowledgedSequence < this.sequence) return;
      void this.close(false).then(() => process.exit(0));
    });
  }

  private async waitForProducedOutputAcknowledgement(timeoutMs = 2_000): Promise<void> {
    if (!this.controller || this.controller.socket.destroyed || this.acknowledgedSequence >= this.sequence) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        if (this.acknowledgedSequence < this.sequence && this.controller && !this.controller.socket.destroyed) return;
        settled = true;
        clearTimeout(timer);
        this.acknowledgementWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(() => {
        settled = true;
        this.acknowledgementWaiters.delete(finish);
        resolve();
      }, timeoutMs);
      timer.unref();
      this.acknowledgementWaiters.add(finish);
      finish();
    });
  }

  private signalWorker(signal: NodeJS.Signals): boolean {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  private send(socket: Socket, value: unknown): void {
    if (!socket.destroyed && socket.writable) socket.write(jsonLine(value));
  }
}

export class WorkerHostConnection extends EventEmitter {
  readonly replayed: WorkerHostFrame[] = [];
  accepted: Record<string, unknown> | null = null;
  private readonly bufferedLiveFrames: WorkerHostFrame[] = [];
  private readonly pending = new Map<string, PendingCommand>();
  private buffer = "";
  private ready = false;

  private constructor(readonly socket: Socket) {
    super();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.once("close", () => {
      const error = new Error("Worker host connection closed.");
      if (!this.ready) this.emit("handshake-error", error);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit("close");
    });
    socket.once("error", (error) => {
      if (!this.ready) this.emit("handshake-error", error);
      else this.emit("protocol-error", error);
    });
  }

  static async connect(options: {
    socketPath: string;
    leaseId: string;
    capability: string;
    ownerId: string;
    ownerEpoch: number;
    after?: number;
  }): Promise<WorkerHostConnection> {
    const socket = createConnection(options.socketPath);
    const connection = new WorkerHostConnection(socket);
    const nonce = randomUUID();
    return await new Promise<WorkerHostConnection>((resolve, reject) => {
      const timer = setTimeout(() => onError(new Error("Timed out connecting to worker host.")), 5_000);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        connection.off("handshake-error", onError);
        connection.off("ready", onReady);
      };
      const onError = (error: Error) => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onReady = () => {
        cleanup();
        resolve(connection);
      };
      connection.once("handshake-error", onError);
      connection.once("ready", onReady);
      socket.once("connect", () => socket.write(jsonLine({
        type: "hello",
        ownerId: options.ownerId,
        ownerEpoch: options.ownerEpoch,
        nonce,
        proof: workerHostProof(options.capability, options.leaseId, options.ownerId, options.ownerEpoch, nonce),
        after: options.after ?? 0,
      })));
    });
  }

  request(message: Record<string, unknown> & { commandId: string }): Promise<Record<string, unknown>> {
    if (!this.ready || this.socket.destroyed || !this.socket.writable) {
      return Promise.reject(new Error("Worker host connection is not writable."));
    }
    if (this.pending.has(message.commandId)) return Promise.reject(new Error(`Command is already pending: ${message.commandId}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.commandId);
        reject(new Error(`Timed out waiting for worker host command ${message.commandId}.`));
      }, 5_000);
      timer.unref();
      this.pending.set(message.commandId, { resolve, reject, timer });
      this.socket.write(jsonLine(message), (error) => {
        if (!error) return;
        const pending = this.pending.get(message.commandId);
        if (!pending) return;
        this.pending.delete(message.commandId);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  status(requestId = randomUUID()): Promise<Record<string, unknown>> {
    if (!this.ready || this.socket.destroyed || !this.socket.writable) {
      return Promise.reject(new Error("Worker host connection is not writable."));
    }
    if (this.pending.has(requestId)) return Promise.reject(new Error(`Request is already pending: ${requestId}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for worker host status ${requestId}.`));
      }, 5_000);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(jsonLine({ type: "status", requestId }), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  close(): void {
    this.socket.end();
  }

  takeBufferedFrames(): WorkerHostFrame[] {
    return [...this.replayed.splice(0), ...this.bufferedLiveFrames.splice(0)];
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Worker host message must be an object.");
        message = parsed as Record<string, unknown>;
      } catch (error) {
        const protocolError = error instanceof Error ? error : new Error(String(error));
        if (!this.ready) this.emit("handshake-error", protocolError);
        else this.emit("protocol-error", protocolError);
        this.socket.destroy();
        return;
      }
      if (message.type === "error") {
        const error = new Error(typeof message.message === "string" ? message.message : "Worker host error.");
        if (!this.ready) this.emit("handshake-error", error);
        else this.emit("protocol-error", error);
        continue;
      }
      if (message.type === "frame" && message.frame && typeof message.frame === "object") {
        const frame = message.frame as WorkerHostFrame;
        if (!this.ready) this.replayed.push(frame);
        else if (this.listenerCount("frame") > 0) this.emit("frame", frame);
        else this.bufferedLiveFrames.push(frame);
        continue;
      }
      if (message.type === "replay.complete") {
        this.ready = true;
        this.emit("ready");
        continue;
      }
      if (message.type === "hello.accepted") {
        this.accepted = message;
        this.emit("message", message);
        continue;
      }
      if (message.type === "status" && typeof message.requestId === "string") {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          clearTimeout(pending.timer);
          pending.resolve(message);
        } else {
          this.emit("message", message);
        }
        continue;
      }
      if (message.type === "command.result" && typeof message.commandId === "string") {
        const pending = this.pending.get(message.commandId);
        if (pending && message.state !== "dispatching") {
          this.pending.delete(message.commandId);
          clearTimeout(pending.timer);
          pending.resolve(message);
        }
        continue;
      }
      this.emit("message", message);
    }
  }
}

async function main(): Promise<void> {
  const bootstrap = parseBootstrap(JSON.parse(readFileSync(3, "utf8")) as unknown);
  const host = new WorkerHost(bootstrap);
  await host.start();
  process.stdout.write(`${JSON.stringify({
    type: "worker-host.ready",
    leaseId: bootstrap.leaseId,
    hostInstanceId: bootstrap.hostInstanceId,
    socketPath: bootstrap.socketPath,
  })}\n`);
  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= host.close(true).finally(() => process.exit(0));
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

async function trampolineMain(): Promise<void> {
  const bootstrap = parseTrampolineBootstrap(JSON.parse(readFileSync(3, "utf8")) as unknown);
  const child = spawn(bootstrap.command, bootstrap.args, {
    ...(bootstrap.cwd ? { cwd: bootstrap.cwd } : {}),
    env: environmentWithoutDaemonSecret(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  writeSync(4, jsonLine({ type: "worker-trampoline.ready", pid: child.pid }));
  closeSync(4);
  let terminating = false;
  let forceTimer: NodeJS.Timeout | null = null;
  const armForceKill = () => {
    if (forceTimer || child.exitCode !== null || child.signalCode !== null) return;
    forceTimer = setTimeout(() => {
      try {
        if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        process.exit(1);
      }
    }, 1_000);
    forceTimer.unref();
  };
  const observeTerminationSignal = () => {
    terminating = true;
    armForceKill();
  };
  const terminateAfterHostLoss = () => {
    if (terminating || child.exitCode !== null || child.signalCode !== null) return;
    terminating = true;
    armForceKill();
    try {
      if (process.platform !== "win32") process.kill(-process.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      process.exit(1);
    }
  };

  process.on("SIGINT", observeTerminationSignal);
  process.on("SIGTERM", observeTerminationSignal);
  process.stdin.once("end", terminateAfterHostLoss);
  process.stdin.once("close", terminateAfterHostLoss);
  process.stdin.once("error", terminateAfterHostLoss);
  process.stdout.on("error", terminateAfterHostLoss);
  process.stderr.on("error", terminateAfterHostLoss);
  child.stdin.on("error", () => undefined);
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdin.resume();

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (forceTimer) clearTimeout(forceTimer);
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const run = process.argv[2] === "--worker-trampoline" ? trampolineMain : main;
  await run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
