import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SymphonyConfig } from "@symphony/config";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "@symphony/protocol";
import { buildAgentPrompt, buildSymphonyOperatingContract, isConductor } from "./prompt.js";
import { JsonLineProcess } from "./process.js";
import { capabilities, emit, makeSession, receipt, record, stringifyError, type Emit } from "./common.js";

type ActiveClaude = {
  request: DriverStartRequest;
  emit: Emit;
  query: Query | null;
  sessionId: string;
  running: boolean;
  queued: string[];
};

export class ClaudeDriver implements WorkerDriver {
  readonly id = "claude" as const;
  readonly capabilities = capabilities({ steer: false, cloud: false });
  private readonly active = new Map<string, ActiveClaude>();

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
    return [];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const active: ActiveClaude = {
      request,
      emit: onEvent,
      query: null,
      sessionId: request.agentId,
      running: true,
      queued: [],
    };
    const ready = this.run(active, buildAgentPrompt(request.workOrder));
    const sessionId = await ready;
    active.sessionId = sessionId;
    this.active.set(sessionId, active);
    emit(onEvent, "session.started", { sessionId });
    return makeSession(this.id, sessionId, { agentId: request.agentId });
  }

  async resume(session: DriverSession, request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const active: ActiveClaude = {
      request,
      emit: onEvent,
      query: null,
      sessionId: session.nativeSessionId,
      running: false,
      queued: [],
    };
    this.active.set(session.nativeSessionId, active);
    emit(onEvent, "session.started", { sessionId: session.nativeSessionId, resumed: true });
    return { ...session, state: "idle" };
  }

  async sendMessage(session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean }> {
    const active = this.require(session);
    if (active.running) {
      active.queued.push(message);
      return receipt(true);
    }
    active.running = true;
    void this.run(active, message, active.sessionId);
    return receipt(false);
  }

  async cancel(session: DriverSession): Promise<void> {
    const active = this.require(session);
    if (active.query) await active.query.interrupt().catch(() => active.query?.close());
  }

  async dispose(): Promise<void> {
    for (const active of this.active.values()) active.query?.close();
    this.active.clear();
  }

  private options(request: DriverStartRequest, resume?: string): Options {
    const full = request.workOrder.permissions === "full-access";
    const options: Options = {
      cwd: request.workOrder.workspace.path,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "symphony/0.1.0" },
      includePartialMessages: true,
      persistSession: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildSymphonyOperatingContract(request.workOrder, {
          agentId: request.agentId,
          canCreate: request.coordination.canCreate,
        }),
      },
      ...(isConductor(request.workOrder) ? {} : { outputFormat: { type: "json_schema" as const, schema: request.workOrder.outputSchema } }),
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
      ...(resume ? { resume } : {}),
      ...(request.resolvedModel !== "auto" ? { model: request.resolvedModel } : {}),
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

  private run(active: ActiveClaude, prompt: string, resume?: string): Promise<string> {
    let resolveReady!: (value: string) => void;
    let rejectReady!: (reason?: unknown) => void;
    const ready = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const runningQuery = query({ prompt, options: this.options(active.request, resume) });
    active.query = runningQuery;
    active.running = true;
    void (async () => {
      let resolved = false;
      try {
        for await (const message of runningQuery) {
          const sessionId = "session_id" in message && typeof message.session_id === "string" ? message.session_id : undefined;
          if (sessionId && !resolved) {
            resolved = true;
            resolveReady(sessionId);
          }
          this.onMessage(message, active.emit);
        }
        if (!resolved) resolveReady(active.sessionId);
      } catch (error) {
        if (!resolved) rejectReady(error);
        emit(active.emit, "run.failed", { error: stringifyError(error) });
      } finally {
        active.query = null;
        active.running = false;
        const next = active.queued.shift();
        if (next) void this.run(active, next, active.sessionId);
      }
    })();
    return ready;
  }

  private onMessage(message: SDKMessage, consumer: Emit): void {
    if (message.type === "system" && message.subtype === "init") {
      emit(consumer, "run.started", { sessionId: message.session_id, model: message.model, tools: message.tools });
      return;
    }
    if (message.type === "assistant") {
      const body = record(message.message);
      const blocks = Array.isArray(body.content) ? body.content : [];
      for (const blockValue of blocks) {
        const block = record(blockValue);
        if (block.type === "tool_use") emit(consumer, "tool.started", block);
      }
      return;
    }
    if (message.type === "result") {
      emit(consumer, "usage.recorded", {
        costAmount: message.total_cost_usd,
        usage: message.usage,
        modelUsage: message.modelUsage,
        basis: "harness-reported",
      });
      if (message.subtype === "success" && !message.is_error) {
        emit(consumer, "output.completed", { text: message.result, structuredOutput: message.structured_output ?? null });
        emit(consumer, "run.completed", { stopReason: message.stop_reason, turns: message.num_turns });
      } else {
        emit(consumer, "run.failed", { subtype: message.subtype, errors: "errors" in message ? message.errors : [] });
      }
      return;
    }
    if (message.type === "stream_event") {
      const streamEvent = record(message.event);
      const delta = record(streamEvent.delta);
      if (streamEvent.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
        emit(consumer, "message.delta", { text: delta.text, index: streamEvent.index ?? null });
      } else if (streamEvent.type === "content_block_delta" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        emit(consumer, "reasoning.delta", { text: delta.thinking, index: streamEvent.index ?? null });
      } else emit(consumer, "log", message);
    } else emit(consumer, "log", message);
  }

  private require(session: DriverSession): ActiveClaude {
    const active = this.active.get(session.nativeSessionId);
    if (!active) throw new Error(`Claude session is not active: ${session.nativeSessionId}`);
    return active;
  }
}
