#!/usr/bin/env node
import type {
  AgentOptions,
  Run,
  RunResult,
  SDKAgent,
  SendOptions,
} from "@cursor/sdk";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;
type CursorSdk = {
  Agent: {
    create(options: AgentOptions): Promise<SDKAgent>;
    resume(agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent>;
    getRun(runId: string, options?: JsonObject): Promise<Run>;
  };
};
type EffectiveModel = {
  mode: "auto" | "explicit" | "resolved-auto";
  id: string | null;
  params: Array<{ id: string; value: string }>;
};
type QueuedPrompt = {
  prompt: string;
  requestId: string;
  contentHash: string;
  effectiveModel: EffectiveModel;
  sendOptions: SendOptions;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
};
type ResultFence = {
  generation: number;
  runId: string;
  terminal: boolean;
  acknowledged: Promise<void>;
  acknowledge: () => void;
};
type ActiveRun = {
  run: Run;
  runId: string;
  requestId: string;
  contentHash: string;
  generation: number;
  completion: Promise<RunResult>;
  resolveCompletion: (result: RunResult) => void;
  rejectCompletion: (error: Error) => void;
  resultFence: ResultFence | null;
};
type QueuedDispatch = {
  acceptance: Promise<ActiveRun>;
};

const sensitiveValues = new Set<string>();

function sensitiveEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return [
    "SYMPHONY_DAEMON_SECRET",
    "SYMPHONY_AGENT_TOKEN",
    "CURSOR_API_KEY",
    "DATABASE_URL",
    "PGPASSWORD",
    "REDISCLI_AUTH",
    "GITHUB_PAT",
  ].includes(normalized)
    || /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|PAT|AUTH)(?:_|$)/u.test(normalized);
}

function rememberSecrets(value: unknown, key = ""): void {
  if (typeof value === "string") {
    if (sensitiveEnvironmentName(key) && value.length >= 4) sensitiveValues.add(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rememberSecrets(item, key);
    return;
  }
  for (const [childKey, childValue] of Object.entries(value as JsonObject)) rememberSecrets(childValue, childKey);
}

for (const [name, value] of Object.entries(process.env)) {
  if (value && sensitiveEnvironmentName(name) && value.length >= 4) sensitiveValues.add(value);
}

function scrubText(value: string): string {
  let result = value;
  for (const secret of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, child]) => [scrubText(key), scrubValue(child)]));
}

const rawStderrWrite = process.stderr.write.bind(process.stderr);

class RedactingLineWriter {
  private buffer = "";
  private droppingLine = false;

  write(value: string | Uint8Array, encoding?: BufferEncoding): void {
    let incoming = typeof value === "string" ? value : Buffer.from(value).toString(encoding);
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
        // Do not emit arbitrary chunks from an unbounded diagnostic line: a
        // controlled API key may straddle any chosen chunk boundary.
        this.buffer = "";
        this.droppingLine = newline < 0;
      } else {
        this.buffer += fragment;
        if (newline >= 0) {
          rawStderrWrite(scrubText(this.buffer));
          this.buffer = "";
        }
      }
      if (newline < 0) return;
      incoming = incoming.slice(newline + 1);
    }
  }

  end(): void {
    if (!this.droppingLine && this.buffer.length > 0) rawStderrWrite(scrubText(this.buffer));
    this.buffer = "";
    this.droppingLine = false;
  }
}

const protectedStderr = new RedactingLineWriter();
process.stderr.write = ((
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
): boolean => {
  protectedStderr.write(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined);
  const completed = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
  if (completed) queueMicrotask(() => completed(null));
  return true;
}) as typeof process.stderr.write;

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(scrubValue(value))}\n`);
}

function response(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id: string | number, error: unknown): void {
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32_000, message: scrubText(error instanceof Error ? error.message : String(error)) },
  });
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sameModel(left: EffectiveModel | null, right: EffectiveModel): boolean {
  return Boolean(left && JSON.stringify(left) === JSON.stringify(right));
}

async function loadSdk(): Promise<CursorSdk> {
  const fixture = process.env.SYMPHONY_CURSOR_HOST_SDK_MODULE;
  const imported = fixture
    ? await import(pathToFileURL(fixture).href)
    : await import("@cursor/sdk");
  return imported as unknown as CursorSdk;
}

class CursorHost {
  private readonly sdk: Promise<CursorSdk>;
  private agent: SDKAgent | null = null;
  private agentId: string | null = null;
  private active: ActiveRun | null = null;
  private readonly queued: QueuedPrompt[] = [];
  private generation = 0;
  private effectiveModel: EffectiveModel | null = null;
  private initialRequestId: string | null = null;
  private initialResult: JsonObject | null = null;
  private initialPromise: Promise<JsonObject> | null = null;
  private readonly promptRequests = new Map<string, { contentHash: string; promise: Promise<JsonObject> }>();
  private readonly acknowledgedResults = new Set<string>();
  private queuedDispatch: QueuedDispatch | null = null;
  private closed = false;

  constructor() {
    this.sdk = loadSdk();
  }

  async handle(message: JsonObject): Promise<void> {
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    if (id === null) return;
    try {
      const method = string(message.method);
      const params = object(message.params);
      rememberSecrets(params);
      if (method === "session/start") {
        const requestId = string(params.requestId) ?? String(id);
        if (this.initialRequestId && this.initialRequestId !== requestId) {
          throw new Error("Cursor host already owns a different initial dispatch.");
        }
        if (this.initialResult) {
          response(id, this.initialResult);
          return;
        }
        this.initialRequestId = requestId;
        this.initialPromise ??= this.startInitial(params, requestId);
        response(id, await this.initialPromise);
        return;
      }
      if (method === "session/attach") {
        const sessionId = string(params.sessionId);
        if (!sessionId) throw new Error("Cursor session identity is required for attach.");
        const effectiveModel = object(params.effectiveModel) as EffectiveModel;
        if (!this.agent) {
          const sdk = await this.sdk;
          this.agent = await sdk.Agent.resume(sessionId, object(params.options) as Partial<AgentOptions>);
          this.agentId = this.agent.agentId;
          const nativeRunId = string(params.runId);
          if (nativeRunId) {
            const run = await sdk.Agent.getRun(nativeRunId, object(params.runOptions));
            if (run.status === "running") {
              this.watch(run, integer(params.generation) ?? 1, string(params.requestId) ?? nativeRunId, string(params.contentHash) ?? "");
            }
          }
        }
        if (this.agentId !== sessionId) throw new Error(`Cursor session identity changed from ${sessionId} to ${String(this.agentId)}.`);
        if (this.active?.run.status === "running" && this.effectiveModel && !sameModel(this.effectiveModel, effectiveModel)) {
          throw new Error("Cursor effective model changed while a native run is active; refusing to attach with ambiguous model state.");
        }
        this.effectiveModel = effectiveModel;
        response(id, this.status());
        return;
      }
      if (method === "session/prompt") {
        if (!this.agent || !this.agentId) throw new Error("Cursor host session is not initialized.");
        const prompt = string(params.prompt);
        const requestId = string(params.requestId) ?? String(id);
        const contentHash = string(params.contentHash) ?? "";
        if (!prompt) throw new Error("Cursor follow-up prompt is required.");
        let delivery = this.promptRequests.get(requestId);
        if (delivery && delivery.contentHash !== contentHash) {
          throw new Error("Cursor host rejected a reused request id with different content.");
        }
        if (!delivery) {
          const promise = this.dispatchPrompt(prompt, requestId, contentHash, object(params.effectiveModel) as EffectiveModel);
          delivery = { contentHash, promise };
          this.promptRequests.set(requestId, delivery);
        }
        response(id, await delivery.promise);
        return;
      }
      if (method === "session/result-ack") {
        const generation = integer(params.generation);
        const runId = string(params.runId);
        const active = this.active;
        const fence = active?.resultFence;
        const acknowledgementKey = `${String(runId)}:${String(generation)}`;
        if (this.acknowledgedResults.has(acknowledgementKey)) {
          response(id, { agentId: this.agentId, runId, generation, acknowledged: true, repeated: true });
          return;
        }
        if (!fence || generation !== fence.generation || runId !== fence.runId) {
          throw new Error(`Cursor result acknowledgement did not match pending run ${String(fence?.runId ?? "none")} generation ${String(fence?.generation ?? "none")}.`);
        }
        active.resultFence = null;
        fence.acknowledge();
        this.acknowledgedResults.add(acknowledgementKey);
        if (!fence.terminal) await this.dispatchNextQueued();
        response(id, { agentId: this.agentId, runId, generation, acknowledged: true });
        return;
      }
      if (method === "session/cancel") {
        const active = this.active;
        const queuedDispatch = this.queuedDispatch;
        if (!active && !queuedDispatch) {
          response(id, { agentId: this.agentId, cancelled: false });
          return;
        }
        const queued = this.queued.splice(0);
        for (const pending of queued) pending.reject(new Error("Cursor queued prompt was cancelled before dispatch."));
        if (queuedDispatch) {
          // A result ACK may already have dequeued the follow-up while
          // Agent.send is still awaiting provider acceptance. Follow that
          // transition to the accepted run and cancel it there; acknowledging
          // against the preceding finished run would let the queued prompt run
          // after Symphony reported cancellation.
          const dispatched = await queuedDispatch.acceptance;
          if (dispatched.run.status === "running") await dispatched.run.cancel();
          const result = await dispatched.completion;
          if (result.status !== "cancelled") {
            response(id, {
              agentId: this.agentId,
              runId: dispatched.runId,
              generation: dispatched.generation,
              cancelled: false,
              terminalBoundary: true,
              status: result.status,
            });
            return;
          }
          response(id, {
            agentId: this.agentId,
            runId: dispatched.runId,
            generation: dispatched.generation,
            cancelled: true,
            status: result.status,
            phase: "queued-dispatch-in-flight",
            queuedCancelled: queued.length,
          });
          return;
        }
        if (!active) {
          response(id, { agentId: this.agentId, cancelled: false });
          return;
        }
        if (active.resultFence?.terminal) {
          await active.resultFence.acknowledged;
          response(id, { agentId: this.agentId, runId: active.runId, cancelled: false, terminalBoundary: true });
          return;
        }
        const resultFence = active.resultFence;
        if (queued.length > 0 && resultFence) {
          // Mark the boundary synchronously before awaiting completion. A
          // concurrent result ACK must not clear the fence and strand the
          // controller without either a queued dispatch or terminal event.
          resultFence.terminal = true;
        }
        if (active.run.status === "running") await active.run.cancel();
        const result = await active.completion;
        if (queued.length > 0 && resultFence && result.status === "finished") {
          // The preceding run completed, but its result ACK had not yet opened
          // the queued-turn boundary. The queued native work is now proven not
          // to have been dispatched, so emit a terminal cancellation instead
          // of leaving the controller waiting for an impossible future event.
          send({
            jsonrpc: "2.0",
            method: "cursor/cancelled",
            params: {
              agentId: this.agentId,
              runId: active.runId,
              generation: active.generation,
              phase: "queued-turn-boundary",
              queuedCancelled: queued.length,
            },
          });
          response(id, {
            agentId: this.agentId,
            runId: active.runId,
            generation: active.generation,
            cancelled: true,
            terminalBoundary: true,
            queuedCancelled: queued.length,
          });
          return;
        }
        if (result.status !== "cancelled") {
          response(id, { agentId: this.agentId, runId: active.runId, cancelled: false, terminalBoundary: true, status: result.status });
          return;
        }
        response(id, { agentId: this.agentId, runId: active.runId, cancelled: true, status: result.status });
        return;
      }
      if (method === "session/status") {
        response(id, this.status());
        return;
      }
      throw new Error(`Unsupported Cursor SDK host method: ${String(method)}`);
    } catch (error) {
      failure(id, error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const queued of this.queued.splice(0)) queued.reject(new Error("Cursor SDK host closed."));
    this.agent?.close();
    this.agent = null;
  }

  private sendOptions(model: EffectiveModel): SendOptions {
    return model.id ? { model: { id: model.id, ...(model.params.length ? { params: model.params } : {}) } } : {};
  }

  private async startInitial(params: JsonObject, requestId: string): Promise<JsonObject> {
    const prompt = string(params.prompt);
    if (!prompt) throw new Error("Cursor initial prompt is required.");
    const options = object(params.options) as AgentOptions;
    const effectiveModel = object(params.effectiveModel) as EffectiveModel;
    const sdk = await this.sdk;
    this.agent = await sdk.Agent.create(options);
    this.agentId = this.agent.agentId;
    this.effectiveModel = effectiveModel;
    send({
      jsonrpc: "2.0",
      method: "cursor/session-created",
      params: { agentId: this.agentId, requestId, effectiveModel },
    });
    const run = await this.dispatch(prompt, requestId, this.sendOptions(effectiveModel), "");
    this.initialResult = { agentId: this.agentId, runId: run.runId, generation: run.generation };
    return this.initialResult;
  }

  private async dispatchPrompt(prompt: string, requestId: string, contentHash: string, effectiveModel: EffectiveModel): Promise<JsonObject> {
    const sendOptions = this.sendOptions(effectiveModel);
    if (this.active?.resultFence?.terminal) {
      const terminal = this.active;
      await terminal.resultFence?.acknowledged;
      return { agentId: this.agentId, runId: terminal.runId, generation: terminal.generation, queued: true, terminalBoundary: true };
    }
    if (this.active?.run.status === "running" || this.active?.resultFence) {
      return await new Promise<JsonObject>((resolve, reject) => {
        this.queued.push({ prompt, requestId, contentHash, effectiveModel, sendOptions, resolve, reject });
      });
    }
    this.effectiveModel = effectiveModel;
    const run = await this.dispatch(prompt, requestId, sendOptions, contentHash);
    return { agentId: this.agentId, runId: run.runId, requestId, contentHash, generation: run.generation, queued: false };
  }

  private status(): JsonObject {
    const active = this.active;
    return {
      agentId: this.agentId,
      runId: active?.runId ?? null,
      requestId: active?.requestId ?? null,
      generation: active?.generation ?? this.generation,
      status: active?.run.status ?? "idle",
      queued: this.queued.length,
      effectiveModel: this.effectiveModel,
    };
  }

  private async dispatch(prompt: string, requestId: string, sendOptions: SendOptions, contentHash: string): Promise<ActiveRun> {
    if (!this.agent || !this.agentId) throw new Error("Cursor agent is unavailable.");
    if (this.active?.run.status === "running" || this.active?.resultFence) throw new Error("Cursor host cannot dispatch concurrent runs.");
    const run = await this.agent.send(prompt, { ...sendOptions, idempotencyKey: requestId });
    this.generation += 1;
    return this.watch(run, this.generation, requestId, contentHash);
  }

  private watch(run: Run, generation: number, requestId: string, contentHash: string): ActiveRun {
    let resolveCompletion!: (result: RunResult) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<RunResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const active: ActiveRun = {
      run,
      runId: run.id,
      requestId,
      contentHash,
      generation,
      completion,
      resolveCompletion,
      rejectCompletion,
      resultFence: null,
    };
    this.active = active;
    send({ jsonrpc: "2.0", method: "cursor/run-started", params: { agentId: this.agentId, runId: run.id, requestId, contentHash, generation } });
    void this.consume(active);
    return active;
  }

  private async consume(active: ActiveRun): Promise<void> {
    try {
      for await (const message of active.run.stream()) {
        if (this.active !== active || this.closed) continue;
        send({ jsonrpc: "2.0", method: "cursor/message", params: { agentId: this.agentId, runId: active.runId, requestId: active.requestId, contentHash: active.contentHash, generation: active.generation, message } });
      }
      const result = await active.run.wait();
      active.resolveCompletion(result);
      if (this.active !== active || this.closed) return;
      const successful = result.status === "finished";
      if (!successful) {
        for (const queued of this.queued.splice(0)) queued.reject(new Error(`Cursor run ${active.runId} ended with ${result.status}.`));
      }
      let acknowledge!: () => void;
      const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
      active.resultFence = {
        generation: active.generation,
        runId: active.runId,
        terminal: !successful || this.queued.length === 0,
        acknowledged,
        acknowledge,
      };
      send({
        jsonrpc: "2.0",
        method: "cursor/result",
        params: {
          agentId: this.agentId,
          runId: active.runId,
          requestId: active.requestId,
          contentHash: active.contentHash,
          generation: active.generation,
          queuedPrompts: this.queued.length,
          result,
        },
      });
    } catch (error) {
      active.rejectCompletion(error instanceof Error ? error : new Error(String(error)));
      if (this.active === active && !this.closed) {
        for (const queued of this.queued.splice(0)) queued.reject(error instanceof Error ? error : new Error(String(error)));
        send({ jsonrpc: "2.0", method: "cursor/error", params: { agentId: this.agentId, runId: active.runId, generation: active.generation, error: error instanceof Error ? error.message : String(error) } });
      }
    }
  }

  private async dispatchNextQueued(): Promise<void> {
    const next = this.queued.shift();
    if (!next) return;
    let queuedDispatch: QueuedDispatch | null = null;
    try {
      this.effectiveModel = next.effectiveModel;
      const acceptance = this.dispatch(next.prompt, next.requestId, next.sendOptions, next.contentHash);
      queuedDispatch = { acceptance };
      this.queuedDispatch = queuedDispatch;
      const run = await acceptance;
      next.resolve({ agentId: this.agentId, runId: run.runId, requestId: next.requestId, contentHash: next.contentHash, generation: run.generation, queued: true });
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (queuedDispatch && this.queuedDispatch === queuedDispatch) this.queuedDispatch = null;
    }
  }
}

const host = new CursorHost();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message: JsonObject;
  try {
    message = JSON.parse(line) as JsonObject;
  } catch (error) {
    send({ jsonrpc: "2.0", error: { code: -32_700, message: error instanceof Error ? error.message : String(error) } });
    return;
  }
  void host.handle(message);
});

async function shutdown(): Promise<void> {
  input.close();
  await host.close();
  protectedStderr.end();
  process.exit(0);
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
