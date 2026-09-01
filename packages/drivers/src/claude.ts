import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { environmentWithoutDaemonSecret, type SymphonyConfig } from "@symphony/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DriverDoctorResult, DriverEvent, DriverLifecycleOptions, DriverSession, DriverStartRequest,
  JsonValue, ModelDescriptor, WorkerDriver, DriverMessageRequest,
} from "@symphony/protocol";
import { buildAgentPrompt, buildSymphonyOperatingContract, coordinationPromptOptions, hasStructuredOutputSchema, isConductor } from "./prompt.js";
import { HostedJsonLineProcess } from "./hosted-process.js";
import { JsonLineProcess, asObject, asString, type JsonLineRpcTransport } from "./process.js";
import { canonicalNativeEventId, capabilities, emit, makeSession, messageRequest, record, withMessageIdentity, type Emit } from "./common.js";

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
  messageSequence: number;
  pendingMessage: DriverMessageRequest | null;
  pendingMessageAccepted: boolean;
  queuedMessages: Array<{ request: DriverMessageRequest; accepted: boolean }>;
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
      messageSequence: 0,
      pendingMessage: null,
      pendingMessageAccepted: false,
      queuedMessages: [],
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
        { prompt: buildAgentPrompt(request.workOrder, coordinationPromptOptions(request)), options: this.sdkOptions(request) },
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
      messageSequence: typeof retained.messageSequence === "number" && Number.isSafeInteger(retained.messageSequence) ? retained.messageSequence : 0,
      pendingMessage: retainedMessageDispatch(retained),
      pendingMessageAccepted: retained.pendingMessageAccepted === true,
      queuedMessages: retainedMessageQueue(retained),
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
              { prompt: buildAgentPrompt(request.workOrder, coordinationPromptOptions(request)), options: this.sdkOptions(request) },
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
          state: this.recoveryState(active),
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
      return { ...session, nativeSessionId: active.sessionId, state: this.recoveryState(active) };
    } catch (error) {
      this.removeProcess(rpc);
      if (rpc.mode === "reconnected") await rpc.detach();
      else await rpc.close();
      throw error;
    } finally {
      options?.signal.removeEventListener("abort", abort);
    }
  }

  async sendMessage(session: DriverSession, message: string, request?: DriverMessageRequest): Promise<{ receiptId: string; queued: boolean; terminalBoundary?: boolean }> {
    const active = this.require(session);
    const durable = messageRequest(message, request);
    const pendingMatch = active.pendingMessage?.requestId === durable.requestId && active.pendingMessage.contentHash === durable.contentHash;
    const queuedMatch = active.queuedMessages.some((entry) => entry.request.requestId === durable.requestId && entry.request.contentHash === durable.contentHash);
    if (pendingMatch || queuedMatch) {
      return { receiptId: durable.requestId, queued: pendingMatch ? false : true };
    }
    const pendingDifferent = active.pendingMessage && (active.pendingMessage.requestId !== durable.requestId || active.pendingMessage.contentHash !== durable.contentHash);
    if (pendingDifferent && !active.pendingMessageAccepted) {
      throw new Error("Claude native message is already pending with a different durable identity.");
    }
    const wasRunning = active.running;
    const queuedBehindActiveTurn = Boolean(active.pendingMessage && active.pendingMessageAccepted && active.running);
    if (queuedBehindActiveTurn) active.queuedMessages.push({ request: durable, accepted: false });
    else {
      active.pendingMessage = durable;
      active.pendingMessageAccepted = false;
    }
    this.checkpoint(active);
    const result = asObject(await active.rpc.requestWithId(durable.requestId, "session/prompt", {
      prompt: message,
      requestId: durable.requestId,
      contentHash: durable.contentHash,
    }, 0));
    const acceptedSession = this.responseSessionId(result);
    if (acceptedSession !== active.sessionId) throw new Error(`Claude follow-up session identity changed from ${active.sessionId} to ${acceptedSession}.`);
    const terminalBoundary = result.terminalBoundary === true;
    if (!terminalBoundary && (asString(result.requestId) !== durable.requestId || asString(result.contentHash) !== durable.contentHash)) {
      throw new Error("Claude host did not echo the durable follow-up identity; acceptance is unknown.");
    }
    if (terminalBoundary) {
      // The host proved this prompt was not appended behind the preceding
      // result. Let the runtime requeue it with the same durable request id.
      if (queuedBehindActiveTurn) {
        active.queuedMessages = active.queuedMessages.filter((entry) => entry.request.requestId !== durable.requestId);
      } else {
        active.pendingMessage = null;
        active.pendingMessageAccepted = false;
      }
    } else {
      active.running = true;
      active.settled = false;
      if (queuedBehindActiveTurn) {
        const queued = active.queuedMessages.find((entry) => entry.request.requestId === durable.requestId);
        if (queued) queued.accepted = true;
      } else active.pendingMessageAccepted = true;
    }
    this.checkpoint(active);
    return {
      receiptId: durable.requestId,
      queued: result.queued === true || wasRunning,
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
        append: buildSymphonyOperatingContract(request.workOrder, coordinationPromptOptions(request)),
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
    this.onMessage(
      sdkMessage,
      consumer,
      hostedFrameId ? (suffix) => `${hostedFrameId}:${suffix}` : () => undefined,
      active?.sessionId ?? asString(sdkMessage.session_id) ?? null,
      active,
    );
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

  private onMessage(
    message: Record<string, unknown>,
    consumer: Emit,
    eventId: (suffix: string) => string | undefined,
    sessionId: string | null,
    active: ActiveClaude | undefined,
  ): void {
    const eventRecord = record(message.event);
    const messageId = asString(eventRecord.id)
      ?? asString(eventRecord.eventId)
      ?? asString(message.uuid)
      ?? asString(message.id);
    const streamSequence = active ? ++active.messageSequence : null;
    if (active) this.checkpoint(active);
    const identity = (suffix: string): string | undefined => eventId(suffix)
      ?? (sessionId && messageId ? `claude:${sessionId}:message:${messageId}:${suffix}` : undefined)
      ?? (active && sessionId && streamSequence !== null
        ? canonicalNativeEventId("claude", `${sessionId}:stream:${streamSequence}`, suffix as DriverEvent["kind"], message)
        : undefined);
    const type = asString(message.type) ?? "unknown";
    const durableIdentity = active ? this.messageIdentity(active, message) : null;
    if (type === "system" && message.subtype === "init") {
      emit(consumer, "run.started", { sessionId: message.session_id, model: message.model, tools: message.tools }, identity("run.started"));
      return;
    }
    if (type === "assistant") {
      const body = record(message.message);
      for (const blockValue of Array.isArray(body.content) ? body.content : []) {
        const block = record(blockValue);
        if (block.type !== "tool_use") continue;
        const toolCallId = asString(block.id) ?? asString(message.uuid) ?? "native-tool";
        emit(consumer, "tool.started", { toolCallId, toolName: asString(block.name) ?? "native_tool", args: block.input ?? {}, status: "inProgress" }, sessionId ? `claude:${sessionId}:tool:${toolCallId}:started` : toolCallId);
      }
      return;
    }
    if (type === "user") {
      const body = record(message.message);
      for (const blockValue of Array.isArray(body.content) ? body.content : []) {
        const block = record(blockValue);
        const toolCallId = block.type === "tool_result" ? asString(block.tool_use_id) : null;
        if (!toolCallId) continue;
        emit(consumer, "tool.completed", { toolCallId, result: message.tool_use_result ?? block.content ?? null, status: block.is_error === true ? "failed" : "completed", isError: block.is_error === true }, sessionId ? `claude:${sessionId}:tool:${toolCallId}:completed` : toolCallId);
      }
      return;
    }
    if (type === "tool_progress") {
      const toolCallId = asString(message.tool_use_id) ?? "native-tool";
      emit(
        consumer,
        "tool.updated",
        { toolCallId, toolName: message.tool_name, status: "inProgress", elapsedSeconds: message.elapsed_time_seconds },
        identity("tool.updated") ?? `${toolCallId}:progress:${++this.toolProgressOrdinal}`,
      );
      return;
    }
    if (type === "result") {
      emit(consumer, "usage.recorded", withMessageIdentity({
        costAmount: message.total_cost_usd,
        usage: message.usage,
        modelUsage: message.modelUsage,
        basis: "harness-reported",
        ...(sessionId ? { nativeSessionId: sessionId } : {}),
      }, durableIdentity), identity("usage.recorded"));
      const queuedPrompts = typeof message.__symphonyQueuedPrompts === "number" && Number.isSafeInteger(message.__symphonyQueuedPrompts)
        ? message.__symphonyQueuedPrompts
        : 0;
      const active = this.findActive(consumer);
      if (active) {
        active.running = queuedPrompts > 0;
        active.settled = queuedPrompts === 0 && message.subtype === "success" && message.is_error !== true;
        if (durableIdentity && active.pendingMessage?.requestId === durableIdentity.requestId) {
          active.pendingMessage = null;
          active.pendingMessageAccepted = false;
          const next = active.queuedMessages.shift();
          if (next) {
            active.pendingMessage = next.request;
            active.pendingMessageAccepted = next.accepted;
          }
        }
      }
      if (queuedPrompts > 0 && message.subtype === "success" && message.is_error !== true) {
        emit(consumer, "log", withMessageIdentity({
          phase: "claude-turn-completed-with-queued-prompts",
          queuedPrompts,
          stopReason: message.stop_reason,
          turns: message.num_turns,
        }, durableIdentity), identity("turn.queued"));
        return;
      }
      if (message.subtype === "success" && message.is_error !== true) {
        emit(consumer, "output.completed", withMessageIdentity({ text: message.result, structuredOutput: message.structured_output ?? null, ...(sessionId ? { nativeSessionId: sessionId } : {}) }, durableIdentity), identity("output.completed"));
        emit(consumer, "run.completed", withMessageIdentity({ stopReason: message.stop_reason, turns: message.num_turns, ...(sessionId ? { nativeSessionId: sessionId } : {}) }, durableIdentity), identity("run.completed"));
      } else emit(consumer, "run.failed", withMessageIdentity({ subtype: message.subtype, errors: message.errors ?? [], ...(sessionId ? { nativeSessionId: sessionId } : {}) }, durableIdentity), identity("run.failed"));
      if (active) this.checkpoint(active);
      return;
    }
    if (type === "stream_event") {
      const streamEvent = record(message.event);
      const delta = record(streamEvent.delta);
      if (streamEvent.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
        emit(consumer, "message.delta", { text: delta.text, index: streamEvent.index ?? null }, identity("message.delta"));
      } else if (streamEvent.type === "content_block_delta" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        emit(consumer, "reasoning.delta", { text: delta.thinking, index: streamEvent.index ?? null }, identity("reasoning.delta"));
      } else emit(consumer, "log", message, identity("log"));
    } else emit(consumer, "log", message, identity("log"));
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
    return {
      version: 1,
      sessionId: active.sessionId,
      running: active.running,
      settled: active.settled,
      initialDispatch: active.initialDispatch,
      messageSequence: active.messageSequence,
      pendingMessage: active.pendingMessage as unknown as JsonValue,
      pendingMessageAccepted: active.pendingMessageAccepted,
      queuedMessages: active.queuedMessages.map((entry) => ({ request: entry.request, accepted: entry.accepted })) as unknown as JsonValue,
    };
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

  private recoveryState(active: ActiveClaude): DriverSession["state"] {
    const acceptanceUnknown = (active.pendingMessage !== null && !active.pendingMessageAccepted)
      || active.queuedMessages.some((entry) => !entry.accepted);
    if (acceptanceUnknown) return "unknown";
    if (active.running) return "running";
    if (active.settled) return "completed";
    return "idle";
  }

  private messageIdentity(active: ActiveClaude, message: Record<string, unknown>): DriverMessageRequest | null {
    const requestId = asString(message.__symphonyMessageRequestId);
    const contentHash = asString(message.__symphonyMessageContentHash);
    if (requestId) {
      if (active.pendingMessage?.requestId === requestId && (!contentHash || active.pendingMessage.contentHash === contentHash)) return active.pendingMessage;
      return active.queuedMessages.find((entry) => entry.request.requestId === requestId && (!contentHash || entry.request.contentHash === contentHash))?.request ?? null;
    }
    return active.pendingMessage;
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

function retainedMessageDispatch(state: Record<string, unknown>): DriverMessageRequest | null {
  const value = record(state.pendingMessage);
  if (typeof value.attemptId !== "string" || typeof value.requestId !== "string" || typeof value.contentHash !== "string") return null;
  return { attemptId: value.attemptId, requestId: value.requestId, contentHash: value.contentHash };
}

function retainedMessageQueue(state: Record<string, unknown>): Array<{ request: DriverMessageRequest; accepted: boolean }> {
  const values = Array.isArray(state.queuedMessages) ? state.queuedMessages : [];
  const result: Array<{ request: DriverMessageRequest; accepted: boolean }> = [];
  for (const value of values) {
    const entry = record(value);
    const request = record(entry.request);
    if (typeof request.attemptId !== "string" || typeof request.requestId !== "string" || typeof request.contentHash !== "string") continue;
    result.push({
      request: { attemptId: request.attemptId, requestId: request.requestId, contentHash: request.contentHash },
      accepted: entry.accepted === true,
    });
  }
  return result;
}
