#!/usr/bin/env node
import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;
type PromptRequest = { id: string | number; prompt: string; requestId: string; contentHash: string };
type ResultFence = {
  generation: number;
  terminal: boolean;
  acknowledged: Promise<void>;
  acknowledge: () => void;
};

class AsyncMailbox<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new Error("Claude SDK input mailbox is closed.");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.closed) return { done: true, value: undefined };
    return await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

type ActiveQuery = {
  query: Query;
  mailbox: AsyncMailbox<SDKUserMessage>;
  queued: PromptRequest[];
  turnActive: boolean;
  acceptance: Promise<string>;
  resolveAcceptance: (sessionId: string) => void;
  rejectAcceptance: (error: Error) => void;
  accepted: boolean;
  completion: Promise<void>;
  resolveCompletion: () => void;
  cancelRequested: boolean;
  turnGeneration: number;
  currentRequest: { requestId: string; contentHash: string } | null;
  resultFence: ResultFence | null;
};

const rootSecretName = "SYMPHONY_DAEMON_SECRET";
const interruptDeadlineMs = 1_000;
const terminationProofDeadlineMs = 1_000;
const sensitiveValues = new Set<string>();

function sensitiveEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  if ([
    rootSecretName,
    "SYMPHONY_AGENT_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "PGPASSWORD",
    "DATABASE_URL",
    "REDISCLI_AUTH",
    "GITHUB_PAT",
  ].includes(normalized)) return true;
  return /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|PAT|AUTH)(?:_|$)/u.test(normalized);
}

function containsEmbeddedUrlCredential(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]*@/iu.test(value);
  }
}

function scrubbedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...environment };
  for (const key of Object.keys(scrubbed)) {
    if (key.toUpperCase() === rootSecretName) delete scrubbed[key];
  }
  return scrubbed;
}

function scrubText(value: string): string {
  let scrubbed = value;
  // Credential values are a security boundary, including unusually short
  // values. Native stderr is unconstrained and may concatenate a value with
  // surrounding text, so delimiter-aware replacement can still leak it.
  // Prefer degraded diagnostics for a pathological short credential over
  // persisting any part of that credential in a host spool or daemon event.
  // Longest-first prevents a short credential that is a substring of a
  // longer credential from destroying the longer match and leaking its
  // remaining prefix/suffix.
  for (const secret of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
    scrubbed = scrubbed.replaceAll(secret, "[REDACTED]");
  }
  return scrubbed;
}

function markFields(
  protectedFields: WeakMap<object, Set<string>>,
  value: unknown,
  fields: string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  protectedFields.set(value, new Set(fields));
}

type JsonProtection = {
  keyFields: WeakMap<object, Set<string>>;
  valueFields: WeakMap<object, Set<string>>;
};

function protocolProtection(value: unknown): JsonProtection {
  const protection: JsonProtection = {
    keyFields: new WeakMap<object, Set<string>>(),
    valueFields: new WeakMap<object, Set<string>>(),
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return protection;
  const envelope = value as JsonObject;
  markFields(protection.keyFields, envelope, ["error", "id", "jsonrpc", "method", "params", "result"]);
  markFields(protection.valueFields, envelope, ["id", "jsonrpc", "method"]);
  if (envelope.result && typeof envelope.result === "object" && !Array.isArray(envelope.result)) {
    markFields(protection.keyFields, envelope.result, Object.keys(envelope.result));
    // Durable dispatch identity is protocol metadata, not user/provider
    // content. Preserve it verbatim through the host's credential scrubber so
    // the controller can prove native acceptance after a crash. In particular,
    // a one-character credential such as `p` must not turn `symphony:...` into
    // a different request id on the way back to the driver.
    markFields(protection.valueFields, envelope.result, ["contentHash", "requestId", "sessionId"]);
  }
  if (envelope.error && typeof envelope.error === "object" && !Array.isArray(envelope.error)) {
    markFields(protection.keyFields, envelope.error, ["code", "data", "message"]);
  }

  if (envelope.method !== "claude/message") return protection;
  const params = object(envelope.params);
  markFields(protection.keyFields, params, [
    "__symphonyQueuedPrompts",
    "__symphonyTurnGeneration",
    "apiKeySource",
    "cwd",
    "duration_api_ms",
    "duration_ms",
    "elapsed_time_seconds",
    "errors",
    "event",
    "is_error",
    "mcp_servers",
    "message",
    "model",
    "modelUsage",
    "num_turns",
    "output_style",
    "parent_tool_use_id",
    "permissionMode",
    "permission_denials",
    "plugins",
    "request_id",
    "requestId",
    "contentHash",
    "__symphonyMessageRequestId",
    "__symphonyMessageContentHash",
    "result",
    "session_id",
    "skills",
    "slash_commands",
    "stop_reason",
    "structured_output",
    "subtype",
    "tool_name",
    "tool_use_id",
    "tool_use_result",
    "tools",
    "total_cost_usd",
    "type",
    "usage",
    "uuid",
  ]);
  markFields(protection.valueFields, params, [
    "__symphonyMessageContentHash",
    "__symphonyMessageRequestId",
    "contentHash",
    "parent_tool_use_id",
    "request_id",
    "requestId",
    "session_id",
    "subtype",
    "tool_use_id",
    "type",
    "uuid",
  ]);
  const nativeMessage = object(params.message);
  markFields(protection.keyFields, nativeMessage, ["content", "id", "model", "role", "stop_reason", "stop_sequence", "type", "usage"]);
  markFields(protection.valueFields, nativeMessage, ["id", "type"]);
  const content = Array.isArray(nativeMessage.content) ? nativeMessage.content : [];
  for (const block of content) {
    markFields(protection.keyFields, block, ["content", "id", "input", "is_error", "name", "tool_use_id", "type"]);
    markFields(protection.valueFields, block, ["id", "tool_use_id", "type"]);
  }
  const event = object(params.event);
  markFields(protection.keyFields, event, ["content_block", "delta", "index", "type"]);
  markFields(protection.valueFields, event, ["type"]);
  markFields(protection.keyFields, event.delta, ["partial_json", "text", "thinking", "type"]);
  markFields(protection.valueFields, event.delta, ["type"]);
  markFields(protection.keyFields, event.content_block, ["id", "input", "name", "type"]);
  markFields(protection.valueFields, event.content_block, ["id", "type"]);
  const usage = object(params.usage);
  markFields(protection.keyFields, usage, ["cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens", "output_tokens", "server_tool_use"]);
  const messageUsage = object(nativeMessage.usage);
  markFields(protection.keyFields, messageUsage, ["cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens", "output_tokens", "server_tool_use"]);
  return protection;
}

function sanitizeJson(
  value: unknown,
  protection: JsonProtection,
  ancestors = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  if (value instanceof Error) return { name: scrubText(value.name), message: scrubText(value.message) };
  if (ancestors.has(value)) throw new TypeError("Claude SDK output contains a circular value.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((child) => sanitizeJson(child, protection, ancestors));
    const output: JsonObject = {};
    const protectedKeys = protection.keyFields.get(value);
    const protectedValues = protection.valueFields.get(value);
    for (const [key, child] of Object.entries(value)) {
      const outputKey = protectedKeys?.has(key) ? key : scrubText(key);
      output[outputKey] = typeof child === "string" && protectedValues?.has(key)
        ? child
        : sanitizeJson(child, protection, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function json(value: unknown): string {
  return JSON.stringify(sanitizeJson(value, protocolProtection(value)));
}

class RedactingLineWriter {
  private buffer = "";
  private droppingLine = false;

  write(value: string | Buffer): void {
    let incoming = value.toString();
    while (incoming.length > 0) {
      if (this.droppingLine) {
        const newline = incoming.indexOf("\n");
        if (newline < 0) return;
        this.droppingLine = false;
        incoming = incoming.slice(newline + 1);
        continue;
      }
      const newline = incoming.indexOf("\n");
      const fragment = newline < 0 ? incoming : incoming.slice(0, newline + 1);
      if (this.buffer.length + fragment.length > 65_536) {
        // An unbounded line cannot be emitted safely because a credential may
        // straddle any chosen chunk boundary. Drop it through its newline.
        this.buffer = "";
        this.droppingLine = newline < 0;
      } else {
        this.buffer += fragment;
        if (newline >= 0) {
          process.stderr.write(scrubText(this.buffer));
          this.buffer = "";
        }
      }
      if (newline < 0) return;
      incoming = incoming.slice(newline + 1);
    }
  }

  end(): void {
    if (!this.droppingLine && this.buffer.length > 0) process.stderr.write(scrubText(this.buffer));
    this.buffer = "";
    this.droppingLine = false;
  }
}

function send(value: unknown): void {
  process.stdout.write(`${json(value)}\n`);
}

function errorMessage(error: unknown): string {
  return scrubText(error instanceof Error ? error.message : String(error));
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function response(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id: string | number, error: unknown): void {
  send({ jsonrpc: "2.0", id, error: { code: -32_000, message: errorMessage(error) } });
}

/**
 * Owns one streaming-input Claude query outside the Symphony daemon. A host
 * mailbox serializes prompts, so in-flight steering can be accepted without
 * letting a later prompt race the current turn. The worker host durably spools
 * native output and fences every JSON-RPC mutation.
 */
export class ClaudeSdkHost {
  private options: Options | null = null;
  private sessionId: string | null = null;
  private active: ActiveQuery | null = null;
  private closed = false;
  private nativeProcess: ChildProcess | null = null;
  private nativeExit: Promise<void> | null = null;
  private readonly sdkStderr = new RedactingLineWriter();
  private nativeStderr: RedactingLineWriter | null = null;

  async request(message: JsonObject): Promise<void> {
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    const method = string(message.method);
    if (id === null || !method) return;
    try {
      const params = object(message.params);
      if (method === "session/start") {
        if (this.options || this.sessionId || this.active) throw new Error("Claude SDK host session is already initialized.");
        const prompt = string(params.prompt);
        if (!prompt) throw new Error("Claude SDK host start requires a prompt.");
        this.options = this.sdkOptions(object(params.options) as Options);
        const accepted = await this.startQuery(prompt, {
          requestId: string(params.requestId) ?? `claude:initial:${String(id)}`,
          contentHash: string(params.contentHash) ?? "",
        });
        response(id, { sessionId: accepted, queued: false });
        return;
      }
      if (method === "session/attach") {
        if (this.options || this.sessionId || this.active) throw new Error("Claude SDK host session is already initialized.");
        const sessionId = string(params.sessionId);
        if (!sessionId) throw new Error("Claude SDK host attach requires a native session id.");
        this.options = this.sdkOptions(object(params.options) as Options);
        this.sessionId = sessionId;
        response(id, { sessionId, attached: true });
        return;
      }
      if (method === "session/prompt") {
        const prompt = string(params.prompt);
        if (!prompt || !this.options || !this.sessionId) throw new Error("Claude SDK host session is not initialized.");
        const request = {
          requestId: string(params.requestId) ?? `claude:prompt:${String(id)}`,
          contentHash: string(params.contentHash) ?? "",
        };
        if (!this.active) {
          const accepted = await this.startQuery(prompt, request);
          response(id, { sessionId: accepted, queued: false, requestId: request.requestId, contentHash: request.contentHash });
          return;
        }
        if (this.active.cancelRequested) throw new Error("Claude SDK host session is being cancelled.");
        const fence = this.active.resultFence;
        if (fence?.terminal) {
          // The result has left the native process but has not yet been
          // projected by the daemon. Do not append a prompt behind a result
          // that will terminalize the Symphony turn. The controller reroutes
          // it through the durable follow-up queue after acknowledging result.
          await fence.acknowledged;
          response(id, { sessionId: this.sessionId, queued: true, terminalBoundary: true });
          return;
        }
        if (fence) {
          this.active.queued.push({ id, prompt, ...request });
          response(id, { sessionId: this.sessionId, queued: true, requestId: request.requestId, contentHash: request.contentHash });
          return;
        }
        if (this.active.turnActive) {
          this.active.queued.push({ id, prompt, ...request });
          response(id, { sessionId: this.sessionId, queued: true, requestId: request.requestId, contentHash: request.contentHash });
          return;
        }
        this.dispatch(this.active, prompt, request);
        response(id, { sessionId: this.sessionId, queued: false, requestId: request.requestId, contentHash: request.contentHash });
        return;
      }
      if (method === "session/cancel") {
        const active = this.active;
        if (active?.resultFence?.terminal) {
          await active.resultFence.acknowledged;
          response(id, { sessionId: this.sessionId, cancelled: false, terminalBoundary: true, queuedDiscarded: 0 });
          return;
        }
        if (active?.resultFence) await active.resultFence.acknowledged;
        const queuedDiscarded = active?.queued.length ?? 0;
        const activeCancelled = active?.turnActive === true;
        if (active) {
          active.queued.length = 0;
          active.cancelRequested = true;
          let cancellationProved = !activeCancelled;
          if (activeCancelled) {
            const interrupted = await this.interruptWithinDeadline(active);
            if (interrupted) cancellationProved = true;
          }
          active.mailbox.close();
          active.query.close();
          if (!cancellationProved) cancellationProved = await this.nativeTerminationWithinDeadline();
          if (!cancellationProved) {
            throw new Error("Claude SDK interrupt was not acknowledged and native process termination could not be proved.");
          }
          if (this.active === active) this.active = null;
        }
        const cancelled = Boolean(active);
        if (cancelled) {
          send({
            jsonrpc: "2.0",
            method: "claude/cancelled",
            params: { sessionId: this.sessionId, queuedDiscarded, activeCancelled },
          });
        }
        response(id, { sessionId: this.sessionId, cancelled, queuedDiscarded });
        return;
      }
      if (method === "session/result-ack") {
        const active = this.active;
        const generation = typeof params.generation === "number" && Number.isSafeInteger(params.generation)
          ? params.generation
          : null;
        const fence = active?.resultFence;
        if (!active || !fence || generation !== fence.generation) {
          throw new Error(`Claude result acknowledgement did not match the pending turn generation ${String(fence?.generation ?? "none")}.`);
        }
        active.resultFence = null;
        fence.acknowledge();
        if (!fence.terminal && !active.cancelRequested) {
          const next = active.queued.shift();
          if (next) this.dispatch(active, next.prompt, next);
        }
        response(id, { sessionId: this.sessionId, generation, acknowledged: true });
        return;
      }
      if (method === "session/status") {
        response(id, {
          sessionId: this.sessionId,
          running: this.active?.turnActive === true,
          queued: this.active?.queued.length ?? 0,
        });
        return;
      }
      throw new Error(`Unsupported Claude SDK host method: ${method}`);
    } catch (error) {
      failure(id, error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.active) {
      this.active.queued.length = 0;
      this.active.cancelRequested = true;
      this.active.mailbox.close();
      this.active.query.close();
      this.active = null;
    }
    this.sdkStderr.end();
    this.nativeStderr?.end();
  }

  private startQuery(prompt: string, request: { requestId: string; contentHash: string }): Promise<string> {
    if (!this.options) return Promise.reject(new Error("Claude SDK host options are unavailable."));
    if (this.active) return Promise.reject(new Error("Claude SDK host query is already running."));
    let resolveAcceptance!: (sessionId: string) => void;
    let rejectAcceptance!: (error: Error) => void;
    let resolveCompletion!: () => void;
    const acceptance = new Promise<string>((resolve, reject) => {
      resolveAcceptance = resolve;
      rejectAcceptance = reject;
    });
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const mailbox = new AsyncMailbox<SDKUserMessage>();
    const runningQuery = query({
      prompt: mailbox,
      options: { ...this.options, ...(this.sessionId ? { resume: this.sessionId } : {}) },
    });
    const active: ActiveQuery = {
      query: runningQuery,
      mailbox,
      queued: [],
      turnActive: false,
      acceptance,
      resolveAcceptance,
      rejectAcceptance,
      accepted: false,
      completion,
      resolveCompletion,
      cancelRequested: false,
      turnGeneration: 0,
      currentRequest: null,
      resultFence: null,
    };
    this.active = active;
    this.dispatch(active, prompt, request);
    void this.consume(active);
    return acceptance;
  }

  private dispatch(active: ActiveQuery, prompt: string, request: { requestId: string; contentHash: string }): void {
    if (active.turnActive) throw new Error("Claude SDK host cannot dispatch concurrent turns.");
    if (active.resultFence) throw new Error("Claude SDK host cannot dispatch before the previous result is acknowledged.");
    active.turnActive = true;
    active.turnGeneration += 1;
    active.currentRequest = request;
    active.mailbox.push({
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    });
  }

  private async consume(active: ActiveQuery): Promise<void> {
    try {
      for await (const message of active.query) {
        const sessionId = this.messageSessionId(message);
        if (sessionId) {
          if (this.sessionId && this.sessionId !== sessionId) {
            throw new Error(`Claude SDK session identity changed from ${this.sessionId} to ${sessionId}.`);
          }
          this.sessionId = sessionId;
          if (!active.accepted) {
            active.accepted = true;
            active.resolveAcceptance(sessionId);
          }
        }
        if (active.cancelRequested) continue;
        if (message.type !== "result") {
          send({ jsonrpc: "2.0", method: "claude/message", params: message });
          continue;
        }
        if (!active.turnActive) throw new Error("Claude SDK returned a result without an active prompt.");
        active.turnActive = false;
        const successful = message.subtype === "success" && message.is_error !== true;
        if (!successful) active.queued.length = 0;
        let acknowledge!: () => void;
        const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
        const queuedPrompts = active.queued.length;
        active.resultFence = {
          generation: active.turnGeneration,
          terminal: !successful || queuedPrompts === 0,
          acknowledged,
          acknowledge,
        };
        send({
          jsonrpc: "2.0",
          method: "claude/message",
          params: {
            ...message,
            __symphonyQueuedPrompts: queuedPrompts,
            __symphonyTurnGeneration: active.turnGeneration,
            __symphonyMessageRequestId: active.currentRequest?.requestId ?? null,
            __symphonyMessageContentHash: active.currentRequest?.contentHash ?? null,
          },
        });
      }
      if (!active.accepted) active.rejectAcceptance(new Error("Claude SDK query ended without native session identity evidence."));
      if (!active.cancelRequested && !this.closed) throw new Error("Claude SDK streaming query ended unexpectedly.");
    } catch (error) {
      if (!active.accepted) active.rejectAcceptance(error instanceof Error ? error : new Error(String(error)));
      if (!active.cancelRequested) {
        send({
          jsonrpc: "2.0",
          method: "claude/error",
          params: { error: errorMessage(error), sessionId: this.sessionId },
        });
      }
    } finally {
      if (this.active === active) this.active = null;
      this.sdkStderr.end();
      active.resolveCompletion();
    }
  }

  private sdkOptions(supplied: Options): Options {
    const environment = scrubbedEnvironment({ ...process.env, ...object(supplied.env) as NodeJS.ProcessEnv });
    delete environment.DEBUG_CLAUDE_AGENT_SDK;
    delete environment.DEBUG_SDK;
    this.captureSensitiveValues(environment);
    return {
      ...supplied,
      env: environment,
      stderr: (data: string) => { this.sdkStderr.write(data); },
      spawnClaudeCodeProcess: (options) => {
        const child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const nativeStderr = new RedactingLineWriter();
        this.nativeStderr = nativeStderr;
        child.stderr.on("data", (chunk: Buffer | string) => { nativeStderr.write(chunk); });
        child.stderr.once("end", () => nativeStderr.end());
        this.nativeProcess = child;
        this.nativeExit = new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        });
        return child;
      },
    };
  }

  private async interruptWithinDeadline(active: ActiveQuery): Promise<boolean> {
    return await this.operationWithinDeadline(active.query.interrupt(), interruptDeadlineMs);
  }

  private async nativeTerminationWithinDeadline(): Promise<boolean> {
    const child = this.nativeProcess;
    if (!child) return false;
    if (child.exitCode !== null || child.signalCode !== null) return true;
    if (!this.nativeExit) return false;
    return await this.operationWithinDeadline(this.nativeExit, terminationProofDeadlineMs);
  }

  private async operationWithinDeadline(operation: Promise<unknown>, deadlineMs: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(false), deadlineMs);
      timer.unref();
      void operation.then(() => finish(true), () => finish(false));
    });
  }

  private messageSessionId(message: SDKMessage): string | null {
    return "session_id" in message ? string(message.session_id) : null;
  }

  private captureSensitiveValues(environment: NodeJS.ProcessEnv | undefined): void {
    if (!environment) return;
    for (const [name, value] of Object.entries(environment)) {
      if (!value) continue;
      if (sensitiveEnvironmentName(name) || containsEmbeddedUrlCredential(value)) {
        sensitiveValues.add(value);
      }
    }
  }
}

async function main(): Promise<void> {
  const host = new ClaudeSdkHost();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude SDK host request must be an object.");
      void host.request(parsed as JsonObject);
    } catch (error) {
      send({ jsonrpc: "2.0", method: "claude/error", params: { error: errorMessage(error) } });
    }
  });
  const close = () => { void host.close().finally(() => process.exit(0)); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
