import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { environmentWithoutDaemonSecret, type SymphonyConfig } from "@symphony/config";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverLifecycleOptions,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
  DriverProcessSupervisor,
} from "@symphony/protocol";
import { buildAgentPrompt } from "./prompt.js";
import { JsonLineProcess } from "./process.js";
import { captureProcessIdentity } from "./process-identity.js";
import { capabilities, emit, makeSession, receipt, stringifyError, type Emit } from "./common.js";

type AcpConfig = SymphonyConfig["harnesses"]["acp"][number];
type ActiveAcp = {
  process: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  emit: Emit;
  sessionId: string;
  output: { text: string };
  failure: Promise<Error>;
  closed: boolean;
  runSequence: number;
  activeRun: number | null;
  processLeaseId: string | null;
  processSupervisor: DriverProcessSupervisor | undefined;
  processReleased: boolean;
};

export class AcpDriver implements WorkerDriver {
  readonly id = "acp" as const;
  readonly capabilities = capabilities({ cloud: false });
  private readonly active = new Map<string, ActiveAcp>();

  constructor(private readonly agents: AcpConfig[]) {}

  async doctor(): Promise<DriverDoctorResult> {
    const enabled = this.agents.filter((agent) => agent.enabled);
    const available = (await Promise.all(enabled.map((agent) => JsonLineProcess.probe(agent.process.command)))).filter(Boolean);
    return {
      driver: this.id,
      available: available.length > 0,
      authenticated: null,
      version: null,
      capabilities: this.capabilities,
      detail: `${available.length}/${enabled.length} configured ACP agents are executable.`,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.agents.filter((agent) => agent.enabled).map((agent) => ({
      id: `acp/${agent.id}`,
      harness: this.id,
      name: agent.id,
      description: `Agent Client Protocol adapter ${agent.id}`,
      modalities: ["text"],
      structuredOutput: false,
      pricing: {},
      metadata: { adapterId: agent.id },
    }));
  }

  async start(
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    options?.signal.throwIfAborted();
    const adapter = this.resolve(request.resolvedModel);
    const active = await this.connect(adapter, request, onEvent, options);
    const abort = () => this.closeActive(active, "SIGKILL", options?.signal.reason);
    options?.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.withFailure(active, active.connection.agent.request(acp.methods.agent.session.new, {
        cwd: request.workOrder.workspace.path,
        mcpServers: [this.mcp(request)],
        _meta: { symphonyAgentId: request.agentId },
      }));
      options?.signal.throwIfAborted();
      active.sessionId = response.sessionId;
      if (active.processSupervisor && active.processLeaseId) active.processSupervisor.updateProcess(active.processLeaseId, {
        nativeSessionId: response.sessionId,
        nativeRunId: null,
        activeTurnId: response.sessionId,
      });
      this.active.set(response.sessionId, active);
      emit(onEvent, "session.started", { sessionId: response.sessionId, adapter: adapter.id });
      this.prompt(active, buildAgentPrompt(request.workOrder));
      return makeSession(this.id, response.sessionId, { adapterId: adapter.id, agentId: request.agentId });
    } catch (error) {
      this.closeActive(active, "SIGTERM", error);
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
    const adapterId = typeof session.metadata.adapterId === "string" ? session.metadata.adapterId : request.resolvedModel.replace(/^acp\//u, "");
    const adapter = this.agents.find((candidate) => candidate.id === adapterId);
    if (!adapter) throw new Error(`ACP adapter not configured: ${adapterId}`);
    const active = await this.connect(adapter, request, onEvent, options);
    const abort = () => this.closeActive(active, "SIGKILL", options?.signal.reason);
    options?.signal.addEventListener("abort", abort, { once: true });
    try {
      await this.withFailure(active, active.connection.agent.request(acp.methods.agent.session.resume, {
        sessionId: session.nativeSessionId,
        cwd: request.workOrder.workspace.path,
        mcpServers: [this.mcp(request)],
      }));
      options?.signal.throwIfAborted();
      active.sessionId = session.nativeSessionId;
      if (active.processSupervisor && active.processLeaseId) active.processSupervisor.updateProcess(active.processLeaseId, {
        nativeSessionId: session.nativeSessionId,
        nativeRunId: session.nativeRunId,
        activeTurnId: null,
      });
      this.active.set(session.nativeSessionId, active);
      emit(onEvent, "session.started", { sessionId: session.nativeSessionId, adapter: adapter.id, resumed: true });
      return { ...session, state: "unknown" };
    } catch (error) {
      this.closeActive(active, "SIGTERM", error);
      throw error;
    } finally {
      options?.signal.removeEventListener("abort", abort);
    }
  }

  async sendMessage(session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean }> {
    this.prompt(this.require(session), message);
    return receipt(false);
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    await this.withFailure(active, active.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: active.sessionId }));
  }

  async forceTerminate(session: DriverSession): Promise<void> {
    const active = this.active.get(session.nativeSessionId);
    if (!active) return;
    this.closeActive(active, "SIGKILL");
  }

  async dispose(): Promise<void> {
    for (const active of [...this.active.values()]) this.closeActive(active, "SIGTERM");
  }

  private async connect(
    adapter: AcpConfig,
    request: DriverStartRequest,
    consumer: Emit,
    options?: DriverLifecycleOptions,
  ): Promise<ActiveAcp> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const processSupervisor = options?.processSupervisor;
    const processLease = processSupervisor?.reserveProcess({
      role: `acp-adapter:${adapter.id}`,
      command: adapter.process.command,
      args: adapter.process.args,
      cwd: request.workOrder.workspace.path,
      adapterVersion: null,
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(adapter.process.command, adapter.process.args, {
        cwd: request.workOrder.workspace.path,
        env: environmentWithoutDaemonSecret(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      if (processLease) {
        processSupervisor?.releaseProcess(processLease.id, {
          exitCode: null,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
    let active: ActiveAcp | undefined;
    let failure: Error | undefined;
    let resolveFailure!: (error: Error) => void;
    const failurePromise = new Promise<Error>((resolve) => {
      resolveFailure = resolve;
    });
    const reportFailure = (error: Error): void => {
      if (failure) return;
      failure = error;
      resolveFailure(error);
      if (active) this.onUnexpectedClose(active, error);
    };
    let processReleased = false;
    const releaseProcess = (exitCode: number | null, exitSignal: NodeJS.Signals | null, error: string | null) => {
      if (!processLease || processReleased) return;
      processReleased = true;
      try {
        processSupervisor?.releaseProcess(processLease.id, { exitCode, signal: exitSignal, error });
      } catch {
        // The durable store may already be closing.
      }
      if (active) active.processReleased = true;
    };
    child.once("error", (error) => {
      if (!child.pid) releaseProcess(null, null, error.message);
      reportFailure(error);
    });
    child.once("exit", (code, signal) => {
      releaseProcess(code, signal, null);
      reportFailure(new Error(`ACP process exited (code=${String(code)}, signal=${String(signal)})`));
    });
    if (processLease && child.pid) {
      const identity = captureProcessIdentity(child.pid);
      if (!identity) {
        this.terminateProcess(child, "SIGKILL");
        throw new Error(`Could not capture identity for newly spawned ACP PID ${child.pid}.`);
      }
      try {
        processSupervisor?.attachProcess(processLease.id, identity);
      } catch (error) {
        this.terminateProcess(child, "SIGKILL");
        throw error;
      }
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => emit(consumer, "log", { stream: "stderr", text: chunk }));
    const output = { text: "" };
    let connection: acp.ClientConnection;
    try {
      const app = acp.client({ name: "symphony" })
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
          emit(consumer, "approval.requested", params);
          if (request.workOrder.permissions === "read-only") return { outcome: { outcome: "cancelled" as const } };
          const choice = params.options.find((option) => option.kind === "allow_always")
            ?? params.options.find((option) => option.kind === "allow_once");
          return choice
            ? { outcome: { outcome: "selected" as const, optionId: choice.optionId } }
            : { outcome: { outcome: "cancelled" as const } };
        })
        .onNotification(acp.methods.client.session.update, ({ params }) => this.onUpdate(params.update, consumer, output));
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      connection = app.connect(stream);
    } catch (error) {
      this.terminateProcess(child, "SIGTERM");
      throw error;
    }
    const connected: ActiveAcp = {
      process: child,
      connection,
      emit: consumer,
      sessionId: request.agentId,
      output,
      failure: failurePromise,
      closed: false,
      runSequence: 0,
      activeRun: null,
      processLeaseId: processLease?.id ?? null,
      processSupervisor,
      processReleased,
    };
    active = connected;
    const abort = () => this.closeActive(connected, "SIGKILL", signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    void connection.closed.then(
      () => reportFailure(new Error("ACP connection closed unexpectedly")),
      (error: unknown) => reportFailure(error instanceof Error ? error : new Error(String(error))),
    );
    if (failure) this.onUnexpectedClose(connected, failure);
    try {
      await this.withFailure(connected, connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }));
      signal?.throwIfAborted();
      return connected;
    } catch (error) {
      this.closeActive(connected, "SIGTERM", error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private prompt(active: ActiveAcp, text: string): void {
    active.output.text = "";
    const run = ++active.runSequence;
    active.activeRun = run;
    emit(active.emit, "run.started", { sessionId: active.sessionId });
    void this.withFailure(active, active.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: active.sessionId,
      prompt: [{ type: "text", text }],
    })).then((response) => {
      if (!this.settleRun(active, run)) return;
      if (response.usage) emit(active.emit, "usage.recorded", { usage: response.usage, basis: "harness-reported" });
      if (response.stopReason === "cancelled") emit(active.emit, "run.cancelled", response);
      else {
        emit(active.emit, "output.completed", { text: active.output.text });
        emit(active.emit, "run.completed", response);
      }
    }).catch((error) => {
      if (this.settleRun(active, run)) emit(active.emit, "run.failed", { error: stringifyError(error) });
    });
  }

  private async withFailure<T>(active: ActiveAcp, operation: Promise<T>): Promise<T> {
    return await Promise.race([
      operation,
      active.failure.then((error): never => {
        throw error;
      }),
    ]);
  }

  private settleRun(active: ActiveAcp, run: number): boolean {
    if (active.activeRun !== run) return false;
    active.activeRun = null;
    return true;
  }

  private onUnexpectedClose(active: ActiveAcp, error: Error): void {
    if (active.closed) return;
    const run = active.activeRun;
    if (run !== null && this.settleRun(active, run)) {
      emit(active.emit, "run.failed", { error: stringifyError(error) });
    }
    this.closeActive(active, "SIGTERM", error);
  }

  private closeActive(active: ActiveAcp, signal: NodeJS.Signals, error?: unknown): void {
    if (active.closed) return;
    active.closed = true;
    if (this.active.get(active.sessionId) === active) this.active.delete(active.sessionId);
    try {
      active.connection.close(error);
    } catch {
      // The child process is still terminated below; connection shutdown is best-effort.
    }
    this.terminateProcess(active.process, signal);
  }

  private terminateProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }

  private onUpdate(update: acp.SessionUpdate, consumer: Emit, output: { text: string }): void {
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") output.text += update.content.text;
      if (update.content.type === "text") emit(consumer, "message.delta", { text: update.content.text });
    }
    else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") emit(consumer, "reasoning.delta", { text: update.content.text });
    else if (update.sessionUpdate === "tool_call") emit(consumer, "tool.started", update);
    else if (update.sessionUpdate === "tool_call_update") emit(consumer, "tool.updated", update);
    else if (update.sessionUpdate === "usage_update") emit(consumer, "usage.recorded", { usage: update, basis: "harness-reported" });
    else emit(consumer, "log", update);
  }

  private mcp(request: DriverStartRequest): acp.McpServer {
    return {
      name: "symphony",
      command: request.coordination.mcpCommand,
      args: request.coordination.mcpArgs,
      env: [
        { name: "SYMPHONY_DAEMON_URL", value: request.coordination.daemonUrl },
        { name: "SYMPHONY_AGENT_ID", value: request.agentId },
        { name: "SYMPHONY_AGENT_TOKEN", value: request.coordination.token },
        { name: "SYMPHONY_AGENT_CAN_CREATE", value: String(request.coordination.canCreate) },
      ],
    };
  }

  private resolve(model: string): AcpConfig {
    const id = model.replace(/^acp\//u, "");
    const adapter = this.agents.find((candidate) => candidate.enabled && (candidate.id === id || model === "auto"));
    if (!adapter) throw new Error(`No enabled ACP adapter matches ${model}`);
    return adapter;
  }

  private require(session: DriverSession): ActiveAcp {
    const active = this.active.get(session.nativeSessionId);
    if (!active) throw new Error(`ACP session is not active: ${session.nativeSessionId}`);
    return active;
  }
}
