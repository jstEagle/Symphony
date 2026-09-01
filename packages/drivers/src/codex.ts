import { environmentWithoutDaemonSecret, type SymphonyConfig } from "@symphony/config";
import {
  type DriverDoctorResult,
  type DriverEvent,
  type DriverLifecycleOptions,
  type DriverMessageRequest,
  type DriverSession,
  type DriverStartRequest,
  type ModelDescriptor,
  type JsonValue,
  type WorkerDriver,
} from "@symphony/protocol";
import { buildAgentPrompt, buildSymphonyOperatingContract, coordinationPromptOptions, hasStructuredOutputSchema, isConductor } from "./prompt.js";
import { HostedJsonLineProcess } from "./hosted-process.js";
import { JsonLineProcess, asObject, asString, type JsonLineRpcTransport } from "./process.js";
import { capabilities, deepString, emit, makeSession, messageRequest, receipt, record, stringifyError, withMessageIdentity, type Emit } from "./common.js";

type ActiveCodex = {
  rpc: JsonLineRpcTransport;
  emit: Emit;
  threadId: string;
  turnId: string | null;
  pendingUsage: Record<string, unknown> | null;
  fullAccess: boolean;
  outputSchema: DriverStartRequest["workOrder"]["outputSchema"] | null;
  activeTools: Set<string>;
  cancellation: CancellationLatch | null;
  pendingCancelled: PendingCancelled | null;
  finalOutputTurnId: string | null;
  idleTurnId: string | null;
  idleCompletion: { turnId: string; timer: NodeJS.Timeout; attempt: number } | null;
  lastSettledTurnId: string | null;
  initialTurn: InitialTurnDispatch | null;
  initialTurnAcceptance: InitialTurnAcceptance | null;
  recoveringInitialTurn: boolean;
  pendingMessage: DriverMessageRequest | null;
};

type InitialTurnDispatch = {
  id: string;
  requestId: string;
  state: "dispatching" | "accepted";
  turnId: string | null;
};

type InitialTurnAcceptance = {
  promise: Promise<string>;
  resolve: (turnId: string) => void;
};

type CancellationLatch = {
  promise: Promise<void>;
  resolve: () => void;
};

type PendingCancelled = {
  params: Record<string, unknown>;
  turnId: string | undefined;
  timer: NodeJS.Timeout | null;
};

const CODEX_TOOL_QUIESCENCE_GRACE_MS = 250;
const CODEX_IDLE_COMPLETION_GRACE_MS = 500;
const CODEX_IDLE_COMPLETION_MAX_ATTEMPTS = 3;

function createCancellationLatch(): CancellationLatch {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createInitialTurnAcceptance(): InitialTurnAcceptance {
  let resolve!: (turnId: string) => void;
  const promise = new Promise<string>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

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
      {
        command: this.config.process.command,
        args: this.config.process.args,
        cwd: process.cwd(),
        env: environmentWithoutDaemonSecret(),
      },
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
      await rpc.request("initialize", {
        clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      const params = this.threadParams(request);
      const response = asObject(await rpc.request("thread/start", params));
      options?.signal.throwIfAborted();
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
        outputSchema: isConductor(request.workOrder) || !hasStructuredOutputSchema(request.workOrder)
          ? null
          : strictCodexOutputSchema(request.workOrder.outputSchema),
        activeTools: new Set(),
        cancellation: null,
        pendingCancelled: null,
        finalOutputTurnId: null,
        idleTurnId: null,
        idleCompletion: null,
        lastSettledTurnId: null,
        initialTurn: null,
        initialTurnAcceptance: null,
        recoveringInitialTurn: false,
        pendingMessage: null,
      };
      this.active.set(threadId, active);
      const initialTurn: InitialTurnDispatch = {
        id: `initial:${request.agentId}`,
        requestId: `codex:initial-turn:${request.agentId}`,
        state: "dispatching",
        turnId: null,
      };
      active.initialTurn = initialTurn;
      this.checkpointInitialTurn(active);
      const turnId = await this.startTurn(active, request, buildAgentPrompt(request.workOrder, coordinationPromptOptions(request)), initialTurn);
      options?.signal.throwIfAborted();
      emit(onEvent, "session.started", { threadId, turnId });
      return makeSession(this.id, threadId, { agentId: request.agentId }, turnId);
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
        const retainedState = record(rpc.retainedAdapterState());
        const retainedInitialTurn = this.retainedInitialTurn(retainedState);
        // An accepted initial-turn marker is historical once adapterState.turnId
        // has been cleared. Do not resurrect it as the active turn on a later
        // daemon restart or a follow-up will be misrouted as turn/steer.
        const retainedTurnId = asString(retainedState.turnId)
          ?? (retainedInitialTurn?.state === "dispatching" ? retainedInitialTurn.turnId : null);
        const turnId = session.state === "running" || session.state === "starting"
          ? session.nativeRunId ?? retainedTurnId
          : null;
        const retainedActiveTools = Array.isArray(retainedState.activeToolIds)
          ? retainedState.activeToolIds.filter((value): value is string => typeof value === "string")
          : Array.isArray(session.metadata.activeToolIds)
            ? session.metadata.activeToolIds.filter((value): value is string => typeof value === "string")
            : [];
        const retainedUsage = retainedState.pendingUsage && typeof retainedState.pendingUsage === "object" && !Array.isArray(retainedState.pendingUsage)
          ? retainedState.pendingUsage as Record<string, unknown>
          : null;
        const active: ActiveCodex = {
          rpc,
          emit: onEvent,
          threadId: session.nativeSessionId,
          turnId,
          pendingUsage: retainedUsage,
          fullAccess: request.workOrder.permissions === "full-access",
          outputSchema: isConductor(request.workOrder) || !hasStructuredOutputSchema(request.workOrder)
            ? null
            : strictCodexOutputSchema(request.workOrder.outputSchema),
          activeTools: new Set(retainedActiveTools),
          cancellation: null,
          pendingCancelled: null,
          finalOutputTurnId: asString(retainedState.finalOutputTurnId) ?? null,
          idleTurnId: asString(retainedState.idleTurnId) ?? null,
          idleCompletion: null,
          lastSettledTurnId: asString(retainedState.lastSettledTurnId) ?? null,
          initialTurn: retainedInitialTurn,
          initialTurnAcceptance: null,
          recoveringInitialTurn: retainedInitialTurn?.state === "dispatching" && !turnId,
          pendingMessage: retainedMessageDispatch(retainedState),
        };
        this.restoreRetainedCancellation(active, retainedState);
        this.active.set(session.nativeSessionId, active);
        const recoveringInitialTurn = active.recoveringInitialTurn && retainedInitialTurn
          ? this.startTurn(
              active,
              request,
              buildAgentPrompt(request.workOrder, coordinationPromptOptions(request)),
              retainedInitialTurn,
              true,
            )
          : null;
        // The recovery request deliberately exists before activate(): retained
        // response frames must find their stable pending resolver before replay.
        void recoveringInitialTurn?.catch(() => undefined);
        await rpc.activate();
        if (recoveringInitialTurn) await recoveringInitialTurn;
        options?.signal.throwIfAborted();
        this.armRetainedLifecycle(active, retainedState);
        const recoveredTurnId = active.turnId ?? active.lastSettledTurnId ?? session.nativeRunId;
        rpc.updateProcessLease({
          nativeSessionId: session.nativeSessionId,
          nativeRunId: recoveredTurnId,
          activeTurnId: active.turnId,
          adapterState: this.adapterState(active),
        });
        emit(onEvent, "session.started", {
          threadId: session.nativeSessionId,
          turnId: recoveredTurnId,
          resumed: true,
          transportReconnected: true,
        }, `host-session:${session.nativeSessionId}:${recoveredTurnId ?? "idle"}`);
        return {
          ...session,
          nativeRunId: recoveredTurnId,
          state: active.pendingMessage ? "unknown" : active.turnId ? "running" : active.lastSettledTurnId ? "completed" : "idle",
          metadata: { ...session.metadata, transportReusable: rpc.isReusable() },
        };
      }
      await rpc.activate();
      await rpc.request("initialize", {
        clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      const response = asObject(await rpc.request("thread/resume", {
        threadId: session.nativeSessionId,
        ...this.threadParams(request),
      }));
      options?.signal.throwIfAborted();
      const thread = asObject(response.thread ?? response);
      const turns = Array.isArray(thread.turns) ? thread.turns.map(asObject) : [];
      const persistedTurn = session.nativeRunId
        ? turns.find((turn) => asString(turn.id) === session.nativeRunId)
        : undefined;
      const currentTurn = persistedTurn ?? turns.at(-1);
      const turnId = currentTurn ? asString(currentTurn.id) ?? session.nativeRunId : session.nativeRunId;
      const turnStatus = currentTurn ? asString(currentTurn.status) : undefined;
      const threadStatus = asString(asObject(thread.status).type);
      const active: ActiveCodex = {
        rpc,
        emit: onEvent,
        threadId: session.nativeSessionId,
        turnId: turnStatus === "inProgress" ? turnId : null,
        pendingUsage: null,
        fullAccess: request.workOrder.permissions === "full-access",
        outputSchema: isConductor(request.workOrder) || !hasStructuredOutputSchema(request.workOrder)
          ? null
          : strictCodexOutputSchema(request.workOrder.outputSchema),
        activeTools: new Set(),
        cancellation: null,
        pendingCancelled: null,
        finalOutputTurnId: null,
        idleTurnId: null,
        idleCompletion: null,
        lastSettledTurnId: null,
        initialTurn: null,
        initialTurnAcceptance: null,
          recoveringInitialTurn: false,
          pendingMessage: null,
      };
      this.active.set(session.nativeSessionId, active);
      rpc.updateProcessLease({
        nativeSessionId: session.nativeSessionId,
        nativeRunId: turnId ?? null,
        activeTurnId: turnStatus === "inProgress" ? turnId ?? null : null,
      });
      emit(onEvent, "session.started", {
        threadId: session.nativeSessionId,
        turnId,
        resumed: true,
        nativeStatus: turnStatus ?? threadStatus ?? "idle",
      });
      if (turnStatus === "inProgress" || (!currentTurn && threadStatus === "active")) {
        emit(onEvent, "run.started", { threadId: session.nativeSessionId, turnId, resumed: true });
        return { ...session, nativeRunId: turnId, state: "running" };
      }
      if (turnStatus === "completed") {
        const items = Array.isArray(currentTurn?.items) ? currentTurn.items.map(asObject) : [];
        const finalMessage = items.findLast((item) => item.type === "agentMessage" && item.phase !== "commentary");
        const text = finalMessage ? asString(finalMessage.text) : undefined;
        if (text) emit(onEvent, "output.completed", { text }, turnId ?? undefined);
        emit(onEvent, "run.completed", { threadId: session.nativeSessionId, turnId, status: turnStatus }, turnId ?? undefined);
        return { ...session, nativeRunId: turnId, state: "completed" };
      }
      if (turnStatus === "failed" || threadStatus === "systemError") {
        emit(onEvent, "run.failed", {
          threadId: session.nativeSessionId,
          turnId,
          status: turnStatus ?? threadStatus,
          error: currentTurn?.error ?? null,
        }, turnId ?? undefined);
        this.markTurnSettled(active, turnId ?? active.turnId);
        this.retireUnusableSession(active);
        return { ...session, nativeRunId: turnId, state: "failed" };
      }
      if (turnStatus === "interrupted") {
        emit(onEvent, "run.cancelled", { threadId: session.nativeSessionId, turnId, status: turnStatus }, turnId ?? undefined);
        this.markTurnSettled(active, turnId ?? active.turnId);
        this.retireUnusableSession(active);
        return { ...session, nativeRunId: turnId, state: "cancelled" };
      }
      return { ...session, nativeRunId: turnId, state: "idle" };
    } catch (error) {
      this.removeProcess(rpc);
      if (rpc.mode === "reconnected") await rpc.detach();
      else await rpc.close();
      throw error;
    } finally {
      options?.signal.removeEventListener("abort", abort);
    }
  }

  async sendMessage(session: DriverSession, message: string, request?: DriverMessageRequest): Promise<{ receiptId: string; queued: boolean }> {
    const active = this.require(session);
    const durable = messageRequest(message, request);
    if (active.pendingMessage) {
      if (active.pendingMessage.requestId !== durable.requestId || active.pendingMessage.contentHash !== durable.contentHash) {
        throw new Error("Codex native message is already pending with a different durable identity.");
      }
      return { receiptId: durable.requestId, queued: false };
    }
    active.pendingMessage = durable;
    this.checkpoint(active);
    if (active.turnId) {
      await active.rpc.request("turn/steer", {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        input: [{ type: "text", text: message, text_elements: [] }],
        // Codex app-server currently treats this as opaque request metadata;
        // retaining it in the request also gives a hosted process a stable
        // replay key when the response crosses a daemon crash window.
        _meta: { symphonyRequestId: durable.requestId, symphonyContentHash: durable.contentHash },
      });
      this.checkpoint(active);
      return { receiptId: durable.requestId, queued: false };
    }
    await this.startTurn(active, undefined, message, undefined, false, durable);
    return { receiptId: durable.requestId, queued: false };
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    if (!active.turnId) return;
    const turnId = active.turnId;
    const existingCancellation = active.cancellation;
    const cancellation = existingCancellation ?? createCancellationLatch();
    active.cancellation = cancellation;
    if (!existingCancellation && !active.pendingCancelled) {
      try {
        await active.rpc.request("turn/interrupt", { threadId: active.threadId, turnId });
      } catch (error) {
        if (active.cancellation === cancellation) active.cancellation = null;
        throw error;
      }
    }
    // The app-server acknowledges turn/interrupt before command_execution
    // grandchildren necessarily stop. Do not let the runtime settle this agent
    // until the terminal notification has been reconciled with active tools.
    await cancellation.promise;
  }

  async forceTerminate(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    this.active.delete(session.nativeSessionId);
    this.clearIdleCompletion(active);
    const pending = active.pendingCancelled;
    if (pending?.timer) clearTimeout(pending.timer);
    await active.rpc.close("SIGKILL");
    active.activeTools.clear();
    if (pending && active.pendingCancelled === pending) {
      active.pendingCancelled = null;
      this.emitCancelled(active, pending.params, pending.turnId, true);
    } else if (active.cancellation) {
      this.emitCancelled(active, {
        threadId: active.threadId,
        turnId: active.turnId,
        status: "interrupted",
        forced: true,
      }, active.turnId ?? undefined, true);
    }
  }

  async detach(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    this.active.delete(session.nativeSessionId);
    this.clearIdleCompletion(active);
    if (active.pendingCancelled?.timer) clearTimeout(active.pendingCancelled.timer);
    await active.rpc.detach();
  }

  async dispose(): Promise<void> {
    for (const active of this.active.values()) {
      if (active.pendingCancelled?.timer) clearTimeout(active.pendingCancelled.timer);
      this.clearIdleCompletion(active);
    }
    await Promise.allSettled([...this.active.values()].map((active) => active.rpc.detach()));
    this.active.clear();
  }

  private spawn(
    request: DriverStartRequest,
    consumer: Emit,
    processSupervisor?: DriverLifecycleOptions["processSupervisor"],
  ): JsonLineRpcTransport {
    const spec = {
      command: this.config.process.command,
      args: this.config.process.args,
      cwd: request.workOrder.workspace.path,
      env: environmentWithoutDaemonSecret(),
      ...(processSupervisor ? { processSupervisor } : {}),
      processRole: "codex-app-server",
    };
    const callbacks = {
      onNotification: (message: Record<string, unknown>) => this.onNotification(message, consumer),
      onRequest: async (message: Record<string, unknown>) => this.onServerRequest(message, request, consumer),
      onStderr: (line: string, nativeEventId?: string) => emit(consumer, "log", { stream: "stderr", line }, nativeEventId),
      onUnexpectedExit: (error: Error, nativeEventId?: string) => emit(consumer, "run.failed", { error: error.message, phase: "native-process" }, nativeEventId),
    };
    return HostedJsonLineProcess.shouldHost(spec)
      ? new HostedJsonLineProcess(spec, callbacks)
      : new JsonLineProcess(spec, callbacks.onNotification, callbacks.onRequest, callbacks.onStderr, callbacks.onUnexpectedExit);
  }

  private removeProcess(rpc: JsonLineRpcTransport): void {
    for (const [sessionId, active] of this.active.entries()) {
      if (active.rpc === rpc) this.active.delete(sessionId);
    }
  }

  private threadParams(request: DriverStartRequest): Record<string, unknown> {
    const full = request.workOrder.permissions === "full-access";
    return {
      model: request.resolvedModel === "auto" ? null : request.resolvedModel,
      cwd: request.workOrder.workspace.path,
      approvalPolicy: "never",
      sandbox: full ? "danger-full-access" : "read-only",
      developerInstructions: buildSymphonyOperatingContract(request.workOrder, coordinationPromptOptions(request)),
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

  private async startTurn(
    active: ActiveCodex,
    request: DriverStartRequest | undefined,
    text: string,
    initialTurn?: InitialTurnDispatch,
    resumed = false,
    messageRequestValue?: DriverMessageRequest,
  ): Promise<string> {
    this.clearIdleCompletion(active);
    active.finalOutputTurnId = null;
    active.idleTurnId = null;
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
    if (initialTurn) {
      active.initialTurn = initialTurn;
      active.initialTurnAcceptance = createInitialTurnAcceptance();
      active.recoveringInitialTurn = resumed;
      const responsePromise = active.rpc.requestWithId(
        initialTurn.requestId,
        "turn/start",
        params,
        30_000,
        (value) => {
          const response = asObject(value);
          const turnId = deepString(response, ["turn", "id"], ["turnId"]);
          if (!turnId) throw new Error(`Codex did not return a turn id: ${JSON.stringify(response)}`);
          this.acceptInitialTurn(active, turnId, "turn-start-response");
        },
      );
      // Native notifications can prove acceptance before a delayed response.
      // Keep the pending response observed if that evidence wins the race.
      void responsePromise.catch(() => undefined);
      try {
        return await Promise.race([
          responsePromise.then((value) => {
            const response = asObject(value);
            const turnId = deepString(response, ["turn", "id"], ["turnId"]);
            if (!turnId) throw new Error(`Codex did not return a turn id: ${JSON.stringify(response)}`);
            return turnId;
          }),
          active.initialTurnAcceptance.promise,
        ]);
      } finally {
        active.initialTurnAcceptance = null;
        active.recoveringInitialTurn = false;
      }
    }
    const response = asObject(await (messageRequestValue
      ? active.rpc.requestWithId(messageRequestValue.requestId, "turn/start", {
          ...params,
          _meta: { symphonyRequestId: messageRequestValue.requestId, symphonyContentHash: messageRequestValue.contentHash },
        })
      : active.rpc.request("turn/start", params)));
    const turnId = deepString(response, ["turn", "id"], ["turnId"]);
    if (!turnId) throw new Error(`Codex did not return a turn id: ${JSON.stringify(response)}`);
    active.turnId = turnId;
    active.rpc.updateProcessLease({
      nativeSessionId: active.threadId,
      nativeRunId: turnId,
      activeTurnId: turnId,
      adapterState: this.adapterState(active),
    });
    emit(active.emit, "run.started", withMessageIdentity({ threadId: active.threadId, turnId }, messageRequestValue ?? null));
    if (messageRequestValue) this.checkpoint(active);
    return turnId;
  }

  private onNotification(message: Record<string, unknown>, consumer: Emit): void {
    const method = asString(message.method) ?? asString(message.type) ?? "unknown";
    const params = record(message.params ?? message);
    const active = this.findActive(params, consumer);
    const observedTurnId = deepString(params, ["turn", "id"], ["turnId"]);
    if (active?.initialTurn?.state === "dispatching" && observedTurnId) {
      this.acceptInitialTurn(active, observedTurnId, "native-event");
    }
    const hostedFrameId = asString(message.__symphonyHostEventId);
    const emitNotification = (
      kind: DriverEvent["kind"],
      payload: unknown,
      nativeEventId?: string,
    ) => emit(
      consumer,
      kind,
      withMessageIdentity(payload, active?.pendingMessage ?? null),
      nativeEventId ?? (hostedFrameId ? `${hostedFrameId}:${kind}` : undefined),
    );
    if (method.includes("tokenUsage/updated")) {
      const threadId = deepString(params, ["threadId"], ["thread", "id"]);
      const usage = record(record(params.tokenUsage).last ?? params.usage);
      const usageSession = threadId
        ? this.active.get(threadId)
        : [...this.active.values()].find((candidate) => candidate.emit === consumer);
      if (usageSession && Object.keys(usage).length) {
        usageSession.pendingUsage = usage;
        if (!usageSession.turnId && usageSession.lastSettledTurnId) {
          this.flushPendingUsageSafely(usageSession, usageSession.lastSettledTurnId);
        }
      }
    } else if (method.includes("turn/completed")) {
      const threadId = deepString(params, ["threadId"], ["thread", "id"]);
      const turnId = deepString(params, ["turn", "id"], ["turnId"]);
      const status = deepString(params, ["turn", "status"], ["status"])?.toLowerCase();
      const session = threadId ? this.active.get(threadId) : active;
      if (session && turnId && session.lastSettledTurnId === turnId) return;
      if (session && turnId && session.turnId && session.turnId !== turnId) {
        emitNotification("log", { method, params, ignored: "late-terminal-for-non-active-turn" });
        return;
      }
      if (session) this.flushPendingUsageSafely(session, turnId ?? session.turnId ?? session.lastSettledTurnId);
      if (status === "interrupted" || status === "cancelled" || status === "canceled") {
        if (active) {
          this.clearIdleCompletion(active);
          this.reconcileCancelledTurn(active, params, turnId);
        }
        else emitNotification("run.cancelled", params, turnId);
      } else if (status === "failed" || status === "error") {
        emitNotification("run.failed", params, turnId);
        if (session) {
          this.markTurnSettled(session, turnId ?? session.turnId);
          this.retireUnusableSession(session);
        }
      } else {
        emitNotification("run.completed", params, turnId);
        if (session) this.markTurnSettled(session, turnId ?? session.turnId);
      }
    } else if (method.includes("thread/status/changed")) {
      const nativeStatus = deepString(params, ["status", "type"], ["status"])?.toLowerCase();
      if (active?.turnId && nativeStatus === "idle") {
        active.idleTurnId = active.turnId;
        this.scheduleIdleCompletion(active);
      } else if (active && nativeStatus === "active") {
        active.idleTurnId = null;
        this.clearIdleCompletion(active);
      }
      emitNotification("log", { method, params });
    } else if (method.includes("turn/failed") || method.includes("error")) {
      emitNotification("run.failed", params);
      if (active) {
        this.markTurnSettled(active, active.turnId);
        this.retireUnusableSession(active);
      }
    } else if (method.includes("agentMessage") && method.includes("delta")) {
      const text = deepString(params, ["delta"], ["text"], ["item", "delta"], ["item", "textDelta"]);
      if (text) emitNotification("message.delta", { text, messageId: deepString(params, ["itemId"], ["item", "id"]) ?? null });
    } else if (method.includes("reasoning") && method.includes("delta")) {
      const text = deepString(params, ["delta"], ["text"], ["item", "delta"], ["item", "textDelta"]);
      if (text) emitNotification("reasoning.delta", { text });
    } else if (method.includes("item/started")) {
      const tool = codexToolEvent(params);
      if (tool) {
        active?.activeTools.add(tool.toolCallId);
        emitNotification("tool.started", tool, tool.toolCallId);
      }
      else emitNotification("log", { method, params });
    } else if (method.includes("command") || method.includes("tool")) {
      const tool = codexToolEvent(params);
      if (tool && method.includes("completed")) this.markToolQuiescent(active, tool.toolCallId);
      emitNotification(
        method.includes("completed") ? "tool.completed" : "tool.updated",
        tool ?? { method, ...params },
        tool?.toolCallId,
      );
    } else if (method.includes("item/completed")) {
      const text = deepString(params, ["item", "text"], ["item", "content"], ["text"]);
      const item = record(params.item);
      const phase = asString(item.phase);
      if (text) emitNotification("message.completed", params);
      else {
        const tool = codexToolEvent(params);
        if (tool) {
          this.markToolQuiescent(active, tool.toolCallId);
          emitNotification("tool.completed", tool, tool.toolCallId);
        }
        else emitNotification("log", { method, params });
      }
      if (text && phase !== "commentary") {
        emitNotification("output.completed", { text });
        const itemTurnId = deepString(params, ["turnId"], ["turn", "id"]);
        if (active?.turnId && itemTurnId === active.turnId) {
          active.finalOutputTurnId = itemTurnId;
          this.scheduleIdleCompletion(active);
        }
      }
    } else {
      emitNotification("log", { method, params });
    }
    const checkpointTarget = this.findActive(params, consumer);
    if (checkpointTarget) this.checkpoint(checkpointTarget);
  }

  private findActive(params: Record<string, unknown>, consumer: Emit): ActiveCodex | undefined {
    const threadId = deepString(params, ["threadId"], ["thread", "id"]);
    return (threadId ? this.active.get(threadId) : undefined)
      ?? [...this.active.values()].find((candidate) => candidate.emit === consumer);
  }

  private restoreRetainedCancellation(active: ActiveCodex, retainedState: Record<string, unknown>): void {
    const pendingCancellation = record(retainedState.pendingCancellation);
    const pendingTurnId = asString(pendingCancellation.turnId) ?? undefined;
    if (
      Object.keys(pendingCancellation).length > 0
      && pendingTurnId
      && active.turnId === pendingTurnId
      && active.lastSettledTurnId !== pendingTurnId
      && !active.pendingCancelled
    ) {
      // Install the durable marker before replay. Replay checkpoints must not
      // erase cancellation evidence if this daemon dies during activation.
      active.pendingCancelled = {
        params: record(pendingCancellation.params),
        turnId: pendingTurnId,
        timer: null,
      };
    }
  }

  private armRetainedLifecycle(active: ActiveCodex, retainedState: Record<string, unknown>): void {
    if (active.pendingCancelled && active.pendingCancelled.timer === null) {
      if (active.activeTools.size === 0) {
        const pending = active.pendingCancelled;
        active.pendingCancelled = null;
        this.emitCancelled(active, pending.params, pending.turnId, false);
      } else {
        active.pendingCancelled.timer = setTimeout(() => {
          void this.terminateCancelledTools(active);
        }, CODEX_TOOL_QUIESCENCE_GRACE_MS);
        this.checkpoint(active);
      }
    }
    const retainedAttempt = retainedState.idleCompletionAttempt;
    const idleAttempt = typeof retainedAttempt === "number"
      && Number.isSafeInteger(retainedAttempt)
      && retainedAttempt >= 0
      && retainedAttempt < CODEX_IDLE_COMPLETION_MAX_ATTEMPTS
      ? retainedAttempt
      : 0;
    this.scheduleIdleCompletion(active, idleAttempt);
  }

  private reconcileCancelledTurn(
    active: ActiveCodex,
    params: Record<string, unknown>,
    turnId: string | undefined,
  ): void {
    if (active.activeTools.size === 0) {
      this.emitCancelled(active, params, turnId, false);
      return;
    }
    if (active.pendingCancelled) return;
    const timer = setTimeout(() => {
      void this.terminateCancelledTools(active);
    }, CODEX_TOOL_QUIESCENCE_GRACE_MS);
    active.pendingCancelled = { params, turnId, timer };
    this.checkpoint(active);
  }

  private markToolQuiescent(active: ActiveCodex | undefined, toolCallId: string): void {
    if (!active) return;
    active.activeTools.delete(toolCallId);
    this.checkpoint(active);
    if (active.activeTools.size !== 0 || !active.pendingCancelled) return;
    if (active.pendingCancelled.timer) clearTimeout(active.pendingCancelled.timer);
    const pending = active.pendingCancelled;
    active.pendingCancelled = null;
    this.emitCancelled(active, pending.params, pending.turnId, false);
    this.scheduleIdleCompletion(active);
  }

  private async terminateCancelledTools(active: ActiveCodex): Promise<void> {
    const pending = active.pendingCancelled;
    if (!pending) return;
    active.pendingCancelled = null;
    this.active.delete(active.threadId);
    try {
      await active.rpc.close("SIGKILL");
      active.activeTools.clear();
      this.emitCancelled(active, pending.params, pending.turnId, true);
    } catch (error) {
      emit(active.emit, "run.failed", {
        error: stringifyError(error),
        phase: "cancel-active-tools",
        status: "termination-unconfirmed",
      }, pending.turnId);
      // Leave cancellation unresolved so the coordinator records an
      // interrupted/unconfirmed outcome instead of a false cancellation.
    }
  }

  private emitCancelled(
    active: ActiveCodex,
    params: Record<string, unknown>,
    turnId: string | undefined,
    processTreeTerminated: boolean,
  ): void {
    const pendingMessage = active.pendingMessage;
    this.markTurnSettled(active, turnId ?? active.turnId);
    emit(active.emit, "run.cancelled", withMessageIdentity({
      ...params,
      toolCleanup: processTreeTerminated ? "process-tree-terminated" : "quiescent",
    }, pendingMessage), turnId);
    active.cancellation?.resolve();
    active.cancellation = null;
    this.retireUnusableSession(active);
  }

  private retireUnusableSession(active: ActiveCodex): void {
    if (this.active.get(active.threadId) !== active) return;
    this.active.delete(active.threadId);
    this.clearIdleCompletion(active);
    if (active.pendingCancelled?.timer) clearTimeout(active.pendingCancelled.timer);
    void active.rpc.close().catch((error: unknown) => {
      emit(active.emit, "log", {
        phase: "terminal-session-retirement",
        error: stringifyError(error),
      });
    });
  }

  private scheduleIdleCompletion(active: ActiveCodex, attempt = 0): void {
    const turnId = active.turnId;
    if (
      !turnId
      || active.finalOutputTurnId !== turnId
      || active.idleTurnId !== turnId
      || active.activeTools.size > 0
      || active.cancellation
      || active.pendingCancelled
      || active.idleCompletion
    ) return;
    const timer = setTimeout(() => {
      if (active.idleCompletion?.timer === timer) active.idleCompletion = null;
      if (
        this.active.get(active.threadId) !== active
        || active.turnId !== turnId
        || active.finalOutputTurnId !== turnId
        || active.idleTurnId !== turnId
        || active.activeTools.size > 0
        || active.cancellation
        || active.pendingCancelled
      ) return;
      this.flushPendingUsageSafely(active, turnId);
      try {
        emit(active.emit, "run.completed", {
          threadId: active.threadId,
          turnId,
          status: "completed",
          terminalEvidence: "thread-idle-after-final-output",
        }, turnId);
        this.markTurnSettled(active, turnId);
      } catch (error) {
        try {
          emit(active.emit, "log", {
            phase: "idle-completion-projection",
            turnId,
            error: stringifyError(error),
            attempt: attempt + 1,
          });
        } catch {
          // A projection failure must not escape a timer callback and crash the daemon.
        }
        if (attempt + 1 < CODEX_IDLE_COMPLETION_MAX_ATTEMPTS) {
          this.scheduleIdleCompletion(active, attempt + 1);
        }
      }
    }, CODEX_IDLE_COMPLETION_GRACE_MS);
    active.idleCompletion = { turnId, timer, attempt };
    this.checkpoint(active);
  }

  private clearIdleCompletion(active: ActiveCodex): void {
    if (active.idleCompletion) clearTimeout(active.idleCompletion.timer);
    active.idleCompletion = null;
  }

  private markTurnSettled(active: ActiveCodex, turnId: string | null | undefined): void {
    if (!turnId) return;
    this.clearIdleCompletion(active);
    if (active.turnId === turnId) active.turnId = null;
    if (active.finalOutputTurnId === turnId) active.finalOutputTurnId = null;
    if (active.idleTurnId === turnId) active.idleTurnId = null;
    active.lastSettledTurnId = turnId;
    active.pendingMessage = null;
    active.rpc.updateProcessLease({ activeTurnId: null, adapterState: this.adapterState(active) });
  }

  private flushPendingUsageSafely(active: ActiveCodex, turnId: string | null | undefined): void {
    if (!active.pendingUsage) return;
    const usage = active.pendingUsage;
    try {
      emit(active.emit, "usage.recorded", { usage, basis: "harness-reported" }, turnId ?? undefined);
      active.pendingUsage = null;
      this.checkpoint(active);
    } catch (error) {
      try {
        emit(active.emit, "log", {
          phase: "usage-projection",
          turnId: turnId ?? null,
          error: stringifyError(error),
        });
      } catch {
        // Keep the pending usage for a later terminal or late-usage retry.
      }
    }
  }

  private checkpoint(active: ActiveCodex): void {
    active.rpc.updateProcessLease({ adapterState: this.adapterState(active) });
  }

  private adapterState(active: ActiveCodex): JsonValue {
    return {
      version: 1,
      turnId: active.turnId,
      activeToolIds: [...active.activeTools],
      pendingUsage: active.pendingUsage as JsonValue,
      finalOutputTurnId: active.finalOutputTurnId,
      idleTurnId: active.idleTurnId,
      lastSettledTurnId: active.lastSettledTurnId,
      pendingCancellation: active.pendingCancelled
        ? {
            params: active.pendingCancelled.params as JsonValue,
            turnId: active.pendingCancelled.turnId ?? null,
          }
        : null,
      idleCompletionAttempt: active.idleCompletion?.attempt ?? null,
      ...(active.initialTurn ? { initialTurn: active.initialTurn } : {}),
      pendingMessage: active.pendingMessage as unknown as JsonValue,
    };
  }

  private retainedInitialTurn(state: Record<string, unknown>): InitialTurnDispatch | null {
    const value = record(state.initialTurn);
    if (typeof value.id !== "string" || typeof value.requestId !== "string") return null;
    if (value.state !== "dispatching" && value.state !== "accepted") return null;
    return {
      id: value.id,
      requestId: value.requestId,
      state: value.state,
      turnId: asString(value.turnId) ?? null,
    };
  }

  /** Persist the native thread before its first turn can cross stdin. */
  private checkpointInitialTurn(active: ActiveCodex): void {
    active.rpc.updateProcessLease({
      nativeSessionId: active.threadId,
      nativeRunId: null,
      activeTurnId: null,
      adapterState: this.adapterState(active),
    });
  }

  /**
   * This callback runs inside transport response dispatch, before a hosted
   * response frame is acknowledged. A replacement controller can therefore
   * either observe the accepted checkpoint or replay that same retained frame.
   */
  private acceptInitialTurn(active: ActiveCodex, turnId: string, evidence: string): void {
    const initialTurn = active.initialTurn;
    if (!initialTurn) return;
    if (initialTurn.state === "accepted") {
      if (initialTurn.turnId === turnId) active.initialTurnAcceptance?.resolve(turnId);
      else if (evidence === "turn-start-response") {
        throw new Error(`Codex initial turn identity changed from ${String(initialTurn.turnId)} to ${turnId}.`);
      }
      return;
    }
    active.turnId = turnId;
    active.initialTurn = { ...initialTurn, state: "accepted", turnId };
    active.rpc.updateProcessLease({
      nativeSessionId: active.threadId,
      nativeRunId: turnId,
      activeTurnId: turnId,
      adapterState: this.adapterState(active),
    });
    emit(active.emit, "run.started", {
      threadId: active.threadId,
      turnId,
      ...(active.recoveringInitialTurn ? { resumed: true } : {}),
      acceptanceEvidence: evidence,
    }, `codex-turn:${active.threadId}:${turnId}:started`);
    active.initialTurnAcceptance?.resolve(turnId);
  }

  private async onServerRequest(message: Record<string, unknown>, request: DriverStartRequest, consumer: Emit): Promise<unknown> {
    const method = asString(message.method) ?? "unknown";
    const hostedFrameId = asString(message.__symphonyHostEventId);
    emit(consumer, "approval.requested", { method, params: message.params ?? null }, hostedFrameId ? `${hostedFrameId}:approval.requested` : undefined);
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

function retainedMessageDispatch(state: Record<string, unknown>): DriverMessageRequest | null {
  const value = record(state.pendingMessage);
  if (typeof value.attemptId !== "string" || typeof value.requestId !== "string" || typeof value.contentHash !== "string") return null;
  return { attemptId: value.attemptId, requestId: value.requestId, contentHash: value.contentHash };
}

function codexToolEvent(params: Record<string, unknown>): {
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: unknown;
  result?: unknown;
  isError?: boolean;
} | null {
  const item = record(params.item);
  const itemType = asString(item.type) ?? "";
  if (!itemType || /agentMessage|assistant|reasoning|userMessage|plan/iu.test(itemType)) return null;
  const toolCallId = asString(item.id);
  if (!toolCallId) return null;
  const toolName = asString(item.tool)
    ?? (itemType === "commandExecution"
      ? "command_execution"
      : itemType === "fileChange"
        ? "file_change"
        : itemType);
  const args = item.arguments
    ?? (item.command !== undefined ? { command: item.command } : undefined)
    ?? (item.changes !== undefined ? { changes: item.changes } : undefined)
    ?? (item.prompt !== undefined ? { prompt: item.prompt } : {});
  const nativeResult = record(item.result);
  const result = nativeResult.structuredContent
    ?? item.result
    ?? item.output
    ?? item.aggregatedOutput
    ?? item.contentItems
    ?? (item.exitCode !== undefined ? { exitCode: item.exitCode } : undefined);
  const status = item.status ?? "inProgress";
  const failed = status === "failed" || item.success === false || item.error != null;
  return {
    toolCallId,
    toolName,
    args,
    status,
    ...(result !== undefined ? { result } : {}),
    ...(failed ? { isError: true } : {}),
  };
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
