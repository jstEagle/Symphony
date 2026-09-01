import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerHostConnection, workerHostProof, type WorkerHostFrame } from "../apps/worker-host/src/index.js";

type JsonMessage = Record<string, unknown>;

const workerHostEntry = resolve("apps/worker-host/src/index.ts");
const fixtureEntry = resolve("tests/fixtures/worker-host-child.mjs");
const hosts: HostHarness[] = [];

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

class JsonSocket extends EventEmitter {
  readonly messages: JsonMessage[] = [];
  private buffer = "";

  constructor(readonly socket: Socket) {
    super();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
  }

  send(message: JsonMessage): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  async waitFor(predicate: (message: JsonMessage) => boolean, timeoutMs = 3_000): Promise<JsonMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return await new Promise<JsonMessage>((resolveMessage, reject) => {
      const onMessage = (message: JsonMessage) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.off("message", onMessage);
        resolveMessage(message);
      };
      const timer = setTimeout(() => {
        this.off("message", onMessage);
        reject(new Error(`Timed out waiting for worker-host message. Received: ${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      this.on("message", onMessage);
    });
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    const closed = once(this.socket, "close");
    this.socket.end();
    await closed;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonMessage;
      this.messages.push(message);
      this.emit("message", message);
    }
  }
}

type HostHarness = {
  process: ChildProcess;
  root: string;
  socketPath: string;
  spoolPath: string;
  leaseId: string;
  capability: string;
  ownerId: string;
  workerPid: number | null;
  stderr: string;
};

async function startHost(overrides: Partial<{ maxSpoolBytes: number; maxSpoolFrames: number }> = {}): Promise<HostHarness> {
  const root = mkdtempSync(join(tmpdir(), "symphony-worker-host-"));
  const harness: HostHarness = {
    process: null as unknown as ChildProcess,
    root,
    socketPath: join(root, "host.sock"),
    spoolPath: join(root, "spool.jsonl"),
    leaseId: `lease-${Date.now()}-${Math.random()}`,
    capability: "test-capability-with-enough-entropy",
    ownerId: "daemon-owner-a",
    workerPid: null,
    stderr: "",
  };
  const child = spawn(process.execPath, ["--import", "tsx", workerHostEntry], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  harness.process = child;
  hosts.push(harness);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { harness.stderr += chunk; });

  const bootstrap = {
    version: 1,
    leaseId: harness.leaseId,
    hostInstanceId: `host-${harness.leaseId}`,
    ownerId: harness.ownerId,
    ownerEpoch: 1,
    capability: harness.capability,
    socketPath: harness.socketPath,
    spoolPath: harness.spoolPath,
    maxSpoolBytes: overrides.maxSpoolBytes ?? 256 * 1_024,
    maxSpoolFrames: overrides.maxSpoolFrames ?? 128,
    command: process.execPath,
    args: [fixtureEntry],
    cwd: process.cwd(),
  };
  const bootstrapPipe = child.stdio[3] as Writable;
  bootstrapPipe.end(JSON.stringify(bootstrap));

  const ready = await new Promise<JsonMessage>((resolveReady, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Worker host did not become ready. ${harness.stderr}`)), 4_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolveReady(JSON.parse(buffer.slice(0, newline)) as JsonMessage);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Worker host exited before ready (${code ?? signal}). ${harness.stderr}`));
    });
  });
  expect(ready).toMatchObject({
    type: "worker-host.ready",
    leaseId: harness.leaseId,
    hostInstanceId: `host-${harness.leaseId}`,
    socketPath: harness.socketPath,
  });
  return harness;
}

async function openSocket(socketPath: string): Promise<JsonSocket> {
  const socket = createConnection(socketPath);
  await once(socket, "connect");
  return new JsonSocket(socket);
}

async function authenticate(
  host: HostHarness,
  options: { ownerId?: string; ownerEpoch?: number; after?: number; capability?: string } = {},
): Promise<JsonSocket> {
  const connection = await openSocket(host.socketPath);
  const ownerId = options.ownerId ?? host.ownerId;
  const ownerEpoch = options.ownerEpoch ?? 1;
  const capability = options.capability ?? host.capability;
  const nonce = `nonce-${Date.now()}-${Math.random()}`;
  connection.send({
    type: "hello",
    ownerId,
    ownerEpoch,
    nonce,
    proof: workerHostProof(capability, host.leaseId, ownerId, ownerEpoch, nonce),
    after: options.after ?? 0,
  });
  return connection;
}

function frameFrom(message: JsonMessage): WorkerHostFrame | null {
  return message.type === "frame" && message.frame && typeof message.frame === "object"
    ? message.frame as WorkerHostFrame
    : null;
}

function outputContains(message: JsonMessage, needle: string): boolean {
  const frame = frameFrom(message);
  return frame?.stream === "stdout" && typeof frame.payload.data === "string" && frame.payload.data.includes(needle);
}

function outputPayload(message: JsonMessage): JsonMessage | null {
  const frame = frameFrom(message);
  if (frame?.stream !== "stdout" || typeof frame.payload.data !== "string") return null;
  try {
    const parsed = JSON.parse(frame.payload.data) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonMessage : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function command(connection: JsonSocket, message: JsonMessage & { commandId: string }): Promise<JsonMessage> {
  connection.send(message);
  return await connection.waitFor((candidate) => candidate.type === "command.result"
    && candidate.commandId === message.commandId
    && candidate.state !== "dispatching");
}

async function stopHost(host: HostHarness): Promise<void> {
  if (host.process.exitCode !== null || host.process.signalCode !== null) return;
  host.process.kill("SIGTERM");
  await Promise.race([once(host.process, "exit"), wait(2_000)]);
  if (host.process.exitCode === null && host.process.signalCode === null) {
    host.process.kill("SIGKILL");
    await once(host.process, "exit");
  }
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await stopHost(host);
    if (host.workerPid) {
      try { process.kill(host.workerPid, "SIGKILL"); } catch { /* already stopped */ }
    }
    rmSync(host.root, { recursive: true, force: true });
  }
});

describe("worker host external process", () => {
  it("terminates its native process group if the worker host is killed", async () => {
    const host = await startHost();
    const connection = await authenticate(host);
    const hello = await connection.waitFor((message) => message.type === "hello.accepted");
    host.workerPid = hello.workerPid as number;
    await connection.waitFor((message) => message.type === "replay.complete");
    const ready = await connection.waitFor((message) => outputPayload(message)?.type === "fixture.ready");
    const nativePid = outputPayload(ready)?.pid;
    if (typeof nativePid !== "number") throw new Error("Fixture did not report its native PID.");
    expect(nativePid).toBe(host.workerPid);

    host.process.kill("SIGKILL");
    await once(host.process, "exit");
    await expect.poll(() => ({
      native: processIsAlive(nativePid),
    }), { timeout: 3_000, interval: 25 }).toEqual({ native: false });
  });

  it("lets a higher epoch from the same owner immediately fence a stale controller", async () => {
    const host = await startHost();
    const first = await authenticate(host);
    const firstHello = await first.waitFor((message) => message.type === "hello.accepted");
    host.workerPid = firstHello.workerPid as number;
    await first.waitFor((message) => message.type === "replay.complete");

    const firstClosed = first.socket.destroyed ? Promise.resolve() : once(first.socket, "close");
    const successor = await authenticate(host, { ownerEpoch: 2 });
    await expect(successor.waitFor((message) => message.type === "hello.accepted")).resolves.toMatchObject({
      ownerId: host.ownerId,
      ownerEpoch: 2,
      workerPid: host.workerPid,
      workerRunning: true,
    });
    await firstClosed;

    await expect(command(successor, { type: "shutdown", commandId: "shutdown-successor" })).resolves.toMatchObject({ state: "applied" });
    await once(host.process, "exit");
    expect(host.process.exitCode).toBe(0);
  });

  it("survives controller disconnect, replays output, fences owners, deduplicates commands, and shuts down cleanly", async () => {
    const host = await startHost();
    expect(statSync(host.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(host.spoolPath).mode & 0o777).toBe(0o600);

    const unauthorized = await authenticate(host, { capability: "wrong-capability" });
    await expect(unauthorized.waitFor((message) => message.type === "error")).resolves.toMatchObject({ code: "unauthorized" });
    await unauthorized.close();

    const first = await authenticate(host);
    const hello = await first.waitFor((message) => message.type === "hello.accepted");
    expect(hello).toMatchObject({ ownerId: host.ownerId, ownerEpoch: 1, spoolState: "healthy" });
    host.workerPid = hello.workerPid as number;
    expect(host.workerPid).toBeGreaterThan(0);
    await first.waitFor((message) => message.type === "replay.complete");
    const readyFrame = await first.waitFor((message) => outputContains(message, "fixture.ready"));
    const readySequence = frameFrom(readyFrame)?.seq ?? 0;

    const payload = `${JSON.stringify({ id: "delayed-once", text: "survived-disconnect", delayMs: 150 })}\n`;
    await expect(command(first, { type: "stdin", commandId: "stdin-once", data: payload })).resolves.toMatchObject({
      state: "applied",
      repeated: false,
    });
    await first.close();
    await wait(250);
    expect(() => process.kill(host.process.pid as number, 0)).not.toThrow();
    expect(() => process.kill(host.workerPid as number, 0)).not.toThrow();

    const second = await authenticate(host, { ownerEpoch: 2, after: readySequence });
    const secondHello = await second.waitFor((message) => message.type === "hello.accepted");
    expect(secondHello).toMatchObject({ ownerEpoch: 2, workerPid: host.workerPid });
    await second.waitFor((message) => message.type === "replay.complete");
    const replay = await second.waitFor((message) => outputContains(message, "survived-disconnect"));
    const replayedThrough = frameFrom(replay)?.seq ?? 0;
    expect(replayedThrough).toBeGreaterThan(readySequence);

    await expect(command(second, { type: "stdin", commandId: "stdin-once", data: payload })).resolves.toMatchObject({
      state: "applied",
      repeated: true,
    });
    await wait(200);
    const spoolOutputs = readFileSync(host.spoolPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkerHostFrame)
      .filter((frame) => frame.stream === "stdout" && String(frame.payload.data).includes("survived-disconnect"));
    expect(spoolOutputs).toHaveLength(1);

    const competing = await authenticate(host, { ownerId: "daemon-owner-b", ownerEpoch: 3 });
    await expect(competing.waitFor((message) => message.type === "error")).resolves.toMatchObject({ code: "controller-active" });
    await competing.close();

    await expect(command(second, { type: "ack", commandId: "ack-replay", through: replayedThrough })).resolves.toMatchObject({ state: "applied" });
    expect(readFileSync(host.spoolPath, "utf8")).toBe("");
    await second.close();
    await wait(30);

    const stale = await authenticate(host, { ownerEpoch: 1 });
    await expect(stale.waitFor((message) => message.type === "error")).resolves.toMatchObject({ code: "stale-owner" });
    await stale.close();

    const final = await WorkerHostConnection.connect({
      socketPath: host.socketPath,
      leaseId: host.leaseId,
      capability: host.capability,
      ownerId: host.ownerId,
      ownerEpoch: 3,
      after: replayedThrough,
    });
    expect(final.accepted).toMatchObject({ ownerEpoch: 3, workerPid: host.workerPid });
    await expect(final.status("status-final")).resolves.toMatchObject({
      requestId: "status-final",
      workerPid: host.workerPid,
      workerRunning: true,
    });
    await expect(final.request({ type: "shutdown", commandId: "shutdown-host" })).resolves.toMatchObject({ state: "applied" });
    await once(host.process, "exit");
    expect(host.process.exitCode).toBe(0);
    expect(existsSync(host.socketPath)).toBe(false);
    expect(() => process.kill(host.workerPid as number, 0)).toThrow();
  });

  it("retires the native process after controller grace expires without a successor", async () => {
    const host = await startHost();
    const connection = await authenticate(host);
    const hello = await connection.waitFor((message) => message.type === "hello.accepted");
    host.workerPid = hello.workerPid as number;
    await connection.waitFor((message) => message.type === "replay.complete");
    await connection.waitFor((message) => outputPayload(message)?.type === "fixture.ready");

    await connection.close();
    await expect.poll(
      () => host.process.exitCode ?? host.process.signalCode,
      { timeout: 8_000, interval: 50 },
    ).not.toBeNull();
    expect(processIsAlive(host.workerPid as number)).toBe(false);
  });

  it("fails closed when the durable spool exceeds its bound", async () => {
    const host = await startHost({ maxSpoolBytes: 1_024, maxSpoolFrames: 8 });
    const connection = await authenticate(host);
    const hello = await connection.waitFor((message) => message.type === "hello.accepted");
    host.workerPid = hello.workerPid as number;
    await connection.waitFor((message) => message.type === "replay.complete");

    const spam = `${JSON.stringify({ type: "spam", id: "overflow", bytes: 4_096 })}\n`;
    await expect(command(connection, { type: "stdin", commandId: "overflow-input", data: spam })).resolves.toMatchObject({ state: "applied" });
    await expect(connection.waitFor((message) => {
      const frame = frameFrom(message);
      return frame?.stream === "control" && frame.payload.type === "spool-overflow";
    })).resolves.toBeTruthy();
    await expect(connection.waitFor((message) => frameFrom(message)?.stream === "exit")).resolves.toBeTruthy();
    expect(() => process.kill(host.workerPid as number, 0)).toThrow();

    connection.send({ type: "status", requestId: "status-after-overflow" });
    await expect(connection.waitFor((message) => message.type === "status")).resolves.toMatchObject({
      workerRunning: false,
      spoolState: "overflow",
    });
    await expect(command(connection, { type: "shutdown", commandId: "shutdown-overflow-host" })).resolves.toMatchObject({ state: "applied" });
    await once(host.process, "exit");
    expect(host.process.exitCode).toBe(0);
  });

  it("bounds an unterminated native output line before it can exhaust host memory", async () => {
    const host = await startHost({ maxSpoolBytes: 1_024, maxSpoolFrames: 8 });
    const connection = await authenticate(host);
    const hello = await connection.waitFor((message) => message.type === "hello.accepted");
    host.workerPid = hello.workerPid as number;
    await connection.waitFor((message) => message.type === "replay.complete");

    const spam = `${JSON.stringify({ type: "spam-unterminated", id: "unterminated", bytes: 4_096 })}\n`;
    await expect(command(connection, { type: "stdin", commandId: "unterminated-input", data: spam })).resolves.toMatchObject({ state: "applied" });
    await expect(connection.waitFor((message) => {
      const frame = frameFrom(message);
      return frame?.stream === "control"
        && frame.payload.type === "spool-overflow"
        && frame.payload.reason === "unterminated-native-line";
    })).resolves.toBeTruthy();
    await expect(connection.waitFor((message) => frameFrom(message)?.stream === "exit")).resolves.toBeTruthy();
    expect(() => process.kill(host.workerPid as number, 0)).toThrow();

    connection.send({ type: "status", requestId: "status-after-line-overflow" });
    await expect(connection.waitFor((message) => message.type === "status")).resolves.toMatchObject({
      workerRunning: false,
      spoolState: "overflow",
    });
    await expect(command(connection, { type: "shutdown", commandId: "shutdown-line-overflow-host" })).resolves.toMatchObject({ state: "applied" });
    await once(host.process, "exit");
  });
});
