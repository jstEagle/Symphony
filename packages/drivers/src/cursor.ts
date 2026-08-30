import { Agent, Cursor, type AgentOptions, type Run, type SDKAgent, type SDKMessage } from "@cursor/sdk";
import type { SecretStore, SymphonyConfig } from "@symphony/config";
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
import { capabilities, emit, makeSession, receipt, record, stringifyError, toJson, type Emit } from "./common.js";

type ActiveCursor = { agent: SDKAgent; run: Run | null; emit: Emit; request: DriverStartRequest };

export class CursorDriver implements WorkerDriver {
  readonly id = "cursor" as const;
  readonly capabilities = capabilities({ cloud: true });
  private readonly active = new Map<string, ActiveCursor>();

  constructor(
    private readonly config: SymphonyConfig["harnesses"]["cursor"],
    private readonly secrets: SecretStore,
  ) {}

  async doctor(): Promise<DriverDoctorResult> {
    if (!this.config.enabled) return this.result(false, false, null, "Cursor driver is disabled.");
    const version = await JsonLineProcess.probe(this.config.process.command, ["--version"]);
    if (!version) return this.result(false, false, null, "Cursor Agent CLI was not found.");
    const status = await JsonLineProcess.probe(this.config.process.command, ["status"]);
    const authenticated = cursorStatusIsAuthenticated(status);
    return this.result(true, authenticated, version, authenticated
      ? "Cursor Agent CLI is installed and the current account is authenticated."
      : "Cursor Agent CLI is installed. Run cursor-agent login, then refresh this live status.");
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const apiKey = this.secrets.get("cursor.apiKey") ?? undefined;
    try {
      const models = await Cursor.models.list(apiKey ? { apiKey } : {});
      return models.map((model) => ({
        id: model.id,
        harness: this.id,
        name: model.displayName,
        description: model.description ?? "",
        modalities: ["text"],
        structuredOutput: false,
        pricing: {},
        metadata: toJson({ aliases: model.aliases ?? [], parameters: model.parameters ?? [], variants: model.variants ?? [] }) as Record<string, never>,
      }));
    } catch {
      return [];
    }
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const options = await this.options(request);
    const agent = await Agent.create(options);
    const active: ActiveCursor = { agent, run: null, emit: onEvent, request };
    this.active.set(agent.agentId, active);
    const run = await agent.send(buildAgentPrompt(request.workOrder), { idempotencyKey: `symphony:${request.agentId}:initial` });
    active.run = run;
    emit(onEvent, "session.started", { agentId: agent.agentId, runId: run.id, cloud: Boolean(request.workOrder.workspace.remoteRepository) });
    this.consume(active, run);
    return makeSession(this.id, agent.agentId, { agentId: request.agentId }, run.id);
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const agent = await Agent.resume(session.nativeSessionId, await this.options(request));
    this.active.set(session.nativeSessionId, { agent, run: null, emit: onEvent, request });
    emit(onEvent, "session.started", { agentId: session.nativeSessionId, resumed: true });
    return { ...session, state: "idle" };
  }

  async sendMessage(session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean }> {
    const active = this.require(session);
    if (active.run?.status === "running") throw new Error("Cursor agent is still running; safe-boundary follow-up is required.");
    const run = await active.agent.send(message);
    active.run = run;
    this.consume(active, run);
    return receipt(false);
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    if (active.run?.status === "running") await active.run.cancel();
  }

  async dispose(): Promise<void> {
    for (const active of this.active.values()) active.agent.close();
    this.active.clear();
  }

  private async options(request: DriverStartRequest): Promise<AgentOptions> {
    const isCloud = Boolean(request.workOrder.workspace.remoteRepository);
    if (isCloud && request.workOrder.permissions === "read-only") {
      throw new Error("Cursor Cloud does not support enforceable read-only tool restrictions; use a local Cursor agent or full-access.");
    }
    let model = request.resolvedModel;
    if (!isCloud && model === "auto") {
      const available = await this.listModels();
      if (!available[0]) throw new Error("Cursor local agents require an explicit model and no authenticated model catalog was available.");
      model = available[0].id;
    }
    const apiKey = this.secrets.get("cursor.apiKey") ?? undefined;
    const options: AgentOptions = {
      name: request.workOrder.objective.slice(0, 100),
      idempotencyKey: `symphony:${request.agentId}`,
      ...(apiKey ? { apiKey } : {}),
      ...(model !== "auto" ? { model: { id: model } } : {}),
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
        repos: [{
          url: request.workOrder.workspace.remoteRepository as string,
          ...(request.workOrder.workspace.startingRef ? { startingRef: request.workOrder.workspace.startingRef } : {}),
        }],
        autoCreatePR: this.config.autoCreatePR,
        metadata: { symphonyAgentId: request.agentId, workflowId: request.workOrder.workflowId, runId: request.workOrder.runId },
      };
    } else {
      options.local = { cwd: request.workOrder.workspace.path, sandboxOptions: { enabled: request.workOrder.permissions === "read-only" } };
      if (request.workOrder.permissions === "read-only") options.tools = ["read", "grep", "glob", "ls", "webSearch", "webFetch", "mcp"];
    }
    return options;
  }

  private consume(active: ActiveCursor, run: Run): void {
    emit(active.emit, "run.started", { runId: run.id });
    void (async () => {
      try {
        for await (const message of run.stream()) this.onMessage(message, active.emit);
        const result = await run.wait();
        if (result.usage) emit(active.emit, "usage.recorded", { usage: result.usage, basis: "harness-reported" });
        if (result.status === "finished") {
          if (result.result) emit(active.emit, "output.completed", { text: result.result });
          emit(active.emit, "run.completed", result);
        } else if (result.status === "cancelled") emit(active.emit, "run.cancelled", result);
        else emit(active.emit, "run.failed", result);
      } catch (error) {
        emit(active.emit, "run.failed", { error: stringifyError(error) });
      }
    })();
  }

  private onMessage(message: SDKMessage, consumer: Emit): void {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") emit(consumer, "message.delta", { text: block.text });
        else emit(consumer, "tool.started", block);
      }
    } else if (message.type === "thinking") emit(consumer, "reasoning.delta", { text: message.text });
    else if (message.type === "tool_call") emit(consumer, message.status === "running" ? "tool.started" : "tool.completed", message);
    else if (message.type === "usage") emit(consumer, "usage.recorded", { usage: message.usage, basis: "harness-reported" });
    else if (message.type === "status" && message.status === "ERROR") emit(consumer, "run.failed", message);
    else emit(consumer, "log", message);
  }

  private result(available: boolean, authenticated: boolean, version: string | null, detail: string): DriverDoctorResult {
    return { driver: this.id, available, authenticated, version, capabilities: this.capabilities, detail };
  }

  private require(session: DriverSession): ActiveCursor {
    const active = this.active.get(session.nativeSessionId);
    if (!active) throw new Error(`Cursor session is not active: ${session.nativeSessionId}`);
    return active;
  }
}

export function cursorStatusIsAuthenticated(status: string | null): boolean {
  return Boolean(status && !/not\s+(?:logged\s+in|authenticated)/iu.test(status) && /logged\s+in|authenticated/iu.test(status));
}
