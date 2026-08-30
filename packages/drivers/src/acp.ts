import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { SymphonyConfig } from "@symphony/config";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "@symphony/protocol";
import { buildAgentPrompt } from "./prompt.js";
import { JsonLineProcess } from "./process.js";
import { capabilities, emit, makeSession, receipt, stringifyError, type Emit } from "./common.js";

type AcpConfig = SymphonyConfig["harnesses"]["acp"][number];
type ActiveAcp = {
  process: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  emit: Emit;
  sessionId: string;
  output: { text: string };
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

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const adapter = this.resolve(request.resolvedModel);
    const active = await this.connect(adapter, request, onEvent);
    const response = await active.connection.agent.request(acp.methods.agent.session.new, {
      cwd: request.workOrder.workspace.path,
      mcpServers: [this.mcp(request)],
      _meta: { symphonyAgentId: request.agentId },
    });
    active.sessionId = response.sessionId;
    this.active.set(response.sessionId, active);
    emit(onEvent, "session.started", { sessionId: response.sessionId, adapter: adapter.id });
    this.prompt(active, buildAgentPrompt(request.workOrder));
    return makeSession(this.id, response.sessionId, { adapterId: adapter.id, agentId: request.agentId });
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const adapterId = typeof session.metadata.adapterId === "string" ? session.metadata.adapterId : request.resolvedModel.replace(/^acp\//u, "");
    const adapter = this.agents.find((candidate) => candidate.id === adapterId);
    if (!adapter) throw new Error(`ACP adapter not configured: ${adapterId}`);
    const active = await this.connect(adapter, request, onEvent);
    await active.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId: session.nativeSessionId,
      cwd: request.workOrder.workspace.path,
      mcpServers: [this.mcp(request)],
    });
    active.sessionId = session.nativeSessionId;
    this.active.set(session.nativeSessionId, active);
    emit(onEvent, "session.started", { sessionId: session.nativeSessionId, adapter: adapter.id, resumed: true });
    return { ...session, state: "idle" };
  }

  async sendMessage(session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean }> {
    this.prompt(this.require(session), message);
    return receipt(false);
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    await active.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: active.sessionId });
  }

  async dispose(): Promise<void> {
    for (const active of this.active.values()) {
      active.connection.close();
      active.process.kill("SIGTERM");
    }
    this.active.clear();
  }

  private async connect(adapter: AcpConfig, request: DriverStartRequest, consumer: Emit): Promise<ActiveAcp> {
    const child = spawn(adapter.process.command, adapter.process.args, {
      cwd: request.workOrder.workspace.path,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => emit(consumer, "log", { stream: "stderr", text: chunk }));
    const output = { text: "" };
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
    const connection = app.connect(stream);
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    return { process: child, connection, emit: consumer, sessionId: request.agentId, output };
  }

  private prompt(active: ActiveAcp, text: string): void {
    active.output.text = "";
    emit(active.emit, "run.started", { sessionId: active.sessionId });
    void active.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: active.sessionId,
      prompt: [{ type: "text", text }],
    }).then((response) => {
      if (response.usage) emit(active.emit, "usage.recorded", { usage: response.usage, basis: "harness-reported" });
      if (response.stopReason === "cancelled") emit(active.emit, "run.cancelled", response);
      else {
        emit(active.emit, "output.completed", { text: active.output.text });
        emit(active.emit, "run.completed", response);
      }
    }).catch((error) => emit(active.emit, "run.failed", { error: stringifyError(error) }));
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
