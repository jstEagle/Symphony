import { Cursor, type AgentOptions, type SDKMessage } from "@cursor/sdk";
import { environmentWithoutDaemonSecret, type SecretStore, type SymphonyConfig } from "@symphony/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  DriverAuthenticationResult,
  DriverDoctorResult,
  DriverEvent,
  DriverLifecycleOptions,
  DriverMessageRequest,
  DriverSession,
  DriverStartRequest,
  JsonValue,
  ModelDescriptor,
  WorkerDriver,
} from "@symphony/protocol";
import { buildAgentPrompt, coordinationPromptOptions } from "./prompt.js";
import { HostedJsonLineProcess } from "./hosted-process.js";
import { JsonLineProcess, asObject, asString, type JsonLineRpcTransport } from "./process.js";
import { capabilities, emit, makeSession, messageRequest, record, stringifyError, toJson, withMessageIdentity, type Emit } from "./common.js";

export type EffectiveModel = {
  mode: "auto" | "explicit" | "resolved-auto";
  id: string | null;
  params: Array<{ id: string; value: string }>;
};
type InitialCursorDispatch = {
  requestId: string;
  state: "dispatching" | "accepted";
  sessionId: string | null;
  runId: string | null;
  generation: number;
};
type CursorPromptDispatch = {
  attemptId: string;
  requestId: string;
  contentHash: string;
  state: "dispatching" | "accepted";
  baseRunId: string | null;
  baseGeneration: number;
  runId: string | null;
  generation: number | null;
};
type ActiveCursor = {
  request: DriverStartRequest;
  emit: Emit;
  rpc: JsonLineRpcTransport;
  session: DriverSession;
  running: boolean;
  settled: boolean;
  generation: number;
  terminalRunId: string | null;
  terminalGeneration: number | null;
  effectiveModel: EffectiveModel;
  initialDispatch: InitialCursorDispatch | null;
  promptDispatch: CursorPromptDispatch | null;
};
type PreparedCursorOptions = { options: AgentOptions; effectiveModel: EffectiveModel };
type CursorSdkApi = Pick<typeof Cursor, "auth" | "models">;

export function cursorEffectiveModelsEqual(left: EffectiveModel, right: EffectiveModel): boolean {
  return left.mode === right.mode
    && left.id === right.id
    && left.params.length === right.params.length
    && left.params.every((parameter, index) => {
      const candidate = right.params[index];
      return candidate?.id === parameter.id && candidate.value === parameter.value;
    });
}

export function environmentWithoutCursorApiKey(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = environmentWithoutDaemonSecret(environment);
  for (const key of Object.keys(childEnvironment)) {
    if (key.toUpperCase() === "CURSOR_API_KEY") delete childEnvironment[key];
  }
  return childEnvironment;
}

export class CursorDriver implements WorkerDriver {
  readonly id = "cursor" as const;
  readonly capabilities = capabilities({ cloud: true });
  private readonly active = new Map<string, ActiveCursor>();
  private authenticationAttempt: Promise<DriverAuthenticationResult> | null = null;
  private catalogCache: { source: string; checkedAt: number; models: ModelDescriptor[] } | null = null;
  private sdkApiPromise: Promise<CursorSdkApi> | null = null;

  constructor(
    private readonly config: SymphonyConfig["harnesses"]["cursor"],
    private readonly secrets: SecretStore,
  ) {}

  async doctor(): Promise<DriverDoctorResult> {
    if (!this.config.enabled) return this.result(false, false, null, "Cursor driver is disabled.");
    const version = await JsonLineProcess.probe(this.config.process.command, [...this.config.process.args, "--version"]);
    if (!version) return this.result(false, false, null, "Cursor Agent CLI was not found.");
    const cliStatus = await JsonLineProcess.probe(this.config.process.command, [...this.config.process.args, "status"]);
    const cliAuthenticated = cursorStatusIsAuthenticated(cliStatus);
    const credential = await this.runtimeCredential();
    if (!credential) {
      return this.result(true, false, version, cliAuthenticated
        ? "Cursor CLI is signed in, but Symphony runs Cursor through @cursor/sdk. Authenticate the Cursor SDK here or configure cursor.apiKey."
        : "Cursor SDK authentication is required. Authenticate here or configure cursor.apiKey.");
    }
    try {
      await this.sdkModels(credential);
      return this.result(true, true, version, credential.source === "configured-api-key"
        ? `Cursor SDK runtime is verified with the configured API key${cliAuthenticated ? "; the CLI account is also signed in" : ""}.`
        : `Cursor SDK login is verified${credential.email ? ` for ${credential.email}` : ""}${cliAuthenticated ? "; the CLI account is also signed in" : ""}.`);
    } catch (error) {
      return this.result(true, false, version, cursorAuthenticationFailureDetail(error, cliAuthenticated));
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const credential = await this.runtimeCredential();
    if (!credential) return [];
    try {
      return await this.sdkModels(credential);
    } catch {
      // CLI authentication and its catalog are not runtime evidence for the
      // SDK transport Symphony actually uses. Fail closed instead of exposing
      // model cards that cannot be launched.
      return [];
    }
  }

  async authenticate(): Promise<DriverAuthenticationResult> {
    if (this.authenticationAttempt) return await this.authenticationAttempt;
    this.authenticationAttempt = this.authenticateOnce().finally(() => {
      this.authenticationAttempt = null;
    });
    return await this.authenticationAttempt;
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void, lifecycle?: DriverLifecycleOptions): Promise<DriverSession> {
    lifecycle?.signal.throwIfAborted();
    const prepared = await this.options(request);
    lifecycle?.signal.throwIfAborted();
    const rpc = this.spawn(request, onEvent, lifecycle?.processSupervisor);
    const provisionalSessionId = `cursor-pending:${request.agentId}`;
    const provisional = makeSession(this.id, provisionalSessionId, {
      agentId: request.agentId,
      transportReusable: true,
      effectiveModel: prepared.effectiveModel as unknown as JsonValue,
    });
    provisional.nativeRunId = null;
    provisional.state = "starting";
    const active: ActiveCursor = {
      request,
      emit: onEvent,
      rpc,
      session: provisional,
      running: true,
      settled: false,
      generation: 0,
      terminalRunId: null,
      terminalGeneration: null,
      effectiveModel: prepared.effectiveModel,
      initialDispatch: { requestId: `cursor:initial-run:${request.agentId}`, state: "dispatching", sessionId: null, runId: null, generation: 0 },
      promptDispatch: null,
    };
    this.active.set(provisionalSessionId, active);
    const abort = () => {
      this.removeProcess(rpc);
      void (rpc.mode === "reconnected" ? rpc.detach() : rpc.close("SIGKILL")).catch(() => undefined);
    };
    lifecycle?.signal.addEventListener("abort", abort, { once: true });
    try {
      await rpc.activate();
      this.checkpoint(active);
      const initial = active.initialDispatch;
      if (!initial) throw new Error("Cursor initial dispatch checkpoint is unavailable.");
      const result = asObject(await rpc.requestWithId(
        initial.requestId,
        "session/start",
        { requestId: initial.requestId, prompt: buildAgentPrompt(request.workOrder, coordinationPromptOptions(request)), options: prepared.options, effectiveModel: prepared.effectiveModel },
        0,
        (value) => this.acceptDispatch(active, asObject(value), "start-response"),
      ));
      this.acceptDispatch(active, result, "start-response");
      lifecycle?.signal.throwIfAborted();
      emit(onEvent, "session.started", {
        agentId: active.session.nativeSessionId,
        runId: active.session.nativeRunId,
        generation: active.generation,
        cloud: Boolean(request.workOrder.workspace.remoteRepository),
      }, `cursor-session:${active.session.nativeSessionId}:started`);
      return active.session;
    } catch (error) {
      this.removeProcess(rpc);
      if (rpc.mode === "reconnected") await rpc.detach();
      else await rpc.close();
      throw error;
    } finally {
      lifecycle?.signal.removeEventListener("abort", abort);
    }
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void, lifecycle?: DriverLifecycleOptions): Promise<DriverSession> {
    lifecycle?.signal.throwIfAborted();
    const prepared = await this.options(request);
    lifecycle?.signal.throwIfAborted();
    const rpc = this.spawn(request, onEvent, lifecycle?.processSupervisor);
    const retained = record(rpc.retainedAdapterState());
    const retainedModel = this.retainedEffectiveModel(retained.effectiveModel) ?? prepared.effectiveModel;
    const resumedSession: DriverSession = {
      ...session,
      nativeSessionId: asString(retained.sessionId) ?? session.nativeSessionId,
      nativeRunId: asString(retained.runId) ?? session.nativeRunId,
      metadata: { ...session.metadata, transportReusable: true, effectiveModel: retainedModel as unknown as JsonValue },
    };
    const active: ActiveCursor = {
      request,
      emit: onEvent,
      rpc,
      session: resumedSession,
      running: retained.running === true || session.state === "running" || session.state === "starting",
      settled: retained.settled === true,
      generation: typeof retained.generation === "number" && Number.isSafeInteger(retained.generation) ? retained.generation : 0,
      terminalRunId: retained.running === false && retained.runId && typeof retained.runId === "string" ? retained.runId : null,
      terminalGeneration: retained.running === false && typeof retained.generation === "number" && Number.isSafeInteger(retained.generation)
        ? retained.generation
        : null,
      effectiveModel: retainedModel,
      initialDispatch: this.retainedInitialDispatch(retained),
      promptDispatch: this.retainedPromptDispatch(retained),
    };
    if (active.initialDispatch?.state === "dispatching"
      && !cursorEffectiveModelsEqual(active.effectiveModel, prepared.effectiveModel)) {
      throw new Error("Cursor effective model changed while the initial native dispatch outcome is unknown; refusing to replay with different model state.");
    }
    if (active.running && !cursorEffectiveModelsEqual(active.effectiveModel, prepared.effectiveModel)) {
      throw new Error("Cursor effective model changed while a native run is active; refusing to resume with ambiguous model state.");
    }
    this.active.set(active.session.nativeSessionId, active);
    const abort = () => {
      this.removeProcess(rpc);
      void (rpc.mode === "reconnected" ? rpc.detach() : rpc.close("SIGKILL")).catch(() => undefined);
    };
    lifecycle?.signal.addEventListener("abort", abort, { once: true });
    try {
      const initial = active.initialDispatch;
      const pendingStart = rpc.mode === "reconnected" && initial?.state === "dispatching"
        ? rpc.requestWithId(
            initial.requestId,
            "session/start",
            { requestId: initial.requestId, prompt: buildAgentPrompt(request.workOrder, coordinationPromptOptions(request)), options: prepared.options, effectiveModel: prepared.effectiveModel },
            0,
            (value) => this.acceptDispatch(active, asObject(value), "replayed-start-response"),
          )
        : null;
      await rpc.activate();
      if (pendingStart) this.acceptDispatch(active, asObject(await pendingStart), "replayed-start-response");
      else {
        const status = asObject(await rpc.request("session/attach", {
          sessionId: active.session.nativeSessionId,
          runId: active.session.nativeRunId,
          requestId: active.promptDispatch?.requestId ?? active.initialDispatch?.requestId,
          generation: active.generation,
          options: prepared.options,
          runOptions: this.runOptions(active.session, request),
          effectiveModel: prepared.effectiveModel,
        }, 30_000));
        this.applyStatus(active, status);
        const hostModel = this.retainedEffectiveModel(status.effectiveModel);
        if (!hostModel || !cursorEffectiveModelsEqual(hostModel, prepared.effectiveModel)) {
          throw new Error("Cursor SDK host did not confirm the complete effective model tuple during attach.");
        }
        active.effectiveModel = hostModel;
      }
      lifecycle?.signal.throwIfAborted();
      active.session = {
        ...active.session,
        state: active.promptDispatch?.state === "dispatching"
          ? "unknown"
          : active.running ? "running" : active.settled ? "completed" : "idle",
        metadata: {
          ...active.session.metadata,
          transportReusable: rpc.isReusable(),
          effectiveModel: active.effectiveModel as unknown as JsonValue,
        },
      };
      this.checkpoint(active);
      emit(onEvent, "session.started", {
        agentId: active.session.nativeSessionId,
        runId: active.session.nativeRunId,
        generation: active.generation,
        resumed: true,
        nativeStatus: active.session.state,
      }, `cursor-session:${active.session.nativeSessionId}:started`);
      return active.session;
    } catch (error) {
      this.removeProcess(rpc);
      if (rpc.mode === "reconnected") await rpc.detach();
      else await rpc.close();
      throw error;
    } finally {
      lifecycle?.signal.removeEventListener("abort", abort);
    }
  }

  async sendMessage(session: DriverSession, message: string, request?: DriverMessageRequest): Promise<{
    receiptId: string;
    queued: boolean;
    terminalBoundary?: boolean;
    session?: DriverSession;
  }> {
    const active = this.require(session);
    const durableBase = messageRequest(message, request);
    const durable = request
      ? durableBase
      : { ...durableBase, requestId: `cursor:prompt:${session.metadata.agentId ?? session.nativeSessionId}:${durableBase.requestId.replace(/^legacy:/u, "")}` };
    const existing = active.promptDispatch;
    if (existing) {
      if (existing.requestId === durable.requestId && (existing.contentHash === durable.contentHash || existing.contentHash === "")) {
        return { receiptId: durable.requestId, queued: false, ...(active.session.state === "running" ? { session: active.session } : {}) };
      }
      if (existing.state === "dispatching" || active.running) {
        throw new Error("Cursor native message is already pending with a different durable identity.");
      }
      // The prior accepted marker is historical after terminal projection;
      // reuse the same slot for a new durable follow-up.
      active.promptDispatch = null;
    }
    const requestId = durable.requestId;
    active.promptDispatch = {
      attemptId: durable.attemptId,
      requestId,
      contentHash: durable.contentHash,
      state: "dispatching",
      baseRunId: active.session.nativeRunId,
      baseGeneration: active.generation,
      runId: null,
      generation: null,
    };
    this.checkpoint(active);
    const result = asObject(await active.rpc.requestWithId(requestId, "session/prompt", {
      prompt: message,
      requestId,
      contentHash: durable.contentHash,
      effectiveModel: active.effectiveModel,
    }, 0));
    const terminalBoundary = result.terminalBoundary === true;
    if (!terminalBoundary && (asString(result.requestId) !== durable.requestId || asString(result.contentHash) !== durable.contentHash)) {
      throw new Error("Cursor host did not echo the durable follow-up identity; acceptance is unknown.");
    }
    if (terminalBoundary) {
      // This response explicitly says no prompt crossed the native boundary;
      // the runtime may retry it once the preceding result is acknowledged.
      active.promptDispatch = null;
      this.checkpoint(active);
    } else {
      this.acceptRun(active, result, "follow-up-response");
      this.acceptPromptDispatch(active, result, "follow-up-response");
    }
    return {
      receiptId: durable.requestId,
      queued: result.queued === true,
      ...(terminalBoundary ? { terminalBoundary: true } : { session: active.session }),
    };
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    const result = asObject(await active.rpc.request("session/cancel", {}, 0));
    if (result.terminalBoundary === true) return;
    if (result.cancelled !== true) throw new Error("Cursor host did not confirm native cancellation.");
  }

  async forceTerminate(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    this.removeProcess(active.rpc);
    await active.rpc.close("SIGTERM", 2_000);
  }

  async detach(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    this.removeProcess(active.rpc);
    // A hosted transport is durable whether this controller launched it or
    // reconnected to it. Only a direct adapter is owned by the daemon process
    // and must be terminated when its controller goes away.
    if (active.rpc.mode === "direct") await active.rpc.close("SIGTERM", 2_000);
    else await active.rpc.detach();
  }

  async dispose(): Promise<void> {
    const processes = new Set([...this.active.values()].map((active) => active.rpc));
    this.active.clear();
    await Promise.allSettled([...processes].map((rpc) => rpc.mode === "direct" ? rpc.close() : rpc.detach()));
  }

  private async options(request: DriverStartRequest): Promise<PreparedCursorOptions> {
    const isCloud = Boolean(request.workOrder.workspace.remoteRepository);
    if (isCloud && request.workOrder.permissions === "read-only") {
      throw new Error("Cursor Cloud does not support enforceable read-only tool restrictions; use a local Cursor agent or full-access.");
    }
    let model = request.resolvedModel;
    let mode: EffectiveModel["mode"] = model === "auto" ? "auto" : "explicit";
    if (!isCloud && model === "auto") {
      const available = await this.listModels();
      if (!available[0]) throw new Error("Cursor local agents require an explicit model and no authenticated model catalog was available.");
      model = available[0].id;
      mode = "resolved-auto";
    }
    const credential = await this.runtimeCredential();
    if (!credential) {
      throw new Error("Cursor SDK authentication is required before native work can start. Cursor CLI login is separate; authenticate the Cursor SDK in Symphony Settings or configure cursor.apiKey.");
    }
    // The controlled credential is passed only as an SDK option. It never
    // enters child environment variables, arguments, leases, events, or logs.
    const apiKey = credential.apiKey;
    const effectiveModel: EffectiveModel = { mode, id: model === "auto" ? null : model, params: [] };
    const options: AgentOptions = {
      name: request.workOrder.objective.slice(0, 100),
      idempotencyKey: `symphony:${request.agentId}`,
      ...(!isCloud ? { agentId: `symphony-${request.agentId}` } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(effectiveModel.id ? { model: { id: effectiveModel.id } } : {}),
      mcpServers: {
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
    };
    if (isCloud) {
      options.cloud = {
        repos: [{ url: request.workOrder.workspace.remoteRepository as string, ...(request.workOrder.workspace.startingRef ? { startingRef: request.workOrder.workspace.startingRef } : {}) }],
        autoCreatePR: this.config.autoCreatePR,
        metadata: { symphonyAgentId: request.agentId, workflowId: request.workOrder.workflowId, runId: request.workOrder.runId },
      };
    } else {
      options.local = { cwd: request.workOrder.workspace.path, sandboxOptions: { enabled: request.workOrder.permissions === "read-only" } };
      if (request.workOrder.permissions === "read-only") options.tools = ["read", "grep", "glob", "ls", "webSearch", "webFetch", "mcp"];
    }
    return { options, effectiveModel };
  }

  private spawn(request: DriverStartRequest, consumer: Emit, processSupervisor?: DriverLifecycleOptions["processSupervisor"]): JsonLineRpcTransport {
    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const builtHost = resolve(sourceDirectory, "cursor-host.js");
    const sourceHost = resolve(sourceDirectory, "cursor-host.ts");
    const host = existsSync(builtHost) ? builtHost : sourceHost;
    const tsxImport = host.endsWith(".ts") ? fileURLToPath(import.meta.resolve("tsx")) : null;
    const hostEnvironment = environmentWithoutCursorApiKey();
    // The controlled cloud credential is passed only in AgentOptions. Keeping
    // an ambient copy in either local or cloud host environments would create
    // an uncontrolled stderr/crash-report leak path and could override native
    // login selection.
    const spec = {
      command: process.execPath,
      args: tsxImport ? ["--import", tsxImport, host] : [host],
      cwd: request.workOrder.workspace.path,
      env: hostEnvironment,
      ...(processSupervisor ? { processSupervisor } : {}),
      processRole: "cursor-sdk-host",
      adapterVersion: "cursor-sdk-host:v2",
    };
    const callbacks = {
      onNotification: (message: Record<string, unknown>) => this.onNotification(message, consumer),
      onStderr: (line: string, nativeEventId?: string) => emit(consumer, "log", { stream: "stderr", line: line.replaceAll(request.coordination.token, "[REDACTED]") }, nativeEventId),
      onUnexpectedExit: (error: Error, nativeEventId?: string) => emit(consumer, "run.failed", { error: error.message, phase: "cursor-sdk-host" }, nativeEventId ? `${nativeEventId}:run.failed` : undefined),
    };
    return HostedJsonLineProcess.shouldHost(spec)
      ? new HostedJsonLineProcess(spec, callbacks)
      : new JsonLineProcess(spec, callbacks.onNotification, undefined, callbacks.onStderr, callbacks.onUnexpectedExit);
  }

  private onNotification(message: Record<string, unknown>, consumer: Emit): void {
    const method = asString(message.method) ?? asString(message.type) ?? "unknown";
    const params = record(message.params);
    const hostedFrameId = asString(message.__symphonyHostEventId);
    const active = this.findActive(consumer);
    if (!active) return;
    if (method === "cursor/session-created") {
      const sessionId = asString(params.agentId);
      if (sessionId) this.acceptSession(active, sessionId, "session-created-notification");
      return;
    }
    if (method === "cursor/run-started") {
      this.acceptRun(active, params, "run-started-notification");
      this.acceptPromptDispatch(active, params, "run-started-notification");
      emit(consumer, "run.started", { runId: active.session.nativeRunId, generation: active.generation }, hostedFrameId ? `${hostedFrameId}:run.started` : `cursor-run:${active.session.nativeRunId}:started`);
      return;
    }
    const runId = asString(params.runId);
    const generation = typeof params.generation === "number" && Number.isSafeInteger(params.generation) ? params.generation : null;
    if (runId && generation !== null && (runId !== active.session.nativeRunId || generation !== active.generation)) {
      emit(consumer, "log", { phase: "cursor-stale-run-event-fenced", eventRunId: runId, eventGeneration: generation, activeRunId: active.session.nativeRunId, activeGeneration: active.generation }, hostedFrameId ? `${hostedFrameId}:fenced` : undefined);
      return;
    }
    if (method === "cursor/message") {
      this.onMessage(params.message as SDKMessage, consumer, hostedFrameId ? (suffix) => `${hostedFrameId}:${suffix}` : () => undefined);
      return;
    }
    if (method === "cursor/result") {
      this.acceptPromptDispatch(active, params, "result-notification");
      const result = record(params.result);
      const queuedPrompts = typeof params.queuedPrompts === "number" && Number.isSafeInteger(params.queuedPrompts) ? params.queuedPrompts : 0;
      active.running = queuedPrompts > 0;
      active.settled = queuedPrompts === 0 && result.status === "finished";
      active.session = { ...active.session, state: active.running ? "running" : active.settled ? "completed" : result.status === "cancelled" ? "cancelled" : "failed" };
      if (!active.running) {
        active.terminalRunId = runId ?? active.session.nativeRunId;
        active.terminalGeneration = generation ?? active.generation;
      }
      this.checkpoint(active);
      if (result.usage) emit(consumer, "usage.recorded", withMessageIdentity({
        usage: result.usage,
        basis: "harness-reported",
        runId: runId ?? active.session.nativeRunId,
        generation: generation ?? active.generation,
      }, active.promptDispatch), hostedFrameId ? `${hostedFrameId}:usage.recorded` : undefined);
      if (result.status === "finished") {
        if (result.result) emit(consumer, "output.completed", withMessageIdentity({ text: result.result, runId: runId ?? active.session.nativeRunId, generation: generation ?? active.generation }, active.promptDispatch), hostedFrameId ? `${hostedFrameId}:output.completed` : undefined);
        if (queuedPrompts === 0) emit(consumer, "run.completed", withMessageIdentity({ ...result, runId: runId ?? active.session.nativeRunId, generation: generation ?? active.generation }, active.promptDispatch), hostedFrameId ? `${hostedFrameId}:run.completed` : undefined);
        else emit(consumer, "log", { phase: "cursor-run-completed-with-queued-prompts", runId, generation, queuedPrompts }, hostedFrameId ? `${hostedFrameId}:turn.queued` : undefined);
      } else if (result.status === "cancelled") emit(consumer, "run.cancelled", withMessageIdentity({ ...result, runId: runId ?? active.session.nativeRunId, generation: generation ?? active.generation }, active.promptDispatch), hostedFrameId ? `${hostedFrameId}:run.cancelled` : undefined);
      else emit(consumer, "run.failed", withMessageIdentity({ ...normalizeCursorFailurePayload(result), runId: runId ?? active.session.nativeRunId, generation: generation ?? active.generation }, active.promptDispatch), hostedFrameId ? `${hostedFrameId}:run.failed` : undefined);
      // Retain accepted identity in the lease after terminal projection. A
      // replay can then correlate the native run without redispatching; the
      // next distinct follow-up replaces this historical marker.
      if (queuedPrompts === 0) this.checkpoint(active);
      if (runId && generation !== null) {
        // The result acknowledgement is intentionally sent only after the
        // process lease and runtime event projection have synchronously
        // persisted this exact run/generation. The retained host may dispatch
        // the next queued turn only after this durable boundary.
        void active.rpc.request("session/result-ack", { runId, generation }, 30_000).catch((error: unknown) => {
          emit(consumer, "log", { phase: "cursor-result-acknowledgement-failed", runId, generation, error: stringifyError(error) });
        });
      }
      return;
    }
    if (method === "cursor/error") {
      active.running = false;
      active.settled = false;
      active.session = { ...active.session, state: "failed" };
      active.terminalRunId = runId ?? active.session.nativeRunId;
      active.terminalGeneration = generation ?? active.generation;
      this.checkpoint(active);
      emit(consumer, "run.failed", { ...normalizeCursorFailurePayload(params), runId: runId ?? active.session.nativeRunId, generation: generation ?? active.generation }, hostedFrameId ? `${hostedFrameId}:run.failed` : undefined);
      this.checkpoint(active);
      return;
    }
    if (method === "cursor/cancelled") {
      active.running = false;
      active.settled = false;
      active.session = { ...active.session, state: "cancelled" };
      active.terminalRunId = runId ?? active.session.nativeRunId;
      active.terminalGeneration = generation ?? active.generation;
      this.checkpoint(active);
      emit(
        consumer,
        "run.cancelled",
        params,
        hostedFrameId
          ? `${hostedFrameId}:run.cancelled`
          : `cursor-run:${String(active.session.nativeRunId)}:${active.generation}:cancelled`,
      );
      this.checkpoint(active);
      return;
    }
    emit(consumer, "log", message, hostedFrameId);
  }

  private onMessage(message: SDKMessage, consumer: Emit, eventId: (suffix: string) => string | undefined): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") emit(consumer, "message.delta", { text: block.text }, eventId("message.delta"));
        else emit(consumer, "tool.started", { toolCallId: block.id, toolName: block.name, args: block.input, status: "inProgress" }, block.id);
      }
    } else if (message.type === "thinking") emit(consumer, "reasoning.delta", { text: message.text }, eventId("reasoning.delta"));
    else if (message.type === "tool_call") emit(consumer, message.status === "running" ? "tool.started" : "tool.completed", {
      toolCallId: message.call_id,
      toolName: message.name,
      args: message.args,
      result: message.result,
      status: message.status === "error" ? "failed" : message.status === "running" ? "inProgress" : "completed",
      isError: message.status === "error",
    }, message.call_id);
    else if (message.type === "usage") emit(consumer, "usage.recorded", { usage: message.usage, basis: "harness-reported" }, eventId("usage.recorded"));
    else if (message.type === "status" && message.status === "ERROR") emit(consumer, "run.failed", normalizeCursorFailurePayload(message), eventId("run.failed"));
    else emit(consumer, "log", message, eventId("log"));
  }

  private acceptDispatch(active: ActiveCursor, value: Record<string, unknown>, evidence: string): void {
    const sessionId = asString(value.agentId);
    const runId = asString(value.runId);
    if (!sessionId || !runId) throw new Error(`Cursor SDK host did not return native identity: ${JSON.stringify(value)}`);
    this.acceptSession(active, sessionId, evidence);
    this.acceptRun(active, value, evidence);
    const initial = active.initialDispatch;
    if (initial) active.initialDispatch = { ...initial, state: "accepted", sessionId, runId, generation: active.generation };
    this.checkpoint(active);
  }

  private acceptSession(active: ActiveCursor, sessionId: string, evidence: string): void {
    const previous = active.session.nativeSessionId;
    if (!previous.startsWith("cursor-pending:") && previous !== sessionId) throw new Error(`Cursor native session identity changed from ${previous} to ${sessionId}.`);
    active.session = { ...active.session, nativeSessionId: sessionId };
    if (this.active.get(previous) === active) this.active.delete(previous);
    this.active.set(sessionId, active);
    emit(active.emit, "log", { phase: "cursor-session-accepted", sessionId, evidence }, `cursor-session:${sessionId}:accepted`);
  }

  private acceptRun(active: ActiveCursor, value: Record<string, unknown>, _evidence: string): void {
    const runId = asString(value.runId);
    const generation = typeof value.generation === "number" && Number.isSafeInteger(value.generation) ? value.generation : null;
    if (!runId || generation === null) throw new Error(`Cursor SDK host did not return native run identity: ${JSON.stringify(value)}`);
    if (generation < active.generation) return;
    if (runId === active.terminalRunId && generation === active.terminalGeneration) return;
    if (generation === active.generation && active.session.nativeRunId && active.session.nativeRunId !== runId) throw new Error(`Cursor native run identity changed within generation ${generation}.`);
    if (active.terminalGeneration !== null && generation > active.terminalGeneration) {
      active.terminalRunId = null;
      active.terminalGeneration = null;
    }
    active.generation = generation;
    active.running = true;
    active.settled = false;
    active.session = { ...active.session, nativeRunId: runId, state: "running" };
    this.checkpoint(active);
  }

  private applyStatus(active: ActiveCursor, value: Record<string, unknown>): void {
    const sessionId = asString(value.agentId);
    if (sessionId) this.acceptSession(active, sessionId, "attach-status");
    const runId = asString(value.runId);
    const generation = typeof value.generation === "number" && Number.isSafeInteger(value.generation) ? value.generation : active.generation;
    const sameRun = runId === active.session.nativeRunId && generation === active.generation;
    const terminalProjection = runId === active.terminalRunId
      && generation === active.terminalGeneration;
    // A retained host can emit the terminal frame while an attach request with
    // an older `running` snapshot is already in flight. Never let that stale
    // response regress the synchronously checkpointed terminal projection for
    // the same native run/generation.
    if (runId && value.status === "running" && sameRun && terminalProjection) return;
    if (runId && (value.status === "running" || generation > active.generation)) this.acceptRun(active, { runId, generation }, "attach-status");
    else {
      active.running = value.status === "running";
      active.settled = value.status === "finished";
    }
    this.acceptPromptDispatch(active, value, "attach-status");
  }

  private acceptPromptDispatch(active: ActiveCursor, value: Record<string, unknown>, _evidence: string): void {
    const pending = active.promptDispatch;
    if (!pending) return;
    const requestId = asString(value.requestId);
    const contentHash = asString(value.contentHash);
    const runId = asString(value.runId);
    const generation = typeof value.generation === "number" && Number.isSafeInteger(value.generation) ? value.generation : null;
    if (!requestId || requestId !== pending.requestId || (pending.contentHash && contentHash !== pending.contentHash) || !runId || generation === null) return;
    if (generation <= pending.baseGeneration && runId === pending.baseRunId) return;
    active.promptDispatch = { ...pending, state: "accepted", runId, generation };
    this.checkpoint(active);
  }

  private checkpoint(active: ActiveCursor): void {
    active.rpc.updateProcessLease({
      nativeSessionId: active.session.nativeSessionId,
      nativeRunId: active.session.nativeRunId,
      activeTurnId: active.running ? active.session.nativeRunId : null,
      adapterState: this.adapterState(active),
    });
  }

  private adapterState(active: ActiveCursor): JsonValue {
    return {
      version: 2,
      sessionId: active.session.nativeSessionId,
      runId: active.session.nativeRunId,
      generation: active.generation,
      running: active.running,
      settled: active.settled,
      effectiveModel: active.effectiveModel as unknown as JsonValue,
      initialDispatch: active.initialDispatch as unknown as JsonValue,
      promptDispatch: active.promptDispatch as unknown as JsonValue,
    };
  }

  private retainedEffectiveModel(value: unknown): EffectiveModel | null {
    const model = record(value);
    if (!["auto", "explicit", "resolved-auto"].includes(String(model.mode))) return null;
    if (model.id !== null && typeof model.id !== "string") return null;
    const params = Array.isArray(model.params)
      ? model.params.filter((item): item is { id: string; value: string } => {
          const candidate = record(item);
          return typeof candidate.id === "string" && typeof candidate.value === "string";
        })
      : [];
    return { mode: model.mode as EffectiveModel["mode"], id: model.id as string | null, params };
  }

  private retainedInitialDispatch(state: Record<string, unknown>): InitialCursorDispatch | null {
    const value = record(state.initialDispatch);
    const requestId = asString(value.requestId);
    if (!requestId || (value.state !== "dispatching" && value.state !== "accepted")) return null;
    return {
      requestId,
      state: value.state,
      sessionId: asString(value.sessionId) ?? null,
      runId: asString(value.runId) ?? null,
      generation: typeof value.generation === "number" && Number.isSafeInteger(value.generation) ? value.generation : 0,
    };
  }

  private retainedPromptDispatch(state: Record<string, unknown>): CursorPromptDispatch | null {
    const value = record(state.promptDispatch);
    const requestId = asString(value.requestId);
    const attemptId = asString(value.attemptId);
    const contentHash = asString(value.contentHash);
    if (!requestId || (value.state !== "dispatching" && value.state !== "accepted")) return null;
    const baseGeneration = typeof value.baseGeneration === "number" && Number.isSafeInteger(value.baseGeneration)
      ? value.baseGeneration
      : 0;
    const generation = typeof value.generation === "number" && Number.isSafeInteger(value.generation)
      ? value.generation
      : null;
    return {
      attemptId: attemptId ?? requestId,
      requestId,
      contentHash: contentHash ?? "",
      state: value.state,
      baseRunId: asString(value.baseRunId) ?? null,
      baseGeneration,
      runId: asString(value.runId) ?? null,
      generation,
    };
  }

  private runOptions(session: DriverSession, request: DriverStartRequest): Record<string, unknown> {
    const apiKey = this.secrets.get("cursor.apiKey") ?? undefined;
    if (!request.workOrder.workspace.remoteRepository) {
      return { runtime: "local", cwd: request.workOrder.workspace.path, ...(apiKey ? { apiKey } : {}) };
    }
    return { runtime: "cloud", agentId: session.nativeSessionId, ...(apiKey ? { apiKey } : {}) };
  }

  private async authenticateOnce(): Promise<DriverAuthenticationResult> {
    const sdk = await this.sdkApi();
    const existing = await sdk.auth.status();
    if (existing.status === "logged-in") {
      this.catalogCache = null;
      return {
        authenticated: true,
        detail: `Cursor SDK is already authenticated${existing.email ? ` as ${existing.email}` : ""}.`,
      };
    }
    let loginUrl: string | undefined;
    const result = await sdk.auth.login({
      apiKeyName: "Symphony local orchestration",
      onLoginUrl: (url) => { loginUrl = url; },
    });
    // Cursor persists the minted key in its documented SDK credential store.
    // Deliberately discard the returned key and never project it into Symphony.
    this.catalogCache = null;
    return {
      authenticated: true,
      detail: `Cursor SDK authenticated${result.email ? ` as ${result.email}` : ""}.`,
      ...(loginUrl ? { loginUrl } : {}),
    };
  }

  private async runtimeCredential(): Promise<{ source: "configured-api-key" | "sdk-login"; apiKey?: string; email?: string } | null> {
    const apiKey = this.secrets.get("cursor.apiKey") ?? undefined;
    if (apiKey) return { source: "configured-api-key", apiKey };
    const status = await (await this.sdkApi()).auth.status();
    return status.status === "logged-in"
      ? { source: "sdk-login", ...(status.email ? { email: status.email } : {}) }
      : null;
  }

  private async sdkModels(credential: { source: "configured-api-key" | "sdk-login"; apiKey?: string }): Promise<ModelDescriptor[]> {
    const source = credential.source;
    const cached = this.catalogCache;
    if (cached && cached.source === source && Date.now() - cached.checkedAt < 30_000) return cached.models;
    const models = await (await this.sdkApi()).models.list(credential.apiKey ? { apiKey: credential.apiKey } : {});
    if (!models.length) throw new Error("Cursor SDK returned an empty authenticated model catalog.");
    const descriptors = models.map((model) => ({
      id: model.id,
      harness: this.id,
      name: model.displayName,
      description: model.description ?? "",
      modalities: ["text"],
      structuredOutput: false,
      pricing: {},
      metadata: toJson({ aliases: model.aliases ?? [], parameters: model.parameters ?? [], variants: model.variants ?? [], source: "cursor-sdk" }) as Record<string, never>,
    }));
    this.catalogCache = { source, checkedAt: Date.now(), models: descriptors };
    return descriptors;
  }

  private sdkApi(): Promise<CursorSdkApi> {
    if (this.sdkApiPromise) return this.sdkApiPromise;
    const fixtureModule = process.env.SYMPHONY_CURSOR_HOST_SDK_MODULE;
    this.sdkApiPromise = fixtureModule
      ? import(pathToFileURL(resolve(fixtureModule)).href).then((module: Record<string, unknown>) => {
          const candidate = module.Cursor;
          if (!candidate || typeof candidate !== "object") throw new Error("Cursor SDK fixture module does not export Cursor auth/catalog APIs.");
          return candidate as CursorSdkApi;
        })
      : Promise.resolve(Cursor);
    return this.sdkApiPromise;
  }

  private findActive(consumer: Emit): ActiveCursor | undefined {
    return [...this.active.values()].find((candidate) => candidate.emit === consumer);
  }

  private removeProcess(rpc: JsonLineRpcTransport): void {
    for (const [sessionId, active] of this.active.entries()) if (active.rpc === rpc) this.active.delete(sessionId);
  }

  private require(session: DriverSession): ActiveCursor {
    const active = this.active.get(session.nativeSessionId);
    if (!active) throw new Error(`Cursor session is not active: ${session.nativeSessionId}`);
    return active;
  }

  private result(available: boolean, authenticated: boolean, version: string | null, detail: string): DriverDoctorResult {
    return { driver: this.id, available, authenticated, version, capabilities: this.capabilities, detail };
  }
}

function cursorAuthenticationFailureDetail(error: unknown, cliAuthenticated: boolean): string {
  const message = stringifyError(error);
  const reason = /invalid.*api key|unauthenticated|authentication|api key is required/iu.test(message)
    ? "The Cursor SDK credential is missing, expired, revoked, or invalid."
    : "Cursor SDK provider readiness could not be verified.";
  return `${reason} ${cliAuthenticated ? "The Cursor CLI is signed in, but its login is separate. " : ""}Authenticate the SDK here or configure cursor.apiKey.`;
}

export function cursorStatusIsAuthenticated(status: string | null): boolean {
  return Boolean(status && !/not\s+(?:logged\s+in|authenticated)/iu.test(status) && /logged\s+in|authenticated/iu.test(status));
}

export function normalizeCursorFailurePayload(value: unknown): Record<string, JsonValue> {
  const payload = record(value);
  const rendered = value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : JSON.stringify(value) ?? String(value);
  if (/invalid\s+(?:user\s+)?api\s+key|api\s+key\s+is\s+required|unauthenticated/iu.test(rendered)) {
    return {
      code: "cursor-sdk-unauthenticated",
      error: "Cursor SDK authentication failed. Authenticate the Cursor SDK in Symphony Settings or configure cursor.apiKey; cursor-agent CLI login is separate.",
    };
  }
  return Object.keys(payload).length
    ? payload as Record<string, JsonValue>
    : { error: rendered };
}
