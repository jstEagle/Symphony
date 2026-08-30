import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { environmentWithoutDaemonSecret, type SymphonyConfig } from "@symphony/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DriverDoctorResult, DriverEvent, DriverLifecycleOptions, DriverSession, DriverStartRequest,
  JsonValue, ModelDescriptor, WorkerDriver,
} from "@symphony/protocol";
import { buildAgentPrompt, buildSymphonyOperatingContract, hasStructuredOutputSchema, isConductor } from "./prompt.js";
import { HostedJsonLineProcess } from "./hosted-process.js";
import { JsonLineProcess, asObject, asString, type JsonLineRpcTransport } from "./process.js";
import { capabilities, emit, makeSession, receipt, record, type Emit } from "./common.js";

type InitialClaudeDispatch = {
  requestId: string;
  state: "dispatching" | "accepted";
  sessionId: string | null;
};

type ActiveClaude = {
  request: DriverStartRequest;
  emit: Emit;
  rpc: JsonLineRpcTransport;
  sessionId: string;
  running: boolean;
  settled: boolean;
  initialDispatch: InitialClaudeDispatch | null;
};

export class ClaudeDriver implements WorkerDriver {
  readonly id = "claude" as const;
  readonly capabilities = capabilities({ steer: true, cloud: false });
  private readonly active = new Map<string, ActiveClaude>();
  private toolProgressOrdinal = 0;

  constructor(private readonly config: SymphonyConfig["harnesses"]["claude"]) {}

  async doctor(): Promise<DriverDoctorResult> {
    const version = await JsonLineProcess.probe(this.config.process.command);
    return {
      driver: this.id,
      available: this.config.enabled && version !== null,
      authenticated: null,
      version,
      capabilities: this.capabilities,
      detail: version ? "Claude Agent SDK and Claude Code executable are available; credentials are verified on query." : "Claude Code executable was not found.",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      { id: "auto", harness: this.id, name: "Native default", description: "Use the model selected by Claude Code.", modalities: ["text"], structuredOutput: true, pricing: {}, metadata: { alias: true } },
      { id: "fable", harness: this.id, name: "Claude Fable", description: "Claude Code's current Fable alias.", modalities: ["text"], structuredOutput: true, pricing: {}, metadata: { alias: true } },
      { id: "opus", harness: this.id, name: "Claude Opus", description: "Claude Code's current Opus alias.", modalities: ["text"], structuredOutput: true, pricing: {}, metadata: { alias: true } },
      { id: "sonnet", harness: this.id, name: "Claude Sonnet", description: "Claude Code's current Sonnet alias.", modalities: ["text"], structuredOutput: true, pricing: {}, metadata: { alias: true } },
      { id: "haiku", harness: this.id, name: "Claude Haiku", description: "Claude Code's current Haiku alias.", modalities: ["text"], structuredOutput: true, pricing: {}, metadata: { alias: true } },
    ];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void, options?: DriverLifecycleOptions): Promise<DriverSession> {
    options?.signal.throwIfAborted();
    const rpc = this.spawn(request, onEvent, options?.processSupervisor);
    const provisionalSessionId = `claude-pending:${request.agentId}`;
    const active: ActiveClaude = {
      request,
      emit: onEvent,
      rpc,
      sessionId: provisionalSessionId,
      running: true,
      settled: false,
      initialDispatch: { requestId: `claude:initial-query:${request.agentId}`, state: "dispatching", sessionId: null },
    };
    this.active.set(provisionalSessionId, active);
    const abort = () => {
      this.removeProcess(rpc);
      void (rpc.mode === "reconnected" ? rpc.detach() : rpc.close("SIGKILL")).catch(() => undefined);
    };
    options?.signal.addEventListener("abort", abort, { once: true });
    try {
      await rpc.activate();
      // A provisional native identity makes an in-flight first query
      // reconnectable. The actual Claude session replaces it before the first
      // accepted response frame can be acknowledged.
      this.checkpoint(active);
      const initialDispatch = active.initialDispatch;
      if (!initialDispatch) throw new Error("Claude initial dispatch checkpoint is unavailable.");
      const result = asObject(await rpc.requestWithId(
        initialDispatch.requestId,
        "session/start",
        { prompt: buildAgentPrompt(request.workOrder), options: this.sdkOptions(request) },
        0,
        (value) => this.acceptInitialDispatch(active, this.responseSessionId(value), "start-response"),
      ));
      this.acceptInitialDispatch(active, this.responseSessionId(result), "start-response");
      options?.signal.throwIfAborted();
      emit(onEvent, "session.started", { sessionId: active.sessionId }, `claude-session:${active.sessionId}:started`);
      return makeSession(this.id, active.sessionId, { agentId: request.agentId, transportReusable: rpc.isReusable() });
    } catch (error) {
      this.removeProcess(rpc);
      if (rpc.mode === "reconnected") await rpc.detach();
      else await rpc.close();
      throw error;
    } finally {
      options?.signal.removeEventListener("abort", abort);
    }
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void, options?: DriverLifecycleOptions): Promise<DriverSession> {
    options?.signal.throwIfAborted();
    const rpc = this.spawn(request, onEvent, options?.processSupervisor);
    const retained = record(rpc.retainedAdapterState());
    const initialDispatch = this.retainedInitialDispatch(retained);
    const active: ActiveClaude = {
      request,
      emit: onEvent,
      rpc,
      sessionId: asString(retained.sessionId) ?? session.nativeSessionId,
      running: retained.running === true || session.state === "running" || session.state === "starting",
      settled: retained.settled === true,
      initialDispatch,
    };
    this.active.set(active.sessionId, active);
    const abort = () => {
      this.removeProcess(rpc);
      void (rpc.mode === "reconnected" ? rpc.detach() : rpc.close("SIGKILL")).catch(() => undefined);
    };
    options?.signal.addEventListener("abort", abort, { once: true });
    try {
      if (rpc.mode === "reconnected") {
        const recovering = initialDispatch?.state === "dispatching"
          ? rpc.requestWithId(
              initialDispatch.requestId,
              "session/start",
              { prompt: buildAgentPrompt(request.workOrder), options: this.sdkOptions(request) },
              0,
              (value) => this.acceptInitialDispatch(active, this.responseSessionId(value), "replayed-start-response"),
            )
          : null;
        // The stable pending request exists before activation so retained
        // response frames can resolve it without redispatching native work.
        void recovering?.catch(() => undefined);
        await rpc.activate();
        if (recovering) {
          const result = await recovering;
          this.acceptInitialDispatch(active, this.responseSessionId(result), "replayed-start-response");
        }
        options?.signal.throwIfAborted();
        this.checkpoint(active);
        emit(onEvent, "session.started", { sessionId: active.sessionId, resumed: true, transportReconnected: true }, `claude-session:${active.sessionId}:started`);
        return {
          ...session,
          nativeSessionId: active.sessionId,
          state: active.running ? "running" : active.settled ? "completed" : "idle",
          metadata: { ...session.metadata, transportReusable: rpc.isReusable() },
        };
      }
      await rpc.activate();
      const result = asObject(await rpc.request("session/attach", { sessionId: session.nativeSessionId, options: this.sdkOptions(request) }));
      const attachedSession = this.responseSessionId(result);
      if (attachedSession !== session.nativeSessionId) throw new Error(`Claude SDK attach returned mismatched session ${attachedSession}.`);
      active.sessionId = attachedSession;
      active.running = false;
      active.settled = false;
      this.checkpoint(active);
      emit(onEvent, "session.started", { sessionId: active.sessionId, resumed: true }, `claude-session:${active.sessionId}:started`);
      return { ...session, nativeSessionId: active.sessionId, state: "idle" };
    } catch (error) {
      this.removeProcess(rpc);
      if (rpc.mode === "reconnected") await rpc.detach();
      else await rpc.close();
      throw error;
    } finally {
      options?.signal.removeEventListener("abort", abort);
    }
  }

  async sendMessage(session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean; terminalBoundary?: boolean }> {
    const active = this.require(session);
    const wasRunning = active.running;
    const result = asObject(await active.rpc.request("session/prompt", { prompt: message }, 0));
    const acceptedSession = this.responseSessionId(result);
    if (acceptedSession !== active.sessionId) throw new Error(`Claude follow-up session identity changed from ${active.sessionId} to ${acceptedSession}.`);
    const terminalBoundary = result.terminalBoundary === true;
    if (!terminalBoundary) {
      active.running = true;
      active.settled = false;
    }
    this.checkpoint(active);
    return {
      ...receipt(result.queued === true || wasRunning),
      ...(terminalBoundary ? { terminalBoundary: true } : {}),
    };
  }

  async cancel(session: DriverSession): Promise<void> {
    await this.require(session).rpc.request("session/cancel", {}, 30_000);
  }

  async forceTerminate(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    this.active.delete(session.nativeSessionId);
    await active.rpc.close("SIGKILL");
  }

  async detach(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    this.active.delete(session.nativeSessionId);
    await active.rpc.detach();
  }

  async dispose(): Promise<void> {
    const transports = [...new Set([...this.active.values()].map((active) => active.rpc))];
    await Promise.allSettled(transports.map((rpc) => rpc.detach()));
    this.active.clear();
  }

  private sdkOptions(request: DriverStartRequest): Options {
    const full = request.workOrder.permissions === "full-access";
    const sdkEnvironment = environmentWithoutDaemonSecret();
    // SDK debug mode records the complete native invocation. Symphony never
    // enables it for a durable host, even when inherited from the daemon.
    delete sdkEnvironment.DEBUG_CLAUDE_AGENT_SDK;
    delete sdkEnvironment.DEBUG_SDK;
    Object.assign(sdkEnvironment, {
      CLAUDE_AGENT_SDK_CLIENT_APP: "symphony/0.1.0",
      SYMPHONY_DAEMON_URL: request.coordination.daemonUrl,
      SYMPHONY_AGENT_ID: request.agentId,
      SYMPHONY_AGENT_TOKEN: request.coordination.token,
      SYMPHONY_AGENT_CAN_CREATE: String(request.coordination.canCreate),
    });
    const options: Options = {
      cwd: request.workOrder.workspace.path,
      env: sdkEnvironment,
      includePartialMessages: true,
      persistSession: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildSymphonyOperatingContract(request.workOrder, { agentId: request.agentId, canCreate: request.coordination.canCreate }),
      },
      ...(isConductor(request.workOrder) || !hasStructuredOutputSchema(request.workOrder)
        ? {}
        : { outputFormat: { type: "json_schema" as const, schema: request.workOrder.outputSchema } }),
      mcpServers: {
        symphony: {
          command: request.coordination.mcpCommand,
          args: request.coordination.mcpArgs,
        },
      },
      ...(request.resolvedModel !== "auto" ? { model: request.resolvedModel } : {}),
      ...(this.config.process.command !== "claude" ? { pathToClaudeCodeExecutable: this.config.process.command } : {}),
      ...(this.config.process.args.length ? { executableArgs: this.config.process.args } : {}),
    };
    if (full) {
      options.tools = { type: "preset", preset: "claude_code" };
      options.permissionMode = "bypassPermissions";
      options.allowDangerouslySkipPermissions = true;
    } else {
      options.tools = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"];
      options.disallowedTools = ["Edit", "Write", "Bash", "NotebookEdit", "Task"];
      options.permissionMode = "dontAsk";
    }
    return options;
  }

  private spawn(request: DriverStartRequest, consumer: Emit, processSupervisor?: DriverLifecycleOptions["processSupervisor"]): JsonLineRpcTransport {
    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const builtHost = resolve(sourceDirectory, "claude-host.js");
    const sourceHost = resolve(sourceDirectory, "claude-host.ts");
    const host = existsSync(builtHost) ? builtHost : sourceHost;
    const tsxImport = host.endsWith(".ts") ? fileURLToPath(import.meta.resolve("tsx")) : null;
    const hostEnvironment = environmentWithoutDaemonSecret();
    delete hostEnvironment.DEBUG_CLAUDE_AGENT_SDK;
    delete hostEnvironment.DEBUG_SDK;
    const spec = {
      command: process.execPath,
      args: tsxImport ? ["--import", tsxImport, host] : [host],
      cwd: request.workOrder.workspace.path,
      env: hostEnvironment,
      ...(processSupervisor ? { processSupervisor } : {}),
      processRole: "claude-sdk-host",
      adapterVersion: "claude-sdk-host:v1",
    };
    const callbacks = {
      onNotification: (message: Record<string, unknown>) => this.onNotification(message, consumer),
      onStderr: (line: string, nativeEventId?: string) => emit(consumer, "log", {
        stream: "stderr",
        line: line.replaceAll(request.coordination.token, "[REDACTED]"),
      }, nativeEventId),
      onUnexpectedExit: (error: Error, nativeEventId?: string) => emit(consumer, "run.failed", { error: error.message, phase: "claude-sdk-host" }, nativeEventId ? `${nativeEventId}:run.failed` : undefined),
    };
    return HostedJsonLineProcess.shouldHost(spec)
      ? new HostedJsonLineProcess(spec, callbacks)
      : new JsonLineProcess(spec, callbacks.onNotification, undefined, callbacks.onStderr, callbacks.onUnexpectedExit);
  }

  private onNotification(message: Record<string, unknown>, consumer: Emit): void {
    const method = asString(message.method) ?? asString(message.type) ?? "unknown";
    const hostedFrameId = asString(message.__symphonyHostEventId);
    if (method === "claude/error") {
      const params = record(message.params);
      const active = this.findActive(consumer);
      if (active) {
        active.running = false;
        active.settled = false;
        this.checkpoint(active);
      }
      emit(consumer, "run.failed", params, hostedFrameId ? `${hostedFrameId}:run.failed` : undefined);
      return;
    }
    if (method === "claude/cancelled") {
      const params = record(message.params);
      const active = this.findActive(consumer);
      if (active) {
        active.running = false;
        active.settled = false;
        this.checkpoint(active);
      }
      emit(consumer, "run.cancelled", params, hostedFrameId ? `${hostedFrameId}:run.cancelled` : undefined);
      return;
    }
    if (method !== "claude/message") {
      emit(consumer, "log", message, hostedFrameId);
      return;
    }
    const sdkMessage = record(message.params);
    const active = this.findActive(consumer);
    const observedSessionId = asString(sdkMessage.session_id);
    if (active && observedSessionId && active.initialDispatch?.state === "dispatching") {
      this.acceptInitialDispatch(active, observedSessionId, "native-message");
    }
    this.onMessage(sdkMessage, consumer, hostedFrameId ? (suffix) => `${hostedFrameId}:${suffix}` : () => undefined);
    if (active) this.checkpoint(active);
    const generation = typeof sdkMessage.__symphonyTurnGeneration === "number" && Number.isSafeInteger(sdkMessage.__symphonyTurnGeneration)
      ? sdkMessage.__symphonyTurnGeneration
      : null;
    if (active && sdkMessage.type === "result" && generation !== null) {
      // onMessage synchronously projects and persists the terminal/nonterminal
      // result before this controller acknowledgement releases the next turn.
      void active.rpc.request("session/result-ack", { generation }, 30_000).catch((error: unknown) => {
        emit(consumer, "log", {
          phase: "claude-result-acknowledgement-failed",
          generation,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private onMessage(message: Record<string, unknown>, consumer: Emit, eventId: (suffix: string) => string | undefined): void {
    const type = asString(message.type) ?? "unknown";
    if (type === "system" && message.subtype === "init") {
      emit(consumer, "run.started", { sessionId: message.session_id, model: message.model, tools: message.tools }, eventId("run.started"));
      return;
    }
    if (type === "assistant") {
      const body = record(message.message);
      for (const blockValue of Array.isArray(body.content) ? body.content : []) {
        const block = record(blockValue);
        if (block.type !== "tool_use") continue;
        const toolCallId = asString(block.id) ?? asString(message.uuid) ?? "native-tool";
        emit(consumer, "tool.started", { toolCallId, toolName: asString(block.name) ?? "native_tool", args: block.input ?? {}, status: "inProgress" }, toolCallId);
      }
      return;
    }
    if (type === "user") {
      const body = record(message.message);
      for (const blockValue of Array.isArray(body.content) ? body.content : []) {
        const block = record(blockValue);
        const toolCallId = block.type === "tool_result" ? asString(block.tool_use_id) : null;
        if (!toolCallId) continue;
        emit(consumer, "tool.completed", { toolCallId, result: message.tool_use_result ?? block.content ?? null, status: block.is_error === true ? "failed" : "completed", isError: block.is_error === true }, toolCallId);
      }
      return;
    }
    if (type === "tool_progress") {
      const toolCallId = asString(message.tool_use_id) ?? "native-tool";
      emit(
        consumer,
        "tool.updated",
        { toolCallId, toolName: message.tool_name, status: "inProgress", elapsedSeconds: message.elapsed_time_seconds },
        eventId("tool.updated") ?? `${toolCallId}:progress:${++this.toolProgressOrdinal}`,
      );
      return;
    }
    if (type === "result") {
      emit(consumer, "usage.recorded", { costAmount: message.total_cost_usd, usage: message.usage, modelUsage: message.modelUsage, basis: "harness-reported" }, eventId("usage.recorded"));
      const queuedPrompts = typeof message.__symphonyQueuedPrompts === "number" && Number.isSafeInteger(message.__symphonyQueuedPrompts)
        ? message.__symphonyQueuedPrompts
        : 0;
      const active = this.findActive(consumer);
      if (active) {
        active.running = queuedPrompts > 0;
        active.settled = queuedPrompts === 0 && message.subtype === "success" && message.is_error !== true;
      }
      if (queuedPrompts > 0 && message.subtype === "success" && message.is_error !== true) {
        emit(consumer, "log", {
          phase: "claude-turn-completed-with-queued-prompts",
          queuedPrompts,
          stopReason: message.stop_reason,
          turns: message.num_turns,
        }, eventId("turn.queued"));
        return;
      }
      if (message.subtype === "success" && message.is_error !== true) {
        emit(consumer, "output.completed", { text: message.result, structuredOutput: message.structured_output ?? null }, eventId("output.completed"));
        emit(consumer, "run.completed", { stopReason: message.stop_reason, turns: message.num_turns }, eventId("run.completed"));
      } else emit(consumer, "run.failed", { subtype: message.subtype, errors: message.errors ?? [] }, eventId("run.failed"));
      return;
    }
    if (type === "stream_event") {
      const streamEvent = record(message.event);
      const delta = record(streamEvent.delta);
      if (streamEvent.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
        emit(consumer, "message.delta", { text: delta.text, index: streamEvent.index ?? null }, eventId("message.delta"));
      } else if (streamEvent.type === "content_block_delta" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        emit(consumer, "reasoning.delta", { text: delta.thinking, index: streamEvent.index ?? null }, eventId("reasoning.delta"));
      } else emit(consumer, "log", message, eventId("log"));
    } else emit(consumer, "log", message, eventId("log"));
  }

  private responseSessionId(value: unknown): string {
    const sessionId = asString(asObject(value).sessionId);
    if (!sessionId) throw new Error(`Claude SDK host did not return native session identity: ${JSON.stringify(value)}`);
    return sessionId;
  }

  private acceptInitialDispatch(active: ActiveClaude, sessionId: string, evidence: string): void {
    const initial = active.initialDispatch;
    if (!initial) return;
    if (initial.state === "accepted") {
      if (initial.sessionId !== sessionId) throw new Error(`Claude initial session identity changed from ${String(initial.sessionId)} to ${sessionId}.`);
      return;
    }
    const previousKey = active.sessionId;
    active.sessionId = sessionId;
    active.initialDispatch = { ...initial, state: "accepted", sessionId };
    if (this.active.get(previousKey) === active) this.active.delete(previousKey);
    this.active.set(sessionId, active);
    active.rpc.updateProcessLease({ nativeSessionId: sessionId, nativeRunId: sessionId, activeTurnId: sessionId, adapterState: this.adapterState(active) });
    emit(active.emit, "log", { phase: "claude-initial-dispatch-accepted", sessionId, evidence }, `claude-session:${sessionId}:accepted`);
  }

  private checkpoint(active: ActiveClaude): void {
    active.rpc.updateProcessLease({
      nativeSessionId: active.sessionId,
      nativeRunId: active.sessionId,
      activeTurnId: active.running ? active.sessionId : null,
      adapterState: this.adapterState(active),
    });
  }

  private adapterState(active: ActiveClaude): JsonValue {
    return { version: 1, sessionId: active.sessionId, running: active.running, settled: active.settled, initialDispatch: active.initialDispatch };
  }

  private retainedInitialDispatch(state: Record<string, unknown>): InitialClaudeDispatch | null {
    const value = record(state.initialDispatch);
    const requestId = asString(value.requestId);
    if (!requestId || (value.state !== "dispatching" && value.state !== "accepted")) return null;
    return { requestId, state: value.state, sessionId: asString(value.sessionId) ?? null };
  }

  private findActive(consumer: Emit): ActiveClaude | undefined {
    return [...this.active.values()].find((candidate) => candidate.emit === consumer);
  }

  private removeProcess(rpc: JsonLineRpcTransport): void {
    for (const [sessionId, active] of this.active.entries()) if (active.rpc === rpc) this.active.delete(sessionId);
  }

  private require(session: DriverSession): ActiveClaude {
    const active = this.active.get(session.nativeSessionId);
    if (!active) throw new Error(`Claude session is not active: ${session.nativeSessionId}`);
    return active;
  }
}
