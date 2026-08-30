import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.env.SYMPHONY_CURSOR_FIXTURE_ROOT;
if (!root) throw new Error("SYMPHONY_CURSOR_FIXTURE_ROOT is required.");
mkdirSync(root, { recursive: true });

const agents = new Map();
let runOrdinal = 0;

export const Cursor = {
  auth: {
    async status() {
      return { status: "logged-in", backendUrl: "https://fixture.cursor.invalid", email: "fixture@example.invalid" };
    },
    async login() {
      return { apiKey: "fixture-key", email: "fixture@example.invalid", apiKeyExpiresAtMs: Date.now() + 60_000 };
    },
  },
  models: {
    async list() {
      return [{
        id: "fixture-model",
        displayName: "Cursor fixture model",
        description: "Deterministic Cursor SDK fixture model",
        aliases: [],
        parameters: [],
        variants: [],
      }];
    },
  },
};

function append(name, value) {
  appendFileSync(join(root, name), `${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FixtureRun {
  constructor(agentId, prompt, options) {
    this.agentId = agentId;
    this.id = `fixture-cursor-run-${++runOrdinal}`;
    this.requestId = options.idempotencyKey;
    this.model = options.model;
    this._status = "running";
    this._listeners = new Set();
    this._prompt = prompt;
    this._result = undefined;
    this._completion = this.completeLater();
    append(".fixture-cursor-dispatches", {
      agentId,
      runId: this.id,
      prompt,
      idempotencyKey: options.idempotencyKey,
      model: options.model ?? null,
    });
  }

  async completeLater() {
    await delay(Number(process.env.SYMPHONY_CURSOR_FIXTURE_DELAY_MS ?? "180"));
    if (this._status === "running") {
      this._status = "finished";
      this._result = `completed:${this._prompt}`;
      for (const listener of this._listeners) listener(this._status);
    }
    return {
      id: this.id,
      requestId: this.requestId,
      status: this._status,
      ...(this._result ? { result: this._result } : {}),
      model: this.model,
      usage: { inputTokens: 4, outputTokens: 5 },
    };
  }

  supports() { return true; }
  unsupportedReason() { return undefined; }
  async *stream() {
    yield { type: "system", subtype: "init", agent_id: this.agentId, run_id: this.id, model: this.model, tools: ["read", "mcp"] };
    yield { type: "assistant", agent_id: this.agentId, run_id: this.id, message: { role: "assistant", content: [{ type: "text", text: `stream:${this._prompt}` }] } };
    await this._completion;
  }
  conversation() { return Promise.resolve([]); }
  wait() { return this._completion; }
  async cancel() {
    if (this._status !== "running") return;
    this._status = "cancelled";
    for (const listener of this._listeners) listener(this._status);
  }
  get status() { return this._status; }
  onDidChangeStatus(listener) { this._listeners.add(listener); return () => this._listeners.delete(listener); }
  get result() { return this._result; }
  get error() { return undefined; }
  get durationMs() { return undefined; }
  get usage() { return undefined; }
  get git() { return undefined; }
  get createdAt() { return Date.now(); }
}

class FixtureAgent {
  constructor(agentId, options) {
    this.agentId = agentId;
    this.model = options.model;
    this._runs = new Map();
    this._idempotency = new Map();
    append(".fixture-cursor-agents", { agentId, optionsApiKey: options.apiKey ?? null, environmentApiKey: process.env.CURSOR_API_KEY ?? null, model: options.model ?? null });
  }
  async send(message, options = {}) {
    const key = options.idempotencyKey;
    if (key && this._idempotency.has(key)) return this._idempotency.get(key);
    if (process.env.SYMPHONY_CURSOR_FIXTURE_BLOCK_INITIAL === "1" && runOrdinal === 0) {
      append(".fixture-cursor-send-entered", options.idempotencyKey ?? "missing");
      const release = join(root, ".fixture-cursor-release-initial");
      while (!existsSync(release)) await delay(10);
    }
    if (process.env.SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_BEFORE_ACCEPT === "1" && runOrdinal === 1) {
      append(".fixture-cursor-followup-entered", options.idempotencyKey ?? "missing");
      const release = join(root, ".fixture-cursor-release-followup-before-accept");
      while (!existsSync(release)) await delay(10);
    }
    const run = new FixtureRun(this.agentId, typeof message === "string" ? message : message.text, options);
    this._runs.set(run.id, run);
    if (key) this._idempotency.set(key, run);
    this.model = options.model ?? this.model;
    if (process.env.SYMPHONY_CURSOR_FIXTURE_BLOCK_FOLLOWUP_AFTER_ACCEPT === "1" && run.id === "fixture-cursor-run-2") {
      append(".fixture-cursor-followup-accepted", run.id);
      const release = join(root, ".fixture-cursor-release-followup");
      while (!existsSync(release)) await delay(10);
    }
    return run;
  }
  close() {}
  reload() { return Promise.resolve(); }
  [Symbol.asyncDispose]() { return Promise.resolve(); }
  listArtifacts() { return Promise.resolve([]); }
  downloadArtifact() { return Promise.reject(new Error("fixture artifact unavailable")); }
  getUsage() { return Promise.resolve({ runs: [] }); }
}

export class Agent {
  static async create(options) {
    if (process.env.SYMPHONY_CURSOR_FIXTURE_EMIT_API_KEY_STDERR === "1" && options.apiKey) {
      const splitAt = Math.max(1, Math.floor(options.apiKey.length / 2));
      process.stderr.write(`fixture Cursor SDK credential=x${options.apiKey.slice(0, splitAt)}`);
      await delay(10);
      process.stderr.write(`${options.apiKey.slice(splitAt)}x\n`);
    }
    const agentId = options.agentId ?? `bc-fixture-agent-${agents.size + 1}`;
    const existing = agents.get(agentId);
    if (existing) return existing;
    const agent = new FixtureAgent(agentId, options);
    agents.set(agentId, agent);
    return agent;
  }
  static async resume(agentId, options = {}) {
    return agents.get(agentId) ?? Agent.create({ ...options, agentId });
  }
  static async getRun(runId) {
    for (const agent of agents.values()) {
      const run = agent._runs.get(runId);
      if (run) return run;
    }
    throw new Error(`Unknown fixture Cursor run: ${runId}`);
  }
}
