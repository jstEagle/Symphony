import { createHash, createHmac, randomBytes } from "node:crypto";
import { createOpencodeClient, type Event as OpenCodeEvent, type OpencodeClient } from "@opencode-ai/sdk";
import { environmentWithoutDaemonSecret, type SecretStore, type SymphonyConfig } from "@symphony/config";
import type {
  DriverProcessLeaseUpdate,
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
import { capabilities, emit, makeSession, messageRequest, record, stringifyError, withMessageIdentity, type Emit } from "./common.js";
import { HostedRawLineProcess } from "./hosted-process.js";

type ServerHandle = {
  url: string;
  mode: "direct" | "spawned" | "reconnected";
  retainedAdapterState(): JsonValue;
  updateProcessLease(patch: DriverProcessLeaseUpdate): void;
  close(): Promise<void>;
  detach(): Promise<void>;
};
type InitialTurnDispatch = {
  id: string;
  state: "dispatching" | "accepted";
};
type OpenCodeEventStream = AsyncGenerator<OpenCodeEvent, unknown, unknown>;
type ReconciledTurnState = "completed" | "failed" | "idle" | "unknown";
type ActiveOpenCode = {
  client: OpencodeClient;
  emit: Emit;
  directory: string;
  outputText: string;
  runPending: boolean;
  cancelRequested: boolean;
  closed: boolean;
  turnSequence: number;
  nativeTurnId: string | null;
  streamSequence: number;
  pendingMessage: DriverMessageRequest | null;
  cancelPromise?: Promise<void>;
  terminalReconciliation?: Promise<ReconciledTurnState>;
  subscription?: {
    abort: AbortController;
    stream: OpenCodeEventStream;
    task: Promise<void>;
  };
  server?: ServerHandle;
};

// Driver instances are agent-scoped, but a configured discovery URL is shared.
// Remember hosted endpoints owned by this daemon so a retained historical
// service that happened to bind the old configured port is not mistaken for a
// user-managed external server by a later agent in the same daemon.
const managedHostedEndpoints = new Set<string>();

export class OpenCodeDriver implements WorkerDriver {
  readonly id = "opencode" as const;
  readonly capabilities = capabilities({ steer: false, cloud: false });
  private readonly active = new Map<string, ActiveOpenCode>();
  private ownedServiceMaster: Buffer | null = null;

  constructor(
    private readonly config: SymphonyConfig["harnesses"]["opencode"],
    private readonly secrets: SecretStore,
  ) {}

  async doctor(): Promise<DriverDoctorResult> {
    try {
      const client = createOpencodeClient({ baseUrl: this.config.baseUrl });
      const response = await client.path.get();
      return this.result(Boolean(response.data), null, response.data ? "OpenCode server is reachable." : "OpenCode SDK loaded but server did not answer.");
    } catch (error) {
      if (!this.config.autoStart) return this.result(false, null, stringifyError(error));
      try {
        this.autoStartEndpoint();
        this.ownedServiceMasterKey();
        return this.result(true, null, "An authenticated OpenCode service will be started on demand.");
      } catch (ownedError) {
        return this.result(false, null, stringifyError(ownedError));
      }
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    try {
      const client = createOpencodeClient({ baseUrl: this.config.baseUrl });
      const response = await client.provider.list().catch(() => null);
      if (!response?.data) return [];
      const connected = new Set(response.data.connected);
      return response.data.all.flatMap((provider) => {
        if (!connected.has(provider.id)) return [];
        return Object.values(provider.models).map((model) => ({
          id: `${provider.id}/${model.id}`,
          harness: this.id,
          name: model.name,
          description: `${provider.name} model available through the native OpenCode harness.`,
          contextTokens: model.limit.context,
          modalities: model.modalities?.input ?? ["text"],
          structuredOutput: model.tool_call,
          pricing: { inputPerMillion: model.cost?.input, outputPerMillion: model.cost?.output },
          metadata: { provider: provider.id, reasoning: model.reasoning, status: model.status ?? "active" },
        }));
      });
    } catch {
      return [];
    }
  }

  async start(
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    const { client, server } = await this.client(request.workOrder.workspace.path, request.agentId, options?.processSupervisor);
    let active: ActiveOpenCode | undefined;
    let sessionId: string | undefined;
    const abort = () => {
      if (active && sessionId) void this.closeActive(sessionId, active, true, false);
      if (sessionId) void this.abortBestEffort(client, sessionId, request.workOrder.workspace.path);
      void this.retireSetupServer(server);
    };
    options?.signal.addEventListener("abort", abort, { once: true });
    try {
      options?.signal.throwIfAborted();
      await this.configureMcp(client, request);
      options?.signal.throwIfAborted();
      const created = await client.session.create({
        body: { title: request.workOrder.objective.slice(0, 100) },
        query: { directory: request.workOrder.workspace.path },
      });
      if (!created.data) throw new Error(`OpenCode failed to create a session: ${JSON.stringify(created.error)}`);
      sessionId = created.data.id;
      options?.signal.throwIfAborted();
      active = this.makeActive(client, onEvent, request.workOrder.workspace.path, server, true);
      this.active.set(sessionId, active);
      await this.subscribe(sessionId, active);
      options?.signal.throwIfAborted();
      const initialTurn = { id: `initial:${request.agentId}`, state: "dispatching" as const };
      this.checkpointInitialTurn(server, sessionId, initialTurn);
      await this.prompt(sessionId, request, buildAgentPrompt(request.workOrder, coordinationPromptOptions(request)), active);
      this.checkpointInitialTurn(server, sessionId, { ...initialTurn, state: "accepted" });
      options?.signal.throwIfAborted();
      this.assertActive(sessionId, active, "startup");
      emit(onEvent, "session.started", { sessionId });
      return makeSession(this.id, sessionId, { agentId: request.agentId });
    } catch (error) {
      if (active && sessionId) {
        // Detach first so an abort-induced idle event cannot make failed startup
        // look like a successful completed run.
        await this.closeActive(sessionId, active, true, false);
        await this.abortBestEffort(client, sessionId, request.workOrder.workspace.path);
        await this.retireSetupServer(server);
      } else {
        if (sessionId) await this.abortBestEffort(client, sessionId, request.workOrder.workspace.path);
        await this.retireSetupServer(server);
      }
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
    const { client, server } = await this.client(request.workOrder.workspace.path, request.agentId, options?.processSupervisor);
    let active: ActiveOpenCode | undefined;
    const abort = () => {
      if (active) {
        void this.closeActive(session.nativeSessionId, active, true, false)
          .then(async () => await this.retireSetupServer(server));
      } else {
        void this.retireSetupServer(server);
      }
    };
    options?.signal.addEventListener("abort", abort, { once: true });
    try {
      options?.signal.throwIfAborted();
      await this.configureMcp(client, request);
      options?.signal.throwIfAborted();
      const found = await client.session.get({ path: { id: session.nativeSessionId }, query: { directory: request.workOrder.workspace.path } });
      if (!found.data) throw new Error(`OpenCode session not found: ${session.nativeSessionId}`);
      options?.signal.throwIfAborted();
      active = this.makeActive(client, onEvent, request.workOrder.workspace.path, server, true);
      const retainedState = record(server?.retainedAdapterState());
      active.turnSequence = typeof retainedState.turnSequence === "number" && Number.isSafeInteger(retainedState.turnSequence)
        ? retainedState.turnSequence
        : this.turnSequenceFromNativeId(
            typeof retainedState.nativeTurnId === "string" ? retainedState.nativeTurnId : session.nativeRunId,
          );
      active.nativeTurnId = typeof retainedState.nativeTurnId === "string" ? retainedState.nativeTurnId : session.nativeRunId;
      active.streamSequence = typeof retainedState.streamSequence === "number" && Number.isSafeInteger(retainedState.streamSequence)
        ? retainedState.streamSequence
        : 0;
      active.pendingMessage = retainedMessageDispatch(retainedState);
      const previous = this.active.get(session.nativeSessionId);
      if (previous) await this.closeActive(session.nativeSessionId, previous);
      this.active.set(session.nativeSessionId, active);
      await this.subscribe(session.nativeSessionId, active);
      options?.signal.throwIfAborted();
      const statuses = await client.session.status({ query: { directory: request.workOrder.workspace.path } });
      if (statuses.error) throw new Error(`OpenCode session status failed: ${JSON.stringify(statuses.error)}`);
      options?.signal.throwIfAborted();
      this.assertActive(session.nativeSessionId, active, "resume");
      const nativeStatus = statuses.data?.[session.nativeSessionId]?.type ?? "idle";
      const running = nativeStatus === "busy" || nativeStatus === "retry";
      active.runPending = running;
      emit(onEvent, "session.started", { sessionId: session.nativeSessionId, resumed: true, nativeStatus });
      // A retained durable follow-up marker without transcript correlation is
      // outcome-unknown, even when OpenCode reports the session busy. Do not
      // project a misleading running event during that recovery window.
      if (running && !active.pendingMessage) emit(onEvent, "run.started", { sessionId: session.nativeSessionId, resumed: true, nativeStatus });
      const recoveredState = running
        ? active.pendingMessage ? "unknown" : "running"
        : await this.reconcilePersistedTurn(session.nativeSessionId, active);
      const initialTurn = this.retainedInitialTurn(server);
      const previousTurnMayBeActive = session.state === "running" || session.state === "starting" || session.state === "unknown";
      return {
        ...session,
        state: recoveredState === "idle" && (previousTurnMayBeActive || initialTurn?.state === "dispatching")
          ? "unknown"
          : recoveredState,
      };
    } catch (error) {
      if (active) await this.closeActive(session.nativeSessionId, active, true, false);
      await this.retireSetupServer(server);
      throw error;
    } finally {
      options?.signal.removeEventListener("abort", abort);
    }
  }

  async sendMessage(session: DriverSession, message: string, request?: DriverMessageRequest): Promise<{ receiptId: string; queued: boolean }> {
    const active = this.require(session);
    const durable = messageRequest(message, request);
    if (active.pendingMessage) {
      if (active.pendingMessage.requestId === durable.requestId && active.pendingMessage.contentHash === durable.contentHash) {
        return { receiptId: durable.requestId, queued: false };
      }
      if (active.runPending) {
        throw new Error("OpenCode native message is already pending with a different durable identity.");
      }
      active.pendingMessage = null;
      this.persistStreamState(active);
    }
    active.outputText = "";
    active.runPending = true;
    active.cancelRequested = false;
    delete active.cancelPromise;
    delete active.terminalReconciliation;
    active.turnSequence += 1;
    active.nativeTurnId = `${session.nativeSessionId}:turn:${active.turnSequence}`;
    active.pendingMessage = durable;
    this.persistNativeTurn(active);
    this.persistStreamState(active);
    const response = await active.client.session.promptAsync({
      path: { id: session.nativeSessionId },
      query: { directory: active.directory },
      body: { parts: [{ type: "text", text: message }], messageID: durable.requestId },
    });
    if (response.error) {
      active.runPending = false;
      throw new Error(JSON.stringify(response.error));
    }
    this.assertActive(session.nativeSessionId, active, "message submission");
    this.persistStreamState(active);
    return { receiptId: durable.requestId, queued: false };
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active || active.closed) return;
    if (!active.cancelPromise) {
      active.cancelRequested = true;
      active.cancelPromise = (async () => {
        const response = await active.client.session.abort({ path: { id: session.nativeSessionId }, query: { directory: active.directory } });
        if (response.error || response.data !== true) {
          throw new Error(`OpenCode session cancellation failed: ${JSON.stringify(response.error ?? { acknowledged: response.data })}`);
        }
      })();
    }
    await active.cancelPromise;
  }

  async forceTerminate(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    // Only an auto-started OpenCode server belongs to this driver. An external
    // server is shared infrastructure and must not be terminated by Symphony.
    await this.closeActive(session.nativeSessionId, active);
  }

  async detach(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    await this.closeActive(session.nativeSessionId, active, true, false);
    await this.detachServer(active.server);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.active].map(async ([sessionId, active]) => {
      await this.closeActive(sessionId, active, true, false);
      await this.detachServer(active.server);
    }));
  }

  private async client(
    directory: string,
    agentId: string,
    processSupervisor?: DriverLifecycleOptions["processSupervisor"],
  ): Promise<{ client: OpencodeClient; server?: ServerHandle }> {
    if (!this.config.autoStart) return { client: createOpencodeClient({ baseUrl: this.config.baseUrl, directory }) };
    const retainedProcess = processSupervisor?.retainedProcess === true;
    if (retainedProcess && processSupervisor?.workerHostPlan) {
      this.autoStartEndpoint();
      return await this.hostedClient(directory, agentId, processSupervisor);
    }
    const discoveryEndpoint = new URL(this.config.baseUrl).origin;
    if (!managedHostedEndpoints.has(discoveryEndpoint)) {
      try {
        const existing = createOpencodeClient({ baseUrl: this.config.baseUrl, directory });
        const response = await existing.path.get();
        if (response.data) return { client: existing };
      } catch {
        // Start an isolated native server below.
      }
    }
    this.autoStartEndpoint();
    if (!processSupervisor?.workerHostPlan) {
      throw new Error("OpenCode auto-start requires the authenticated worker-host supervisor; refusing an unauthenticated direct SDK fallback.");
    }
    return await this.hostedClient(directory, agentId, processSupervisor);
  }

  private async hostedClient(
    directory: string,
    agentId: string,
    processSupervisor: NonNullable<DriverLifecycleOptions["processSupervisor"]>,
  ): Promise<{ client: OpencodeClient; server: ServerHandle }> {
    const auth = this.ownedServiceAuth(agentId);
    const childEnv = environmentWithoutDaemonSecret();
    delete childEnv.SYMPHONY_OPENCODE_SERVICE_KEY;
    delete childEnv.OPENCODE_SERVER_USERNAME;
    childEnv.OPENCODE_SERVER_PASSWORD = auth.password;
    const isolatedArgs = this.isolatedHostedProcessArgs();
    const makeService = (args: string[]) => new HostedRawLineProcess({
      command: this.config.process.command,
      args,
      cwd: directory,
      env: childEnv,
      processSupervisor,
      processRole: "opencode-server",
    });
    let service: HostedRawLineProcess;
    try {
      service = makeService(isolatedArgs);
    } catch (error) {
      const historicalSpec = processSupervisor.retainedProcess === true
        && JSON.stringify(isolatedArgs) !== JSON.stringify(this.config.process.args)
        && stringifyError(error).includes("does not match the requested native process");
      if (!historicalSpec) throw error;
      // Leases created before per-agent port isolation retain the exact process
      // spec they were launched with. Adopt that already-running service once;
      // never rewrite its identity or launch a duplicate merely to migrate it.
      service = makeService(this.config.process.args);
    }
    try {
      const retainedEndpoint = this.retainedEndpoint(service.retainedAdapterState());
      if (retainedEndpoint) managedHostedEndpoints.add(retainedEndpoint);
      const readiness = retainedEndpoint
        ? Promise.resolve(retainedEndpoint)
        : service.waitForLine((line) => this.parseServerEndpoint(line));
      const [url] = await Promise.all([readiness, service.activate()]);
      if (!retainedEndpoint) service.updateProcessLease({ adapterState: { endpoint: url } });
      managedHostedEndpoints.add(url);
      return {
        client: createOpencodeClient({
          baseUrl: url,
          directory,
          headers: { Authorization: auth.authorization },
        }),
        server: {
          url,
          mode: service.mode,
          retainedAdapterState: () => service.retainedAdapterState(),
          updateProcessLease: (patch) => service.updateProcessLease(patch),
          close: async () => {
            try {
              await service.close();
            } finally {
              managedHostedEndpoints.delete(url);
            }
          },
          detach: async () => await service.detach(),
        },
      };
    } catch (error) {
      if (service.mode === "reconnected") await service.detach().catch(() => undefined);
      else await service.close("SIGKILL").catch(() => undefined);
      throw error;
    }
  }

  private ownedServiceAuth(agentId: string): { password: string; authorization: string } {
    const password = createHmac("sha256", this.ownedServiceMasterKey())
      .update(`symphony-opencode-basic:v1:${agentId}`)
      .digest("base64url");
    return {
      password,
      authorization: `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`,
    };
  }

  private ownedServiceMasterKey(): Buffer {
    if (this.ownedServiceMaster) return this.ownedServiceMaster;
    const secretKey = "opencode.serverMasterKey";
    let encoded = this.secrets.get(secretKey);
    if (!encoded) {
      if (process.platform !== "darwin") {
        throw new Error("OpenCode auto-start requires SYMPHONY_OPENCODE_SERVICE_KEY containing exactly 32 random base64url-encoded bytes.");
      }
      encoded = randomBytes(32).toString("base64url");
      this.secrets.set(secretKey, encoded);
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) {
      throw new Error("The OpenCode service master key must contain exactly 32 random base64url-encoded bytes.");
    }
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.length !== 32 || decoded.toString("base64url") !== encoded) {
      throw new Error("The OpenCode service master key must contain exactly 32 random base64url-encoded bytes.");
    }
    this.ownedServiceMaster = decoded;
    return decoded;
  }

  private parseServerEndpoint(line: string): string | null {
    if (!line.startsWith("opencode server listening")) return null;
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/u);
    if (!match?.[1]) throw new Error(`Failed to parse OpenCode server URL from output: ${line}`);
    return this.validateHostedEndpoint(match[1], "readiness output");
  }

  private retainedEndpoint(value: JsonValue): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const endpoint = value.endpoint;
    if (typeof endpoint !== "string") return null;
    try {
      return this.validateHostedEndpoint(endpoint, "retained adapter state");
    } catch (error) {
      throw new Error(`Invalid retained OpenCode service endpoint: ${stringifyError(error)}`);
    }
  }

  private retainedInitialTurn(server: ServerHandle | undefined): InitialTurnDispatch | null {
    if (!server) return null;
    const value = record(server.retainedAdapterState()).initialTurn;
    const initialTurn = record(value);
    if (typeof initialTurn.id !== "string") return null;
    if (initialTurn.state !== "dispatching" && initialTurn.state !== "accepted") return null;
    return { id: initialTurn.id, state: initialTurn.state };
  }

  /**
   * The worker-process lease is the daemon-independent handoff record for an
   * owned OpenCode service. Persist the native session and the stable initial
   * dispatch identity in one lease revision before promptAsync can cross the
   * process boundary. A replacement daemon may then inspect native status and
   * transcript evidence without ever re-sending the original work order.
   */
  private checkpointInitialTurn(
    server: ServerHandle | undefined,
    sessionId: string,
    initialTurn: InitialTurnDispatch,
  ): void {
    if (!server) return;
    server.updateProcessLease({
      nativeSessionId: sessionId,
      activeTurnId: initialTurn.id,
      adapterState: {
        ...record(server.retainedAdapterState()),
        initialTurn,
      },
    });
  }

  private validateHostedEndpoint(endpoint: string, source: string): string {
    const parsed = new URL(endpoint);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    const port = parsed.port ? Number(parsed.port) : 80;
    const rootOnly = parsed.pathname === "/" && !parsed.search && !parsed.hash;
    if (
      parsed.protocol !== "http:"
      || !loopback
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || parsed.username.length > 0
      || parsed.password.length > 0
      || !rootOnly
    ) {
      throw new Error(
        `OpenCode ${source} reported ${endpoint}, which is not a plain private loopback HTTP endpoint.`,
      );
    }
    return parsed.origin;
  }

  private autoStartEndpoint(): { hostname: string; port: number } {
    const url = new URL(this.config.baseUrl);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    if (url.protocol !== "http:" || !loopback) {
      throw new Error(`OpenCode auto-start requires a loopback http baseUrl; refusing to claim ${this.config.baseUrl}.`);
    }
    const port = url.port ? Number(url.port) : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`OpenCode auto-start baseUrl has an invalid port: ${this.config.baseUrl}.`);
    }
    return { hostname, port };
  }

  private isolatedHostedProcessArgs(): string[] {
    const source = this.config.process.args;
    if (!source.includes("serve")) return source;
    const args: string[] = [];
    for (let index = 0; index < source.length; index += 1) {
      const value = source[index] as string;
      if (value === "--hostname" || value === "--port") {
        index += 1;
        continue;
      }
      if (value.startsWith("--hostname=") || value.startsWith("--port=")) continue;
      args.push(value);
    }
    args.push("--hostname=127.0.0.1", "--port=0");
    return args;
  }

  private async prompt(sessionId: string, request: DriverStartRequest, text: string, active: ActiveOpenCode): Promise<void> {
    active.outputText = "";
    active.runPending = true;
    active.cancelRequested = false;
    delete active.cancelPromise;
    delete active.terminalReconciliation;
    active.turnSequence += 1;
    active.nativeTurnId = `${sessionId}:turn:${active.turnSequence}`;
    this.persistNativeTurn(active);
    const tools = request.workOrder.permissions === "read-only"
      ? { bash: false, shell: false, edit: false, write: false, patch: false, task: false }
      : undefined;
    const modelParts = request.resolvedModel === "auto" ? undefined : request.resolvedModel.split("/");
    const response = await active.client.session.promptAsync({
      path: { id: sessionId },
      query: { directory: active.directory },
      body: {
        parts: [{ type: "text", text }],
        ...(modelParts?.length && modelParts.length > 1 ? { model: { providerID: modelParts[0] as string, modelID: modelParts.slice(1).join("/") } } : {}),
        ...(tools ? { tools } : {}),
      },
    });
    if (response.error) throw new Error(JSON.stringify(response.error));
    // Only add the resumable stream checkpoint after OpenCode acknowledges the
    // prompt. The pre-ack checkpoint above deliberately contains only the
    // stable Symphony dispatch identity, so an ambiguous request cannot be
    // mistaken for a provider-accepted turn.
    this.persistStreamState(active);
  }

  private async subscribe(sessionId: string, active: ActiveOpenCode): Promise<void> {
    const abort = new AbortController();
    let lastStreamError: unknown;
    const subscription = await active.client.event.subscribe({
      query: { directory: active.directory },
      signal: abort.signal,
      sseMaxRetryAttempts: 3,
      onSseError: (error) => { lastStreamError = error; },
    });
    const stream = subscription.stream as OpenCodeEventStream;
    const task = (async () => {
      try {
        for await (const event of stream) {
          if (active.closed) break;
          lastStreamError = undefined;
          const properties = record(event.properties);
          const eventSessionId = typeof properties.sessionID === "string"
            ? properties.sessionID
            : typeof record(properties.part).sessionID === "string" ? record(properties.part).sessionID as string : undefined;
          if (eventSessionId && eventSessionId !== sessionId) continue;
          if (!eventSessionId && event.type === "session.error") {
            emit(active.emit, "log", { message: "OpenCode reported a session error without a session id; the shared event was not assigned to this agent.", event });
            continue;
          }
          if (event.type === "session.status" && record(properties.status).type === "busy") {
            emit(active.emit, "run.started", withMessageIdentity({ ...event, nativeTurnId: active.nativeTurnId }, active.pendingMessage), active.nativeTurnId ? `${active.nativeTurnId}:started` : undefined);
          }
          else if (event.type === "session.idle") {
            if (!active.runPending) continue;
            active.runPending = false;
            if (active.cancelRequested) {
              active.cancelRequested = false;
              emit(active.emit, "run.cancelled", withMessageIdentity({ ...event, nativeTurnId: active.nativeTurnId }, active.pendingMessage), active.nativeTurnId ? `${active.nativeTurnId}:cancelled` : undefined);
            } else {
              const state = await this.reconcilePersistedTurn(sessionId, active);
              if (state === "idle" || state === "unknown") {
                // A live idle event is itself terminal evidence even if the
                // transcript endpoint is briefly unavailable. Recovery does
                // not have this evidence and therefore stays conservative.
                emit(active.emit, "output.completed", withMessageIdentity({ text: active.outputText, nativeTurnId: active.nativeTurnId }, active.pendingMessage), active.nativeTurnId ? `${active.nativeTurnId}:output` : undefined);
                emit(active.emit, "run.completed", withMessageIdentity({ ...event, nativeTurnId: active.nativeTurnId }, active.pendingMessage), active.nativeTurnId ? `${active.nativeTurnId}:completed` : undefined);
                this.clearPendingMessage(active);
              }
            }
          }
          else if (event.type === "session.error") {
            if (!active.runPending) continue;
            active.runPending = false;
            emit(active.emit, "run.failed", withMessageIdentity({ ...event, nativeTurnId: active.nativeTurnId }, active.pendingMessage), active.nativeTurnId ? `${active.nativeTurnId}:failed` : undefined);
            this.clearPendingMessage(active);
          }
          else if (event.type === "file.edited") emit(active.emit, "file.changed", event, this.eventIdentity(sessionId, active, "file.changed", event));
          else if (event.type === "message.part.updated") {
            const part = record(properties.part);
            if (part.type === "text") {
              const delta = typeof properties.delta === "string" ? properties.delta : null;
              if (delta !== null) active.outputText += delta;
              else if (typeof part.text === "string") active.outputText = part.text;
              emit(
                active.emit,
                "message.delta",
                withMessageIdentity({ text: delta ?? part.text ?? "", replace: delta === null, messageId: part.id ?? null, nativeTurnId: active.nativeTurnId }, active.pendingMessage),
                this.eventIdentity(sessionId, active, "message.delta", event, typeof part.id === "string" ? part.id : null),
              );
            }
            else if (part.type === "reasoning") emit(
              active.emit,
              "reasoning.delta",
              withMessageIdentity({ text: properties.delta ?? part.text ?? "", replace: typeof properties.delta !== "string", messageId: part.id ?? null, part, nativeTurnId: active.nativeTurnId }, active.pendingMessage),
              this.eventIdentity(sessionId, active, "reasoning.delta", event, typeof part.id === "string" ? part.id : null),
            );
            else if (part.type === "tool") emit(active.emit, "tool.updated", { ...part, nativeTurnId: active.nativeTurnId }, this.eventIdentity(sessionId, active, "tool.updated", event, typeof part.id === "string" ? part.id : null));
            else emit(active.emit, "log", event);
          }
        }
      } catch (error) {
        lastStreamError = error;
      } finally {
        if (!active.closed) {
          const error = lastStreamError ?? new Error("OpenCode event stream ended unexpectedly.");
          if (active.runPending) {
            active.runPending = false;
            void this.abortBestEffort(active.client, sessionId, active.directory);
            emit(active.emit, "run.failed", withMessageIdentity({ error: stringifyError(error), source: "event-stream", nativeTurnId: active.nativeTurnId }, active.pendingMessage), active.nativeTurnId ? `${active.nativeTurnId}:failed` : undefined);
          } else {
            emit(active.emit, "log", { level: "error", message: stringifyError(error), source: "event-stream" });
          }
          void this.closeActive(sessionId, active, false);
        }
      }
    })();
    active.subscription = { abort, stream, task };
  }

  /**
   * OpenCode persists the native transcript independently of its SSE stream.
   * Replaying the last native turn is therefore the authoritative recovery
   * path when that turn became idle while Symphony was offline. Every
   * reconstructed event uses native message/part identifiers so the daemon's
   * durable event claim table can reject the same terminal evidence after a
   * later reconnect.
   */
  private reconcilePersistedTurn(sessionId: string, active: ActiveOpenCode): Promise<ReconciledTurnState> {
    active.terminalReconciliation ??= this.importPersistedTurn(sessionId, active);
    return active.terminalReconciliation;
  }

  private async importPersistedTurn(sessionId: string, active: ActiveOpenCode): Promise<ReconciledTurnState> {
    let response: Awaited<ReturnType<OpencodeClient["session"]["messages"]>>;
    try {
      response = await active.client.session.messages({
        path: { id: sessionId },
        query: { directory: active.directory },
      });
    } catch (error) {
      emit(active.emit, "log", {
        level: "error",
        message: `OpenCode persisted transcript could not be read: ${stringifyError(error)}`,
        source: "transcript-recovery",
      });
      return "unknown";
    }
    const transcriptResponse = response as unknown as { data?: unknown; error?: unknown };
    if (transcriptResponse.error) {
      emit(active.emit, "log", {
        level: "error",
        message: `OpenCode persisted transcript could not be read: ${JSON.stringify(transcriptResponse.error)}`,
        source: "transcript-recovery",
      });
      return "unknown";
    }

    const createdAt = (message: unknown): number => {
      const created = record(record(record(message).info).time).created;
      return typeof created === "number" && Number.isFinite(created) ? created : 0;
    };
    const messages = (Array.isArray(transcriptResponse.data) ? [...transcriptResponse.data] : [])
      .sort((left, right) => createdAt(left) - createdAt(right));
    const pending = active.pendingMessage;
    const latestUser = pending
      ? messages.find((message) => record(record(message).info).id === pending.requestId)
      : [...messages].reverse().find((message) => record(record(message).info).role === "user");
    const userInfo = record(record(latestUser).info);
    const userMessageId = typeof userInfo.id === "string" ? userInfo.id : null;
    if (!userMessageId || userInfo.role !== "user") {
      if (pending) emit(active.emit, "log", { level: "error", message: "OpenCode recovery could not correlate the persisted transcript to the durable follow-up request; refusing to replay a previous user prompt.", source: "transcript-recovery", requestId: pending.requestId });
      return pending ? "unknown" : "idle";
    }
    if (pending) {
      const userParts = record(latestUser).parts;
      const promptText = (Array.isArray(userParts) ? userParts : [])
        .map((part) => record(part))
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      const promptHash = createHash("sha256").update(promptText, "utf8").digest("hex");
      if (promptHash !== pending.contentHash) {
        emit(active.emit, "log", { level: "error", message: "OpenCode recovery found the durable request id with different prompt content; refusing to complete an ambiguous native turn.", source: "transcript-recovery", requestId: pending.requestId });
        return "unknown";
      }
    }

    const assistants = messages.filter((message) => {
      const info = record(record(message).info);
      return info.role === "assistant" && info.parentID === userMessageId;
    });
    const lastAssistant = assistants.at(-1);
    const lastInfo = record(record(lastAssistant).info);
    const lastTime = record(lastInfo.time);
    const terminalAssistant = typeof lastTime.completed === "number"
      && Number.isFinite(lastTime.completed);
    if (!lastAssistant || !terminalAssistant) return "idle";

    const text: string[] = [];
    for (const message of assistants) {
      const info = record(record(message).info);
      const messageId = typeof info.id === "string" ? info.id : null;
      if (!messageId) continue;
      const nativeParts = record(message).parts;
      const parts = Array.isArray(nativeParts) ? nativeParts : [];
      for (const value of parts) {
        const part = record(value);
        const partId = typeof part.id === "string" ? part.id : null;
        if (!partId) continue;
        if (part.type === "text" && typeof part.text === "string" && part.ignored !== true) {
          text.push(part.text);
          emit(
            active.emit,
            "message.delta",
            { text: part.text, replace: true, messageId: partId, recovered: true },
            this.nativePartEventId(sessionId, partId, "text"),
          );
        } else if (part.type === "reasoning" && typeof part.text === "string") {
          emit(
            active.emit,
            "reasoning.delta",
            { text: part.text, replace: true, messageId: partId, recovered: true },
            this.nativePartEventId(sessionId, partId, "reasoning"),
          );
        } else if (part.type === "tool") {
          this.importToolPart(sessionId, part, active.emit);
        } else if (part.type === "patch" && Array.isArray(part.files)) {
          for (const file of part.files) {
            if (typeof file !== "string") continue;
            emit(
              active.emit,
              "file.changed",
              { path: file, messageId, partId, recovered: true },
              this.nativePartEventId(sessionId, partId, `file:${file}`),
            );
          }
        }
      }

      if (typeof info.cost === "number" || Object.keys(record(info.tokens)).length > 0) {
        emit(
          active.emit,
          "usage.recorded",
          { costAmount: typeof info.cost === "number" ? info.cost : null, tokens: info.tokens ?? null, basis: "harness-reported", nativeTurnId: messageId },
          this.nativeMessageEventId(sessionId, messageId, "usage"),
        );
      }
    }

    active.outputText = text.join("");
    const nativeError = record(lastInfo.error);
    if (Object.keys(nativeError).length > 0) {
      emit(
        active.emit,
        "run.failed",
        {
          error: this.nativeMessageError(nativeError),
          nativeError,
          sessionId,
          recovered: true,
          nativeTurnId: userMessageId,
        },
        this.nativeTurnEventId(sessionId, userMessageId, "failed"),
      );
      this.clearPendingMessage(active);
      return "failed";
    }

    emit(
      active.emit,
      "output.completed",
      { text: active.outputText, sessionId, recovered: true, nativeTurnId: userMessageId },
      this.nativeTurnEventId(sessionId, userMessageId, "output"),
    );
    emit(
      active.emit,
      "run.completed",
      { sessionId, recovered: true, nativeMessageId: typeof lastInfo.id === "string" ? lastInfo.id : null, nativeTurnId: userMessageId },
      this.nativeTurnEventId(sessionId, userMessageId, "completed"),
    );
    this.clearPendingMessage(active);
    return "completed";
  }

  private importToolPart(sessionId: string, part: Record<string, unknown>, consumer: Emit): void {
    const partId = typeof part.id === "string" ? part.id : null;
    const callId = typeof part.callID === "string" ? part.callID : partId;
    if (!partId || !callId) return;
    const toolName = typeof part.tool === "string" ? part.tool : "native_tool";
    const state = record(part.state);
    const status = typeof state.status === "string" ? state.status : "pending";
    const payload = {
      toolCallId: callId,
      toolName,
      args: state.input ?? null,
      status,
      recovered: true,
      nativeTurnId: sessionId,
      nativePart: part,
    };
    emit(consumer, "tool.started", payload, this.nativePartEventId(sessionId, partId, "tool-started"));
    if (status === "running" || status === "pending") {
      if (status === "running") {
        emit(consumer, "tool.updated", payload, this.nativePartEventId(sessionId, partId, "tool-running"));
      }
      return;
    }
    emit(
      consumer,
      "tool.completed",
      {
        ...payload,
        result: status === "completed" ? state.output ?? null : null,
        error: status === "error" ? state.error ?? "OpenCode tool failed." : null,
        isError: status === "error",
      },
      this.nativePartEventId(sessionId, partId, "tool-completed"),
    );
  }

  private nativeMessageError(error: Record<string, unknown>): string {
    const data = record(error.data);
    if (typeof data.message === "string") return data.message;
    if (typeof error.name === "string") return error.name;
    return "OpenCode reported a failed native assistant message.";
  }

  private nativePartEventId(sessionId: string, partId: string, suffix: string): string {
    return `opencode:${sessionId}:part:${partId}:${suffix}`;
  }

  private nativeMessageEventId(sessionId: string, messageId: string, suffix: string): string {
    return `opencode:${sessionId}:message:${messageId}:${suffix}`;
  }

  private nativeTurnEventId(sessionId: string, userMessageId: string, suffix: string): string {
    return `opencode:${sessionId}:turn:${userMessageId}:${suffix}`;
  }

  private eventIdentity(sessionId: string, active: ActiveOpenCode, kind: DriverEvent["kind"], payload: unknown, partId: string | null = null): string {
    const providerId = this.providerEventId(payload);
    if (partId) {
      if (providerId) return this.nativePartEventId(sessionId, partId, `${kind}:${providerId}`);
      active.streamSequence += 1;
      this.persistStreamState(active);
      return this.nativePartEventId(sessionId, partId, `${kind}:stream:${active.streamSequence}`);
    }
    if (providerId) return `opencode:${sessionId}:turn:${active.nativeTurnId ?? "unknown"}:event:${providerId}:${kind}`;
    active.streamSequence += 1;
    this.persistStreamState(active);
    return `opencode:${sessionId}:turn:${active.nativeTurnId ?? "unknown"}:event:stream:${active.streamSequence}:${kind}`;
  }

  private providerEventId(payload: unknown): string | null {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const recordPayload = payload as Record<string, unknown>;
    const properties = record(recordPayload.properties);
    const values = [
      recordPayload.id, recordPayload.eventId, recordPayload.event_id,
      recordPayload.sequence, recordPayload.seq, recordPayload.offset,
      properties.id, properties.eventId, properties.event_id,
      properties.sequence, properties.seq, properties.offset,
    ];
    const value = values.find((candidate): candidate is string | number =>
      typeof candidate === "string" || (typeof candidate === "number" && Number.isSafeInteger(candidate)));
    return value === undefined ? null : String(value);
  }

  private turnSequenceFromNativeId(nativeTurnId: string | null): number {
    const match = nativeTurnId?.match(/:turn:(\d+)$/u);
    if (!match) return 0;
    const sequence = Number(match[1]);
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
  }

  private persistStreamState(active: ActiveOpenCode): void {
    if (!active.server) return;
    try {
      const retained = record(active.server.retainedAdapterState());
      const shouldPersistTurnState = active.pendingMessage !== null
        || Object.prototype.hasOwnProperty.call(retained, "turnSequence")
        || Object.prototype.hasOwnProperty.call(retained, "nativeTurnId")
        || Object.prototype.hasOwnProperty.call(retained, "streamSequence")
        || Object.prototype.hasOwnProperty.call(retained, "pendingMessage");
      active.server.updateProcessLease({
        nativeRunId: active.nativeTurnId,
        ...(shouldPersistTurnState ? {
          adapterState: {
            ...retained,
            turnSequence: active.turnSequence,
            nativeTurnId: active.nativeTurnId,
            streamSequence: active.streamSequence,
            pendingMessage: active.pendingMessage as unknown as JsonValue,
          },
        } : {}),
      });
    } catch {
      // The runtime owns lease retirement; late stream callbacks are best
      // effort after the service lease has already been released.
    }
  }

  /**
   * Checkpoint provider turn identity without changing Symphony's logical
   * dispatch fence. In particular, this runs before promptAsync crosses the
   * provider boundary, while `activeTurnId` must remain `initial:<agentId>`.
   */
  private persistNativeTurn(active: ActiveOpenCode): void {
    if (!active.server) return;
    try {
      const retained = record(active.server.retainedAdapterState());
      active.server.updateProcessLease({
        nativeRunId: active.nativeTurnId,
        ...(active.pendingMessage ? {
          adapterState: {
            ...retained,
            pendingMessage: active.pendingMessage as unknown as JsonValue,
            turnSequence: active.turnSequence,
            nativeTurnId: active.nativeTurnId,
          },
        } : {}),
      });
    } catch {
      // The runtime owns lease retirement; late stream callbacks are best
      // effort after the service lease has already been released.
    }
  }

  private clearPendingMessage(active: ActiveOpenCode): void {
    // Keep the last accepted identity in the lease after terminal projection.
    // A controller replay can then correlate the exact native transcript and
    // return the same receipt without submitting a second prompt. A later
    // distinct message replaces this historical marker in sendMessage().
    if (!active.pendingMessage) return;
    this.persistStreamState(active);
  }

  private makeActive(
    client: OpencodeClient,
    onEvent: Emit,
    directory: string,
    server: ServerHandle | undefined,
    runPending: boolean,
  ): ActiveOpenCode {
    return {
      client,
      emit: onEvent,
      directory,
      outputText: "",
      runPending,
      cancelRequested: false,
      closed: false,
      turnSequence: 0,
      nativeTurnId: null,
      streamSequence: 0,
      pendingMessage: null,
      ...(server ? { server } : {}),
    };
  }

  private assertActive(sessionId: string, active: ActiveOpenCode, operation: string): void {
    if (active.closed || this.active.get(sessionId) !== active) {
      throw new Error(`OpenCode event stream ended during ${operation}.`);
    }
  }

  private async closeActive(
    sessionId: string,
    active: ActiveOpenCode,
    closeStream = true,
    closeOwnedServer = true,
  ): Promise<void> {
    if (active.closed) return;
    active.closed = true;
    if (this.active.get(sessionId) === active) this.active.delete(sessionId);
    active.subscription?.abort.abort();
    if (closeStream) await active.subscription?.stream.return?.(undefined).catch(() => undefined);
    if (closeOwnedServer) await this.closeServer(active.server);
  }

  private async closeServer(server: ServerHandle | undefined): Promise<void> {
    if (!server) return;
    try {
      await server.close();
    } catch {
      // Cleanup is best effort and must not mask the lifecycle error that led here.
    }
  }

  private async detachServer(server: ServerHandle | undefined): Promise<void> {
    if (!server) return;
    try {
      await server.detach();
    } catch {
      // Ownership loss must not turn daemon shutdown into native work failure.
    }
  }

  private async retireSetupServer(server: ServerHandle | undefined): Promise<void> {
    if (server?.mode === "reconnected") await this.detachServer(server);
    else await this.closeServer(server);
  }

  private async abortBestEffort(client: OpencodeClient, sessionId: string, directory: string): Promise<void> {
    try {
      await client.session.abort({ path: { id: sessionId }, query: { directory } });
    } catch {
      // The startup error is authoritative; cleanup must not replace it.
    }
  }

  private async configureMcp(client: OpencodeClient, request: DriverStartRequest): Promise<void> {
    const name = `symphony-${request.agentId.toLowerCase()}`;
    const status = await client.mcp.status({ query: { directory: request.workOrder.workspace.path } });
    if (status.data?.[name]) return;
    const response = await client.mcp.add({
      query: { directory: request.workOrder.workspace.path },
      body: {
        name,
        config: {
          type: "local",
          command: [request.coordination.mcpCommand, ...request.coordination.mcpArgs],
          environment: {
            SYMPHONY_DAEMON_URL: request.coordination.daemonUrl,
            SYMPHONY_AGENT_ID: request.agentId,
            SYMPHONY_AGENT_TOKEN: request.coordination.token,
            SYMPHONY_AGENT_CAN_CREATE: String(request.coordination.canCreate),
          },
          enabled: true,
        },
      },
    });
    if (response.error) throw new Error(`OpenCode failed to configure Symphony MCP: ${JSON.stringify(response.error)}`);
  }

  private result(available: boolean, authenticated: boolean | null, detail: string): DriverDoctorResult {
    return { driver: this.id, available, authenticated, version: null, capabilities: this.capabilities, detail };
  }

  private require(session: DriverSession): ActiveOpenCode {
    const active = this.active.get(session.nativeSessionId);
    if (!active) throw new Error(`OpenCode session is not active: ${session.nativeSessionId}`);
    return active;
  }
}

function retainedMessageDispatch(state: Record<string, unknown>): DriverMessageRequest | null {
  const value = record(state.pendingMessage);
  const attemptId = typeof value.attemptId === "string" ? value.attemptId : null;
  const requestId = typeof value.requestId === "string" ? value.requestId : null;
  const contentHash = typeof value.contentHash === "string" ? value.contentHash : null;
  if (!attemptId || !requestId || !contentHash) return null;
  return { attemptId, requestId, contentHash };
}
