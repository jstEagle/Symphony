import { environmentWithoutDaemonSecret, type SecretStore, type SymphonyConfig } from "@symphony/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverLifecycleOptions,
  DriverSession,
  DriverStartRequest,
  JsonValue,
  ModelDescriptor,
  WorkerDriver,
} from "@symphony/protocol";
import { buildAgentPrompt } from "./prompt.js";
import { HostedJsonLineProcess } from "./hosted-process.js";
import { JsonLineProcess, asObject, asString, type JsonLineRpcTransport } from "./process.js";
import { capabilities, deepString, emit, makeSession, receipt, record, type Emit } from "./common.js";

type ActivePi = {
  rpc: JsonLineRpcTransport;
  emit: Emit;
  sessionId: string;
  running: boolean;
  settled: boolean;
  outputText: string;
  usage: unknown;
  terminalError: string | null;
};

export class PiDriver implements WorkerDriver {
  readonly id = "pi" as const;
  readonly capabilities = capabilities({ cloud: false });
  private readonly active = new Map<string, ActivePi>();

  constructor(
    private readonly config: SymphonyConfig["harnesses"]["pi"],
    private readonly secrets: SecretStore,
  ) {}

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
      { command: spec.command, args: [...spec.prefixArgs, ...this.config.process.args], cwd: process.cwd(), env: this.environment() },
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
            ...(nonNegative(cost.input) !== null ? { inputPerMillion: nonNegative(cost.input) as number } : {}),
            ...(nonNegative(cost.output) !== null ? { outputPerMillion: nonNegative(cost.output) as number } : {}),
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
      await rpc.close();
    }
  }

  async start(
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    options?.signal.throwIfAborted();
    const rpc = this.spawn(request, onEvent, options?.processSupervisor);
    const abort = () => {
      this.removeProcess(rpc);
      void (rpc.mode === "reconnected" ? rpc.detach() : rpc.close("SIGKILL")).catch(() => undefined);
    };
    options?.signal.addEventListener("abort", abort, { once: true });
    try {
      await rpc.activate();
      const state = this.responseData(await rpc.command("get_state"));
      options?.signal.throwIfAborted();
      const sessionId = asString(state.sessionId) ?? asString(state.sessionFile) ?? request.agentId;
      const active: ActivePi = {
        rpc,
        emit: onEvent,
        sessionId,
        running: true,
        settled: false,
        outputText: "",
        usage: null,
        terminalError: null,
      };
      this.active.set(sessionId, active);
      this.persistActive(active);
      emit(onEvent, "session.started", { sessionId, sessionFile: state.sessionFile ?? null });
      // Pi acknowledges a prompt once it has been accepted or rejected. Keep
      // startup inside that boundary so a detached controller never leaves an
      // ambiguous, unobserved command response in flight.
      await this.submitPrompt(active, buildAgentPrompt(request.workOrder));
      return makeSession(this.id, sessionId, {
        agentId: request.agentId,
        sessionFile: typeof state.sessionFile === "string" ? state.sessionFile : null,
      });
    } catch (error) {
      this.removeProcess(rpc);
      if (rpc.mode === "reconnected") await rpc.detach();
      else await rpc.close();
      throw error;
    } finally {
      options?.signal.removeEventListener("abort", abort);
    }
  }

  async resume(
    session: DriverSession,
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    options?.signal.throwIfAborted();
    const rpc = this.spawn(request, onEvent, options?.processSupervisor);
    const abort = () => {
      this.removeProcess(rpc);
      void (rpc.mode === "reconnected" ? rpc.detach() : rpc.close("SIGKILL")).catch(() => undefined);
    };
    options?.signal.addEventListener("abort", abort, { once: true });
    try {
      if (rpc.mode === "reconnected") {
        const retained = record(rpc.retainedAdapterState());
        const active: ActivePi = {
          rpc,
          emit: onEvent,
          sessionId: session.nativeSessionId,
          running: retained.running === true || session.state === "running" || session.state === "starting",
          settled: retained.settled === true,
          outputText: asString(retained.outputText) ?? "",
          usage: retained.usage ?? null,
          terminalError: asString(retained.terminalError) ?? null,
        };
        // Register before activation: activate() synchronously projects every
        // durable frame missed by the previous daemon generation.
        this.active.set(session.nativeSessionId, active);
        await rpc.activate();
        options?.signal.throwIfAborted();
        this.persistActive(active);
        emit(
          onEvent,
          "session.started",
          { sessionId: session.nativeSessionId, resumed: true, transportReconnected: true },
          `host-session:${session.nativeSessionId}`,
        );
        return {
          ...session,
          state: active.running ? "running" : active.settled ? "completed" : "idle",
          metadata: { ...session.metadata, transportReusable: rpc.isReusable() },
        };
      }
      await rpc.activate();
      const sessionFile = typeof session.metadata.sessionFile === "string" ? session.metadata.sessionFile : undefined;
      if (sessionFile) await rpc.command("switch_session", { sessionPath: sessionFile });
      options?.signal.throwIfAborted();
      const active: ActivePi = {
        rpc,
        emit: onEvent,
        sessionId: session.nativeSessionId,
        running: false,
        settled: false,
        outputText: "",
        usage: null,
        terminalError: null,
      };
      this.active.set(session.nativeSessionId, active);
      this.persistActive(active);
      emit(onEvent, "session.started", { sessionId: session.nativeSessionId, resumed: true });
      return { ...session, state: "unknown" };
    } catch (error) {
      this.removeProcess(rpc);
      if (rpc.mode === "reconnected") await rpc.detach();
      else await rpc.close();
      throw error;
    } finally {
      options?.signal.removeEventListener("abort", abort);
    }
  }

  async sendMessage(session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean }> {
    const active = this.require(session);
    if (active.running) {
      active.rpc.send({ type: "steer", message });
      return receipt(false);
    }
    active.running = true;
    active.settled = false;
    active.outputText = "";
    active.usage = null;
    active.terminalError = null;
    this.persistActive(active);
    await this.submitPrompt(active, message);
    return receipt(false);
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    await active.rpc.command("abort");
  }

  async forceTerminate(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    this.active.delete(session.nativeSessionId);
    await active.rpc.close("SIGKILL");
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((active) => active.rpc.detach()));
    this.active.clear();
  }

  private spawn(
    request: DriverStartRequest,
    consumer: Emit,
    processSupervisor?: DriverLifecycleOptions["processSupervisor"],
  ): JsonLineRpcTransport {
    const spec = this.processSpec();
    const args = [...spec.prefixArgs, ...this.config.process.args];
    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const builtExtension = resolve(sourceDirectory, "pi-extension.js");
    const sourceExtension = resolve(sourceDirectory, "pi-extension.ts");
    const extension = existsSync(builtExtension) ? builtExtension : sourceExtension;
    if (existsSync(extension)) args.push("--extension", extension);
    if (request.workOrder.permissions === "read-only") {
      const coordinationTools = ["list_agents", "send_message", "observe_agent", "get_session_logs", "cancel_agent", "present_ui", "list_workflows", "list_plugin_tools"];
      if (request.coordination.canCreate) coordinationTools.push("create_agent");
      args.push("--tools", ["read", "grep", "find", "ls", ...coordinationTools].join(","));
    }
    if (request.resolvedModel !== "auto") args.push("--model", request.resolvedModel);
    const processSpec = {
      command: spec.command,
      args,
      cwd: request.workOrder.workspace.path,
      env: {
        ...this.environment(),
        SYMPHONY_DAEMON_URL: request.coordination.daemonUrl,
        SYMPHONY_AGENT_ID: request.agentId,
        SYMPHONY_AGENT_TOKEN: request.coordination.token,
        SYMPHONY_AGENT_CAN_CREATE: String(request.coordination.canCreate),
      },
      ...(processSupervisor ? { processSupervisor } : {}),
      processRole: "pi-rpc",
    };
    const callbacks = {
      onNotification: (message: Record<string, unknown>) => this.onMessage(message, consumer),
      onStderr: (line: string, nativeEventId?: string) => emit(consumer, "log", { stream: "stderr", line }, nativeEventId),
      onUnexpectedExit: (error: Error, nativeEventId?: string) => emit(
        consumer,
        "run.failed",
        { error: error.message, phase: "native-process" },
        nativeEventId ? `${nativeEventId}:run.failed` : undefined,
      ),
    };
    return HostedJsonLineProcess.shouldHost(processSpec)
      ? new HostedJsonLineProcess(processSpec, callbacks)
      : new JsonLineProcess(processSpec, callbacks.onNotification, undefined, callbacks.onStderr, callbacks.onUnexpectedExit);
  }

  private removeProcess(rpc: JsonLineRpcTransport): void {
    for (const [sessionId, active] of this.active.entries()) {
      if (active.rpc === rpc) this.active.delete(sessionId);
    }
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

  private environment(): NodeJS.ProcessEnv {
    const openRouterKey = this.secrets.get("openrouter.apiKey");
    const anthropicKey = this.secrets.get("anthropic.apiKey");
    const openAiKey = this.secrets.get("openai.apiKey");
    return {
      ...environmentWithoutDaemonSecret(),
      ...(openRouterKey ? { OPENROUTER_API_KEY: openRouterKey } : {}),
      ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
      ...(openAiKey ? { OPENAI_API_KEY: openAiKey } : {}),
    };
  }

  private onMessage(message: Record<string, unknown>, consumer: Emit): void {
    const type = asString(message.type) ?? "unknown";
    const hostEventId = asString(message.__symphonyHostEventId);
    const emitMessage = (kind: DriverEvent["kind"], payload: unknown) => emit(
      consumer,
      kind,
      payload,
      hostEventId ? `${hostEventId}:${kind}` : undefined,
    );
    if (type === "response" && asString(message.command) === "prompt" && message.success === false) {
      const active = this.findActive(consumer);
      const error = asString(message.error) ?? "Pi rejected the prompt before acceptance.";
      if (active) {
        active.terminalError = error;
        this.failActive(active);
      }
      emitMessage("run.failed", { error, response: message });
    } else if (type === "agent_start") {
      const active = this.findActive(consumer);
      if (active) {
        active.running = true;
        active.settled = false;
        active.terminalError = null;
        this.persistActive(active);
      }
      emitMessage("run.started", message);
    }
    else if (type === "agent_end") {
      const active = this.findActive(consumer);
      if (active) {
        this.captureFinalMessage(active, message.messages);
        this.persistActive(active);
      }
      emitMessage("log", message);
    } else if (type === "agent_settled") {
      const active = this.findActive(consumer);
      let terminalError: string | null = null;
      if (active) {
        active.running = false;
        active.settled = true;
        terminalError = active.terminalError;
        this.persistActive(active);
        if (active.usage) {
          const usage = record(active.usage);
          const cost = record(usage.cost);
          emitMessage("usage.recorded", {
            usage: active.usage,
            costAmount: typeof cost.total === "number" ? cost.total : null,
            basis: typeof cost.total === "number" ? "provider-reported" : "harness-reported",
          });
        }
        emitMessage("output.completed", { text: active.outputText });
      }
      if (terminalError) emitMessage("run.failed", { error: terminalError, response: message });
      else emitMessage("run.completed", message);
    } else if (type === "message_end") {
      const active = this.findActive(consumer);
      if (active) {
        this.captureFinalMessage(active, [message.message]);
        this.persistActive(active);
      }
    } else if (type === "message_update") {
      const event = record(message.assistantMessageEvent ?? message.event);
      const eventType = asString(event.type) ?? "";
      const active = this.findActive(consumer);
      if (active && message.usage !== undefined) {
        active.usage = message.usage;
        this.persistActive(active);
      }
      const text = deepString(event, ["delta"], ["text"], ["content"])
        ?? deepString(message, ["delta"], ["text"]);
      if (text) {
        const replace = /(?:^|_)end$/u.test(eventType) || /snapshot/iu.test(eventType);
        emitMessage(
          eventType.includes("thinking") ? "reasoning.delta" : "message.delta",
          { text, ...(replace ? { replace: true } : {}) },
        );
      }
    } else if (type === "tool_execution_start") emitMessage("tool.started", message);
    else if (type === "tool_execution_update") emitMessage("tool.updated", message);
    else if (type === "tool_execution_end") emitMessage("tool.completed", message);
    else emitMessage("log", message);
  }

  private async submitPrompt(active: ActivePi, message: string): Promise<void> {
    try {
      const response = asObject(await active.rpc.command("prompt", { message }, 0));
      if (response.success !== false) return;
      active.terminalError = asString(response.error) ?? "Pi rejected the prompt before acceptance.";
      this.failActive(active);
      const hostEventId = asString(response.__symphonyHostEventId);
      emit(
        active.emit,
        "run.failed",
        { error: active.terminalError, response },
        hostEventId ? `${hostEventId}:run.failed` : undefined,
      );
    } catch (error) {
      this.failActive(active);
      emit(active.emit, "run.failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private failActive(active: ActivePi): void {
    active.running = false;
    active.settled = false;
    this.persistActive(active);
  }

  private findActive(consumer: Emit): ActivePi | undefined {
    return [...this.active.values()].find((candidate) => candidate.emit === consumer);
  }

  private persistActive(active: ActivePi): void {
    active.rpc.updateProcessLease({
      nativeSessionId: active.sessionId,
      nativeRunId: null,
      activeTurnId: active.running ? active.sessionId : null,
      adapterState: this.adapterState(active),
    });
  }

  private adapterState(active: ActivePi): JsonValue {
    return {
      running: active.running,
      settled: active.settled,
      outputText: active.outputText,
      usage: this.jsonValue(active.usage),
      terminalError: active.terminalError,
    };
  }

  private jsonValue(value: unknown): JsonValue {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch {
      return null;
    }
  }

  private captureFinalMessage(active: ActivePi, value: unknown): void {
    if (!Array.isArray(value)) return;
    const assistant = [...value].reverse().map(record).find((message) => message.role === "assistant");
    if (!assistant) return;
    if (assistant.usage !== undefined) active.usage = assistant.usage;
    const stopReason = asString(assistant.stopReason);
    const errorMessage = asString(assistant.errorMessage);
    active.terminalError = errorMessage ?? (stopReason === "error" ? "Pi provider reported an error." : null);
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

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
