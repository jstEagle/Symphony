import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { environmentWithoutDaemonSecret } from "@symphony/config";
import type { DriverProcessSupervisor, JsonValue, WorkerProcessLease } from "@symphony/protocol";
import { captureProcessIdentity } from "./process-identity.js";

export type JsonObject = Record<string, unknown>;

export type ProcessSpec = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Put the adapter in its own process group so cancellation includes tool grandchildren. */
  processGroup?: boolean;
  /** Durable owner-generation ledger for directly-owned agent adapter processes. */
  processSupervisor?: DriverProcessSupervisor;
  processRole?: string;
  adapterVersion?: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  beforeResolve?: (value: unknown) => void;
  timeout?: NodeJS.Timeout;
};

export interface JsonLineRpcTransport {
  readonly mode: "direct" | "spawned" | "reconnected";
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  requestWithId(
    id: string,
    method: string,
    params?: unknown,
    timeoutMs?: number,
    beforeResolve?: (value: unknown) => void,
  ): Promise<unknown>;
  command(type: string, params?: JsonObject, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  send(value: JsonObject): void;
  updateProcessLease(patch: Parameters<DriverProcessSupervisor["updateProcess"]>[1]): void;
  retainedAdapterState(): JsonValue;
  isReusable(): boolean;
  activate(): Promise<void>;
  detach(): Promise<void>;
  close(signal?: NodeJS.Signals, graceMs?: number): Promise<void>;
}

export class JsonLineProcess implements JsonLineRpcTransport {
  readonly mode = "direct" as const;
  readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, Pending>();
  private stdoutBuffer = "";
  private closed = false;
  private processExited = false;
  private expectedClosing = false;
  private closePromise: Promise<void> | null = null;
  private exitResolve!: () => void;
  private readonly exited = new Promise<void>((resolve) => { this.exitResolve = resolve; });
  private readonly ownsProcessGroup: boolean;
  private readonly supervisor: DriverProcessSupervisor | undefined;
  private readonly processLease: WorkerProcessLease | undefined;
  private processReleased = false;

  private static readonly maxBufferedLineBytes = 1024 * 1024;

  constructor(
    spec: ProcessSpec,
    private readonly onNotification: (message: JsonObject) => void,
    private readonly onRequest?: (message: JsonObject) => Promise<unknown>,
    private readonly onStderr?: (line: string) => void,
    private readonly onUnexpectedExit?: (error: Error) => void,
  ) {
    this.ownsProcessGroup = (spec.processGroup ?? true) && process.platform !== "win32";
    this.supervisor = spec.processSupervisor;
    this.processLease = this.supervisor?.reserveProcess({
      role: spec.processRole ?? "adapter",
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd ?? null,
      adapterVersion: spec.adapterVersion ?? null,
    });
    try {
      this.process = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: environmentWithoutDaemonSecret(spec.env),
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.ownsProcessGroup,
      });
    } catch (error) {
      this.releaseProcess(null, null, error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.process.once("error", (error) => {
      if (!this.process.pid) {
        this.processExited = true;
        this.releaseProcess(null, null, error.message);
        this.exitResolve();
      }
      this.finish(error);
    });
    this.process.once("exit", (code, signal) => {
      this.processExited = true;
      this.releaseProcess(code, signal, null);
      this.exitResolve();
      this.finish(new Error(`Process exited (code=${String(code)}, signal=${String(signal)})`));
    });
    if (this.processLease && this.process.pid) {
      const identity = captureProcessIdentity(this.process.pid);
      if (!identity) {
        this.signalUnattachedProcess(this.process.pid);
        throw new Error(`Could not capture identity for newly spawned PID ${this.process.pid}.`);
      }
      try {
        this.supervisor?.attachProcess(this.processLease.id, identity);
      } catch (error) {
        this.signalUnattachedProcess(this.process.pid);
        throw error;
      }
    }
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.process.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (line) this.onStderr?.(line);
      }
    });
    this.process.stdin.on("error", (error) => this.finish(error));
    this.process.stdout.on("error", (error) => this.finish(error));
    this.process.stderr.on("error", (error) => this.finish(error));
  }

  updateProcessLease(patch: Parameters<DriverProcessSupervisor["updateProcess"]>[1]): void {
    if (!this.processLease || this.processReleased) return;
    this.supervisor?.updateProcess(this.processLease.id, patch);
  }

  retainedAdapterState(): JsonValue {
    return this.processLease?.adapterState ?? {};
  }

  isReusable(): boolean {
    return !this.closed && !this.processExited;
  }

  async activate(): Promise<void> {}

  detach(): Promise<void> {
    return this.close();
  }

  static async probe(
    command: string,
    args: string[] = ["--version"],
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<string | null> {
    return await new Promise((resolve) => {
      const child = spawn(command, args, {
        env: environmentWithoutDaemonSecret(environment),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        killTimer.unref();
        finish(null);
      }, 3_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", () => {
        finish(null);
      });
      child.once("exit", (code) => {
        const output = [stdout, stderr].filter((value) => value.trim()).join("\n").trim();
        finish(code === 0 ? output || "available" : null);
      });
    });
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
    this.write(message);
  }

  send(value: JsonObject): void {
    this.write(value);
  }

  close(signal: NodeJS.Signals = "SIGTERM", graceMs = 2_000): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.expectedClosing = true;
    this.failAll(new Error("Process connection closed"));
    this.closePromise = (async () => {
      if (this.processExited) return;
      this.signal(signal);
      if (signal === "SIGKILL") {
        const exited = await this.waitForExit(graceMs);
        if (!exited) {
          throw new Error(`Owned process group did not exit within ${graceMs}ms after SIGKILL.`);
        }
        return;
      }
      const exited = await this.waitForExit(graceMs);
      if (exited) return;
      this.signal("SIGKILL");
      const killed = await this.waitForExit(Math.min(graceMs, 1_000));
      if (!killed) {
        throw new Error(`Owned process group did not exit within ${Math.min(graceMs, 1_000)}ms after SIGKILL escalation.`);
      }
    })();
    return this.closePromise;
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
      }
      this.pending.set(id, pending);
      try {
        this.write(message);
      } catch (error) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(value: JsonObject): void {
    if (this.closed || !this.process.stdin.writable) throw new Error("Process connection is closed");
    this.process.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) this.finish(error);
    });
  }

  // Protocols handled here are LF-delimited JSON. Splitting only on LF preserves
  // U+2028/U+2029 inside JSON strings, which generic line readers can mishandle.
  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > JsonLineProcess.maxBufferedLineBytes && !this.stdoutBuffer.includes("\n")) {
      const error = new Error(`Native process emitted a JSON line larger than ${JsonLineProcess.maxBufferedLineBytes} bytes.`);
      this.notifySafely({ type: "protocol-error", error: error.message });
      this.finish(error);
      void this.close("SIGKILL").catch(() => undefined);
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as JsonObject;
        void this.dispatch(message).catch((error: unknown) => {
          this.notifySafely({
            type: "protocol-error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        this.notifySafely({
          type: "protocol-error",
          error: error instanceof Error ? error.message : String(error),
          line,
        });
      }
    }
  }

  private async dispatch(message: JsonObject): Promise<void> {
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
    const isJsonRpcRequest = id !== undefined && typeof message.method === "string" && !("result" in message) && !("error" in message);
    if (isJsonRpcRequest && this.onRequest) {
      try {
        const result = await this.onRequest(message);
        this.write({ jsonrpc: "2.0", id, result: result ?? {} });
      } catch (error) {
        this.write({
          jsonrpc: "2.0",
          id,
          error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
        });
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
            pending.beforeResolve?.(result);
            pending.resolve(result);
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
        return;
      }
    }
    this.notifySafely(message);
  }

  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(error);
    if (!this.expectedClosing) this.onUnexpectedExit?.(error);
  }

  private releaseProcess(exitCode: number | null, signal: NodeJS.Signals | null, error: string | null): void {
    if (!this.processLease || this.processReleased) return;
    this.processReleased = true;
    try {
      this.supervisor?.releaseProcess(this.processLease.id, { exitCode, signal, error });
    } catch {
      // The daemon may already be closing its store. Process exit still wins.
    }
  }

  private signalUnattachedProcess(pid: number): void {
    try {
      process.kill(this.ownsProcessGroup ? -pid : pid, "SIGKILL");
    } catch {
      // Best-effort rollback for a process that never became durably attachable.
    }
  }

  private notifySafely(message: JsonObject): void {
    try {
      this.onNotification(message);
    } catch (error) {
      // Projection callbacks cannot be allowed to tear down the process pump,
      // but silently discarding the failure can strand a durable run forever.
      try {
        this.onStderr?.(`[symphony] notification handler failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // The diagnostic projection is best-effort; the native pump stays live.
      }
    }
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.processExited) return;
    if (!this.ownsProcessGroup || !this.process.pid) {
      this.process.kill(signal);
      return;
    }

    // Codex deliberately launches command executions and MCP servers in their
    // own process groups. Snapshot the descendant tree while our directly
    // spawned session leader is still alive, then signal only the groups proven
    // to belong to that tree. This avoids both leaving detached tools alive and
    // broad process-name/PID scans that could target unrelated user work.
    const groups = this.snapshotOwnedProcessGroups(this.process.pid);
    let failure: Error | null = null;
    for (const group of groups) {
      try {
        process.kill(-group, signal);
      } catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ESRCH" && !failure) failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failure) this.finish(failure);
  }

  private snapshotOwnedProcessGroups(rootPid: number): number[] {
    const groups = new Set<number>([rootPid]);
    const snapshot = spawnSync("ps", ["-axo", "pid=,ppid=,pgid="], {
      env: environmentWithoutDaemonSecret(),
      encoding: "utf8",
      timeout: 1_000,
    });
    if (snapshot.error || snapshot.status !== 0) return [...groups];

    const children = new Map<number, Array<{ pid: number; pgid: number }>>();
    for (const line of snapshot.stdout.split(/\r?\n/u)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const pgid = Number(match[3]);
      const siblings = children.get(ppid) ?? [];
      siblings.push({ pid, pgid });
      children.set(ppid, siblings);
    }

    const queue = [rootPid];
    const visited = new Set<number>(queue);
    while (queue.length) {
      const parent = queue.shift();
      if (parent === undefined) break;
      for (const child of children.get(parent) ?? []) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        queue.push(child.pid);
        if (child.pgid > 1) groups.add(child.pgid);
      }
    }
    return [...groups];
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.processExited) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void this.exited.then(() => finish(true));
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
