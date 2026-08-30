import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { ulid } from "ulid";
import { z } from "zod";
import { loadConfig, SecretStore, writeConfig, type LoadedConfig } from "@symphony/config";
import { buildConductorTurnPrompt, createDriverRegistry, type DriverRegistry } from "@symphony/drivers";
import { PluginHost } from "@symphony/plugins";
import {
  CommandSchema,
  ConversationMessageSchema,
  JsonValueSchema,
  nowIso,
  type BootstrapProjection,
  type Command,
  type CommandReceipt,
  type EventEnvelope,
  type JsonValue,
  type ProjectRecord,
  type WorkflowMission,
} from "@symphony/protocol";
import { AgentCoordinator, ModelRouter, PassiveObserver, UiUtilityService } from "@symphony/runtime";
import { createStore, type ChatThreadRecord, type SymphonyStore } from "@symphony/storage";
import { TriggerManager, WorkflowCompiler, WorkflowEngine, WorkflowLoader, loadWorkflowDirectory } from "@symphony/workflow";
import { HarnessMaintenance } from "./harness-maintenance.js";

export type StartDaemonOptions = {
  rootDirectory?: string;
  configPath?: string;
  noPlugins?: boolean;
  port?: number;
  host?: string;
};

const ChatAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(500),
  type: z.string().min(1).max(100),
  contentType: z.string().max(200).optional(),
  content: z.array(JsonValueSchema),
});

const ChatMessageInputSchema = z.object({
  messageId: z.string().min(1).optional(),
  content: z.string().max(1_000_000).default(""),
  attachments: z.array(ChatAttachmentSchema).max(20).default([]),
}).refine((input) => input.content.trim().length > 0 || input.attachments.length > 0, {
  message: "A message or attachment is required.",
});

type ChatMessageInput = z.infer<typeof ChatMessageInputSchema>;

const ThemeFileSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().min(1).max(100),
  colors: z.record(z.string().regex(/^[a-z0-9-]+$/u), z.string().min(1).max(500)),
});

const UI_EVENT_TYPES = [
  "agent.queued",
  "agent.routed",
  "agent.message.sent",
  "agent.cancelled",
  "agent.failed",
  "chat.message.updated",
  "chat.title.generated",
  "chat.ui.presented",
  "config.updated",
  "daemon.started",
  "driver.run.started",
  "driver.tool.started",
  "driver.usage.recorded",
  "driver.output.completed",
  "driver.updated",
  "driver.update.failed",
  "driver.run.completed",
  "driver.run.failed",
  "observer.usage.recorded",
  "project.created",
  "project.updated",
  "router.usage.recorded",
  "ui.utility.usage.recorded",
] as const;
const UI_EVENT_PREFIXES = ["workflow.", "plugin."] as const;
const DEFAULT_CHAT_MISSION = "Help the user accomplish the evolving objective in this conversation.";
const LEGACY_CHAT_MISSION = "Help the user accomplish the evolving objective in this conversation by delegating focused work to the best native agents and synthesizing verified results.";

type ChatStreamState = {
  messageId: string;
  threadId: string;
  createdAt: string;
  text: string;
  reasoning: string;
};

export class ProjectService {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: SymphonyStore,
  ) {
    this.seedFromExistingThreads();
  }

  list(): ProjectRecord[] {
    return this.store.listProjects().map((project) => ({
      ...project,
      isGitRepository: existsSync(join(project.workspacePath, ".git")),
    }));
  }

  get(id: string): ProjectRecord {
    const project = this.store.getProject(id);
    if (!project) throw new HttpError(404, `Project not found: ${id}`);
    return { ...project, isGitRepository: existsSync(join(project.workspacePath, ".git")) };
  }

  create(input: { workspacePath: string; title?: string | undefined }): ProjectRecord {
    const workspacePath = this.canonicalDirectory(input.workspacePath);
    const existing = this.store.getProjectByPath(workspacePath);
    const now = nowIso();
    const project: ProjectRecord = {
      id: existing?.id ?? projectIdForPath(workspacePath),
      title: input.title?.trim() || existing?.title || basename(workspacePath) || workspacePath,
      workspacePath,
      isGitRepository: existsSync(join(workspacePath, ".git")),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.saveProject(project);
    this.store.appendEvent({
      type: existing ? "project.updated" : "project.created",
      workflowId: null,
      runId: null,
      agentId: null,
      occurredAt: now,
      payload: project as unknown as JsonValue,
      provenance: { source: "user" },
    });
    return project;
  }

  browse(inputPath?: string | null) {
    const currentPath = this.canonicalDirectory(inputPath?.trim() || homedir());
    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch (error) {
      throw new HttpError(403, `Cannot browse ${currentPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const directories = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .flatMap((entry) => {
        const path = join(currentPath, entry.name);
        try {
          if (!statSync(path).isDirectory()) return [];
        } catch {
          return [];
        }
        return [{ name: entry.name, path, isGitRepository: existsSync(join(path, ".git")) }];
      })
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
    const parent = dirname(currentPath);
    return {
      currentPath,
      parentPath: parent === currentPath ? null : parent,
      entries: directories,
    };
  }

  private canonicalDirectory(inputPath: string): string {
    const expanded = inputPath.replace(/^~(?=$|[\\/])/u, homedir());
    const absolute = isAbsolute(expanded) ? expanded : resolve(this.loaded.rootDirectory, expanded);
    if (!existsSync(absolute)) throw new HttpError(404, `Folder does not exist: ${absolute}`);
    let canonical: string;
    try {
      canonical = realpathSync.native(absolute);
    } catch (error) {
      throw new HttpError(400, `Cannot resolve folder: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!statSync(canonical).isDirectory()) throw new HttpError(400, `Path is not a folder: ${canonical}`);
    return canonical;
  }

  private seedFromExistingThreads(): void {
    for (const thread of this.store.listThreads({ includeArchived: true })) {
      if (!existsSync(thread.workspacePath)) continue;
      let workspacePath: string;
      try {
        workspacePath = this.canonicalDirectory(thread.workspacePath);
      } catch {
        continue;
      }
      if (this.store.getProjectByPath(workspacePath)) continue;
      const now = thread.updatedAt || nowIso();
      this.store.saveProject({
        id: projectIdForPath(workspacePath),
        title: basename(workspacePath) || workspacePath,
        workspacePath,
        isGitRepository: existsSync(join(workspacePath, ".git")),
        createdAt: thread.createdAt || now,
        updatedAt: now,
      });
    }
  }
}

export class ChatService {
  private readonly unsubscribe: () => void;
  private readonly streams = new Map<string, ChatStreamState>();

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: SymphonyStore,
    private readonly agents: AgentCoordinator,
    private readonly uiUtilities: UiUtilityService,
  ) {
    this.migrateLegacyDefaultMissions();
    this.unsubscribe = this.store.onEvent((event) => this.capture(event));
  }

  close(): void {
    this.unsubscribe();
  }

  private migrateLegacyDefaultMissions(): void {
    for (const thread of this.store.listThreads({ includeArchived: true })) {
      const mission = thread.mission;
      if (!mission || typeof mission !== "object" || Array.isArray(mission)) continue;
      const record = mission as Record<string, JsonValue>;
      if (record.statement !== LEGACY_CHAT_MISSION) continue;
      const statement = DEFAULT_CHAT_MISSION;
      const keyResults: string[] = [];
      this.store.saveThread({
        ...thread,
        mission: {
          ...record,
          statement,
          keyResults,
          revision: typeof record.revision === "number" ? record.revision + 1 : 1,
          hash: hashMission(statement, keyResults),
        },
        updatedAt: thread.updatedAt,
      });
    }
  }

  list(): ChatThreadRecord[] {
    return this.store.listThreads();
  }

  get(id: string): { thread: ChatThreadRecord; messages: ReturnType<SymphonyStore["listConversationMessages"]> } {
    const thread = this.store.getThread(id);
    if (!thread) throw new HttpError(404, `Chat thread not found: ${id}`);
    return { thread, messages: this.store.listConversationMessages(id) };
  }

  create(input: { title?: string | undefined; groupId?: string | null | undefined; mission?: { statement: string; keyResults?: string[] | undefined } | undefined; workspacePath?: string | undefined }): ChatThreadRecord {
    const id = ulid();
    const now = nowIso();
    const statement = input.mission?.statement ?? DEFAULT_CHAT_MISSION;
    const keyResults = input.mission?.keyResults ?? [];
    const hash = hashMission(statement, keyResults);
    const mission: WorkflowMission = { id: `chat:${id}`, revision: 1, hash, statement, keyResults };
    const thread: ChatThreadRecord = {
      id, title: input.title ?? "New Symphony chat", groupId: input.groupId ?? null,
      conductorAgentId: null, mission: mission as unknown as JsonValue,
      workspacePath: resolve(input.workspacePath ?? this.loaded.rootDirectory), archived: false, createdAt: now, updatedAt: now,
    };
    this.store.saveThread(thread);
    this.store.saveRun({
      id: `chat-run:${id}`, workflowId: `chat:${id}`, workflowRevision: 1, status: "running", input: {}, output: null,
      error: null, startedAt: now, updatedAt: now, finishedAt: null, cancelRequested: false,
    });
    return thread;
  }

  async message(threadId: string, input: ChatMessageInput): Promise<{ thread: ChatThreadRecord; agentId: string; messageId: string }> {
    let thread = this.store.getThread(threadId);
    if (!thread) throw new HttpError(404, `Chat thread not found: ${threadId}`);
    const previousMessages = this.store.listConversationMessages(threadId);
    const currentConductor = thread.conductorAgentId ? this.store.getAgent(thread.conductorAgentId) : null;
    const terminalFailure = currentConductor
      ? ["failed", "lost", "cancelled", "interrupted"].includes(currentConductor.status)
      : false;
    const resumable = currentConductor ? this.agents.hasSession(currentConductor.id) : false;
    const needsConductor = !currentConductor || terminalFailure || (!resumable && currentConductor.status === "completed");
    if (currentConductor && !needsConductor && !resumable) {
      throw new HttpError(409, "The conductor is still starting. Wait for it to become active before sending another message.");
    }
    const parts: JsonValue[] = [
      ...(input.content.trim() ? [{ type: "text", text: input.content }] : []),
      ...input.attachments.map((attachment) => ({
        type: "attachment",
        id: attachment.id,
        name: attachment.name,
        attachmentType: attachment.type,
        contentType: attachment.contentType ?? null,
        content: attachment.content,
      })),
    ];
    const userMessage = ConversationMessageSchema.parse({
      id: input.messageId ?? ulid(),
      threadId,
      role: "user",
      parts,
      createdAt: nowIso(),
    });
    this.store.appendConversationMessage(userMessage);
    if (isDefaultChatTitle(thread.title) && input.content.trim()) {
      const fallbackTitle = titleFromMessage(input.content);
      thread = { ...thread, title: fallbackTitle, updatedAt: nowIso() };
      this.store.saveThread(thread);
      void this.refineTitle(threadId, input.content, fallbackTitle);
    }

    const nativeContent = promptFromChatInput(input);

    if (needsConductor) {
      const mission = thread.mission as unknown as WorkflowMission;
      const history = conversationContext(previousMessages);
      const agent = await this.agents.create({
        workflowId: `chat:${threadId}`,
        runId: `chat-run:${threadId}`,
        parentAgentId: null,
        depth: 0,
        mission,
        objective: `Advance the user's request as the Symphony conductor: ${nativeContent}${history ? `\n\nConversation context before this request:\n${history}` : ""}\n\nCoordinate durable, observable, cross-harness work with Symphony tools. Use native harness subagents only for ephemeral harness-local assistance. Observe delegated work without interrupting it and return a concise synthesis to the user. Dynamic workflow files may be written under ${this.loaded.workflowDirectory}.`,
        model: this.loaded.config.conductor.model,
        harness: this.loaded.config.conductor.harness,
        permissions: this.loaded.config.agents.defaultPermissions,
        outputSchema: {},
        workspace: { path: thread.workspacePath, dirtyPolicy: "local-only" },
        inputs: [],
        metadata: { threadId },
      });
      thread = { ...thread, conductorAgentId: agent.id, updatedAt: nowIso() };
      this.store.saveThread(thread);
    } else {
      await this.agents.message(currentConductor.id, buildConductorTurnPrompt(nativeContent));
      thread = { ...thread, updatedAt: nowIso() };
      this.store.saveThread(thread);
    }
    return { thread, agentId: thread.conductorAgentId as string, messageId: userMessage.id };
  }

  update(id: string, patch: { title?: string | undefined; groupId?: string | null | undefined; archived?: boolean | undefined }): ChatThreadRecord {
    const thread = this.store.getThread(id);
    if (!thread) throw new HttpError(404, `Chat thread not found: ${id}`);
    const updated: ChatThreadRecord = {
      ...thread,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      updatedAt: nowIso(),
    };
    this.store.saveThread(updated);
    return updated;
  }

  private capture(event: EventEnvelope): void {
    if (!event.agentId) return;
    const thread = this.store.listThreads({ includeArchived: true }).find((item) => item.conductorAgentId === event.agentId);
    if (!thread) return;
    const agent = this.store.getAgent(event.agentId);
    if (event.type === "driver.message.delta") {
      const payload = jsonRecord(event.payload);
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text) this.updateStream(event, thread, { text, replace: payload.replace === true });
      return;
    }
    if (event.type === "driver.reasoning.delta") {
      const payload = jsonRecord(event.payload);
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text) this.updateStream(event, thread, { reasoning: text, replace: payload.replace === true });
      return;
    }
    if (event.type === "agent.failed") {
      this.finalizeStream(event, thread, null);
      const message = ConversationMessageSchema.parse({
        id: ulid(),
        threadId: thread.id,
        role: "assistant",
        parts: [{
          type: "text",
          text: `I couldn't start or complete this run. ${friendlyAgentError(agent?.error)}`,
        }],
        createdAt: nowIso(),
      });
      this.publishMessage(event, message);
      return;
    }
    if (event.type !== "driver.output.completed") return;
    if (agent?.status === "failed") return;
    const output = jsonRecord(agent?.output ?? null);
    const payload = jsonRecord(event.payload);
    const structured = jsonRecord(payload.structuredOutput);
    const text = firstString(payload.text, output.response, output.text, structured.response, structured.text)
      ?? (payload.structuredOutput !== undefined ? JSON.stringify(payload.structuredOutput) : JSON.stringify(event.payload));
    this.finalizeStream(event, thread, text);
  }

  private updateStream(
    event: EventEnvelope,
    thread: ChatThreadRecord,
    delta: { text?: string; reasoning?: string; replace: boolean },
  ): void {
    const state = this.getStream(event.agentId as string, thread.id);
    if (delta.text) state.text = delta.replace ? delta.text : state.text + delta.text;
    if (delta.reasoning) state.reasoning = delta.replace ? delta.reasoning : state.reasoning + delta.reasoning;
    this.streams.set(event.agentId as string, state);
    this.publishMessage(event, this.streamMessage(state, true));
  }

  private finalizeStream(event: EventEnvelope, thread: ChatThreadRecord, finalText: string | null): void {
    const existing = this.streams.get(event.agentId as string) ?? this.persistedStream(thread.id);
    const state = existing ?? {
      messageId: ulid(),
      threadId: thread.id,
      createdAt: nowIso(),
      text: "",
      reasoning: "",
    };
    if (finalText) state.text = finalText;
    if (!state.text && !state.reasoning) return;
    this.publishMessage(event, this.streamMessage(state, false));
    this.streams.delete(event.agentId as string);
  }

  private getStream(agentId: string, threadId: string): ChatStreamState {
    return this.streams.get(agentId)
      ?? this.persistedStream(threadId)
      ?? { messageId: ulid(), threadId, createdAt: nowIso(), text: "", reasoning: "" };
  }

  private persistedStream(threadId: string): ChatStreamState | null {
    const message = [...this.store.listConversationMessages(threadId)].reverse().find((item) => item.role === "assistant" && item.streaming);
    if (!message) return null;
    const text: string[] = [];
    const reasoning: string[] = [];
    for (const part of message.parts) {
      const record = jsonRecord(part);
      if (typeof record.text !== "string") continue;
      if (record.type === "reasoning") reasoning.push(record.text);
      else if (record.type === "text") text.push(record.text);
    }
    return { messageId: message.id, threadId, createdAt: message.createdAt, text: text.join(""), reasoning: reasoning.join("") };
  }

  private streamMessage(state: ChatStreamState, streaming: boolean) {
    const parts: JsonValue[] = [
      ...(state.reasoning ? [{ type: "reasoning", text: state.reasoning, status: { type: streaming ? "running" : "complete" } }] : []),
      ...(state.text ? [{ type: "text", text: state.text }] : []),
    ];
    return ConversationMessageSchema.parse({
      id: state.messageId,
      threadId: state.threadId,
      role: "assistant",
      parts,
      streaming,
      createdAt: state.createdAt,
      updatedAt: nowIso(),
    });
  }

  private publishMessage(event: EventEnvelope, message: ReturnType<typeof ConversationMessageSchema.parse>): void {
    this.store.appendConversationMessage(message);
    this.store.appendEvent({
      type: "chat.message.updated",
      workflowId: event.workflowId,
      runId: event.runId,
      agentId: event.agentId,
      occurredAt: message.updatedAt ?? message.createdAt,
      payload: { threadId: message.threadId, message } as unknown as JsonValue,
      provenance: { source: "daemon" },
    });
  }

  private async refineTitle(threadId: string, source: string, fallbackTitle: string): Promise<void> {
    const title = await this.uiUtilities.chatTitle(threadId, source).catch(() => null);
    if (!title || title === fallbackTitle) return;
    const current = this.store.getThread(threadId);
    if (!current || current.title !== fallbackTitle) return;
    const updated = { ...current, title, updatedAt: nowIso() };
    this.store.saveThread(updated);
    this.store.appendEvent({
      type: "chat.title.generated",
      workflowId: `chat:${threadId}`,
      runId: `chat-run:${threadId}`,
      agentId: current.conductorAgentId,
      occurredAt: updated.updatedAt,
      payload: { threadId, title, model: this.loaded.config.uiUtilities.model },
      provenance: { source: "daemon" },
    });
  }
}

export class SymphonyDaemon {
  readonly loaded: LoadedConfig;
  readonly store: SymphonyStore;
  readonly secrets: SecretStore;
  readonly drivers: DriverRegistry;
  readonly router: ModelRouter;
  readonly observer: PassiveObserver;
  readonly uiUtilities: UiUtilityService;
  readonly agents: AgentCoordinator;
  readonly workflows: WorkflowEngine;
  readonly triggers: TriggerManager;
  readonly plugins: PluginHost;
  readonly projects: ProjectService;
  readonly chats: ChatService;
  readonly harnessMaintenance: HarnessMaintenance;
  readonly startedAt = nowIso();
  private server: Server | null = null;
  private catalogTimer: NodeJS.Timeout | null = null;
  private readonly eventResponses = new Set<ServerResponse>();

  constructor(private readonly options: StartDaemonOptions = {}) {
    this.loaded = loadConfig({
      ...(options.rootDirectory ? { rootDirectory: options.rootDirectory } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
    if (options.port) this.loaded.config.server.port = options.port;
    if (options.host) this.loaded.config.server.host = options.host;
    this.store = createStore(this.loaded.dataDirectory);
    this.secrets = new SecretStore();
    this.drivers = createDriverRegistry(this.loaded, this.secrets);
    this.harnessMaintenance = new HarnessMaintenance(this.loaded, this.drivers);
    this.router = new ModelRouter(this.loaded, this.secrets, this.drivers, this.store);
    this.observer = new PassiveObserver(this.loaded, this.secrets, this.store);
    this.uiUtilities = new UiUtilityService(this.loaded, this.secrets, this.store);
    this.agents = new AgentCoordinator(this.loaded, this.store, this.drivers, this.router, this.observer);
    this.workflows = new WorkflowEngine(this.loaded, this.store, this.agents);
    this.triggers = new TriggerManager(this.store, this.workflows);
    this.plugins = new PluginHost(this.loaded, this.store, options.noPlugins ?? false);
    this.projects = new ProjectService(this.loaded, this.store);
    this.chats = new ChatService(this.loaded, this.store, this.agents, this.uiUtilities);
  }

  async start(): Promise<{ url: string }> {
    await this.plugins.start();
    this.store.onEvent((event) => void this.plugins.dispatch(event));
    for (const plugin of this.plugins.list()) {
      this.loaded.config.router.localCatalogFiles.push(...plugin.modelCatalogPaths);
      for (const path of plugin.workflowPaths) {
        const provisional = await new WorkflowLoader().load(path, 0);
        const previous = this.store.getWorkflow(provisional.definition.id);
        const ir = previous ? await new WorkflowLoader().load(path, previous.revision) : provisional;
        if (!previous || previous.hash !== ir.hash) this.workflows.register(ir);
        if (this.loaded.config.workflows.triggersEnabled) this.triggers.register(ir);
      }
    }
    await this.router.refresh();
    this.catalogTimer = setInterval(
      () => void this.router.refresh().catch(() => undefined),
      this.loaded.config.router.catalogRefreshMinutes * 60_000,
    );
    this.catalogTimer.unref();
    await loadWorkflowDirectory(
      this.loaded,
      this.store,
      this.workflows,
      this.loaded.config.workflows.triggersEnabled ? this.triggers : undefined,
    );
    await this.agents.recover();
    await this.workflows.recover();
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolvePromise, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.loaded.config.server.port, this.loaded.config.server.host, () => resolvePromise());
    });
    this.store.appendEvent({ type: "daemon.started", workflowId: null, runId: null, agentId: null, occurredAt: nowIso(), payload: { pid: process.pid, version: "0.1.0" }, provenance: { source: "daemon" } });
    return { url: `http://${this.loaded.config.server.host}:${this.loaded.config.server.port}` };
  }

  async close(): Promise<void> {
    if (this.catalogTimer) clearInterval(this.catalogTimer);
    this.catalogTimer = null;
    this.chats.close();
    for (const response of this.eventResponses) response.end();
    this.eventResponses.clear();
    this.triggers.stop();
    await this.plugins.stop();
    await this.drivers.dispose();
    if (this.server) {
      this.server.closeIdleConnections();
      await new Promise<void>((resolvePromise) => this.server?.close(() => resolvePromise()));
    }
    this.store.close();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      response.setHeader("access-control-allow-origin", `http://${this.loaded.config.server.host}:${this.loaded.config.server.port}`);
      response.setHeader("x-content-type-options", "nosniff");
      if (request.method === "OPTIONS") return this.empty(response, 204);
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/health") return this.json(response, 200, { ok: true, version: "0.1.0", startedAt: this.startedAt, cursor: this.store.latestCursor() });
      if (url.pathname === "/v1/theme" && request.method === "GET") return this.json(response, 200, this.theme());
      if (url.pathname === "/v1/theme/icon.svg" && request.method === "GET") return this.themeIcon(response);
      if (url.pathname === "/v1/bootstrap" && request.method === "GET") return this.json(response, 200, this.bootstrap());
      if (url.pathname === "/v1/events" && request.method === "GET") return this.events(request, response, url);
      if (url.pathname === "/v1/drivers" && request.method === "GET") return this.json(response, 200, await this.harnessMaintenance.reports(url.searchParams.get("refresh") === "true"));
      const driverUpdate = url.pathname.match(/^\/v1\/drivers\/([^/]+)\/update$/u);
      if (driverUpdate && request.method === "POST") {
        const driver = z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"]).parse(decodeURIComponent(driverUpdate[1] as string));
        try {
          const result = await this.harnessMaintenance.update(driver);
          this.store.appendEvent({ type: "driver.updated", workflowId: null, runId: null, agentId: null, occurredAt: nowIso(), payload: { driver, version: result.report.version }, provenance: { source: "user" } });
          return this.json(response, 200, result);
        } catch (error) {
          this.store.appendEvent({ type: "driver.update.failed", workflowId: null, runId: null, agentId: null, occurredAt: nowIso(), payload: { driver, error: error instanceof Error ? error.message : String(error) }, provenance: { source: "user" } });
          throw error;
        }
      }
      if (url.pathname === "/v1/models" && request.method === "GET") return this.json(response, 200, this.router.list());
      if (url.pathname === "/v1/settings" && request.method === "GET") return this.json(response, 200, this.settings());
      if (url.pathname === "/v1/settings" && request.method === "PATCH") return this.json(response, 200, this.updateSettings(await body(request)));
      if (url.pathname === "/v1/projects" && request.method === "GET") return this.json(response, 200, this.projects.list());
      if (url.pathname === "/v1/projects" && request.method === "POST") {
        const input = z.object({ workspacePath: z.string().min(1), title: z.string().min(1).max(200).optional() }).parse(await body(request));
        return this.json(response, 201, this.projects.create(input));
      }
      if (url.pathname === "/v1/filesystem/directories" && request.method === "GET") {
        return this.json(response, 200, this.projects.browse(url.searchParams.get("path")));
      }
      if (url.pathname === "/v1/plugins" && request.method === "GET") return this.json(response, 200, this.store.listPluginStates());
      if (url.pathname === "/v1/plugin-tools" && request.method === "GET") return this.json(response, 200, this.plugins.list().flatMap((plugin) => [...plugin.tools.values()].map((tool) => ({ pluginId: plugin.manifest.id, name: tool.name, description: tool.description }))));
      if (url.pathname === "/v1/costs" && request.method === "GET") {
        const workflowId = url.searchParams.get("workflowId");
        const runId = url.searchParams.get("runId");
        const agentId = url.searchParams.get("agentId");
        return this.json(response, 200, this.store.aggregateCost({ ...(workflowId ? { workflowId } : {}), ...(runId ? { runId } : {}), ...(agentId ? { agentId } : {}) }));
      }
      if (url.pathname === "/v1/usage/heatmap" && request.method === "GET") {
        const weeks = z.coerce.number().int().min(4).max(52).default(12).parse(url.searchParams.get("weeks") ?? 12);
        return this.json(response, 200, this.usageHeatmap(weeks));
      }
      if (url.pathname === "/v1/agents" && request.method === "GET") {
        const runId = url.searchParams.get("runId");
        return this.json(response, 200, this.agents.list({ ...(runId ? { runId } : {}), activeOnly: url.searchParams.get("active") === "true" }));
      }
      if (url.pathname === "/v1/agents" && request.method === "POST") return this.json(response, 202, await this.createAgent(request, await body(request)));
      if (url.pathname === "/v1/workflows" && request.method === "GET") return this.json(response, 200, this.store.listWorkflows());
      if (url.pathname === "/v1/workflows" && request.method === "POST") {
        const definition = await body(request);
        const id = typeof (definition as Record<string, unknown>).id === "string" ? (definition as Record<string, unknown>).id as string : "";
        const previous = id ? this.store.getWorkflow(id) : null;
        return this.json(response, 201, this.workflows.register(new WorkflowCompiler().compile(definition, (previous?.revision ?? 0) + 1)));
      }
      if (url.pathname === "/v1/runs" && request.method === "GET") return this.json(response, 200, this.store.listRuns());
      if (url.pathname === "/v1/commands" && request.method === "POST") return this.json(response, 200, await this.command(CommandSchema.parse(await body(request))));
      if (url.pathname === "/v1/threads" && request.method === "GET") return this.json(response, 200, this.chats.list());
      if (url.pathname === "/v1/threads" && request.method === "POST") {
        const input = z.object({ title: z.string().optional(), projectId: z.string().optional(), groupId: z.string().nullable().optional(), mission: z.object({ statement: z.string(), keyResults: z.array(z.string()).optional() }).optional(), workspacePath: z.string().optional() }).parse(await body(request));
        const project = input.projectId ? this.projects.get(input.projectId) : null;
        return this.json(response, 201, this.chats.create({
          ...input,
          groupId: project?.id ?? input.groupId,
          workspacePath: project?.workspacePath ?? input.workspacePath,
        }));
      }
      const match = url.pathname.match(/^\/v1\/(agents|workflows|runs|threads)\/([^/]+)(?:\/(.*))?$/u);
      if (match) return await this.resource(request, response, match[1] as string, decodeURIComponent(match[2] as string), match[3] ?? "", url);
      const pluginTool = url.pathname.match(/^\/v1\/plugin-tools\/([^/]+)$/u);
      if (pluginTool && request.method === "POST") {
        this.requireFullAccessAgent(request, "invoke a plugin tool");
        const registration = this.plugins.getTool(decodeURIComponent(pluginTool[1] as string));
        if (!registration) throw new HttpError(404, "Plugin tool not found");
        const value = await registration.tool.execute(await body(request));
        return this.json(response, 200, { pluginId: registration.plugin.manifest.id, value: value as JsonValue });
      }
      if (url.pathname.startsWith("/v1/")) throw new HttpError(404, "API route not found");
      return this.staticFile(response, url.pathname);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      this.json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async resource(request: IncomingMessage, response: ServerResponse, resource: string, id: string, action: string, url: URL): Promise<void> {
    if (resource === "agents" && !action && request.method === "GET") return this.json(response, 200, this.agents.get(id));
    if (resource === "agents" && action === "messages" && request.method === "POST") {
      const input = z.object({ content: z.string().min(1) }).parse(await body(request));
      return this.json(response, 202, await this.agents.message(id, input.content));
    }
    if (resource === "agents" && action === "observe" && request.method === "GET") {
      const level = z.enum(["tldr", "paragraph", "full"]).parse(url.searchParams.get("level") ?? "tldr");
      return this.json(response, 200, await this.agents.observe(id, level));
    }
    if (resource === "agents" && action === "cancel" && request.method === "POST") {
      await this.agents.cancel(id);
      return this.empty(response, 204);
    }
    if (resource === "agents" && action === "present" && request.method === "POST") {
      return this.json(response, 201, this.presentAgentUi(request, id, await body(request)));
    }
    if (resource === "workflows" && action === "runs" && request.method === "POST") {
      this.requireFullAccessAgent(request, "start a workflow");
      return this.json(response, 202, this.workflows.start(id, JsonValueSchema.parse(await body(request))));
    }
    if (resource === "runs" && action === "cancel" && request.method === "POST") return this.json(response, 200, this.workflows.cancel(id));
    if (resource === "threads" && !action && request.method === "GET") return this.json(response, 200, this.chats.get(id));
    if (resource === "threads" && !action && request.method === "PATCH") return this.json(response, 200, this.chats.update(id, z.object({ title: z.string().optional(), groupId: z.string().nullable().optional(), archived: z.boolean().optional() }).parse(await body(request))));
    if (resource === "threads" && action === "messages" && request.method === "POST") {
      const input = ChatMessageInputSchema.parse(await body(request));
      return this.json(response, 202, await this.chats.message(id, input));
    }
    throw new HttpError(404, "Resource route not found");
  }

  private async createAgent(request: IncomingMessage, payload: unknown): Promise<unknown> {
    const callerId = request.headers["x-symphony-agent-id"];
    const token = request.headers["x-symphony-agent-token"];
    if (typeof callerId !== "string") return await this.agents.create(payload);
    if (typeof token !== "string" || !this.agents.authenticate(callerId, token)) throw new HttpError(401, "Invalid agent coordination token");
    const parent = this.agents.get(callerId);
    const parentOrder = this.store.getMetadata<JsonValue>(`work-order:${callerId}`) as Record<string, JsonValue> | null;
    if (!parentOrder) throw new HttpError(409, "Parent work order is unavailable");
    const child = z.object({
      objective: z.string().min(1), model: z.string().default("auto"),
      harness: z.enum(["auto", "codex", "claude", "cursor", "opencode", "pi", "acp"]).default("auto"),
      permissions: z.enum(["read-only", "full-access"]).optional(),
      outputSchema: z.record(z.string(), JsonValueSchema), routing: z.unknown().optional(), workspace: z.unknown().optional(), inputs: z.array(z.unknown()).default([]),
    }).parse(payload);
    return await this.agents.create({
      workflowId: parent.workflowId, runId: parent.runId, parentAgentId: parent.id, depth: parent.depth + 1,
      mission: parentOrder.mission, objective: child.objective, model: child.model, harness: child.harness,
      permissions: child.permissions ?? parent.permissions, outputSchema: child.outputSchema,
      routing: child.routing, workspace: child.workspace ?? parentOrder.workspace, inputs: child.inputs,
    });
  }

  private requireFullAccessAgent(request: IncomingMessage, action: string): void {
    const callerId = request.headers["x-symphony-agent-id"];
    if (callerId === undefined) return;
    const token = request.headers["x-symphony-agent-token"];
    if (typeof callerId !== "string" || typeof token !== "string" || !this.agents.authenticate(callerId, token)) {
      throw new HttpError(401, "Invalid agent coordination token");
    }
    if (this.agents.get(callerId).permissions !== "full-access") {
      throw new HttpError(403, `A read-only Symphony agent cannot ${action}.`);
    }
  }

  private presentAgentUi(request: IncomingMessage, agentId: string, payload: unknown): { messageId: string; threadId: string } {
    const callerId = request.headers["x-symphony-agent-id"];
    const token = request.headers["x-symphony-agent-token"];
    if (callerId !== agentId || typeof token !== "string" || !this.agents.authenticate(agentId, token)) {
      throw new HttpError(401, "Invalid agent coordination token");
    }
    const agent = this.agents.get(agentId);
    const threadId = agent.workflowId.startsWith("chat:") ? agent.workflowId.slice("chat:".length) : null;
    if (!threadId || !this.store.getThread(threadId)) throw new HttpError(409, "Structured UI can only be presented inside a Symphony chat workflow.");
    const input = z.object({
      kind: z.enum(["speaker-identity", "diagram", "flow-graph", "spec-sheet", "timeline", "job-progress", "score-breakdown", "agent-plan", "subagent-list", "recommendation-card", "handoff", "schedule", "checkpoints", "cost-meter", "tool-timeline", "generative-ui"]),
      data: JsonValueSchema,
    }).parse(payload);
    const messageId = ulid();
    const createdAt = nowIso();
    this.store.appendConversationMessage(ConversationMessageSchema.parse({
      id: messageId,
      threadId,
      role: "assistant",
      parts: [{ type: "data", name: input.kind, data: input.data }],
      createdAt,
    }));
    this.store.appendEvent({
      type: "chat.ui.presented",
      workflowId: agent.workflowId,
      runId: agent.runId,
      agentId,
      occurredAt: createdAt,
      payload: { threadId, messageId, kind: input.kind },
      provenance: { source: "daemon" },
    });
    return { messageId, threadId };
  }

  private async command(command: Command): Promise<CommandReceipt> {
    const existing = this.store.getCommandReceipt(command.idempotencyKey);
    if (existing) return existing;
    let result: JsonValue;
    if (command.type === "agent.create") result = await this.agents.create(command.payload) as unknown as JsonValue;
    else if (command.type === "agent.message") {
      const payload = command.payload as Record<string, JsonValue>;
      result = await this.agents.message(String(payload.agentId), String(payload.content)) as unknown as JsonValue;
    } else if (command.type === "agent.observe") {
      const payload = command.payload as Record<string, JsonValue>;
      result = await this.agents.observe(String(payload.agentId), z.enum(["tldr", "paragraph", "full"]).parse(payload.level ?? "tldr")) as unknown as JsonValue;
    } else if (command.type === "agent.cancel") {
      await this.agents.cancel(String((command.payload as Record<string, JsonValue>).agentId));
      result = { cancelled: true };
    } else if (command.type === "workflow.run") {
      const payload = command.payload as Record<string, JsonValue>;
      result = this.workflows.start(String(payload.workflowId), payload.input ?? {}) as unknown as JsonValue;
    } else if (command.type === "workflow.cancel") result = this.workflows.cancel(String((command.payload as Record<string, JsonValue>).runId)) as unknown as JsonValue;
    else throw new HttpError(400, `Command ${command.type} is not implemented by the local API.`);
    const receipt: CommandReceipt = { idempotencyKey: command.idempotencyKey, accepted: true, result, createdAt: nowIso() };
    this.store.saveCommandReceipt(receipt);
    return receipt;
  }

  private bootstrap(): BootstrapProjection {
    const cursor = this.store.latestCursor();
    const agents = this.store.listAgents();
    const runs = this.store.listRuns();
    return {
      cursor,
      events: this.store.recentEvents({ limit: 500, types: UI_EVENT_TYPES, typePrefixes: UI_EVENT_PREFIXES }),
      workflows: this.store.listWorkflows() as unknown as JsonValue[],
      runs: runs as unknown as JsonValue[], agents,
      messages: this.store.listConversationMessages(), projects: this.projects.list(), costs: this.store.aggregateCost(),
      runCosts: Object.fromEntries(runs.map((run) => [run.id, this.store.aggregateCost({ runId: run.id })])),
      agentCosts: Object.fromEntries(agents.map((agent) => [agent.id, this.store.aggregateCost({ agentId: agent.id })])),
      plugins: this.store.listPluginStates() as unknown as JsonValue[],
      settings: this.settings(),
      daemon: { version: "0.1.0", startedAt: this.startedAt, noPlugins: this.options.noPlugins ?? false },
    };
  }

  private usageHeatmap(weeks: number) {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay() - (weeks - 1) * 7);
    const days = Array.from({ length: weeks * 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return {
        date: localDateKey(date),
        knownCost: 0,
        eventCount: 0,
        unknownEvents: 0,
        future: date.getTime() > today.getTime(),
      };
    });
    const byDate = new Map(days.map((day) => [day.date, day]));
    for (const event of this.store.listUsage()) {
      const day = byDate.get(localDateKey(new Date(event.recordedAt)));
      if (!day) continue;
      day.eventCount += 1;
      if (event.costAmount === null) day.unknownEvents += 1;
      else day.knownCost += event.costAmount;
    }
    return {
      currency: "USD",
      weeks,
      startDate: days[0]?.date ?? localDateKey(start),
      endDate: localDateKey(today),
      days,
    };
  }

  private settings() {
    return {
      configPath: this.loaded.configPath,
      conductor: { ...this.loaded.config.conductor },
      agents: { ...this.loaded.config.agents },
    };
  }

  private theme(): z.infer<typeof ThemeFileSchema> {
    const path = resolve(this.loaded.rootDirectory, "theme.json");
    if (!existsSync(path)) throw new HttpError(404, "theme.json was not found in the Symphony project root.");
    return ThemeFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  private themeIcon(response: ServerResponse): void {
    const theme = this.theme();
    const background = escapeXml(requireThemeColor(theme, "logo-background"));
    const foreground = escapeXml(requireThemeColor(theme, "logo-mark"));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" fill="none"><rect width="256" height="256" rx="48" fill="${background}"/><path d="M128 192C92.654 192 64 220.654 64 256H0C0 185.308 57.308 128 128 128V192ZM256 128C256 198.692 198.692 256 128 256V192C163.346 192 192 163.346 192 128H256ZM128 64C92.654 64 64 92.654 64 128H0C0 57.308 57.308 0 128 0V64ZM256 0C256 70.692 198.692 128 128 128V64C163.346 64 192 35.346 192 0H256Z" fill="${foreground}"/></svg>`;
    response.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-cache" });
    response.end(svg);
  }

  private updateSettings(value: unknown) {
    const patch = z.object({
      conductor: z.object({
        harness: z.enum(["pi", "codex", "claude", "cursor", "opencode", "acp"]),
        model: z.string().min(1),
      }).optional(),
      agents: z.object({
        maxDepth: z.number().int().min(0).max(16).nullable(),
        maxConcurrent: z.number().int().min(1).max(128).nullable(),
        defaultPermissions: z.enum(["read-only", "full-access"]),
      }).partial().optional(),
    }).parse(value);
    if (patch.conductor) this.loaded.config.conductor = patch.conductor;
    if (patch.agents) {
      if (patch.agents.maxDepth !== undefined) this.loaded.config.agents.maxDepth = patch.agents.maxDepth;
      if (patch.agents.maxConcurrent !== undefined) this.loaded.config.agents.maxConcurrent = patch.agents.maxConcurrent;
      if (patch.agents.defaultPermissions !== undefined) {
        this.loaded.config.agents.defaultPermissions = patch.agents.defaultPermissions;
      }
    }
    writeConfig(this.loaded.configPath, this.loaded.config);
    const settings = this.settings();
    this.store.appendEvent({
      type: "config.updated",
      workflowId: null,
      runId: null,
      agentId: null,
      occurredAt: nowIso(),
      payload: settings,
      provenance: { source: "user" },
    });
    return settings;
  }

  private events(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const cursor = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
    const uiProjection = url.searchParams.get("projection") === "ui";
    const eventOptions = uiProjection ? { types: UI_EVENT_TYPES, typePrefixes: UI_EVENT_PREFIXES } : {};
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    this.eventResponses.add(response);
    for (const event of this.store.eventsAfter(Number.isFinite(cursor) ? cursor : 0, eventOptions)) writeEvent(response, event);
    const unsubscribe = this.store.onEvent((event) => {
      if (!uiProjection || isUiProjectionEvent(event.type)) writeEvent(response, event);
    });
    const keepAlive = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      this.eventResponses.delete(response);
    });
  }

  private staticFile(response: ServerResponse, pathname: string): void {
    const base = resolve(this.loaded.webDirectory);
    const requested = resolve(base, `.${normalize(pathname)}`);
    if ((requested !== base && !requested.startsWith(`${base}/`)) || !existsSync(requested) || !statSync(requested).isFile()) {
      const index = join(base, "index.html");
      if (existsSync(index)) return this.sendFile(response, index);
      throw new HttpError(404, "Frontend build is not present. The Symphony API is running at /v1 and /health.");
    }
    this.sendFile(response, requested);
  }

  private sendFile(response: ServerResponse, path: string): void {
    const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
    const immutableAsset = /[\\/]assets[\\/]/u.test(path) && /-[A-Za-z0-9_-]{8,}\.[^.]+$/u.test(path);
    response.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
      "cache-control": immutableAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(path).pipe(response);
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  }

  private empty(response: ServerResponse, status: number): void {
    response.writeHead(status);
    response.end();
  }
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<SymphonyDaemon> {
  const daemon = new SymphonyDaemon(options);
  await daemon.start();
  return daemon;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2_000_000) throw new HttpError(413, "Request body exceeds 2 MB");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeEvent(response: ServerResponse, event: EventEnvelope): void {
  response.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function hashMission(statement: string, keyResults: string[]): string {
  return createHash("sha256").update(`${statement}\0${keyResults.join("\0")}`).digest("hex");
}

function projectIdForPath(workspacePath: string): string {
  return `project-${createHash("sha256").update(workspacePath).digest("hex").slice(0, 16)}`;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function firstString(...values: Array<JsonValue | undefined>): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

function isDefaultChatTitle(title: string): boolean {
  return ["New chat", "New Symphony chat"].includes(title.trim());
}

function titleFromMessage(content: string): string {
  const singleLine = content.replace(/\s+/gu, " ").trim();
  return singleLine.length <= 64 ? singleLine : `${singleLine.slice(0, 61).trimEnd()}…`;
}

function promptFromChatInput(input: ChatMessageInput): string {
  const attachmentText = input.attachments.flatMap((attachment) =>
    attachment.content.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const text = (part as Record<string, JsonValue>).text;
      return typeof text === "string" ? [text] : [];
    }),
  );
  return [input.content.trim(), ...attachmentText].filter(Boolean).join("\n\n");
}

function conversationContext(messages: ReturnType<SymphonyStore["listConversationMessages"]>): string {
  return messages.slice(-20).map((message) => {
    const text = message.parts.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const record = part as Record<string, JsonValue>;
      if (record.type === "text" && typeof record.text === "string") return [record.text];
      if (record.type === "attachment" && Array.isArray(record.content)) {
        return record.content.flatMap((content) => {
          if (!content || typeof content !== "object" || Array.isArray(content)) return [];
          const text = (content as Record<string, JsonValue>).text;
          return typeof text === "string" ? [text] : [];
        });
      }
      return [];
    }).join("\n");
    return text ? `${message.role}: ${text.slice(0, 8_000)}` : "";
  }).filter(Boolean).join("\n\n").slice(-80_000);
}

function friendlyAgentError(error: string | null | undefined): string {
  if (!error) return "Open the agent details or Settings for more information.";
  let current = error;
  for (let index = 0; index < 3; index += 1) {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (typeof parsed === "string") current = parsed;
      else if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { error?: unknown }).error === "string") {
        current = (parsed as { error: string }).error;
      } else break;
    } catch {
      break;
    }
  }
  return current.trim();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function requireThemeColor(theme: z.infer<typeof ThemeFileSchema>, token: string): string {
  const value = theme.colors[token];
  if (!value) throw new HttpError(422, `theme.json is missing the required “${token}” color token.`);
  return value;
}

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isUiProjectionEvent(type: string): boolean {
  return UI_EVENT_TYPES.includes(type as (typeof UI_EVENT_TYPES)[number])
    || UI_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}
