import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export type ProcessSpec = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

export class JsonLineProcess {
  readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, Pending>();
  private stdoutBuffer = "";
  private closed = false;

  constructor(
    spec: ProcessSpec,
    private readonly onNotification: (message: JsonObject) => void,
    private readonly onRequest?: (message: JsonObject) => Promise<unknown>,
    private readonly onStderr?: (line: string) => void,
  ) {
    this.process = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.process.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (line) this.onStderr?.(line);
      }
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`Process exited (code=${String(code)}, signal=${String(signal)})`));
    });
  }

  static async probe(command: string, args: string[] = ["--version"]): Promise<string | null> {
    return await new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve(null);
      }, 3_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        const output = [stdout, stderr].filter((value) => value.trim()).join("\n").trim();
        resolve(code === 0 ? output || "available" : null);
      });
    });
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = randomUUID();
    const message: JsonObject = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    return this.sendRequest(id, message, timeoutMs);
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

  close(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.closed) return;
    this.closed = true;
    this.process.kill(signal);
    this.failAll(new Error("Process connection closed"));
  }

  private sendRequest(id: string | number, message: JsonObject, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject };
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
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  // Protocols handled here are LF-delimited JSON. Splitting only on LF preserves
  // U+2028/U+2029 inside JSON strings, which generic line readers can mishandle.
  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as JsonObject;
        void this.dispatch(message);
      } catch (error) {
        this.onNotification({
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
        else pending.resolve(message.result ?? message);
        return;
      }
    }
    this.onNotification(message);
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
