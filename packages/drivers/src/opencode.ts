import { createOpencode, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
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
import { capabilities, emit, makeSession, receipt, record, stringifyError, type Emit } from "./common.js";

type ServerHandle = { url: string; close(): void };
type ActiveOpenCode = { client: OpencodeClient; emit: Emit; directory: string; outputText: string; server?: ServerHandle };

export class OpenCodeDriver implements WorkerDriver {
  readonly id = "opencode" as const;
  readonly capabilities = capabilities({ steer: false, cloud: false });
  private readonly active = new Map<string, ActiveOpenCode>();

  constructor(private readonly config: SymphonyConfig["harnesses"]["opencode"]) {}

  async doctor(): Promise<DriverDoctorResult> {
    try {
      const client = createOpencodeClient({ baseUrl: this.config.baseUrl });
      const response = await client.path.get();
      return this.result(Boolean(response.data), null, response.data ? "OpenCode server is reachable." : "OpenCode SDK loaded but server did not answer.");
    } catch (error) {
      return this.result(this.config.autoStart, null, this.config.autoStart ? "OpenCode will be started on demand." : stringifyError(error));
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    let server: ServerHandle | undefined;
    try {
      let client = createOpencodeClient({ baseUrl: this.config.baseUrl });
      let response = await client.provider.list().catch(() => null);
      if (!response?.data && this.config.autoStart) {
        const started = await createOpencode({ hostname: "127.0.0.1", port: 0 });
        client = started.client;
        server = started.server;
        response = await client.provider.list();
      }
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
    } finally {
      server?.close();
    }
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const { client, server } = await this.client(request.workOrder.workspace.path);
    await this.configureMcp(client, request);
    const created = await client.session.create({
      body: { title: request.workOrder.objective.slice(0, 100) },
      query: { directory: request.workOrder.workspace.path },
    });
    if (!created.data) throw new Error(`OpenCode failed to create a session: ${JSON.stringify(created.error)}`);
    const sessionId = created.data.id;
    const active: ActiveOpenCode = { client, emit: onEvent, directory: request.workOrder.workspace.path, outputText: "", ...(server ? { server } : {}) };
    this.active.set(sessionId, active);
    await this.subscribe(sessionId, active);
    await this.prompt(sessionId, request, buildAgentPrompt(request.workOrder), active);
    emit(onEvent, "session.started", { sessionId });
    return makeSession(this.id, sessionId, { agentId: request.agentId });
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const { client, server } = await this.client(request.workOrder.workspace.path);
    await this.configureMcp(client, request);
    const found = await client.session.get({ path: { id: session.nativeSessionId }, query: { directory: request.workOrder.workspace.path } });
    if (!found.data) throw new Error(`OpenCode session not found: ${session.nativeSessionId}`);
    const active: ActiveOpenCode = { client, emit: onEvent, directory: request.workOrder.workspace.path, outputText: "", ...(server ? { server } : {}) };
    this.active.set(session.nativeSessionId, active);
    await this.subscribe(session.nativeSessionId, active);
    emit(onEvent, "session.started", { sessionId: session.nativeSessionId, resumed: true });
    return { ...session, state: "idle" };
  }

  async sendMessage(session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean }> {
    const active = this.require(session);
    active.outputText = "";
    const response = await active.client.session.promptAsync({
      path: { id: session.nativeSessionId },
      query: { directory: active.directory },
      body: { parts: [{ type: "text", text: message }] },
    });
    if (response.error) throw new Error(JSON.stringify(response.error));
    return receipt(false);
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    await active.client.session.abort({ path: { id: session.nativeSessionId }, query: { directory: active.directory } });
  }

  async dispose(): Promise<void> {
    for (const active of this.active.values()) active.server?.close();
    this.active.clear();
  }

  private async client(directory: string): Promise<{ client: OpencodeClient; server?: ServerHandle }> {
    if (!this.config.autoStart) return { client: createOpencodeClient({ baseUrl: this.config.baseUrl, directory }) };
    try {
      const existing = createOpencodeClient({ baseUrl: this.config.baseUrl, directory });
      const response = await existing.path.get();
      if (response.data) return { client: existing };
    } catch {
      // Start an isolated native server below.
    }
    const started = await createOpencode({ hostname: "127.0.0.1", port: 0 });
    return { client: started.client, server: started.server };
  }

  private async prompt(sessionId: string, request: DriverStartRequest, text: string, active: ActiveOpenCode): Promise<void> {
    active.outputText = "";
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
  }

  private async subscribe(sessionId: string, active: ActiveOpenCode): Promise<void> {
    const subscription = await active.client.event.subscribe({ query: { directory: active.directory } });
    void (async () => {
      try {
        for await (const event of subscription.stream) {
          const properties = record(event.properties);
          const eventSessionId = typeof properties.sessionID === "string"
            ? properties.sessionID
            : typeof record(properties.part).sessionID === "string" ? record(properties.part).sessionID as string : undefined;
          if (eventSessionId && eventSessionId !== sessionId) continue;
          if (event.type === "session.status" && record(properties.status).type === "busy") emit(active.emit, "run.started", event);
          else if (event.type === "session.idle") {
            emit(active.emit, "output.completed", { text: active.outputText });
            emit(active.emit, "run.completed", event);
          }
          else if (event.type === "session.error") emit(active.emit, "run.failed", event);
          else if (event.type === "file.edited") emit(active.emit, "file.changed", event);
          else if (event.type === "message.part.updated") {
            const part = record(properties.part);
            if (part.type === "text") {
              const delta = typeof properties.delta === "string" ? properties.delta : null;
              if (delta !== null) active.outputText += delta;
              else if (typeof part.text === "string") active.outputText = part.text;
              emit(active.emit, "message.delta", { text: delta ?? part.text ?? "", replace: delta === null, messageId: part.id ?? null });
            }
            else if (part.type === "reasoning") emit(active.emit, "reasoning.delta", { text: properties.delta ?? part.text ?? "", part });
            else if (part.type === "tool") emit(active.emit, "tool.updated", part);
            else emit(active.emit, "log", event);
          } else if (event.type === "message.updated") {
            const info = record(properties.info);
            if (info.role === "assistant" && typeof info.cost === "number") {
              emit(active.emit, "usage.recorded", { costAmount: info.cost, tokens: info.tokens ?? null, basis: "harness-reported" });
            }
          }
        }
      } catch (error) {
        emit(active.emit, "run.failed", { error: stringifyError(error) });
      }
    })();
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
