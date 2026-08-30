import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { ulid } from "ulid";
import { z } from "zod";
import {
  loadConfig,
  removeDaemonSecretFromProcessEnvironment,
  SecretStore,
  writeConfig,
  type LoadedConfig,
} from "@symphony/config";
import { buildConductorTurnPrompt, createDriverRegistry, type DriverRegistry } from "@symphony/drivers";
import { PluginHost } from "@symphony/plugins";
import {
  CommandSchema,
  CommandReceiptSchema,
  ConversationMessageSchema,
  DriverAuthenticationResultSchema,
  isTerminalAgentStatus,
  JsonValueSchema,
  nowIso,
  type BootstrapProjection,
  type AgentRecord,
  type Command,
  type CommandReceipt,
  type ConversationMessage,
  type EventEnvelope,
  type JsonValue,
  type ProjectRecord,
  type ResolvedHarness,
  type UsageEvent,
  type WorkflowMission,
} from "@symphony/protocol";
import { AgentCoordinator, ModelRouter, PassiveObserver, UiUtilityService } from "@symphony/runtime";
import { createStore, type AgentListCursor, type ChatThreadRecord, type SymphonyStore } from "@symphony/storage";
import { TriggerManager, WorkflowCompiler, WorkflowEngine, WorkflowLoader, loadWorkflowDirectory } from "@symphony/workflow";
import { HarnessMaintenance } from "./harness-maintenance.js";
import { resolveDaemonCredential, type DaemonCredential } from "./daemon-credential.js";

export type StartDaemonOptions = {
  rootDirectory?: string;
  configPath?: string;
  noPlugins?: boolean;
  port?: number;
  host?: string;
  driverRegistry?: DriverRegistry;
  /** @internal Override OS/environment credential access in tests. */
  secretStore?: SecretStore;
  /** @internal Exercise Darwin/headless credential behavior deterministically in tests. */
  credentialPlatform?: NodeJS.Platform;
  /** @internal Acquire the data-directory lease before opening SQLite. */
  acquireLease?: boolean;
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

const ChatThreadCreateInputSchema = z.object({
  title: z.string().optional(),
  groupId: z.string().nullable().optional(),
  mission: z.object({
    statement: z.string(),
    keyResults: z.array(z.string()).optional(),
  }).optional(),
  workspacePath: z.string().optional(),
});

type ChatThreadCreateInput = z.infer<typeof ChatThreadCreateInputSchema>;

const ChatThreadCreateReceiptSchema = z.object({
  version: z.literal(1),
  requestHash: z.string().min(16),
  threadId: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.string().min(1),
});

type ChatThreadCreateReceipt = z.infer<typeof ChatThreadCreateReceiptSchema>;

const ChatTurnReceiptSchema = z.object({
  version: z.literal(1),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  requestHash: z.string().min(16),
  state: z.enum(["accepted", "dispatching", "delivered", "failed", "outcome-unknown"]),
  mode: z.enum(["create-conductor", "message-existing"]).nullable(),
  agentId: z.string().min(1).nullable(),
  receiptId: z.string().min(1).nullable(),
  error: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

type ChatTurnReceipt = z.infer<typeof ChatTurnReceiptSchema>;

const DriverUpdateOperationSchema = z.object({
  version: z.literal(1),
  driver: z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"]),
  idempotencyKey: z.string().min(8),
  state: z.enum(["preparing", "dispatching", "settled", "failed"]),
  baselineVersion: z.string().nullable(),
  targetVersion: z.string().nullable(),
  result: JsonValueSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type DriverUpdateOperation = z.infer<typeof DriverUpdateOperationSchema>;

const DriverAuthenticationOperationSchema = z.object({
  version: z.literal(1),
  driver: z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"]),
  idempotencyKey: z.string().min(8),
  state: z.enum(["preparing", "dispatching", "settled", "failed"]),
  baselineAuthenticated: z.boolean().nullable(),
  result: DriverAuthenticationResultSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type DriverAuthenticationOperation = z.infer<typeof DriverAuthenticationOperationSchema>;

const RecoveredFollowUpSchema = z.object({
  version: z.literal(1),
  attemptId: z.string().min(1),
  agentId: z.string().min(1),
  state: z.enum(["queued", "dispatching", "delivered", "settled", "cancelled", "failed", "outcome-unknown"]),
  receiptId: z.string().nullable(),
  error: z.string().optional(),
});

const ThemeFileSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().min(1).max(100),
  colors: z.record(z.string().regex(/^[a-z0-9-]+$/u), z.string().min(1).max(500)),
});

const UI_EVENT_TYPES = [
  "agent.queued",
  "agent.routed",
  "agent.message.sent",
  "agent.cancel.requested",
  "agent.cancelled",
  "agent.failed",
  "agent.recovered",
  "agent.session.hydrated",
  "agent.session.recovery-failed",
  "agent.session.retirement-requested",
  "agent.session.retired",
  "agent.session.retirement-failed",
  "agent.recovery.continued",
  "agent.cancel.reissued",
  "agent.interrupted",
  "chat.message.updated",
  "chat.title.generated",
  "chat.ui.presented",
  "config.updated",
  "daemon.started",
  "driver.run.started",
  "driver.tool.started",
  "driver.tool.updated",
  "driver.tool.completed",
  "driver.usage.recorded",
  "driver.output.completed",
  "driver.authenticated",
  "driver.authentication.failed",
  "driver.updated",
  "driver.update.failed",
  "driver.run.completed",
  "driver.run.failed",
  "supervisor.host.adopted",
  "supervisor.host.adoption-ambiguous",
  "supervisor.host.adoption-pending",
  "supervisor.identity-mismatch",
  "supervisor.identity-unverified",
  "supervisor.orphan.detected",
  "supervisor.process.exited",
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
  parts: JsonValue[];
};

const ChatProjectorStateSchema = z.object({
  version: z.literal(1),
  cursor: z.number().int().nonnegative(),
  initializedAt: z.string(),
  updatedAt: z.string(),
});
type ChatProjectorState = z.infer<typeof ChatProjectorStateSchema>;

const CHAT_PROJECTION_SOURCE_TYPES = new Set([
  "driver.message.delta",
  "driver.reasoning.delta",
  "driver.tool.started",
  "driver.tool.updated",
  "driver.tool.completed",
  "driver.output.completed",
  "driver.run.cancelled",
  "agent.failed",
  "agent.interrupted",
]);

function isChatProjectionSourceEvent(event: EventEnvelope): boolean {
  return CHAT_PROJECTION_SOURCE_TYPES.has(event.type);
}

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
  private static readonly projectorStateKey = "projection:chat:v1";
  private readonly unsubscribe: () => void;
  private readonly streams = new Map<string, ChatStreamState>();

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: SymphonyStore,
    private readonly agents: AgentCoordinator,
    private readonly uiUtilities: UiUtilityService,
  ) {
    this.migrateLegacyDefaultMissions();
    this.migrateDuplicateMessageParts();
    this.initializeProjector();
    this.unsubscribe = this.store.onEvent((event) => this.capture(event));
  }

  close(): void {
    this.unsubscribe();
  }

  /**
   * Rebuild every chat projection that committed to the authoritative event
   * log but did not cross the separate conversation-message commit boundary
   * before the previous daemon stopped. The high-water mark is fixed before
   * replay so native recovery can safely append new evidence afterward.
   */
  recoverProjectionBacklog(): void {
    this.replayProjectionThrough(this.store.latestCursor());
  }

  private initializeProjector(): void {
    const existing = this.store.getMetadata<JsonValue>(ChatService.projectorStateKey);
    if (existing !== null) {
      ChatProjectorStateSchema.parse(existing);
      return;
    }
    // Existing installations already contain fully projected historical chat
    // messages but no projector cursor. Repair only an unmistakably unfinished
    // terminal conductor stream, then adopt the current high-water instead of
    // replaying the entire event history and manufacturing duplicate turns.
    const timestamp = nowIso();
    this.store.durableTransaction(() => {
      if (this.store.getMetadata<JsonValue>(ChatService.projectorStateKey) !== null) return;
      this.repairLegacyTerminalStreams();
      this.store.setMetadata(ChatService.projectorStateKey, {
        version: 1,
        cursor: this.store.latestCursor(),
        initializedAt: timestamp,
        updatedAt: timestamp,
      });
    });
  }

  private repairLegacyTerminalStreams(): void {
    for (const thread of this.store.listThreads({ includeArchived: true })) {
      const streaming = [...this.store.listConversationMessages(thread.id)].reverse()
        .find((message) => message.role === "assistant" && message.streaming);
      if (!streaming || !thread.conductorAgentId) continue;
      const agent = this.store.getAgent(thread.conductorAgentId);
      if (!agent || !isTerminalAgentStatus(agent.status)) continue;
      const terminalTypes = agent.status === "completed"
        ? ["driver.output.completed"]
        : agent.status === "cancelled"
          ? ["driver.run.cancelled"]
          : ["agent.failed", "agent.interrupted"];
      const terminalEvent = this.store.recentEvents({
        agentId: agent.id,
        types: terminalTypes,
        limit: 1,
      }).at(-1);
      if (terminalEvent) {
        this.applyProjectionEvent(terminalEvent);
        continue;
      }
      if (agent.status !== "completed" || agent.output === null) continue;
      // Legacy stores should normally have the raw output event. If only the
      // authoritative agent output survived, it is still enough to close the
      // one visibly unfinished stream without replaying any older turns.
      this.finalizeStream({
        id: `legacy-chat-projection-${agent.id}`,
        cursor: Math.max(1, this.store.latestCursor()),
        type: "driver.output.completed",
        workflowId: agent.workflowId,
        runId: agent.runId,
        agentId: agent.id,
        occurredAt: agent.finishedAt ?? agent.updatedAt,
        payload: { structuredOutput: agent.output },
        provenance: { source: "daemon" },
      }, thread, projectedOutputText({ structuredOutput: agent.output }, agent.output));
    }
  }

  private projectorState(): ChatProjectorState {
    return ChatProjectorStateSchema.parse(
      this.store.getMetadata<JsonValue>(ChatService.projectorStateKey),
    );
  }

  private saveProjectorCursor(cursor: number): void {
    const current = this.projectorState();
    if (cursor <= current.cursor) return;
    this.store.setMetadata(ChatService.projectorStateKey, {
      ...current,
      cursor,
      updatedAt: nowIso(),
    } as unknown as JsonValue);
  }

  private replayProjectionThrough(highWaterCursor: number): void {
    let cursor = this.projectorState().cursor;
    while (cursor < highWaterCursor) {
      const page = this.store.eventsAfter(cursor, { limit: 1_000 })
        .filter((event) => event.cursor <= highWaterCursor);
      if (!page.length) break;
      for (const event of page) {
        if (isChatProjectionSourceEvent(event)) this.projectEvent(event);
        cursor = event.cursor;
      }
    }
    // Irrelevant events need no per-event write. Checkpoint the fixed scan
    // boundary once so startup never rescans an unbounded historical tail.
    this.store.transaction(() => this.saveProjectorCursor(highWaterCursor));
  }

  private projectEvent(event: EventEnvelope): void {
    const agentId = event.agentId;
    const hadStream = agentId ? this.streams.has(agentId) : false;
    const previousStream = agentId && hadStream
      ? cloneChatStream(this.streams.get(agentId) as ChatStreamState)
      : null;
    try {
      this.store.transaction(() => {
        if (event.cursor <= this.projectorState().cursor) return;
        this.applyProjectionEvent(event);
        // The conversation mutation (if any), its chat.message.updated event,
        // and this cursor advance commit or roll back as one SQLite unit.
        this.saveProjectorCursor(event.cursor);
      });
    } catch (error) {
      // Stream assembly is an in-memory acceleration of the durable message.
      // Restore it when SQLite rolls back so replaying the same source cursor
      // cannot append the same delta twice.
      if (agentId) {
        if (previousStream) this.streams.set(agentId, previousStream);
        else this.streams.delete(agentId);
      }
      throw error;
    }
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

  private migrateDuplicateMessageParts(): void {
    for (const message of this.store.listConversationMessages()) {
      const parts = collapseRepeatedPartSequence(message.parts);
      if (parts.length === message.parts.length) continue;
      this.store.appendConversationMessage({ ...message, parts, updatedAt: message.updatedAt ?? nowIso() });
    }
  }

  reconcileInterruptedStreams(): void {
    for (const thread of this.store.listThreads({ includeArchived: true })) {
      const message = [...this.store.listConversationMessages(thread.id)].reverse()
        .find((candidate) => candidate.role === "assistant" && candidate.streaming);
      if (!message) continue;
      const conductor = thread.conductorAgentId ? this.store.getAgent(thread.conductorAgentId) : null;
      // A browser-facing stream belongs to the durable conductor turn, not to
      // this daemon process. Recovery has already reconciled the native
      // session at this point, so every remaining non-terminal conductor can
      // continue projecting into the same message id after a daemon restart.
      if (conductor && conductor.status !== "idle" && !isTerminalAgentStatus(conductor.status)) continue;
      const parts = collapseRepeatedPartSequence(structuredStreamParts(message.parts)).map((part) => {
        const record = jsonRecord(part);
        return record.type === "reasoning"
          ? { ...record, status: { type: "complete" } } as JsonValue
          : part;
      });
      const updatedAt = nowIso();
      const completed = ConversationMessageSchema.parse({ ...message, parts, streaming: false, updatedAt });
      this.store.appendConversationMessage(completed);
      this.store.appendEvent({
        type: "chat.message.updated",
        workflowId: `chat:${thread.id}`,
        runId: `chat-run:${thread.id}`,
        agentId: thread.conductorAgentId,
        occurredAt: updatedAt,
        payload: { threadId: thread.id, message: completed } as unknown as JsonValue,
        provenance: { source: "daemon" },
      }, {
        persistedPayload: { threadId: thread.id, messageId: completed.id },
      });
    }
  }

  list(): ChatThreadRecord[] {
    return this.store.listThreads();
  }

  async search(query: string, signal?: AbortSignal): Promise<{
    method: "openrouter-rerank" | "fuzzy";
    results: Array<{ threadId: string; title: string; groupId: string | null; score: number; snippet: string }>;
  }> {
    const normalized = query.replace(/\s+/gu, " ").trim();
    if (!normalized) return { method: "fuzzy", results: [] };
    signal?.throwIfAborted();
    const searchConfig = this.loaded.config.uiUtilities.chatSearch;
    const documents = this.store.listThreads().map((thread) => {
      const text = this.store.listRecentConversationMessages(thread.id, 40)
        .flatMap((message) => message.parts)
        .map((part) => firstString(jsonRecord(part).text) ?? "")
        .filter(Boolean)
        .join("\n");
      const document = `${thread.title}\n${text}`;
      return { thread, text, document, fuzzyScore: fuzzyChatScore(normalized, document) };
    });
    const localMatches = documents
      .filter((item) => item.fuzzyScore > 0)
      .sort((left, right) => right.fuzzyScore - left.fuzzyScore || right.thread.updatedAt.localeCompare(left.thread.updatedAt));
    const candidates = localMatches.slice(0, searchConfig.prefilterLimit);
    if (candidates.length < searchConfig.prefilterLimit) {
      const selected = new Set(candidates.map((item) => item.thread.id));
      for (const item of [...documents].sort((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt))) {
        if (selected.has(item.thread.id)) continue;
        candidates.push(item);
        selected.add(item.thread.id);
        if (candidates.length >= searchConfig.prefilterLimit) break;
      }
    }
    let ranked: Array<{ id: string; score: number }> | null;
    try {
      ranked = await this.uiUtilities.rankChats(
        normalized,
        candidates.map((item) => ({ id: item.thread.id, text: item.document })),
        signal,
      );
    } catch {
      signal?.throwIfAborted();
      ranked = null;
    }
    const scoreById = new Map(ranked?.map((item) => [item.id, item.score]) ?? []);
    const ordered = ranked
      ? ranked.flatMap((result) => {
          const item = candidates.find((candidate) => candidate.thread.id === result.id);
          return item ? [item] : [];
        })
      : localMatches;
    return {
      method: ranked ? "openrouter-rerank" : "fuzzy",
      results: ordered.slice(0, 30).map((item) => ({
        threadId: item.thread.id,
        title: item.thread.title,
        groupId: item.thread.groupId,
        score: ranked ? scoreById.get(item.thread.id) ?? 0 : item.fuzzyScore,
        snippet: chatSearchSnippet(item.text, normalized),
      })),
    };
  }

  get(id: string): { thread: ChatThreadRecord; messages: ReturnType<SymphonyStore["listConversationMessages"]> } {
    const thread = this.store.getThread(id);
    if (!thread) throw new HttpError(404, `Chat thread not found: ${id}`);
    return { thread, messages: this.store.listConversationMessages(id) };
  }

  create(input: ChatThreadCreateInput, idempotencyKey: string): ChatThreadRecord {
    const statement = input.mission?.statement ?? DEFAULT_CHAT_MISSION;
    const keyResults = input.mission?.keyResults ?? [];
    const workspacePath = resolve(input.workspacePath ?? this.loaded.rootDirectory);
    const requestHash = chatThreadCreateRequestHash({
      title: input.title ?? "New Symphony chat",
      groupId: input.groupId ?? null,
      mission: { statement, keyResults },
      workspacePath,
    });
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const receiptKey = `chat-thread-create:${keyHash}`;
    const id = `chat-thread-${keyHash.slice(0, 26)}`;
    const runId = `chat-run:${id}`;
    const now = nowIso();
    const hash = hashMission(statement, keyResults);
    const mission: WorkflowMission = { id: `chat:${id}`, revision: 1, hash, statement, keyResults };
    const thread: ChatThreadRecord = {
      id, title: input.title ?? "New Symphony chat", groupId: input.groupId ?? null,
      conductorAgentId: null, mission: mission as unknown as JsonValue,
      workspacePath, archived: false, createdAt: now, updatedAt: now,
    };
    return this.store.durableTransaction(() => {
      const existingValue = this.store.getMetadata<JsonValue>(receiptKey);
      if (existingValue !== null) {
        const existing = ChatThreadCreateReceiptSchema.parse(existingValue);
        if (existing.requestHash !== requestHash) {
          throw new HttpError(409, `Idempotency key ${idempotencyKey} is already bound to a different chat creation request.`);
        }
        const existingThread = this.store.getThread(existing.threadId);
        const existingRun = this.store.getRun(existing.runId);
        if (!existingThread || !existingRun) {
          throw new HttpError(500, `Durable chat creation receipt ${idempotencyKey} is inconsistent with stored orchestration state.`);
        }
        return existingThread;
      }

      if (this.store.getThread(id) || this.store.getRun(runId)) {
        throw new HttpError(409, `Chat creation identity ${idempotencyKey} conflicts with existing orchestration state.`);
      }
      this.store.saveThread(thread);
      this.store.saveRun({
        id: runId, workflowId: `chat:${id}`, workflowRevision: 1, status: "running", input: {}, output: null,
        error: null, startedAt: now, updatedAt: now, finishedAt: null, cancelRequested: false,
      });
      this.store.setMetadata(receiptKey, ({
        version: 1,
        requestHash,
        threadId: id,
        runId,
        createdAt: now,
      } satisfies ChatThreadCreateReceipt) as unknown as JsonValue);
      return thread;
    });
  }

  async message(threadId: string, input: ChatMessageInput): Promise<{ thread: ChatThreadRecord; agentId: string; messageId: string }> {
    let thread = this.store.getThread(threadId);
    if (!thread) throw new HttpError(404, `Chat thread not found: ${threadId}`);
    const messageId = input.messageId ?? ulid();
    const requestHash = chatTurnRequestHash(input);
    let receipt = this.getTurnReceipt(messageId);
    const existingMessage = this.store.getConversationMessage(messageId);
    if (receipt) {
      if (receipt.threadId !== threadId || receipt.requestHash !== requestHash) {
        throw new HttpError(409, `Message id ${messageId} is already bound to a different chat request.`);
      }
      if (receipt.state === "delivered" && receipt.agentId) {
        if (thread.conductorAgentId !== receipt.agentId) {
          thread = { ...thread, conductorAgentId: receipt.agentId, updatedAt: nowIso() };
          this.store.saveThread(thread);
        }
        return { thread, agentId: receipt.agentId, messageId };
      }
      if (receipt.state === "dispatching" && receipt.mode === "create-conductor") {
        const existingAgent = this.store.getAgentByLogicalAgentId(chatTurnLogicalAgentId(messageId));
        if (existingAgent) {
          return this.settleCreatedTurn(thread, receipt, existingAgent.id);
        }
        receipt = this.saveTurnReceiptDurably({
          ...receipt,
          state: "accepted",
          mode: null,
          updatedAt: nowIso(),
        });
      } else if (receipt.state === "dispatching" || receipt.state === "outcome-unknown") {
        throw new HttpError(409, "The previous native delivery has an unknown outcome. Symphony will not resend it automatically; send a new message after inspecting the agent session.");
      } else if (receipt.state === "failed") {
        throw new HttpError(409, receipt.error ?? "This chat turn failed before delivery. Send it again with a new message id.");
      }
    } else if (existingMessage) {
      throw new HttpError(409, `Message id ${messageId} already exists without a durable delivery receipt.`);
    }

    const previousMessages = this.store.listConversationMessages(threadId).filter((message) => message.id !== messageId);
    const currentConductor = thread.conductorAgentId ? this.store.getAgent(thread.conductorAgentId) : null;
    const terminalFailure = currentConductor
      ? ["failed", "lost", "cancelled", "interrupted"].includes(currentConductor.status)
      : false;
    const resumable = currentConductor ? this.agents.hasSession(currentConductor.id) : false;
    const busy = currentConductor
      ? ["queued", "routing", "starting", "running", "waiting", "cancel-requested"].includes(currentConductor.status)
      : false;
    if (busy) {
      throw new HttpError(409, "This conversation already has a turn in progress. Stop it or wait for it to finish before sending another message.");
    }
    const configuredHarnessChanged = Boolean(
      currentConductor
      && this.loaded.config.conductor.harness !== currentConductor.requestedHarness,
    );
    const configuredModelChanged = Boolean(
      currentConductor
      && this.loaded.config.conductor.model !== currentConductor.requestedModel,
    );
    const needsConductor = !currentConductor
      || terminalFailure
      || configuredHarnessChanged
      || configuredModelChanged
      || (!resumable && currentConductor.status === "completed");
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
      id: messageId,
      threadId,
      role: "user",
      parts,
      createdAt: nowIso(),
    });
    if (!receipt) {
      const acceptedAt = nowIso();
      receipt = ChatTurnReceiptSchema.parse({
        version: 1,
        messageId,
        threadId,
        requestHash,
        state: "accepted",
        mode: null,
        agentId: null,
        receiptId: null,
        error: null,
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      });
      this.store.durableTransaction(() => {
        this.store.appendConversationMessage(userMessage);
        // Publish the accepted user row through the same durable outbox as
        // assistant deltas. Without this event an already-open browser could
        // receive the reply before it ever learned about the prompt.
        this.store.appendEvent({
          type: "chat.message.updated",
          workflowId: `chat:${threadId}`,
          runId: `chat-run:${threadId}`,
          agentId: currentConductor?.id ?? null,
          occurredAt: userMessage.createdAt,
          payload: { threadId, message: userMessage } as unknown as JsonValue,
          provenance: { source: "user" },
        }, {
          persistedPayload: { threadId, messageId: userMessage.id },
        });
        this.saveTurnReceipt(receipt as ChatTurnReceipt);
      });
    }
    if (isDefaultChatTitle(thread.title) && input.content.trim()) {
      const fallbackTitle = titleFromMessage(input.content);
      thread = { ...thread, title: fallbackTitle, updatedAt: nowIso() };
      this.store.saveThread(thread);
      void this.refineTitle(threadId, input.content, fallbackTitle);
    }

    const nativeContent = promptFromChatInput(input);

    if (needsConductor) {
      receipt = this.saveTurnReceiptDurably({
        ...receipt,
        state: "dispatching",
        mode: "create-conductor",
        updatedAt: nowIso(),
      });
      const mission = thread.mission as unknown as WorkflowMission;
      const history = conversationContext(previousMessages);
      try {
        const agent = await this.agents.create({
          id: chatTurnLogicalAgentId(messageId),
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
          metadata: { threadId, messageId },
        });
        return this.settleCreatedTurn(thread, receipt, agent.id);
      } catch (error) {
        const existingAgent = this.store.getAgentByLogicalAgentId(chatTurnLogicalAgentId(messageId));
        if (existingAgent) return this.settleCreatedTurn(thread, receipt, existingAgent.id);
        this.saveTurnReceiptDurably({
          ...receipt,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: nowIso(),
        });
        throw error;
      }
    } else {
      const dispatchingReceipt = this.saveTurnReceiptDurably({
        ...receipt,
        state: "dispatching",
        mode: "message-existing",
        agentId: currentConductor.id,
        updatedAt: nowIso(),
      });
      receipt = dispatchingReceipt;
      try {
        const delivery = await this.agents.message(
          currentConductor.id,
          buildConductorTurnPrompt(nativeContent),
          { attemptId: messageId },
        );
        const updatedThread = { ...thread, updatedAt: nowIso() };
        this.store.durableTransaction(() => {
          this.store.saveThread(updatedThread);
          this.saveTurnReceipt({
            ...dispatchingReceipt,
            state: "delivered",
            receiptId: delivery.receiptId,
            updatedAt: nowIso(),
          });
        });
        thread = updatedThread;
      } catch (error) {
        this.saveTurnReceiptDurably({
          ...dispatchingReceipt,
          state: "outcome-unknown",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: nowIso(),
        });
        throw error;
      }
    }
    return { thread, agentId: thread.conductorAgentId as string, messageId };
  }

  async recoverPendingTurns(): Promise<void> {
    for (const entry of this.store.listMetadata<JsonValue>("chat-turn:")) {
      const parsed = ChatTurnReceiptSchema.safeParse(entry.value);
      if (!parsed.success) continue;
      let receipt = parsed.data;
      if (receipt.state === "dispatching" && receipt.mode === "message-existing") {
        const followUp = receipt.agentId
          ? RecoveredFollowUpSchema.safeParse(this.store.getMetadata<JsonValue>(`agent-follow-up:${receipt.agentId}`))
          : null;
        if (followUp?.success && followUp.data.attemptId === receipt.messageId) {
          const state = followUp.data.state;
          if (["queued", "dispatching", "delivered", "settled"].includes(state)) {
            this.saveTurnReceiptDurably({
              ...receipt,
              state: "delivered",
              receiptId: followUp.data.receiptId ?? followUp.data.attemptId,
              error: null,
              updatedAt: nowIso(),
            });
          } else {
            this.saveTurnReceiptDurably({
              ...receipt,
              state: state === "outcome-unknown" ? "outcome-unknown" : "failed",
              error: followUp.data.error ?? `The durable native follow-up ended with ${state}.`,
              updatedAt: nowIso(),
            });
          }
        } else {
          this.saveTurnReceiptDurably({
            ...receipt,
            state: "outcome-unknown",
            error: receipt.error ?? "The daemon restarted while a native message delivery was in progress, and no matching durable follow-up receipt exists.",
            updatedAt: nowIso(),
          });
        }
        continue;
      }
      if (receipt.state === "dispatching" && receipt.mode === "create-conductor") {
        const thread = this.store.getThread(receipt.threadId);
        const agent = this.store.getAgentByLogicalAgentId(chatTurnLogicalAgentId(receipt.messageId));
        if (thread && agent) {
          this.settleCreatedTurn(thread, receipt, agent.id);
          continue;
        }
        receipt = this.saveTurnReceiptDurably({ ...receipt, state: "accepted", mode: null, updatedAt: nowIso() });
      }
      if (receipt.state !== "accepted") continue;
      const message = this.store.getConversationMessage(receipt.messageId);
      if (!message) {
        this.saveTurnReceiptDurably({
          ...receipt,
          state: "failed",
          error: "The accepted user message is unavailable.",
          updatedAt: nowIso(),
        });
        continue;
      }
      const input = chatInputFromStoredMessage(message);
      try {
        await this.message(receipt.threadId, input);
      } catch {
        // message() records a deterministic failure or outcome-unknown state.
        // A still-busy conductor leaves the turn accepted for an explicit retry.
      }
    }
  }

  private getTurnReceipt(messageId: string): ChatTurnReceipt | null {
    const raw = this.store.getMetadata<JsonValue>(chatTurnReceiptKey(messageId));
    return raw ? ChatTurnReceiptSchema.parse(raw) : null;
  }

  private saveTurnReceipt(receipt: ChatTurnReceipt): ChatTurnReceipt {
    const parsed = ChatTurnReceiptSchema.parse(receipt);
    this.store.setMetadata(chatTurnReceiptKey(parsed.messageId), parsed as unknown as JsonValue);
    return parsed;
  }

  private saveTurnReceiptDurably(receipt: ChatTurnReceipt): ChatTurnReceipt {
    return this.store.durableTransaction(() => this.saveTurnReceipt(receipt));
  }

  private settleCreatedTurn(
    thread: ChatThreadRecord,
    receipt: ChatTurnReceipt,
    agentId: string,
  ): { thread: ChatThreadRecord; agentId: string; messageId: string } {
    const previousConductorAgentId = thread.conductorAgentId;
    const updated = { ...thread, conductorAgentId: agentId, updatedAt: nowIso() };
    let retirementPrepared = false;
    this.store.durableTransaction(() => {
      this.store.saveThread(updated);
      this.saveTurnReceipt({
        ...receipt,
        state: "delivered",
        mode: "create-conductor",
        agentId,
        updatedAt: nowIso(),
      });
      if (previousConductorAgentId && previousConductorAgentId !== agentId) {
        retirementPrepared = this.agents.prepareReusableSessionRetirement(
          previousConductorAgentId,
          "chat-conductor-replaced",
        );
      }
    });
    if (retirementPrepared && previousConductorAgentId) {
      this.agents.continueReusableSessionRetirement(previousConductorAgentId);
    }
    return { thread: updated, agentId, messageId: receipt.messageId };
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
    if (!isChatProjectionSourceEvent(event)) return;
    try {
      this.replayProjectionThrough(event.cursor);
    } catch (error) {
      // The source event is already authoritative. Keep its cursor pending so
      // the next live event or daemon restart retries projection instead of
      // turning a UI write failure into a false native-run failure.
      try {
        this.store.appendEvent({
          type: "chat.projection.failed",
          workflowId: event.workflowId,
          runId: event.runId,
          agentId: event.agentId,
          occurredAt: nowIso(),
          payload: {
            sourceCursor: event.cursor,
            sourceType: event.type,
            error: error instanceof Error ? error.message : String(error),
          },
          provenance: { source: "daemon" },
        });
      } catch {
        // Storage itself may be unavailable; startup replay remains the
        // authoritative retry path once it can be opened again.
      }
    }
  }

  private applyProjectionEvent(event: EventEnvelope): void {
    if (!event.agentId) return;
    const thread = this.store.listThreads({ includeArchived: true }).find((item) => item.conductorAgentId === event.agentId);
    if (!thread) return;
    const agent = this.store.getAgent(event.agentId);
    const terminalBoundary = agent && isTerminalAgentStatus(agent.status)
      ? this.store.recentEvents({
        agentId: agent.id,
        types: [
          "agent.failed",
          "agent.interrupted",
          "agent.cancelled",
          "driver.run.completed",
          "driver.run.failed",
          "driver.run.cancelled",
        ],
        limit: 100,
      }).at(0)?.cursor
      : undefined;
    const staleDriverProjection = Boolean(
      agent
      && isTerminalAgentStatus(agent.status)
      && terminalBoundary !== undefined
      && event.cursor > terminalBoundary
      && (
        event.type === "driver.message.delta"
        || event.type === "driver.reasoning.delta"
        || event.type === "driver.tool.started"
        || event.type === "driver.tool.updated"
        || event.type === "driver.tool.completed"
      )
    );
    // Preserve late native evidence in the event/log stream, but never let it
    // reopen a settled assistant message after the authoritative agent state
    // crossed a terminal boundary.
    if (staleDriverProjection) return;
    if (event.type === "driver.message.delta") {
      const payload = jsonRecord(event.payload);
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text) {
        this.updateStream(event, thread, {
          kind: "text",
          text,
          replace: payload.replace === true,
          segmentId: streamSegmentId(payload),
        });
      }
      return;
    }
    if (event.type === "driver.reasoning.delta") {
      const payload = jsonRecord(event.payload);
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text) {
        this.updateStream(event, thread, {
          kind: "reasoning",
          text,
          replace: payload.replace === true,
          segmentId: streamSegmentId(payload),
        });
      }
      return;
    }
    if (
      event.type === "driver.tool.started"
      || event.type === "driver.tool.updated"
      || event.type === "driver.tool.completed"
    ) {
      this.updateTool(event, thread, event.type.slice("driver.tool.".length) as ToolLifecycle);
      return;
    }
    if (event.type === "driver.run.cancelled") {
      this.finalizeStream(event, thread, null);
      return;
    }
    if (event.type === "agent.failed" || event.type === "agent.interrupted") {
      this.finalizeStream(event, thread, null);
      const message = ConversationMessageSchema.parse({
        id: ulid(),
        threadId: thread.id,
        role: "assistant",
        parts: [{
          type: "text",
          text: event.type === "agent.interrupted"
            ? `This run was interrupted. ${friendlyAgentError(agent?.error)}`
            : `I couldn't start or complete this run. ${friendlyAgentError(agent?.error)}`,
        }],
        createdAt: nowIso(),
      });
      this.publishMessage(event, message);
      return;
    }
    if (event.type !== "driver.output.completed") return;
    if (agent?.status === "failed") return;
    this.finalizeStream(event, thread, projectedOutputText(event.payload, agent?.output ?? null));
  }

  private updateStream(
    event: EventEnvelope,
    thread: ChatThreadRecord,
    delta: { kind: "text" | "reasoning"; text: string; replace: boolean; segmentId?: string | undefined },
  ): void {
    const state = this.getStream(event.agentId as string, thread.id);
    applyStreamDelta(state, delta);
    this.streams.set(event.agentId as string, state);
    this.publishMessage(event, this.streamMessage(state, true));
  }

  private updateTool(event: EventEnvelope, thread: ChatThreadRecord, lifecycle: ToolLifecycle): void {
    const state = this.getStream(event.agentId as string, thread.id);
    applyToolLifecycle(state, event, lifecycle);
    this.streams.set(event.agentId as string, state);
    this.publishMessage(event, this.streamMessage(state, true));
  }

  private finalizeStream(event: EventEnvelope, thread: ChatThreadRecord, finalText: string | null): void {
    const existing = this.streams.get(event.agentId as string) ?? this.persistedStream(thread.id);
    const state = existing ?? {
      messageId: ulid(),
      threadId: thread.id,
      createdAt: nowIso(),
      parts: [],
    };
    finalizeStreamParts(state, finalText);
    if (!state.parts.length) return;
    this.publishMessage(event, this.streamMessage(state, false));
    this.streams.delete(event.agentId as string);
  }

  private getStream(agentId: string, threadId: string): ChatStreamState {
    return this.streams.get(agentId)
      ?? this.persistedStream(threadId)
      ?? { messageId: ulid(), threadId, createdAt: nowIso(), parts: [] };
  }

  private persistedStream(threadId: string): ChatStreamState | null {
    const message = [...this.store.listConversationMessages(threadId)].reverse().find((item) => item.role === "assistant" && item.streaming);
    if (!message) return null;
    return { messageId: message.id, threadId, createdAt: message.createdAt, parts: structuredStreamParts(message.parts) };
  }

  private streamMessage(state: ChatStreamState, streaming: boolean) {
    const parts = collapseRepeatedPartSequence(state.parts).map((part) => {
      const record = jsonRecord(part);
      if (record.type !== "reasoning") return part;
      return { ...record, status: { type: streaming ? "running" : "complete" } } as JsonValue;
    });
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
    }, {
      persistedPayload: { threadId: message.threadId, messageId: message.id },
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
  private readonly daemonCredential: DaemonCredential;
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
  private ready = false;
  private controlPlaneReady = false;
  private catalogTimer: NodeJS.Timeout | null = null;
  private readonly eventResponses = new Set<ServerResponse>();
  private lease: DaemonLease | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: StartDaemonOptions = {}) {
    this.loaded = loadConfig({
      ...(options.rootDirectory ? { rootDirectory: options.rootDirectory } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
    if (options.port) this.loaded.config.server.port = options.port;
    if (options.host) this.loaded.config.server.host = options.host;
    if (options.acquireLease) {
      this.lease = acquireDaemonLease(this.loaded.dataDirectory, this.loaded.configPath);
    }
    let openedStore: SymphonyStore | null = null;
    try {
      openedStore = createStore(this.loaded.dataDirectory);
      this.store = openedStore;
      this.secrets = options.secretStore ?? new SecretStore();
      this.daemonCredential = resolveDaemonCredential(this.store, this.secrets, {
        ...(options.credentialPlatform ? { platform: options.credentialPlatform } : {}),
      });
      // Environment configuration is only an ingestion path for the daemon
      // authority. Clear it before in-process plugins or native SDKs start.
      removeDaemonSecretFromProcessEnvironment();
      this.drivers = options.driverRegistry ?? createDriverRegistry(this.loaded, this.secrets);
      this.harnessMaintenance = new HarnessMaintenance(this.loaded, this.drivers);
      this.router = new ModelRouter(this.loaded, this.secrets, this.drivers, this.store);
      this.observer = new PassiveObserver(this.loaded, this.secrets, this.store);
      this.uiUtilities = new UiUtilityService(this.loaded, this.secrets, this.store);
      this.agents = new AgentCoordinator(
        this.loaded,
        this.store,
        this.drivers,
        this.router,
        this.observer,
        undefined,
        this.daemonCredential,
      );
      this.workflows = new WorkflowEngine(this.loaded, this.store, this.agents);
      // Daemon-owned schedules stay paused until durable native agents,
      // workflows, and any claimed cron occurrences have been reconciled.
      this.triggers = new TriggerManager(this.store, this.workflows, { paused: true });
      this.plugins = new PluginHost(this.loaded, this.store, options.noPlugins ?? false);
      this.projects = new ProjectService(this.loaded, this.store);
      this.chats = new ChatService(this.loaded, this.store, this.agents, this.uiUtilities);
    } catch (error) {
      openedStore?.close();
      if (this.lease) releaseDaemonLease(this.lease);
      this.lease = null;
      throw error;
    }
  }

  async start(): Promise<{ url: string }> {
    if (this.server) throw new Error("Symphony daemon is already started.");
    // The lease is acquired before plugins, routing, recovery, or any native
    // dispatch. A second daemon must never replay work and only later discover
    // that another process already owns the same durable ledger.
    this.lease ??= acquireDaemonLease(this.loaded.dataDirectory, this.loaded.configPath);
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolvePromise, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.loaded.config.server.port, this.loaded.config.server.host, () => resolvePromise());
    });
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
    if (this.loaded.config.workflows.triggersEnabled) {
      // API-registered workflows live only in SQLite, so they have no plugin
      // or filesystem loader to recreate their in-memory cron jobs after a
      // restart. Rebuild every latest persisted schedule after all file-backed
      // revisions have been loaded. TriggerManager.register replaces existing
      // jobs by workflow ID, making this safe for plugin/file workflows too.
      for (const record of this.store.listWorkflows()) {
        try {
          const ir = new WorkflowCompiler().compile(record.definition, record.revision);
          if (ir.hash !== record.hash) throw new Error(`Stored workflow hash mismatch for ${record.id} revision ${record.revision}.`);
          this.triggers.register(ir);
        } catch (error) {
          this.store.appendEvent({
            type: "workflow.trigger.recovery-failed",
            workflowId: record.id,
            runId: null,
            agentId: null,
            occurredAt: nowIso(),
            payload: { revision: record.revision, error: error instanceof Error ? error.message : String(error) },
            provenance: { source: "daemon" },
          });
        }
      }
    }
    // The event log is the chat projection outbox. Replay every source event
    // committed before this fixed high-water before deciding which visible
    // streams were genuinely interrupted by the previous daemon generation.
    this.chats.recoverProjectionBacklog();
    this.agents.reconcileWorkerProcesses();
    // The durable store, protocol routes, model catalog, plugins, and workflow
    // definitions are now available. Expose the control plane before native
    // recovery so a retained worker can use its Symphony coordination tools
    // while its session is being reattached. `/health` remains `recovering`
    // until every bounded startup reconciliation has completed.
    this.controlPlaneReady = true;
    await this.agents.recover();
    // Only recovery can decide whether a native turn is still live. Preserve
    // its existing streaming message when it is; settle the message only when
    // the authoritative conductor is now idle or terminal.
    this.chats.reconcileInterruptedStreams();
    await this.chats.recoverPendingTurns();
    await this.workflows.recover();
    if (this.loaded.config.workflows.triggersEnabled) {
      await this.triggers.recover();
      this.triggers.activate();
    }
    this.ready = true;
    this.store.appendEvent({ type: "daemon.started", workflowId: null, runId: null, agentId: null, occurredAt: nowIso(), payload: { pid: process.pid, version: "0.1.0" }, provenance: { source: "daemon" } });
    return { url: `http://${this.loaded.config.server.host}:${this.loaded.config.server.port}` };
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    const timeoutMs = this.loaded.config.server.shutdownTimeoutMs;
    try {
      this.ready = false;
      this.controlPlaneReady = false;
      if (this.catalogTimer) clearInterval(this.catalogTimer);
      this.catalogTimer = null;
      this.chats.close();
      for (const response of this.eventResponses) response.end();
      this.eventResponses.clear();
      this.triggers.stop();
      await this.plugins.stop();
      // Closing native transports is an infrastructure action, not evidence
      // that durable work failed. Freeze normalized agent projection before
      // drivers tear down so the next daemon can reconcile the native truth.
      this.agents.quiesce();
      await withinDeadline(this.drivers.dispose(), timeoutMs);
      if (this.server) {
        const server = this.server;
        server.closeIdleConnections();
        const drain = new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
        const drained = await withinDeadline(drain, timeoutMs);
        if (!drained) {
          server.closeAllConnections();
          await withinDeadline(drain, Math.min(timeoutMs, 1_000));
        }
        this.server = null;
      }
    } finally {
      this.store.close();
      if (this.lease) releaseDaemonLease(this.lease);
      this.lease = null;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      response.setHeader("access-control-allow-origin", `http://${this.loaded.config.server.host}:${this.loaded.config.server.port}`);
      response.setHeader("x-content-type-options", "nosniff");
      if (request.method === "OPTIONS") return this.empty(response, 204);
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/health") {
        return this.json(response, 200, {
          ok: this.ready,
          status: this.ready ? "ready" : "recovering",
          version: "0.1.0",
          startedAt: this.startedAt,
          cursor: this.store.latestCursor(),
        });
      }
      if (!this.controlPlaneReady && url.pathname.startsWith("/v1")) {
        return this.json(response, 503, { error: "Symphony is recovering durable work. Retry shortly." });
      }
      if (url.pathname === "/v1/theme" && request.method === "GET") return this.json(response, 200, this.theme());
      if (url.pathname === "/v1/theme/icon.svg" && request.method === "GET") return this.themeIcon(response);
      if (url.pathname === "/v1/bootstrap" && request.method === "GET") return this.json(response, 200, this.bootstrap());
      if (url.pathname === "/v1/events" && request.method === "GET") return this.events(request, response, url);
      if (url.pathname === "/v1/drivers" && request.method === "GET") return this.json(response, 200, await this.harnessMaintenance.reports(url.searchParams.get("refresh") === "true"));
      const driverUpdate = url.pathname.match(/^\/v1\/drivers\/([^/]+)\/update$/u);
      if (driverUpdate && request.method === "POST") {
        const driver = z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"]).parse(decodeURIComponent(driverUpdate[1] as string));
        this.requireFullAccessAgent(request, "update a native harness");
        const receipt = await this.command(CommandSchema.parse({
          idempotencyKey: this.requireIdempotencyKey(request),
          type: "driver.update",
          payload: { driver },
          actor: this.commandActor(request),
        }));
        return this.json(response, 200, receipt.result);
      }
      const driverAuthentication = url.pathname.match(/^\/v1\/drivers\/([^/]+)\/authenticate$/u);
      if (driverAuthentication && request.method === "POST") {
        const driverId = z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"]).parse(decodeURIComponent(driverAuthentication[1] as string));
        const driver = this.drivers.get(driverId);
        if (!driver.authenticate) throw new HttpError(400, `${driverId} does not expose an interactive authentication flow.`);
        this.requireFullAccessAgent(request, "authenticate a native harness");
        const receipt = await this.command(CommandSchema.parse({
          idempotencyKey: this.requireIdempotencyKey(request),
          type: "driver.authenticate",
          payload: { driver: driverId },
          actor: this.commandActor(request),
        }));
        return this.json(response, 200, receipt.result);
      }
      if (url.pathname === "/v1/models" && request.method === "GET") return this.json(response, 200, this.router.list());
      if (url.pathname === "/v1/search/chats" && request.method === "GET") {
        const query = z.string().min(1).max(2_000).parse(url.searchParams.get("q") ?? "");
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("Chat search client disconnected."));
        const close = () => {
          if (!response.writableEnded) abort();
        };
        request.once("aborted", abort);
        response.once("close", close);
        try {
          return this.json(response, 200, await this.chats.search(query, controller.signal));
        } finally {
          request.off("aborted", abort);
          response.off("close", close);
        }
      }
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
        this.requireFullAccessAgent(request, "register a workflow revision");
        const receipt = await this.command(CommandSchema.parse({
          idempotencyKey: this.requireIdempotencyKey(request),
          type: "workflow.register",
          payload: JsonValueSchema.parse(await body(request)),
          actor: this.commandActor(request),
        }));
        return this.json(response, 201, receipt.result);
      }
      if (url.pathname === "/v1/runs" && request.method === "GET") return this.json(response, 200, this.store.listRuns());
      if (url.pathname === "/v1/commands" && request.method === "POST") {
        // Native agents use the scoped, token-authenticated resource routes.
        // Never let a caller-supplied command actor bypass parent, permission,
        // mission, or workflow constraints through the generic user surface.
        if (request.headers["x-symphony-agent-id"] !== undefined) {
          throw new HttpError(403, "Agents must use Symphony's scoped coordination routes.");
        }
        const command = CommandSchema.parse(await body(request));
        return this.json(response, 200, await this.command({ ...command, actor: { type: "user", id: null } }));
      }
      if (url.pathname === "/v1/threads" && request.method === "GET") return this.json(response, 200, this.chats.list());
      if (url.pathname === "/v1/threads" && request.method === "POST") {
        const input = z.object({ title: z.string().optional(), projectId: z.string().optional(), groupId: z.string().nullable().optional(), mission: z.object({ statement: z.string(), keyResults: z.array(z.string()).optional() }).optional(), workspacePath: z.string().optional() }).parse(await body(request));
        const project = input.projectId ? this.projects.get(input.projectId) : null;
        return this.json(response, 201, this.chats.create(ChatThreadCreateInputSchema.parse({
          ...input,
          groupId: project?.id ?? input.groupId,
          workspacePath: project?.workspacePath ?? input.workspacePath,
        }), this.requireIdempotencyKey(request)));
      }
      const match = url.pathname.match(/^\/v1\/(agents|workflows|runs|threads)\/([^/]+)(?:\/(.*))?$/u);
      if (match) return await this.resource(request, response, match[1] as string, decodeURIComponent(match[2] as string), match[3] ?? "", url);
      const pluginTool = url.pathname.match(/^\/v1\/plugin-tools\/([^/]+)$/u);
      if (pluginTool && request.method === "POST") {
        this.requireFullAccessAgent(request, "invoke a plugin tool");
        const receipt = await this.command(CommandSchema.parse({
          idempotencyKey: this.requireIdempotencyKey(request),
          type: "plugin.invoke",
          payload: {
            name: decodeURIComponent(pluginTool[1] as string),
            arguments: JsonValueSchema.parse(await body(request)),
          },
          actor: this.commandActor(request),
        }));
        return this.json(response, 200, receipt.result);
      }
      if (url.pathname.startsWith("/v1/")) throw new HttpError(404, "API route not found");
      return this.staticFile(response, url.pathname);
    } catch (error) {
      // Some response helpers (notably streaming/static responses) take
      // ownership of the socket before all downstream work has settled. Never
      // turn a late serialization or connection error into a process-crashing
      // second writeHead call.
      if (response.headersSent || response.writableEnded) {
        if (!response.writableEnded) response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      this.json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async resource(request: IncomingMessage, response: ServerResponse, resource: string, id: string, action: string, url: URL): Promise<void> {
    if (resource === "agents" && !action && request.method === "GET") return this.json(response, 200, this.agents.get(id));
    if (resource === "agents" && action === "messages" && request.method === "GET") {
      const agent = this.agents.get(id);
      const events = agentEventsThroughCursor(this.store, id, this.store.latestCursor());
      return this.json(response, 200, {
        agentId: id,
        messages: buildAgentTranscript(agent, events),
      });
    }
    if (resource === "agents" && action === "logs" && request.method === "GET") {
      const agent = this.agents.get(id);
      const after = z.coerce.number().int().min(0).default(0).parse(url.searchParams.get("after") ?? 0);
      const limit = z.coerce.number().int().min(1).max(2_000).default(500).parse(url.searchParams.get("limit") ?? 500);
      const tail = url.searchParams.get("tail") === "true" && after === 0;
      const events = tail
        ? this.store.recentEvents({ agentId: id, limit })
        : this.store.eventsAfter(after, { agentId: id, limit });
      return this.json(response, 200, {
        agent: {
          id: agent.id,
          status: agent.status,
          harness: agent.harness ?? agent.requestedHarness,
          model: agent.model ?? agent.requestedModel,
          nativeSessionId: agent.nativeSessionId,
          nativeRunId: agent.nativeRunId,
          workspacePath: agent.workspacePath,
          error: agent.error,
        },
        cursor: events.at(-1)?.cursor ?? after,
        entries: sessionLogEntries(events),
      });
    }
    if (resource === "agents" && action === "messages" && request.method === "POST") {
      const input = z.object({ content: z.string().min(1) }).parse(await body(request));
      return this.json(response, 202, await this.messageAgent(request, id, input.content));
    }
    if (resource === "agents" && action === "observe" && request.method === "GET") {
      const level = z.enum(["tldr", "paragraph", "full"]).parse(url.searchParams.get("level") ?? "tldr");
      return this.json(response, 200, await this.agents.observe(id, level));
    }
    if (resource === "agents" && action === "cancel" && request.method === "POST") {
      this.requireFullAccessAgent(request, "cancel an agent");
      await this.command(CommandSchema.parse({
        idempotencyKey: this.requireIdempotencyKey(request),
        type: "agent.cancel",
        payload: { agentId: id },
        actor: this.commandActor(request),
      }));
      return this.empty(response, 204);
    }
    if (resource === "agents" && action === "present" && request.method === "POST") {
      this.requireAgentAuthentication(request, id);
      const receipt = await this.command(CommandSchema.parse({
        idempotencyKey: this.requireIdempotencyKey(request),
        type: "agent.present",
        payload: { agentId: id, presentation: JsonValueSchema.parse(await body(request)) },
        actor: { type: "agent", id },
      }));
      return this.json(response, 201, receipt.result);
    }
    if (resource === "runs" && action === "events" && request.method === "GET") {
      const after = z.coerce.number().int().min(0).default(0).parse(url.searchParams.get("after") ?? 0);
      const limit = z.coerce.number().int().min(1).max(2_000).default(1_000).parse(url.searchParams.get("limit") ?? 1_000);
      const page = this.store.eventsAfter(after, {
        runId: id,
        limit: limit + 1,
        types: UI_EVENT_TYPES,
        typePrefixes: UI_EVENT_PREFIXES,
      });
      const events = page.slice(0, limit);
      return this.json(response, 200, {
        runId: id,
        cursor: events.at(-1)?.cursor ?? after,
        hasMore: page.length > limit,
        events,
      });
    }
    if (resource === "workflows" && action === "runs" && request.method === "POST") {
      this.requireFullAccessAgent(request, "start a workflow");
      const receipt = await this.command(CommandSchema.parse({
        idempotencyKey: this.requireIdempotencyKey(request),
        type: "workflow.run",
        payload: { workflowId: id, input: JsonValueSchema.parse(await body(request)) },
        actor: this.commandActor(request),
      }));
      return this.json(response, 202, receipt.result);
    }
    if (resource === "runs" && action === "cancel" && request.method === "POST") {
      this.requireFullAccessAgent(request, "cancel a workflow run");
      const receipt = await this.command(CommandSchema.parse({
        idempotencyKey: this.requireIdempotencyKey(request),
        type: "workflow.cancel",
        payload: { runId: id },
        actor: this.commandActor(request),
      }));
      return this.json(response, 200, receipt.result);
    }
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
    const idempotencyKey = this.requireIdempotencyKey(request);
    if (typeof callerId !== "string") {
      const receipt = await this.command(CommandSchema.parse({
        idempotencyKey,
        type: "agent.create",
        payload,
        actor: { type: "user", id: null },
      }));
      return receipt.result;
    }
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
    const workOrder = {
      workflowId: parent.workflowId, runId: parent.runId, parentAgentId: parent.id, depth: parent.depth + 1,
      mission: parentOrder.mission, objective: child.objective, model: child.model, harness: child.harness,
      permissions: child.permissions ?? parent.permissions, outputSchema: child.outputSchema,
      ...(child.routing === undefined ? {} : { routing: child.routing }),
      workspace: child.workspace ?? parentOrder.workspace, inputs: child.inputs,
    };
    const receipt = await this.command(CommandSchema.parse({
      idempotencyKey,
      type: "agent.create",
      payload: workOrder,
      actor: { type: "agent", id: callerId },
    }));
    return receipt.result;
  }

  private async messageAgent(request: IncomingMessage, targetAgentId: string, content: string): Promise<JsonValue> {
    const callerId = request.headers["x-symphony-agent-id"];
    const token = request.headers["x-symphony-agent-token"];
    if (callerId !== undefined) {
      if (typeof callerId !== "string" || typeof token !== "string" || !this.agents.authenticate(callerId, token)) {
        throw new HttpError(401, "Invalid agent coordination token");
      }
    }
    const receipt = await this.command(CommandSchema.parse({
      idempotencyKey: this.requireIdempotencyKey(request),
      type: "agent.message",
      payload: { agentId: targetAgentId, content },
      actor: typeof callerId === "string" ? { type: "agent", id: callerId } : { type: "user", id: null },
    }));
    return receipt.result;
  }

  private requireIdempotencyKey(request: IncomingMessage): string {
    const value = request.headers["idempotency-key"];
    if (Array.isArray(value)) throw new HttpError(400, "Exactly one Idempotency-Key header is required.");
    const parsed = z.string().min(8).max(512).safeParse(value);
    if (!parsed.success) {
      throw new HttpError(400, "Mutating requests require an Idempotency-Key header of at least 8 characters.");
    }
    return parsed.data;
  }

  private commandActor(request: IncomingMessage): Command["actor"] {
    const callerId = request.headers["x-symphony-agent-id"];
    return typeof callerId === "string"
      ? { type: "agent", id: callerId }
      : { type: "user", id: null };
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

  private requireAgentAuthentication(request: IncomingMessage, agentId: string): void {
    const callerId = request.headers["x-symphony-agent-id"];
    const token = request.headers["x-symphony-agent-token"];
    if (callerId !== agentId || typeof token !== "string" || !this.agents.authenticate(agentId, token)) {
      throw new HttpError(401, "Invalid agent coordination token");
    }
  }

  private presentAgentUi(agentId: string, payload: unknown, messageId = ulid()): { messageId: string; threadId: string } {
    const agent = this.agents.get(agentId);
    const threadId = agent.workflowId.startsWith("chat:") ? agent.workflowId.slice("chat:".length) : null;
    if (!threadId || !this.store.getThread(threadId)) throw new HttpError(409, "Structured UI can only be presented inside a Symphony chat workflow.");
    const input = z.object({
      kind: z.enum(["speaker-identity", "diagram", "flow-graph", "spec-sheet", "timeline", "job-progress", "score-breakdown", "agent-plan", "subagent-list", "recommendation-card", "handoff", "schedule", "checkpoints", "cost-meter", "tool-timeline", "generative-ui"]),
      data: JsonValueSchema,
    }).parse(payload);
    const existingMessage = this.store.getConversationMessage(messageId);
    if (existingMessage) {
      if (existingMessage.threadId !== threadId) {
        throw new HttpError(409, `Structured UI message ${messageId} is already bound to a different chat thread.`);
      }
      return { messageId, threadId };
    }
    const createdAt = nowIso();
    const message = ConversationMessageSchema.parse({
      id: messageId,
      threadId,
      role: "assistant",
      parts: [{ type: "data", name: input.kind, data: input.data }],
      createdAt,
    });
    this.store.appendConversationMessage(message);
    // Structured UI is a real conversation message, so deliver the same live
    // projection contract used by streamed assistant messages. Persist only
    // its identity in the event log; the message body remains in the dedicated
    // transcript store.
    this.store.appendEvent({
      type: "chat.message.updated",
      workflowId: agent.workflowId,
      runId: agent.runId,
      agentId,
      occurredAt: createdAt,
      payload: { threadId, message } as unknown as JsonValue,
      provenance: { source: "daemon" },
    }, {
      persistedPayload: { threadId, messageId },
    });
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
    const fingerprint = commandFingerprint(command);
    const fingerprintKey = `command-fingerprint:${createHash("sha256").update(command.idempotencyKey).digest("hex")}`;
    const existing = this.store.durableTransaction(() => {
      const previousFingerprint = this.store.getMetadata<string>(fingerprintKey);
      if (previousFingerprint && previousFingerprint !== fingerprint) {
        throw new HttpError(409, `Command ${command.idempotencyKey} is already bound to a different operation.`);
      }
      const receipt = this.store.getCommandReceipt(command.idempotencyKey);
      if (receipt) return receipt;
      let driverUpdate: { driver: ResolvedHarness; operation: DriverUpdateOperation } | null = null;
      let driverAuthentication: { driver: ResolvedHarness; operation: DriverAuthenticationOperation } | null = null;
      if (command.type === "driver.update") {
        const driver = z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"])
          .parse((command.payload as Record<string, JsonValue>).driver);
        const active = this.driverUpdateOperation(driver);
        if (active && ["preparing", "dispatching"].includes(active.state)) {
          throw new HttpError(
            active.idempotencyKey === command.idempotencyKey ? 425 : 409,
            active.idempotencyKey === command.idempotencyKey
              ? `${driver} update already has a durable operation but its command receipt is unavailable; Symphony will not launch it again automatically.`
              : `${driver} already has an active durable update operation; retry that operation before starting another.`,
          );
        }
        const createdAt = nowIso();
        driverUpdate = {
          driver,
          operation: DriverUpdateOperationSchema.parse({
            version: 1,
            driver,
            idempotencyKey: command.idempotencyKey,
            state: "preparing",
            baselineVersion: null,
            targetVersion: null,
            result: null,
            error: null,
            createdAt,
            updatedAt: createdAt,
          }),
        };
      }
      if (command.type === "driver.authenticate") {
        const driver = z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"])
          .parse((command.payload as Record<string, JsonValue>).driver);
        const active = this.driverAuthenticationOperation(driver);
        if (active && ["preparing", "dispatching"].includes(active.state)) {
          throw new HttpError(
            active.idempotencyKey === command.idempotencyKey ? 425 : 409,
            active.idempotencyKey === command.idempotencyKey
              ? `${driver} authentication already has a durable operation but its command receipt is unavailable; Symphony will not launch it again automatically.`
              : `${driver} already has an active durable authentication operation; retry that operation before starting another.`,
          );
        }
        const createdAt = nowIso();
        driverAuthentication = {
          driver,
          operation: DriverAuthenticationOperationSchema.parse({
            version: 1,
            driver,
            idempotencyKey: command.idempotencyKey,
            state: "preparing",
            baselineAuthenticated: null,
            result: null,
            error: null,
            createdAt,
            updatedAt: createdAt,
          }),
        };
      }
      this.store.setMetadata(fingerprintKey, fingerprint);
      const createdAt = nowIso();
      const pending = CommandReceiptSchema.parse({
        idempotencyKey: command.idempotencyKey,
        accepted: false,
        state: "dispatching",
        result: { commandType: command.type, status: "outcome-unknown" },
        createdAt,
        updatedAt: createdAt,
      });
      if (!this.store.claimCommandReceipt(pending)) {
        throw new HttpError(409, "The command idempotency key was claimed but its durable receipt is unavailable.");
      }
      if (driverUpdate) {
        this.store.setMetadata(
          driverUpdateOperationKey(driverUpdate.driver),
          driverUpdate.operation as unknown as JsonValue,
        );
      }
      if (driverAuthentication) {
        this.store.setMetadata(
          driverAuthenticationOperationKey(driverAuthentication.driver),
          driverAuthentication.operation as unknown as JsonValue,
        );
      }
      return null;
    });
    if (existing) return await this.existingCommandReceipt(existing, command);

    const createdAt = this.store.getCommandReceipt(command.idempotencyKey)?.createdAt ?? nowIso();
    try {
      let result: JsonValue;
      if (command.type === "agent.create") {
        const payload = command.payload as Record<string, JsonValue>;
        result = await this.agents.create({
          ...payload,
          id: typeof payload.id === "string" ? payload.id : commandDerivedId("agent", command.idempotencyKey),
        }) as unknown as JsonValue;
      }
      else if (command.type === "agent.message") {
        const payload = command.payload as Record<string, JsonValue>;
        result = await this.agents.message(
          String(payload.agentId),
          String(payload.content),
          { attemptId: command.idempotencyKey },
        ) as unknown as JsonValue;
      } else if (command.type === "agent.observe") {
        const payload = command.payload as Record<string, JsonValue>;
        result = await this.agents.observe(String(payload.agentId), z.enum(["tldr", "paragraph", "full"]).parse(payload.level ?? "tldr")) as unknown as JsonValue;
      } else if (command.type === "agent.cancel") {
        await this.agents.cancel(String((command.payload as Record<string, JsonValue>).agentId));
        result = { cancelled: true };
      } else if (command.type === "agent.present") {
        const payload = command.payload as Record<string, JsonValue>;
        result = this.presentAgentUi(
          String(payload.agentId),
          payload.presentation,
          commandDerivedId("present", command.idempotencyKey),
        ) as unknown as JsonValue;
      } else if (command.type === "workflow.register") {
        const definition = command.payload as Record<string, JsonValue>;
        const id = typeof definition.id === "string" ? definition.id : "";
        const previous = id ? this.store.getWorkflow(id) : null;
        const ir = new WorkflowCompiler().compile(definition, (previous?.revision ?? 0) + 1);
        if (previous?.hash === ir.hash) {
          result = previous as unknown as JsonValue;
          if (this.loaded.config.workflows.triggersEnabled) {
            this.triggers.register(new WorkflowCompiler().compile(previous.definition, previous.revision));
          }
        } else {
          result = this.workflows.register(ir) as unknown as JsonValue;
          if (this.loaded.config.workflows.triggersEnabled) this.triggers.register(ir);
        }
      } else if (command.type === "workflow.run") {
        const payload = command.payload as Record<string, JsonValue>;
        result = this.workflows.start(
          String(payload.workflowId),
          payload.input ?? {},
          { runId: commandDerivedId("run", command.idempotencyKey) },
        ) as unknown as JsonValue;
      } else if (command.type === "workflow.cancel") result = this.workflows.cancel(String((command.payload as Record<string, JsonValue>).runId)) as unknown as JsonValue;
      else if (command.type === "plugin.invoke") {
        const payload = command.payload as Record<string, JsonValue>;
        const name = z.string().min(1).parse(payload.name);
        const registration = this.plugins.getTool(name);
        if (!registration) throw new HttpError(404, "Plugin tool not found");
        const value = await registration.tool.execute(payload.arguments ?? {});
        result = { pluginId: registration.plugin.manifest.id, value: JsonValueSchema.parse(value) };
      } else if (command.type === "driver.update") result = await this.executeDriverUpdate(command);
      else if (command.type === "driver.authenticate") result = await this.executeDriverAuthentication(command);
      else throw new HttpError(400, `Command ${command.type} is not implemented by the local API.`);
      const receipt = CommandReceiptSchema.parse({
        idempotencyKey: command.idempotencyKey,
        accepted: true,
        state: "settled",
        result,
        createdAt,
        updatedAt: nowIso(),
      });
      this.store.durableTransaction(() => this.store.replaceCommandReceipt(receipt));
      return receipt;
    } catch (error) {
      if (
        error instanceof DriverUpdateOutcomeUnknownError
        || (command.type === "driver.update" && error instanceof HttpError && error.status === 425)
        || error instanceof DriverAuthenticationOutcomeUnknownError
        || (command.type === "driver.authenticate" && error instanceof HttpError && error.status === 425)
      ) throw error;
      this.store.durableTransaction(() => this.store.replaceCommandReceipt(CommandReceiptSchema.parse({
        idempotencyKey: command.idempotencyKey,
        accepted: false,
        state: "failed",
        result: { error: error instanceof Error ? error.message : String(error) },
        createdAt,
        updatedAt: nowIso(),
      })));
      throw error;
    }
  }

  private async existingCommandReceipt(receipt: CommandReceipt, command: Command): Promise<CommandReceipt> {
    if (receipt.state === "settled") return receipt;
    if (receipt.state === "dispatching") {
      if (command.type === "agent.create") {
        const payload = command.payload as Record<string, JsonValue>;
        const logicalAgentId = typeof payload.id === "string"
          ? payload.id
          : commandDerivedId("agent", command.idempotencyKey);
        const agent = this.store.getAgentByLogicalAgentId(logicalAgentId);
        if (agent) return this.settleRecoveredCommandReceipt(receipt, agent as unknown as JsonValue);
      }
      if (command.type === "agent.message") {
        const payload = command.payload as Record<string, JsonValue>;
        const attempt = this.agents.messageAttempt(String(payload.agentId), command.idempotencyKey);
        const result = attempt?.kind === "follow-up"
          ? { receiptId: attempt.attemptId, queued: true }
          : attempt
            && ["delivered", "settled"].includes(attempt.state)
            && attempt.receiptId !== null
            && attempt.queued !== null
            ? { receiptId: attempt.receiptId, queued: attempt.queued }
            : null;
        if (result) return this.settleRecoveredCommandReceipt(receipt, result as unknown as JsonValue);
      }
      if (command.type === "workflow.run") {
        const run = this.store.getRun(commandDerivedId("run", command.idempotencyKey));
        if (run) return this.settleRecoveredCommandReceipt(receipt, run as unknown as JsonValue);
      }
      if (command.type === "workflow.register") {
        const payload = command.payload as Record<string, JsonValue>;
        const workflowId = typeof payload.id === "string" ? payload.id : "";
        const registered = workflowId ? this.store.getWorkflow(workflowId) : null;
        if (registered) {
          const candidate = new WorkflowCompiler().compile(payload, registered.revision);
          if (candidate.hash === registered.hash) {
            if (this.loaded.config.workflows.triggersEnabled) this.triggers.register(candidate);
            return this.settleRecoveredCommandReceipt(receipt, registered as unknown as JsonValue);
          }
        }
      }
      if (command.type === "agent.present") {
        const payload = command.payload as Record<string, JsonValue>;
        const messageId = commandDerivedId("present", command.idempotencyKey);
        const message = this.store.getConversationMessage(messageId);
        if (message) {
          const agent = this.agents.get(String(payload.agentId));
          const threadId = agent.workflowId.startsWith("chat:") ? agent.workflowId.slice("chat:".length) : "";
          if (threadId && message.threadId === threadId) {
            return this.settleRecoveredCommandReceipt(receipt, { messageId, threadId });
          }
        }
      }
      if (command.type === "workflow.cancel") {
        const runId = String((command.payload as Record<string, JsonValue>).runId);
        const run = this.store.getRun(runId);
        if (run) {
          return this.settleRecoveredCommandReceipt(
            receipt,
            this.workflows.cancel(runId) as unknown as JsonValue,
          );
        }
      }
      if (command.type === "agent.cancel") {
        const agentId = String((command.payload as Record<string, JsonValue>).agentId);
        if (this.store.getAgent(agentId)) {
          await this.agents.cancel(agentId);
          return this.settleRecoveredCommandReceipt(receipt, { cancelled: true });
        }
      }
      if (command.type === "driver.update") {
        const driver = z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"])
          .parse((command.payload as Record<string, JsonValue>).driver);
        const operation = this.driverUpdateOperation(driver);
        if (operation === null) {
          throw new HttpError(
            425,
            `${driver} update has a durable command receipt without an operation record; Symphony will not launch it again automatically.`,
          );
        }
        if (operation?.idempotencyKey === command.idempotencyKey) {
          if (operation.state === "settled" && operation.result !== null) {
            return this.settleRecoveredCommandReceipt(receipt, operation.result);
          }
          if (operation.state === "failed") {
            const failed = CommandReceiptSchema.parse({
              ...receipt,
              accepted: false,
              state: "failed",
              result: { error: operation.error ?? `${driver} update failed.` },
              updatedAt: nowIso(),
            });
            this.store.durableTransaction(() => this.store.replaceCommandReceipt(failed));
            throw new HttpError(409, operation.error ?? `${driver} update failed.`);
          }
          if (operation.state === "preparing") {
            return this.settleRecoveredCommandReceipt(receipt, await this.executeDriverUpdate(command));
          }
          if (operation.targetVersion !== null && operation.targetVersion !== operation.baselineVersion) {
            const report = await this.harnessMaintenance.report(driver, true);
            if (report.version === operation.targetVersion) {
              const result = JsonValueSchema.parse({ report, output: "", recovered: true });
              const settledOperation = DriverUpdateOperationSchema.parse({
                ...operation,
                state: "settled",
                result,
                error: null,
                updatedAt: nowIso(),
              });
              const reconciled = CommandReceiptSchema.parse({
                ...receipt,
                accepted: true,
                state: "settled",
                result,
                updatedAt: nowIso(),
              });
              this.store.durableTransaction(() => {
                this.store.setMetadata(driverUpdateOperationKey(driver), settledOperation as unknown as JsonValue);
                this.store.replaceCommandReceipt(reconciled);
              });
              return reconciled;
            }
          }
        }
        throw new HttpError(
          425,
          `${driver} update is still dispatching or its external outcome is unknown; Symphony will not launch it again automatically.`,
        );
      }
      if (command.type === "driver.authenticate") {
        const driver = z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"])
          .parse((command.payload as Record<string, JsonValue>).driver);
        const operation = this.driverAuthenticationOperation(driver);
        if (operation === null) {
          throw new HttpError(
            425,
            `${driver} authentication has a durable command receipt without an operation record; Symphony will not launch it again automatically.`,
          );
        }
        if (operation.idempotencyKey === command.idempotencyKey) {
          if (operation.state === "settled" && operation.result !== null) {
            return this.settleRecoveredCommandReceipt(receipt, operation.result as unknown as JsonValue);
          }
          if (operation.state === "failed") {
            const failed = CommandReceiptSchema.parse({
              ...receipt,
              accepted: false,
              state: "failed",
              result: { error: operation.error ?? `${driver} authentication failed.` },
              updatedAt: nowIso(),
            });
            this.store.durableTransaction(() => this.store.replaceCommandReceipt(failed));
            throw new HttpError(409, operation.error ?? `${driver} authentication failed.`);
          }
          if (operation.state === "preparing") {
            return this.settleRecoveredCommandReceipt(receipt, await this.executeDriverAuthentication(command));
          }
          let report: Awaited<ReturnType<HarnessMaintenance["report"]>>;
          try {
            report = await this.harnessMaintenance.report(driver, true);
          } catch (error) {
            throw new DriverAuthenticationOutcomeUnknownError(
              `${driver} authentication is dispatching and its authoritative status could not be verified; Symphony will not launch it again automatically.`,
              { cause: error },
            );
          }
          if (report.authenticated === true) {
            const result = DriverAuthenticationResultSchema.parse({
              authenticated: true,
              detail: `Recovered ${driver} authentication from verified native harness status.`,
            });
            const timestamp = nowIso();
            const settledOperation = DriverAuthenticationOperationSchema.parse({
              ...operation,
              state: "settled",
              result,
              error: null,
              updatedAt: timestamp,
            });
            const reconciled = CommandReceiptSchema.parse({
              ...receipt,
              accepted: true,
              state: "settled",
              result: result as unknown as JsonValue,
              updatedAt: timestamp,
            });
            try {
              await this.router.refresh();
              this.store.durableTransaction(() => {
                this.store.setMetadata(
                  driverAuthenticationOperationKey(driver),
                  settledOperation as unknown as JsonValue,
                );
                this.store.replaceCommandReceipt(reconciled);
                this.store.appendEvent({
                  type: "driver.authenticated",
                  workflowId: null,
                  runId: null,
                  agentId: null,
                  occurredAt: timestamp,
                  payload: { driver, authenticated: true },
                  provenance: { source: "user" },
                });
              });
            } catch (error) {
              throw new DriverAuthenticationOutcomeUnknownError(
                `${driver} authentication was verified, but Symphony could not durably record its outcome.`,
                { cause: error },
              );
            }
            return reconciled;
          }
        }
        throw new HttpError(
          425,
          `${driver} authentication is still dispatching or its external outcome is unknown; Symphony will not launch it again automatically.`,
        );
      }
    }
    const status = receipt.state === "dispatching" ? "may already have been delivered" : "previously failed";
    throw new HttpError(
      409,
      `Command ${receipt.idempotencyKey} ${status}; Symphony will not replay it automatically. Inspect its durable receipt and use a new key only after reconciling the external outcome.`,
    );
  }

  private settleRecoveredCommandReceipt(receipt: CommandReceipt, result: JsonValue): CommandReceipt {
    const reconciled = CommandReceiptSchema.parse({
      ...receipt,
      accepted: true,
      state: "settled",
      result,
      updatedAt: nowIso(),
    });
    this.store.durableTransaction(() => this.store.replaceCommandReceipt(reconciled));
    return reconciled;
  }

  private driverUpdateOperation(driver: ResolvedHarness): DriverUpdateOperation | null {
    const value = this.store.getMetadata<JsonValue>(driverUpdateOperationKey(driver));
    return value === null ? null : DriverUpdateOperationSchema.parse(value);
  }

  private async executeDriverUpdate(command: Command): Promise<JsonValue> {
    const driver = z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"])
      .parse((command.payload as Record<string, JsonValue>).driver);
    const existing = this.driverUpdateOperation(driver);
    if (existing === null || existing.idempotencyKey !== command.idempotencyKey) {
      throw new HttpError(
        425,
        `${driver} update no longer owns its durable operation; Symphony will not launch it again automatically.`,
      );
    }
    if (existing.state === "settled" && existing.result !== null) return existing.result;
    if (existing.state === "failed") throw new HttpError(409, existing.error ?? `${driver} update failed.`);
    if (existing.state === "dispatching") {
      throw new HttpError(425, `${driver} update is already dispatching.`);
    }

    let reportBefore: Awaited<ReturnType<HarnessMaintenance["report"]>>;
    try {
      reportBefore = await this.harnessMaintenance.report(driver, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const resolution = this.store.durableTransaction(() => {
        const current = this.driverUpdateOperation(driver);
        if (current?.idempotencyKey !== command.idempotencyKey) return "ambiguous" as const;
        if (current.state === "settled" && current.result !== null) {
          return { state: "settled" as const, result: current.result };
        }
        if (current.state !== "preparing") return "ambiguous" as const;
        this.store.setMetadata(driverUpdateOperationKey(driver), DriverUpdateOperationSchema.parse({
          ...current,
          state: "failed",
          error: message,
          updatedAt: nowIso(),
        }) as unknown as JsonValue);
        return "failed" as const;
      });
      if (typeof resolution === "object") return resolution.result;
      if (resolution === "ambiguous") {
        throw new DriverUpdateOutcomeUnknownError(
          `${driver} update preparation lost durable ownership; Symphony will not launch it again automatically.`,
          { cause: error },
        );
      }
      throw error;
    }

    const ownership = this.store.durableTransaction(() => {
      const current = this.driverUpdateOperation(driver);
      if (current?.idempotencyKey !== command.idempotencyKey) return "ambiguous" as const;
      if (current.state === "settled" && current.result !== null) {
        return { state: "settled" as const, result: current.result };
      }
      if (current.state === "failed") return { state: "failed" as const, error: current.error };
      if (current.state !== "preparing") return "ambiguous" as const;
      this.store.setMetadata(driverUpdateOperationKey(driver), DriverUpdateOperationSchema.parse({
        ...current,
        state: "dispatching",
        baselineVersion: reportBefore.version,
        targetVersion: reportBefore.latestVersion,
        updatedAt: nowIso(),
      }) as unknown as JsonValue);
      return "owned" as const;
    });
    if (typeof ownership === "object") {
      if (ownership.state === "settled") return ownership.result;
      throw new HttpError(409, ownership.error ?? `${driver} update failed.`);
    }
    if (ownership !== "owned") {
      throw new HttpError(
        425,
        `${driver} update is already dispatching or lost durable ownership; Symphony will not launch it again automatically.`,
      );
    }

    let update: Awaited<ReturnType<HarnessMaintenance["update"]>>;
    try {
      update = await this.harnessMaintenance.update(driver);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.durableTransaction(() => {
        const current = this.driverUpdateOperation(driver);
        if (current?.idempotencyKey === command.idempotencyKey && current.state === "dispatching") {
          this.store.setMetadata(driverUpdateOperationKey(driver), DriverUpdateOperationSchema.parse({
            ...current,
            state: "failed",
            error: message,
            updatedAt: nowIso(),
          }) as unknown as JsonValue);
        }
        this.store.appendEvent({
          type: "driver.update.failed",
          workflowId: null,
          runId: null,
          agentId: null,
          occurredAt: nowIso(),
          payload: { driver, error: message },
          provenance: { source: "user" },
        });
      });
      throw error;
    }

    const result = JsonValueSchema.parse(update);
    try {
      this.store.durableTransaction(() => {
        const current = this.driverUpdateOperation(driver);
        if (current?.idempotencyKey !== command.idempotencyKey) {
          throw new Error(`${driver} update lost its durable operation ownership.`);
        }
        this.store.setMetadata(driverUpdateOperationKey(driver), DriverUpdateOperationSchema.parse({
          ...current,
          state: "settled",
          result,
          error: null,
          updatedAt: nowIso(),
        }) as unknown as JsonValue);
        this.store.appendEvent({
          type: "driver.updated",
          workflowId: null,
          runId: null,
          agentId: null,
          occurredAt: nowIso(),
          payload: { driver, version: update.report.version },
          provenance: { source: "user" },
        });
      });
    } catch (error) {
      throw new DriverUpdateOutcomeUnknownError(
        `${driver} updater exited, but Symphony could not durably record its outcome; the update will not be replayed automatically.`,
        { cause: error },
      );
    }
    return result;
  }

  private driverAuthenticationOperation(driver: ResolvedHarness): DriverAuthenticationOperation | null {
    const value = this.store.getMetadata<JsonValue>(driverAuthenticationOperationKey(driver));
    return value === null ? null : DriverAuthenticationOperationSchema.parse(value);
  }

  private async executeDriverAuthentication(command: Command): Promise<JsonValue> {
    const driver = z.enum(["codex", "claude", "cursor", "opencode", "pi", "acp"])
      .parse((command.payload as Record<string, JsonValue>).driver);
    const existing = this.driverAuthenticationOperation(driver);
    if (existing === null || existing.idempotencyKey !== command.idempotencyKey) {
      throw new HttpError(
        425,
        `${driver} authentication no longer owns its durable operation; Symphony will not launch it again automatically.`,
      );
    }
    if (existing.state === "settled" && existing.result !== null) {
      return existing.result as unknown as JsonValue;
    }
    if (existing.state === "failed") {
      throw new HttpError(409, existing.error ?? `${driver} authentication failed.`);
    }
    if (existing.state === "dispatching") {
      throw new HttpError(425, `${driver} authentication is already dispatching.`);
    }

    const nativeDriver = this.drivers.get(driver);
    if (!nativeDriver.authenticate) {
      const error = new Error(`${driver} does not expose an interactive authentication flow.`);
      this.failPreparingDriverAuthenticationOperation(driver, command.idempotencyKey, error);
      throw new HttpError(400, error.message);
    }

    let reportBefore: Awaited<ReturnType<HarnessMaintenance["report"]>>;
    try {
      reportBefore = await this.harnessMaintenance.report(driver, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const resolution = this.store.durableTransaction(() => {
        const current = this.driverAuthenticationOperation(driver);
        if (current?.idempotencyKey !== command.idempotencyKey) return "ambiguous" as const;
        if (current.state === "settled" && current.result !== null) {
          return { state: "settled" as const, result: current.result };
        }
        if (current.state !== "preparing") return "ambiguous" as const;
        const timestamp = nowIso();
        this.store.setMetadata(driverAuthenticationOperationKey(driver), DriverAuthenticationOperationSchema.parse({
          ...current,
          state: "failed",
          error: message,
          updatedAt: timestamp,
        }) as unknown as JsonValue);
        this.store.appendEvent({
          type: "driver.authentication.failed",
          workflowId: null,
          runId: null,
          agentId: null,
          occurredAt: timestamp,
          payload: { driver, error: message },
          provenance: { source: "user" },
        });
        return "failed" as const;
      });
      if (typeof resolution === "object") return resolution.result as unknown as JsonValue;
      if (resolution === "ambiguous") {
        throw new DriverAuthenticationOutcomeUnknownError(
          `${driver} authentication preparation lost durable ownership; Symphony will not launch it again automatically.`,
          { cause: error },
        );
      }
      throw error;
    }

    if (reportBefore.authenticated === true) {
      const result = DriverAuthenticationResultSchema.parse({
        authenticated: true,
        detail: reportBefore.detail,
      });
      return await this.settleDriverAuthenticationOperation(
        driver,
        command.idempotencyKey,
        "preparing",
        result,
      ) as unknown as JsonValue;
    }

    const ownership = this.store.durableTransaction(() => {
      const current = this.driverAuthenticationOperation(driver);
      if (current?.idempotencyKey !== command.idempotencyKey) return "ambiguous" as const;
      if (current.state === "settled" && current.result !== null) {
        return { state: "settled" as const, result: current.result };
      }
      if (current.state === "failed") return { state: "failed" as const, error: current.error };
      if (current.state !== "preparing") return "ambiguous" as const;
      this.store.setMetadata(driverAuthenticationOperationKey(driver), DriverAuthenticationOperationSchema.parse({
        ...current,
        state: "dispatching",
        baselineAuthenticated: reportBefore.authenticated,
        updatedAt: nowIso(),
      }) as unknown as JsonValue);
      return "owned" as const;
    });
    if (typeof ownership === "object") {
      if (ownership.state === "settled") return ownership.result as unknown as JsonValue;
      throw new HttpError(409, ownership.error ?? `${driver} authentication failed.`);
    }
    if (ownership !== "owned") {
      throw new HttpError(
        425,
        `${driver} authentication is already dispatching or lost durable ownership; Symphony will not launch it again automatically.`,
      );
    }

    let authentication: Awaited<ReturnType<NonNullable<typeof nativeDriver.authenticate>>>;
    try {
      authentication = await nativeDriver.authenticate();
    } catch (error) {
      this.recordDriverAuthenticationOutcomeUnknown(driver, command.idempotencyKey, error);
      throw new DriverAuthenticationOutcomeUnknownError(
        `${driver} authentication returned an error after launch; its external outcome is unknown and Symphony will not launch it again automatically.`,
        { cause: error },
      );
    }

    let result: z.infer<typeof DriverAuthenticationResultSchema>;
    try {
      result = DriverAuthenticationResultSchema.parse(authentication);
      await this.settleDriverAuthenticationOperation(
        driver,
        command.idempotencyKey,
        "dispatching",
        result,
      );
    } catch (error) {
      if (error instanceof DriverAuthenticationOutcomeUnknownError) throw error;
      throw new DriverAuthenticationOutcomeUnknownError(
        `${driver} authentication completed, but Symphony could not durably record its outcome; it will not be replayed automatically.`,
        { cause: error },
      );
    }
    return result as unknown as JsonValue;
  }

  private async settleDriverAuthenticationOperation(
    driver: ResolvedHarness,
    idempotencyKey: string,
    expectedState: "preparing" | "dispatching",
    result: z.infer<typeof DriverAuthenticationResultSchema>,
  ): Promise<z.infer<typeof DriverAuthenticationResultSchema>> {
    try {
      await this.router.refresh();
      const timestamp = nowIso();
      this.store.durableTransaction(() => {
        const current = this.driverAuthenticationOperation(driver);
        if (current?.idempotencyKey !== idempotencyKey || current.state !== expectedState) {
          throw new Error(`${driver} authentication lost its durable operation ownership.`);
        }
        this.store.setMetadata(driverAuthenticationOperationKey(driver), DriverAuthenticationOperationSchema.parse({
          ...current,
          state: "settled",
          result,
          error: null,
          updatedAt: timestamp,
        }) as unknown as JsonValue);
        this.store.appendEvent({
          type: "driver.authenticated",
          workflowId: null,
          runId: null,
          agentId: null,
          occurredAt: timestamp,
          payload: { driver, authenticated: result.authenticated },
          provenance: { source: "user" },
        });
      });
      return result;
    } catch (error) {
      throw new DriverAuthenticationOutcomeUnknownError(
        `${driver} authentication succeeded, but Symphony could not durably record its outcome; it will not be replayed automatically.`,
        { cause: error },
      );
    }
  }

  private failPreparingDriverAuthenticationOperation(driver: ResolvedHarness, idempotencyKey: string, error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return this.store.durableTransaction(() => {
      const current = this.driverAuthenticationOperation(driver);
      if (current?.idempotencyKey !== idempotencyKey || current.state !== "preparing") return false;
      const timestamp = nowIso();
      this.store.setMetadata(driverAuthenticationOperationKey(driver), DriverAuthenticationOperationSchema.parse({
        ...current,
        state: "failed",
        error: message,
        updatedAt: timestamp,
      }) as unknown as JsonValue);
      this.store.appendEvent({
        type: "driver.authentication.failed",
        workflowId: null,
        runId: null,
        agentId: null,
        occurredAt: timestamp,
        payload: { driver, error: message },
        provenance: { source: "user" },
      });
      return true;
    });
  }

  private recordDriverAuthenticationOutcomeUnknown(driver: ResolvedHarness, idempotencyKey: string, error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return this.store.durableTransaction(() => {
      const current = this.driverAuthenticationOperation(driver);
      if (current?.idempotencyKey !== idempotencyKey || current.state !== "dispatching") return false;
      const timestamp = nowIso();
      this.store.setMetadata(driverAuthenticationOperationKey(driver), DriverAuthenticationOperationSchema.parse({
        ...current,
        error: message,
        updatedAt: timestamp,
      }) as unknown as JsonValue);
      this.store.appendEvent({
        type: "driver.authentication.failed",
        workflowId: null,
        runId: null,
        agentId: null,
        occurredAt: timestamp,
        payload: { driver, error: message, outcome: "unknown" },
        provenance: { source: "user" },
      });
      return true;
    });
  }

  private bootstrap(): BootstrapProjection {
    const cursor = this.store.latestCursor();
    const agents: AgentRecord[] = [];
    let pageCursor: AgentListCursor | undefined;
    do {
      const page = this.store.listAgentPage({
        limit: 250,
        ...(pageCursor ? { cursor: pageCursor } : {}),
      });
      agents.push(...page.agents);
      pageCursor = page.nextCursor ?? undefined;
    } while (pageCursor);
    const runs = this.store.listRuns();
    const usage = this.store.listUsage();
    return {
      cursor,
      events: this.store.recentEvents({
        limit: 200,
        // Bootstrap is a directory/status projection, not a transcript or
        // trace payload. Active thread messages and complete run events have
        // dedicated endpoints and are loaded only for the selected chat.
        types: UI_EVENT_TYPES.filter((type) => type !== "chat.message.updated" && !type.startsWith("driver.tool.")),
        typePrefixes: UI_EVENT_PREFIXES,
      }),
      workflows: this.store.listWorkflows() as unknown as JsonValue[],
      runs: runs as unknown as JsonValue[], agents,
      messages: [], projects: this.projects.list(), costs: summarizeUsage(usage),
      runCosts: Object.fromEntries(runs.map((run) => [run.id, summarizeUsage(usage.filter((event) => event.runId === run.id))])),
      agentCosts: Object.fromEntries(agents.map((agent) => [agent.id, summarizeUsage(usage.filter((event) => event.agentId === agent.id))])),
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
      uiUtilities: {
        chatSearch: { ...this.loaded.config.uiUtilities.chatSearch },
      },
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
      uiUtilities: z.object({
        chatSearch: z.object({
          rerankEnabled: z.boolean(),
        }).partial(),
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
    if (patch.uiUtilities?.chatSearch?.rerankEnabled !== undefined) {
      this.loaded.config.uiUtilities.chatSearch.rerankEnabled = patch.uiUtilities.chatSearch.rerankEnabled;
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
    // Flush an initial frame even when the client is already at the latest cursor.
    // Without it, fetch() does not resolve until the 15s heartbeat and a healthy
    // projection incorrectly remains in its "connecting" state after reload.
    response.write(": connected\n\n");
    this.eventResponses.add(response);
    let replaying = true;
    const buffered: EventEnvelope[] = [];
    const unsubscribe = this.store.onEvent((event) => {
      if (uiProjection && !isUiProjectionEvent(event.type)) return;
      if (replaying) buffered.push(event);
      else writeEvent(response, event);
    });

    // Subscribe before taking the high-water mark so events cannot fall into
    // the query/listener gap. Page all projected rows through that immutable
    // cursor instead of silently dropping everything after the first 1,000.
    const highWaterCursor = this.store.latestCursor();
    let replayCursor = Number.isFinite(cursor) ? cursor : 0;
    while (replayCursor < highWaterCursor) {
      const page = this.store.eventsAfter(replayCursor, { ...eventOptions, limit: 1_000 })
        .filter((event) => event.cursor <= highWaterCursor);
      if (page.length === 0) break;
      for (const event of projectStoredBacklog(this.store, page)) writeEvent(response, event);
      replayCursor = page.at(-1)!.cursor;
      if (page.length < 1_000) break;
    }
    replaying = false;
    for (const event of buffered
      .filter((candidate) => candidate.cursor > replayCursor)
      .sort((left, right) => left.cursor - right.cursor)) writeEvent(response, event);
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
    const payload = JSON.stringify(value);
    if (response.headersSent || response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(payload);
  }

  private empty(response: ServerResponse, status: number): void {
    if (response.headersSent || response.writableEnded) return;
    response.writeHead(status);
    response.end();
  }
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<SymphonyDaemon> {
  const daemon = new SymphonyDaemon({ ...options, acquireLease: true });
  try {
    await daemon.start();
    return daemon;
  } catch (error) {
    await daemon.close().catch(() => undefined);
    throw error;
  }
}

async function withinDeadline(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<boolean>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type DaemonLeaseOwner = {
  ownerId: string;
  pid: number;
  startedAt: string;
  configPath: string;
};

type DaemonLease = DaemonLeaseOwner & { fd: number; path: string };

function acquireDaemonLease(dataDirectory: string, configPath: string): DaemonLease {
  mkdirSync(dataDirectory, { recursive: true });
  const path = join(dataDirectory, "daemon.lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const owner: DaemonLeaseOwner = {
        ownerId: ulid(),
        pid: process.pid,
        startedAt: nowIso(),
        configPath,
      };
      writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      return { ...owner, fd, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readDaemonLeaseOwner(path);
      if (owner && processIsAlive(owner.pid)) {
        throw new Error(
          `Symphony data directory is already owned by daemon PID ${owner.pid} (started ${owner.startedAt}).`,
        );
      }
      // A just-created lock whose owner record is not visible yet belongs to a
      // competing starter. Older invalid records are crash residue and can be
      // removed before retrying the atomic create.
      if (!owner && Date.now() - statSync(path).mtimeMs < 10_000) {
        throw new Error("Symphony data directory lease is currently being acquired by another daemon.");
      }
      unlinkSync(path);
    }
  }
  throw new Error("Could not acquire the Symphony data directory lease.");
}

function readDaemonLeaseOwner(path: string): DaemonLeaseOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonLeaseOwner>;
    if (
      typeof value.ownerId === "string"
      && typeof value.pid === "number"
      && Number.isInteger(value.pid)
      && value.pid > 0
      && typeof value.startedAt === "string"
      && typeof value.configPath === "string"
    ) return value as DaemonLeaseOwner;
  } catch {
    // Invalid old records are handled by the age check in acquireDaemonLease.
  }
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function releaseDaemonLease(lease: DaemonLease): void {
  try {
    closeSync(lease.fd);
  } finally {
    const current = readDaemonLeaseOwner(lease.path);
    if (current?.ownerId === lease.ownerId) {
      try {
        unlinkSync(lease.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

class DriverUpdateOutcomeUnknownError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(425, message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

class DriverAuthenticationOutcomeUnknownError extends HttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(425, message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
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

function projectStoredBacklog(store: SymphonyStore, events: EventEnvelope[]): EventEnvelope[] {
  const latestChatCursor = new Map<string, number>();
  for (const event of events) {
    const key = chatUpdateKey(event);
    if (key) latestChatCursor.set(key, event.cursor);
  }
  return events.flatMap((event) => {
    const key = chatUpdateKey(event);
    if (!key) return [event];
    if (latestChatCursor.get(key) !== event.cursor) return [];
    const payload = jsonRecord(event.payload);
    const embedded = jsonRecord(payload.message);
    if (typeof embedded.id === "string") return [event];
    const messageId = firstString(payload.messageId);
    const message = messageId ? store.getConversationMessage(messageId) : null;
    if (!message) return [];
    return [{ ...event, payload: { threadId: message.threadId, message } as unknown as JsonValue }];
  });
}

function chatUpdateKey(event: EventEnvelope): string | null {
  if (event.type !== "chat.message.updated") return null;
  const payload = jsonRecord(event.payload);
  const embedded = jsonRecord(payload.message);
  const messageId = firstString(payload.messageId, embedded.id);
  const threadId = firstString(payload.threadId, embedded.threadId);
  return messageId ? `${threadId ?? "unknown"}:${messageId}` : null;
}

function summarizeUsage(events: UsageEvent[]): JsonValue {
  const byBasis: Record<string, number> = {};
  let knownTotal = 0;
  let unknownEvents = 0;
  for (const event of events) {
    if (event.costAmount === null) {
      unknownEvents += 1;
      continue;
    }
    knownTotal += event.costAmount;
    byBasis[event.basis] = (byBasis[event.basis] ?? 0) + event.costAmount;
  }
  return { currency: "USD", knownTotal, unknownEvents, eventCount: events.length, byBasis };
}

function hashMission(statement: string, keyResults: string[]): string {
  return createHash("sha256").update(`${statement}\0${keyResults.join("\0")}`).digest("hex");
}

function projectIdForPath(workspacePath: string): string {
  return `project-${createHash("sha256").update(workspacePath).digest("hex").slice(0, 16)}`;
}

type ToolLifecycle = "started" | "updated" | "completed";

type TranscriptAgent = ReturnType<AgentCoordinator["get"]>;

function agentEventsThroughCursor(store: SymphonyStore, agentId: string, highWaterCursor: number): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  let cursor = 0;
  while (cursor < highWaterCursor) {
    const page = store.eventsAfter(cursor, { agentId, limit: 10_000 });
    const bounded = page.filter((event) => event.cursor <= highWaterCursor);
    if (bounded.length === 0) break;
    events.push(...bounded);
    const nextCursor = bounded.at(-1)?.cursor ?? cursor;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }
  return events;
}

function buildAgentTranscript(agent: TranscriptAgent, events: EventEnvelope[]) {
  const threadId = `agent:${agent.id}`;
  const messages = [ConversationMessageSchema.parse({
    id: `${threadId}:objective`,
    threadId,
    role: "user",
    parts: [{ type: "text", text: agent.objective }],
    createdAt: agent.createdAt,
  })];
  let turn = 0;
  let state: ChatStreamState | null = null;
  let lastEventAt = agent.createdAt;
  let settled = false;

  const currentState = (event: EventEnvelope) => {
    if (!state) {
      state = {
        messageId: `${threadId}:assistant:${turn}`,
        threadId,
        createdAt: event.occurredAt,
        parts: [],
      };
    }
    lastEventAt = event.occurredAt;
    return state;
  };
  const flush = (streaming = false) => {
    if (!state?.parts.length) {
      state = null;
      return;
    }
    messages.push(transcriptStreamMessage(state, streaming, lastEventAt));
    state = null;
    turn += 1;
  };

  for (const event of events) {
    if (
      settled
      && (
        event.type === "driver.message.delta"
        || event.type === "driver.reasoning.delta"
        || event.type === "driver.tool.started"
        || event.type === "driver.tool.updated"
        || event.type === "driver.tool.completed"
      )
    ) continue;
    if (event.type === "agent.message.sent") {
      flush(false);
      const content = jsonRecord(event.payload).content;
      if (typeof content === "string" && content.trim()) {
        messages.push(ConversationMessageSchema.parse({
          id: `${threadId}:user:${event.cursor}`,
          threadId,
          role: "user",
          parts: [{ type: "text", text: content }],
          createdAt: event.occurredAt,
        }));
      }
      continue;
    }
    if (event.type === "driver.message.delta" || event.type === "driver.reasoning.delta") {
      const payload = jsonRecord(event.payload);
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text) {
        applyStreamDelta(currentState(event), {
          kind: event.type === "driver.message.delta" ? "text" : "reasoning",
          text,
          replace: payload.replace === true,
          segmentId: streamSegmentId(payload),
        });
      }
      continue;
    }
    if (
      event.type === "driver.tool.started"
      || event.type === "driver.tool.updated"
      || event.type === "driver.tool.completed"
    ) {
      applyToolLifecycle(
        currentState(event),
        event,
        event.type.slice("driver.tool.".length) as ToolLifecycle,
      );
      continue;
    }
    if (event.type === "driver.output.completed") {
      const payload = jsonRecord(event.payload);
      const structured = jsonRecord(payload.structuredOutput);
      const text = firstString(payload.text, structured.response, structured.text)
        ?? (payload.structuredOutput !== undefined ? JSON.stringify(payload.structuredOutput) : null);
      const outputState = currentState(event);
      finalizeStreamParts(outputState, text);
      flush(false);
      continue;
    }
    if (event.type === "agent.failed" || event.type === "agent.interrupted") {
      const payload = jsonRecord(event.payload);
      const error = firstString(payload.error, payload.message) ?? agent.error ?? "The native agent failed.";
      // Preserve any partial native response as its own settled turn, then
      // project the authoritative failure exactly once instead of replacing or
      // duplicating the partial text.
      flush(false);
      const failureState = currentState(event);
      failureState.parts.push({ type: "text", text: error });
      flush(false);
      settled = true;
      continue;
    }
    if (event.type === "driver.run.completed" || event.type === "driver.run.cancelled") {
      flush(false);
      settled = true;
    }
  }

  const live = ["queued", "routing", "starting", "running", "cancel-requested"].includes(agent.status);
  flush(live);
  return messages;
}

function transcriptStreamMessage(state: ChatStreamState, streaming: boolean, updatedAt: string) {
  const parts = state.parts.map((part) => {
    const record = jsonRecord(part);
    if (record.type !== "reasoning") return part;
    return { ...record, status: { type: streaming ? "running" : "complete" } } as JsonValue;
  });
  return ConversationMessageSchema.parse({
    id: state.messageId,
    threadId: state.threadId,
    role: "assistant",
    parts,
    streaming,
    createdAt: state.createdAt,
    updatedAt,
  });
}

function streamSegmentId(payload: Record<string, JsonValue>): string | undefined {
  const direct = firstString(payload.messageId, payload.partId, payload.blockId, payload.id);
  if (direct) return direct;
  const index = payload.index;
  return typeof index === "string" || typeof index === "number" ? `index:${index}` : undefined;
}

function structuredStreamParts(parts: JsonValue[]): JsonValue[] {
  return parts.flatMap((part) => {
    const record = jsonRecord(part);
    return record.type === "text" || record.type === "reasoning" || record.type === "tool-call" || record.type === "data"
      ? [{ ...record } as JsonValue]
      : [];
  });
}

function cloneChatStream(state: ChatStreamState): ChatStreamState {
  return { ...state, parts: [...state.parts] };
}

function projectedOutputText(payloadValue: JsonValue, outputValue: JsonValue): string {
  const payload = jsonRecord(payloadValue);
  const output = jsonRecord(outputValue);
  const structured = jsonRecord(payload.structuredOutput);
  return firstString(payload.text, output.response, output.text, structured.response, structured.text)
    ?? (payload.structuredOutput !== undefined ? JSON.stringify(payload.structuredOutput) : JSON.stringify(payloadValue));
}

function collapseRepeatedPartSequence(parts: JsonValue[]): JsonValue[] {
  if (parts.length < 2) return parts;
  const comparable = parts.map(comparableStreamPart);
  for (let period = 1; period <= Math.floor(parts.length / 2); period += 1) {
    if (parts.length % period !== 0) continue;
    const repeated = comparable.every((part, index) => part === comparable[index % period]);
    if (repeated) return parts.slice(0, period);
  }
  return parts;
}

function comparableStreamPart(part: JsonValue): string {
  const record = jsonRecord(part);
  if (record.type !== "text" && record.type !== "reasoning") return JSON.stringify(part);
  const { status: _status, nativeMessageId: _nativeMessageId, ...content } = record;
  return JSON.stringify(content);
}

function applyStreamDelta(
  state: ChatStreamState,
  delta: { kind: "text" | "reasoning"; text: string; replace: boolean; segmentId?: string | undefined },
): void {
  let index = -1;
  if (delta.replace) {
    index = findStreamPart(state.parts, delta.kind, delta.segmentId);
  } else {
    const lastIndex = state.parts.length - 1;
    const last = jsonRecord(state.parts[lastIndex]);
    const lastSegmentId = typeof last.nativeMessageId === "string" ? last.nativeMessageId : undefined;
    const sameSegment = delta.segmentId === undefined && lastSegmentId === undefined
      ? true
      : delta.segmentId === lastSegmentId;
    if (last.type === delta.kind && sameSegment) index = lastIndex;
  }

  if (index === -1) {
    state.parts.push({
      type: delta.kind,
      text: delta.text,
      ...(delta.segmentId ? { nativeMessageId: delta.segmentId } : {}),
      ...(delta.kind === "reasoning" ? { status: { type: "running" } } : {}),
    });
    return;
  }

  const current = jsonRecord(state.parts[index]);
  const currentText = typeof current.text === "string" ? current.text : "";
  state.parts[index] = {
    ...current,
    text: delta.replace ? delta.text : currentText + delta.text,
    ...(delta.segmentId ? { nativeMessageId: delta.segmentId } : {}),
  } as JsonValue;
}

function findStreamPart(parts: JsonValue[], kind: "text" | "reasoning", segmentId?: string): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const record = jsonRecord(parts[index]);
    if (record.type !== kind) continue;
    const candidate = typeof record.nativeMessageId === "string" ? record.nativeMessageId : undefined;
    if (segmentId === undefined || candidate === segmentId) return index;
  }
  return -1;
}

function applyToolLifecycle(state: ChatStreamState, event: EventEnvelope, lifecycle: ToolLifecycle): void {
  const payload = jsonRecord(event.payload);
  const records = nestedToolRecords(payload);
  const projectedToolName = toolString(records, ["toolName", "tool_name", "name", "tool"])
    ?? inferredToolName(records);
  const suppliedId = toolString(records, ["toolCallId", "tool_call_id", "tool_use_id", "callId", "callID", "call_id", "itemId", "id"]);
  let partIndex = suppliedId
    ? state.parts.findIndex((part) => jsonRecord(part).type === "tool-call" && jsonRecord(part).toolCallId === suppliedId)
    : -1;
  if (partIndex === -1 && projectedToolName) {
    partIndex = findRunningToolPart(state.parts, projectedToolName);
  }

  const previous = partIndex >= 0 ? jsonRecord(state.parts[partIndex]) : {};
  const toolName = projectedToolName
    ?? (typeof previous.toolName === "string" ? previous.toolName : null)
    ?? "native_tool";
  const toolCallId = suppliedId
    ?? firstString(previous.toolCallId)
    ?? event.provenance?.nativeEventId
    ?? `tool:${event.id}`;
  const args = toolArgs(records) ?? jsonRecord(previous.args);
  const terminal = lifecycle === "completed" || toolStatus(records) === "completed" || toolStatus(records) === "failed";
  const result = terminal ? toolResult(records) : undefined;
  const isError = terminal && toolFailed(records);
  const part: Record<string, JsonValue> = {
    ...previous,
    type: "tool-call",
    toolCallId,
    toolName,
    args,
    ...(terminal ? { result: result ?? null } : {}),
    ...(isError ? { isError: true } : {}),
  };

  if (partIndex >= 0) state.parts[partIndex] = part;
  else state.parts.push(part);
}

function nestedToolRecords(payload: Record<string, JsonValue>): Record<string, JsonValue>[] {
  const records = [payload];
  for (const key of ["item", "part", "state", "content", "update", "data"]) {
    const nested = jsonRecord(payload[key]);
    if (Object.keys(nested).length) records.push(nested);
  }
  return records;
}

function toolString(records: Record<string, JsonValue>[], keys: string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

function inferredToolName(records: Record<string, JsonValue>[]): string | null {
  const type = toolString(records, ["type", "itemType", "kind"]);
  if (type && !["tool", "tool_use", "tool_result"].includes(type)) return type;
  const method = toolString(records, ["method"]);
  if (!method) return null;
  if (/command/iu.test(method)) return "command_execution";
  if (/file|patch|edit/iu.test(method)) return "file_change";
  return null;
}

function toolArgs(records: Record<string, JsonValue>[]): Record<string, JsonValue> | null {
  const value = toolValue(records, ["args", "arguments", "input", "rawInput", "parameters"]);
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, JsonValue>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as JsonValue;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, JsonValue>;
    } catch {
      // Preserve non-JSON native arguments without inventing a schema.
    }
  }
  return { input: value };
}

function toolResult(records: Record<string, JsonValue>[]): JsonValue | undefined {
  const direct = toolValue(records, ["result", "output", "rawOutput", "tool_use_result", "contentItems"]);
  if (direct !== undefined) return direct;
  const error = toolValue(records, ["error"]);
  if (error !== undefined && error !== null) return { error };
  const detail = toolValue(records, ["detail", "message", "exitCode"]);
  return detail === undefined ? undefined : { detail };
}

function toolValue(records: Record<string, JsonValue>[], keys: string[]): JsonValue | undefined {
  for (const record of records) {
    for (const key of keys) {
      if (record[key] !== undefined) return record[key];
    }
  }
  return undefined;
}

function toolStatus(records: Record<string, JsonValue>[]): "running" | "completed" | "failed" | null {
  const status = toolString(records, ["status", "state"] )?.toLowerCase();
  if (!status) return null;
  if (["completed", "complete", "success", "succeeded", "finished", "done"].includes(status)) return "completed";
  if (["failed", "error", "declined", "cancelled", "canceled"].includes(status)) return "failed";
  return "running";
}

function toolFailed(records: Record<string, JsonValue>[]): boolean {
  if (toolStatus(records) === "failed") return true;
  return records.some((record) => record.isError === true || record.is_error === true || record.success === false || record.error != null);
}

function findRunningToolPart(parts: JsonValue[], toolName: string): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const record = jsonRecord(parts[index]);
    if (record.type === "tool-call" && record.toolName === toolName && record.result === undefined) return index;
  }
  return -1;
}

function finalizeStreamParts(state: ChatStreamState, finalText: string | null): void {
  if (finalText) {
    const textParts = state.parts
      .map((part, index) => ({ index, record: jsonRecord(part) }))
      .filter(({ record }) => record.type === "text" && typeof record.text === "string");
    const compact = textParts.map(({ record }) => record.text as string).join("");
    const separated = textParts.map(({ record }) => record.text as string).join("\n\n");
    const alreadyPresent = textParts.some(({ record }) => record.text === finalText)
      || finalText === compact
      || finalText === separated;
    if (!alreadyPresent) {
      const hasTools = state.parts.some((part) => jsonRecord(part).type === "tool-call");
      if (!hasTools && textParts.length === 1) {
        const only = textParts[0];
        if (only) state.parts[only.index] = { ...only.record, text: finalText } as JsonValue;
      } else {
        state.parts.push({ type: "text", text: finalText });
      }
    }
  }
  appendFileChangeSummary(state);
}

function appendFileChangeSummary(state: ChatStreamState): void {
  if (state.parts.some((part) => jsonRecord(part).type === "data" && jsonRecord(part).name === "file-changes")) return;
  const files = new Map<string, { path: string; additions: number; deletions: number; kind: string }>();
  for (const part of state.parts) {
    const tool = jsonRecord(part);
    if (tool.type !== "tool-call" || typeof tool.toolName !== "string" || !/edit|write|patch|file[_ -]?change|notebook/iu.test(tool.toolName)) continue;
    const args = jsonRecord(tool.args);
    const result = jsonRecord(tool.result);
    const candidates = [args, result, ...[args.changes, result.changes].flatMap((value) => Array.isArray(value) ? value.map((item) => jsonRecord(item)) : [])];
    for (const candidate of candidates) {
      const path = firstString(candidate.path, candidate.file_path, candidate.filePath, candidate.filename);
      if (!path) continue;
      const patch = firstString(candidate.patch, candidate.diff, candidate.new_string, candidate.content) ?? "";
      const additions = numberValue(candidate.additions) ?? patchLineCount(patch, "+");
      const deletions = numberValue(candidate.deletions) ?? patchLineCount(patch, "-");
      const previous = files.get(path);
      files.set(path, {
        path,
        additions: Math.max(previous?.additions ?? 0, additions),
        deletions: Math.max(previous?.deletions ?? 0, deletions),
        kind: firstString(candidate.kind, candidate.type) ?? previous?.kind ?? "modified",
      });
    }
  }
  if (!files.size) return;
  const entries = [...files.values()];
  state.parts.push({
    type: "data",
    name: "file-changes",
    data: {
      files: entries,
      additions: entries.reduce((sum, file) => sum + file.additions, 0),
      deletions: entries.reduce((sum, file) => sum + file.deletions, 0),
    },
  });
}

function numberValue(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function patchLineCount(value: string, prefix: "+" | "-"): number {
  return value.split(/\r?\n/u).filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function firstString(...values: Array<JsonValue | undefined>): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

function sessionLogEntries(events: EventEnvelope[]) {
  const toolNames = new Map<string, string>();
  return events.map((event) => {
    const payload = jsonRecord(event.payload);
    const callId = firstString(payload.toolCallId, payload.id);
    const suppliedName = firstString(payload.toolName, payload.name, payload.tool);
    if (callId && suppliedName) toolNames.set(callId, suppliedName);
    return sessionLogEntry(event, callId ? toolNames.get(callId) : undefined);
  });
}

function sessionLogEntry(event: EventEnvelope, rememberedTool?: string) {
  const payload = jsonRecord(event.payload);
  const level = sessionLogLevel(event, payload);
  const tool = firstString(payload.toolName, payload.name, payload.tool) ?? rememberedTool ?? null;
  const direct = firstString(payload.error, payload.message, payload.summary, payload.line, payload.text);
  const lifecycle = event.type.startsWith("driver.tool.")
    ? `${event.type.endsWith("started") ? "Started" : event.type.endsWith("completed") ? "Completed" : "Updated"} ${tool ?? "native tool"}`
    : null;
  const message = clipLogMessage(direct ?? lifecycle ?? event.type.replaceAll(".", " "));
  return {
    cursor: event.cursor,
    at: event.occurredAt,
    level,
    source: event.provenance?.driver ?? event.provenance?.source ?? "daemon",
    type: event.type,
    message,
    data: event.payload,
  };
}

function sessionLogLevel(event: EventEnvelope, payload: Record<string, JsonValue>): "debug" | "info" | "warn" | "error" {
  const embeddedLevel = nativeStructuredLogLevel(payload);
  const suppliedLevel = typeof payload.level === "string" ? payload.level.toLocaleLowerCase() : null;
  const reportedLevel = embeddedLevel ?? suppliedLevel;
  if (/fail|error|lost/iu.test(event.type) || reportedLevel === "error" || reportedLevel === "fatal") return "error";
  if (
    /cancel|interrupt|stale|blocked/iu.test(event.type)
    || reportedLevel === "warn"
    || reportedLevel === "warning"
    // Native CLIs routinely put warnings and progress diagnostics on stderr.
    // Preserve that evidence without presenting every stderr line as a fatal
    // session failure when the harness itself did not classify it as one.
    || payload.stream === "stderr"
  ) return "warn";
  if (/delta|updated|usage/iu.test(event.type) || reportedLevel === "debug" || reportedLevel === "trace") return "debug";
  return "info";
}

function nativeStructuredLogLevel(payload: Record<string, JsonValue>): string | null {
  const line = firstString(payload.line, payload.message);
  if (!line?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const level = (parsed as Record<string, unknown>).level;
    return typeof level === "string" ? level.toLocaleLowerCase() : null;
  } catch {
    return null;
  }
}

function clipLogMessage(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 497)}…` : normalized;
}

function isDefaultChatTitle(title: string): boolean {
  return ["New chat", "New Symphony chat"].includes(title.trim());
}

function titleFromMessage(content: string): string {
  const singleLine = content.replace(/\s+/gu, " ").trim();
  return singleLine.length <= 64 ? singleLine : `${singleLine.slice(0, 61).trimEnd()}…`;
}

function fuzzyChatScore(query: string, document: string): number {
  const needle = query.toLocaleLowerCase();
  const haystack = document.toLocaleLowerCase();
  if (haystack.includes(needle)) return 10_000 - haystack.indexOf(needle);
  const tokens = needle.split(/\s+/u).filter(Boolean);
  let score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 100 + token.length : 0), 0);
  let cursor = 0;
  let subsequenceScore = 0;
  for (const character of needle) {
    const index = haystack.indexOf(character, cursor);
    if (index < 0) {
      subsequenceScore = 0;
      break;
    }
    subsequenceScore += Math.max(1, 20 - (index - cursor));
    cursor = index + 1;
  }
  score += subsequenceScore;
  return score;
}

function chatSearchSnippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return "No message text yet";
  const index = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index < 0 ? 0 : index - 70);
  const snippet = normalized.slice(start, start + 180).trim();
  return `${start > 0 ? "…" : ""}${snippet}${start + snippet.length < normalized.length ? "…" : ""}`;
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

function chatTurnReceiptKey(messageId: string): string {
  return `chat-turn:${messageId}`;
}

function chatTurnLogicalAgentId(messageId: string): string {
  return `chat-turn:${messageId}`;
}

function chatTurnRequestHash(input: ChatMessageInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ content: input.content, attachments: input.attachments }))
    .digest("hex");
}

function chatThreadCreateRequestHash(input: {
  title: string;
  groupId: string | null;
  mission: { statement: string; keyResults: string[] };
  workspacePath: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function chatInputFromStoredMessage(message: ConversationMessage): ChatMessageInput {
  const content = message.parts.flatMap((part) => {
    const record = jsonRecord(part);
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("\n\n");
  const attachments = message.parts.flatMap((part) => {
    const record = jsonRecord(part);
    if (record.type !== "attachment" || !Array.isArray(record.content)) return [];
    const id = firstString(record.id);
    const name = firstString(record.name);
    const type = firstString(record.attachmentType);
    if (!id || !name || !type) return [];
    const contentType = firstString(record.contentType);
    return [{
      id,
      name,
      type,
      ...(contentType ? { contentType } : {}),
      content: record.content,
    }];
  });
  return ChatMessageInputSchema.parse({ messageId: message.id, content, attachments });
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

function commandFingerprint(command: Command): string {
  return createHash("sha256").update(stableJson({
    type: command.type,
    actor: command.actor,
    payload: command.payload,
  })).digest("hex");
}

function driverUpdateOperationKey(driver: ResolvedHarness): string {
  return `driver-update-operation:${driver}`;
}

function driverAuthenticationOperationKey(driver: ResolvedHarness): string {
  return `driver-authentication-operation:${driver}`;
}

function commandDerivedId(kind: "agent" | "run" | "present", idempotencyKey: string): string {
  return `command-${kind}-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 26)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
