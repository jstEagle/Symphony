import type { SymphonyConfig } from "@symphony/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "@symphony/protocol";
import { buildAgentPrompt } from "./prompt.js";
import { JsonLineProcess, asObject, asString } from "./process.js";
import { capabilities, deepString, emit, makeSession, receipt, record, type Emit } from "./common.js";

type ActivePi = { rpc: JsonLineProcess; emit: Emit; running: boolean; outputText: string; usage: unknown };

export class PiDriver implements WorkerDriver {
  readonly id = "pi" as const;
  readonly capabilities = capabilities({ cloud: false });
  private readonly active = new Map<string, ActivePi>();

  constructor(private readonly config: SymphonyConfig["harnesses"]["pi"]) {}

  async doctor(): Promise<DriverDoctorResult> {
    const spec = this.processSpec();
    const version = await JsonLineProcess.probe(spec.command, [...spec.prefixArgs, "--version"]);
    return {
      driver: this.id,
      available: this.config.enabled && version !== null,
      authenticated: null,
      version,
      capabilities: this.capabilities,
      detail: version ? "Pi RPC mode is available; provider authentication is verified on prompt." : "Pi executable was not found.",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const spec = this.processSpec();
    const rpc = new JsonLineProcess(
      { command: spec.command, args: [...spec.prefixArgs, ...this.config.process.args], cwd: process.cwd(), env: process.env },
      () => undefined,
    );
    try {
      const response = this.responseData(await rpc.command("get_available_models"));
      const models = Array.isArray(response.models) ? response.models : [];
      return models.flatMap((value): ModelDescriptor[] => {
        const model = record(value);
        const id = asString(model.id);
        const provider = asString(model.provider);
        if (!id || !provider) return [];
        const cost = record(model.cost);
        return [{
          id: `${provider}/${id}`,
          harness: this.id,
          name: asString(model.name) ?? id,
          description: `${provider} model configured in the native Pi harness.`,
          ...(typeof model.contextWindow === "number" ? { contextTokens: model.contextWindow } : {}),
          modalities: Array.isArray(model.input) ? model.input.filter((item): item is string => typeof item === "string") : ["text"],
          structuredOutput: false,
          pricing: {
            ...(typeof cost.input === "number" ? { inputPerMillion: cost.input } : {}),
            ...(typeof cost.output === "number" ? { outputPerMillion: cost.output } : {}),
          },
          metadata: {
            provider,
            api: asString(model.api) ?? "unknown",
            reasoning: model.reasoning === true,
            maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : null,
          },
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
    const state = this.responseData(await rpc.command("get_state"));
    const sessionId = asString(state.sessionId) ?? asString(state.sessionFile) ?? request.agentId;
    const active: ActivePi = { rpc, emit: onEvent, running: true, outputText: "", usage: null };
    this.active.set(sessionId, active);
    emit(onEvent, "session.started", { sessionId, sessionFile: state.sessionFile ?? null });
    void rpc.command("prompt", { message: buildAgentPrompt(request.workOrder) }, 0).catch((error) => {
      emit(onEvent, "run.failed", { error: error instanceof Error ? error.message : String(error) });
    });
    return makeSession(this.id, sessionId, {
      agentId: request.agentId,
      sessionFile: typeof state.sessionFile === "string" ? state.sessionFile : null,
    });
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const rpc = this.spawn(request, onEvent);
    const sessionFile = typeof session.metadata.sessionFile === "string" ? session.metadata.sessionFile : undefined;
    if (sessionFile) await rpc.command("switch_session", { sessionPath: sessionFile });
    const active: ActivePi = { rpc, emit: onEvent, running: false, outputText: "", usage: null };
    this.active.set(session.nativeSessionId, active);
    emit(onEvent, "session.started", { sessionId: session.nativeSessionId, resumed: true });
    return { ...session, state: "idle" };
  }

  async sendMessage(session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean }> {
    const active = this.require(session);
    if (active.running) {
      active.rpc.send({ type: "steer", message });
      return receipt(false);
    }
    active.running = true;
    active.outputText = "";
    active.usage = null;
    void active.rpc.command("prompt", { message }, 0).catch((error) => {
      emit(active.emit, "run.failed", { error: error instanceof Error ? error.message : String(error) });
    });
    return receipt(false);
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    await active.rpc.command("abort");
  }

  async dispose(): Promise<void> {
    for (const active of this.active.values()) active.rpc.close();
    this.active.clear();
  }

  private spawn(request: DriverStartRequest, consumer: Emit): JsonLineProcess {
    const spec = this.processSpec();
    const args = [...spec.prefixArgs, ...this.config.process.args];
    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const builtExtension = resolve(sourceDirectory, "pi-extension.js");
    const sourceExtension = resolve(sourceDirectory, "pi-extension.ts");
    const extension = existsSync(builtExtension) ? builtExtension : sourceExtension;
    if (existsSync(extension)) args.push("--extension", extension);
    if (request.workOrder.permissions === "read-only") {
      const coordinationTools = ["list_agents", "send_message", "observe_agent", "cancel_agent", "present_ui", "list_workflows", "list_plugin_tools"];
      if (request.coordination.canCreate) coordinationTools.push("create_agent");
      args.push("--tools", ["read", "grep", "find", "ls", ...coordinationTools].join(","));
    }
    if (request.resolvedModel !== "auto") args.push("--model", request.resolvedModel);
    return new JsonLineProcess(
      {
        command: spec.command,
        args,
        cwd: request.workOrder.workspace.path,
        env: {
          ...process.env,
          SYMPHONY_DAEMON_URL: request.coordination.daemonUrl,
          SYMPHONY_AGENT_ID: request.agentId,
          SYMPHONY_AGENT_TOKEN: request.coordination.token,
          SYMPHONY_AGENT_CAN_CREATE: String(request.coordination.canCreate),
        },
      },
      (message) => this.onMessage(message, consumer),
      undefined,
      (line) => emit(consumer, "log", { stream: "stderr", line }),
    );
  }

  private processSpec(): { command: string; prefixArgs: string[] } {
    if (this.config.process.command !== "pi") return { command: this.config.process.command, prefixArgs: [] };
    try {
      const modulePath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
      const bundled = resolve(dirname(modulePath), "bundle", "cli.js");
      if (existsSync(bundled)) return { command: process.execPath, prefixArgs: [bundled] };
    } catch {
      // Fall back to PATH for globally-installed Pi.
    }
    return { command: "pi", prefixArgs: [] };
  }

  private onMessage(message: Record<string, unknown>, consumer: Emit): void {
    const type = asString(message.type) ?? "unknown";
    if (type === "agent_start") emit(consumer, "run.started", message);
    else if (type === "agent_end") {
      const active = [...this.active.values()].find((candidate) => candidate.emit === consumer);
      if (active) this.captureFinalMessage(active, message.messages);
      emit(consumer, "log", message);
    } else if (type === "agent_settled") {
      const active = [...this.active.values()].find((candidate) => candidate.emit === consumer);
      if (active) {
        active.running = false;
        if (active.usage) {
          const usage = record(active.usage);
          const cost = record(usage.cost);
          emit(consumer, "usage.recorded", {
            usage: active.usage,
            costAmount: typeof cost.total === "number" ? cost.total : null,
            basis: typeof cost.total === "number" ? "provider-reported" : "harness-reported",
          });
        }
        emit(consumer, "output.completed", { text: active.outputText });
      }
      emit(consumer, "run.completed", message);
    } else if (type === "message_end") {
      const active = [...this.active.values()].find((candidate) => candidate.emit === consumer);
      if (active) this.captureFinalMessage(active, [message.message]);
    } else if (type === "message_update") {
      const event = record(message.assistantMessageEvent ?? message.event);
      const eventType = asString(event.type) ?? "";
      const active = [...this.active.values()].find((candidate) => candidate.emit === consumer);
      if (active && message.usage !== undefined) active.usage = message.usage;
      const text = deepString(event, ["delta"], ["text"], ["content"])
        ?? deepString(message, ["delta"], ["text"]);
      if (text) emit(consumer, eventType.includes("thinking") ? "reasoning.delta" : "message.delta", { text });
    } else if (type === "tool_execution_start") emit(consumer, "tool.started", message);
    else if (type === "tool_execution_update") emit(consumer, "tool.updated", message);
    else if (type === "tool_execution_end") emit(consumer, "tool.completed", message);
    else emit(consumer, "log", message);
  }

  private captureFinalMessage(active: ActivePi, value: unknown): void {
    if (!Array.isArray(value)) return;
    const assistant = [...value].reverse().map(record).find((message) => message.role === "assistant");
    if (!assistant) return;
    if (assistant.usage !== undefined) active.usage = assistant.usage;
    const content = Array.isArray(assistant.content) ? assistant.content.map(record) : [];
    const text = content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("");
    if (text) active.outputText = text;
  }

  private responseData(value: unknown): Record<string, unknown> {
    const response = asObject(value);
    return asObject(response.data ?? response);
  }

  private require(session: DriverSession): ActivePi {
    const active = this.active.get(session.nativeSessionId);
    if (!active) throw new Error(`Pi session is not active: ${session.nativeSessionId}`);
    return active;
  }
}
