import type { SymphonyConfig } from "@symphony/config";
import {
  type DriverDoctorResult,
  type DriverEvent,
  type DriverSession,
  type DriverStartRequest,
  type ModelDescriptor,
  type JsonValue,
  type WorkerDriver,
} from "@symphony/protocol";
import { buildAgentPrompt, buildSymphonyOperatingContract, isConductor } from "./prompt.js";
import { JsonLineProcess, asObject, asString } from "./process.js";
import { capabilities, deepString, emit, makeSession, receipt, record, stringifyError, type Emit } from "./common.js";

type ActiveCodex = {
  rpc: JsonLineProcess;
  emit: Emit;
  threadId: string;
  turnId: string | null;
  pendingUsage: Record<string, unknown> | null;
  fullAccess: boolean;
  outputSchema: DriverStartRequest["workOrder"]["outputSchema"] | null;
};

export class CodexDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities({ cloud: false });
  private readonly active = new Map<string, ActiveCodex>();

  constructor(private readonly config: SymphonyConfig["harnesses"]["codex"]) {}

  async doctor(): Promise<DriverDoctorResult> {
    const version = await JsonLineProcess.probe(this.config.process.command);
    return {
      driver: this.id,
      available: this.config.enabled && version !== null,
      authenticated: null,
      version,
      capabilities: this.capabilities,
      detail: version ? "Codex app-server is available; authentication is verified when a thread starts." : "Codex executable was not found.",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const rpc = new JsonLineProcess(
      { command: this.config.process.command, args: this.config.process.args, cwd: process.cwd(), env: process.env },
      () => undefined,
    );
    try {
      await rpc.request("initialize", { clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" }, capabilities: {} });
      rpc.notify("initialized");
      const response = asObject(await rpc.request("model/list", { limit: 200 }));
      const entries = Array.isArray(response.data) ? response.data : Array.isArray(response.models) ? response.models : [];
      return entries.flatMap((value): ModelDescriptor[] => {
        const model = asObject(value);
        const id = asString(model.id) ?? asString(model.model);
        if (!id) return [];
        const contextTokens = typeof model.contextWindow === "number" ? model.contextWindow : typeof model.context_window === "number" ? model.context_window : undefined;
        return [{
          id,
          harness: this.id,
          name: asString(model.displayName) ?? asString(model.name) ?? id,
          description: asString(model.description) ?? "Model available through Codex app-server.",
          ...(contextTokens ? { contextTokens } : {}),
          modalities: ["text"],
          structuredOutput: true,
          pricing: {},
          metadata: {},
        }];
      });
    } catch {
      return [];
    } finally {
      rpc.close();
    }
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const rpc = this.spawn(request, onEvent);
    await rpc.request("initialize", {
      clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    const params = this.threadParams(request);
    const response = asObject(await rpc.request("thread/start", params));
    const thread = asObject(response.thread);
    const threadId = asString(thread.id) ?? asString(response.threadId);
    if (!threadId) throw new Error(`Codex did not return a thread id: ${JSON.stringify(response)}`);
    const active: ActiveCodex = {
      rpc,
      emit: onEvent,
      threadId,
      turnId: null,
      pendingUsage: null,
      fullAccess: request.workOrder.permissions === "full-access",
      outputSchema: isConductor(request.workOrder) ? null : strictCodexOutputSchema(request.workOrder.outputSchema),
    };
    this.active.set(threadId, active);
    const turnId = await this.startTurn(active, request, buildAgentPrompt(request.workOrder));
    emit(onEvent, "session.started", { threadId, turnId });
    return makeSession(this.id, threadId, { agentId: request.agentId }, turnId);
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const rpc = this.spawn(request, onEvent);
    await rpc.request("initialize", {
      clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    await rpc.request("thread/resume", { threadId: session.nativeSessionId, ...this.threadParams(request) });
    const active: ActiveCodex = {
      rpc,
      emit: onEvent,
      threadId: session.nativeSessionId,
      turnId: null,
      pendingUsage: null,
      fullAccess: request.workOrder.permissions === "full-access",
      outputSchema: isConductor(request.workOrder) ? null : strictCodexOutputSchema(request.workOrder.outputSchema),
    };
    this.active.set(session.nativeSessionId, active);
    emit(onEvent, "session.started", { threadId: session.nativeSessionId, resumed: true });
    return { ...session, state: "idle" };
  }

  async sendMessage(session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean }> {
    const active = this.require(session);
    if (active.turnId) {
      await active.rpc.request("turn/steer", {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        input: [{ type: "text", text: message, text_elements: [] }],
      });
      return receipt(false);
    }
    await this.startTurn(active, undefined, message);
    return receipt(false);
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    if (active.turnId) await active.rpc.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
  }

  async dispose(): Promise<void> {
    for (const active of this.active.values()) active.rpc.close();
    this.active.clear();
  }

  private spawn(request: DriverStartRequest, consumer: Emit): JsonLineProcess {
    let rpc: JsonLineProcess;
    rpc = new JsonLineProcess(
      {
        command: this.config.process.command,
        args: this.config.process.args,
        cwd: request.workOrder.workspace.path,
        env: process.env,
      },
      (message) => this.onNotification(message, consumer),
      async (message) => this.onServerRequest(message, request, consumer),
      (line) => emit(consumer, "log", { stream: "stderr", line }),
    );
    return rpc;
  }

  private threadParams(request: DriverStartRequest): Record<string, unknown> {
    const full = request.workOrder.permissions === "full-access";
    return {
      model: request.resolvedModel === "auto" ? null : request.resolvedModel,
      cwd: request.workOrder.workspace.path,
      approvalPolicy: "never",
      sandbox: full ? "danger-full-access" : "read-only",
      developerInstructions: buildSymphonyOperatingContract(request.workOrder, {
        agentId: request.agentId,
        canCreate: request.coordination.canCreate,
      }),
      config: {
        mcp_servers: {
          symphony: {
            command: request.coordination.mcpCommand,
            args: request.coordination.mcpArgs,
            env: {
              SYMPHONY_DAEMON_URL: request.coordination.daemonUrl,
              SYMPHONY_AGENT_ID: request.agentId,
              SYMPHONY_AGENT_TOKEN: request.coordination.token,
              SYMPHONY_AGENT_CAN_CREATE: String(request.coordination.canCreate),
            },
          },
        },
      },
    };
  }

  private async startTurn(active: ActiveCodex, request: DriverStartRequest | undefined, text: string): Promise<string> {
    const full = active.fullAccess;
    const params: Record<string, unknown> = {
      threadId: active.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: "never",
      sandboxPolicy: full ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: true },
    };
    if (active.outputSchema) params.outputSchema = active.outputSchema;
    if (request) {
      params.cwd = request.workOrder.workspace.path;
      params.model = request.resolvedModel === "auto" ? null : request.resolvedModel;
    }
    const response = asObject(await active.rpc.request("turn/start", params));
    const turnId = deepString(response, ["turn", "id"], ["turnId"]);
    if (!turnId) throw new Error(`Codex did not return a turn id: ${JSON.stringify(response)}`);
    active.turnId = turnId;
    emit(active.emit, "run.started", { threadId: active.threadId, turnId });
    return turnId;
  }

  private onNotification(message: Record<string, unknown>, consumer: Emit): void {
    const method = asString(message.method) ?? asString(message.type) ?? "unknown";
    const params = record(message.params ?? message);
    if (method.includes("tokenUsage/updated")) {
      const threadId = deepString(params, ["threadId"], ["thread", "id"]);
      const usage = record(record(params.tokenUsage).last ?? params.usage);
      const active = threadId
        ? this.active.get(threadId)
        : [...this.active.values()].find((candidate) => candidate.emit === consumer);
      if (active && Object.keys(usage).length) active.pendingUsage = usage;
    } else if (method.includes("turn/completed")) {
      const threadId = deepString(params, ["threadId"], ["thread", "id"]);
      if (threadId) {
        const active = this.active.get(threadId);
        if (active?.pendingUsage) {
          emit(consumer, "usage.recorded", { usage: active.pendingUsage, basis: "harness-reported" });
          active.pendingUsage = null;
        }
        if (active) active.turnId = null;
      }
      emit(consumer, "run.completed", params, deepString(params, ["turn", "id"]));
    } else if (method.includes("turn/failed") || method.includes("error")) {
      emit(consumer, "run.failed", params);
    } else if (method.includes("agentMessage") && method.includes("delta")) {
      const text = deepString(params, ["delta"], ["text"], ["item", "delta"], ["item", "textDelta"]);
      if (text) emit(consumer, "message.delta", { text, messageId: deepString(params, ["itemId"], ["item", "id"]) ?? null });
    } else if (method.includes("reasoning") && method.includes("delta")) {
      const text = deepString(params, ["delta"], ["text"], ["item", "delta"], ["item", "textDelta"]);
      if (text) emit(consumer, "reasoning.delta", { text });
    } else if (method.includes("command") || method.includes("tool")) {
      emit(consumer, method.includes("completed") ? "tool.completed" : "tool.updated", { method, ...params });
    } else if (method.includes("item/completed")) {
      const text = deepString(params, ["item", "text"], ["item", "content"], ["text"]);
      const item = record(params.item);
      const phase = asString(item.phase);
      emit(consumer, text ? "message.completed" : "tool.completed", params);
      if (text && phase !== "commentary") emit(consumer, "output.completed", { text });
    } else {
      emit(consumer, "log", { method, params });
    }
  }

  private async onServerRequest(message: Record<string, unknown>, request: DriverStartRequest, consumer: Emit): Promise<unknown> {
    const method = asString(message.method) ?? "unknown";
    emit(consumer, "approval.requested", { method, params: message.params ?? null });
    const allowed = request.workOrder.permissions === "full-access";
    if (method.includes("requestApproval") || method.includes("approval")) {
      return { decision: allowed ? "accept" : "decline" };
    }
    throw new Error(`Unsupported Codex server request: ${method}`);
  }

  private require(session: DriverSession): ActiveCodex {
    const active = this.active.get(session.nativeSessionId);
    if (!active) throw new Error(`Codex session is not active: ${session.nativeSessionId}`);
    return active;
  }
}

const UNSUPPORTED_STRICT_SCHEMA_KEYS = new Set(["$schema", "default", "examples"]);

/**
 * Codex app-server forwards outputSchema to OpenAI Structured Outputs, whose
 * strict subset requires closed objects and every declared property in
 * `required`. Symphony still validates the native result against the original
 * workflow schema, so this adapter may safely make generation more restrictive.
 */
export function strictCodexOutputSchema(schema: Record<string, JsonValue>): Record<string, JsonValue> {
  return normalizeStrictSchemaValue(schema) as Record<string, JsonValue>;
}

function normalizeStrictSchemaValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalizeStrictSchemaValue);
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, JsonValue>;
  const normalized: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(source)) {
    if (UNSUPPORTED_STRICT_SCHEMA_KEYS.has(key)) continue;
    normalized[key] = normalizeStrictSchemaValue(child);
  }

  const objectLike = source.type === "object" || (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties));
  if (objectLike) {
    const properties = source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
      ? normalizeStrictSchemaValue(source.properties) as Record<string, JsonValue>
      : {};
    normalized.properties = properties;
    normalized.required = Object.keys(properties);
    normalized.additionalProperties = false;
  }
  return normalized;
}
