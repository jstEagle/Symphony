import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
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
  AgentWorkOrderSchema,
  DriverAuthenticationResultSchema,
  isTerminalAgentStatus,
  JsonValueSchema,
  ObjectiveSideEffectClassSchema,
  ObjectivePolicyRequestSchema,
  ObjectiveSpecSchema,
  ObjectiveTaskSchema,
  AgentMessageArtifactRefSchema,
  AgentMessageEvidenceRefSchema,
  ObjectiveRunStateSchema,
  ObjectiveRunRecordSchema,
  ObjectiveControlMutationRequestSchema,
  ObjectiveControlMutationSchema,
  ObjectiveControlPlanSchema,
  previewObjectiveControlMutation,
  ObjectiveControlSignalDeliveryInputSchema,
  ObjectiveArtifactPublishInputSchema,
  ObjectiveArtifactReviewInputSchema,
  ObjectiveArtifactReviewRecordSchema,
  ObjectiveArtifactRecordSchema,
  ObjectiveAttentionRecordSchema,
  ObjectiveAttentionRequestSchema,
  ObjectiveAttentionResolveRequestSchema,
  ObjectiveAttentionListQuerySchema,
  ObjectiveAggregateSnapshotSchema,
  CapabilityResultFeedbackRecordSchema,
  ObjectiveRunOccurrenceInputSchema,
  ObjectiveAggregateRecordSchema,
  ObjectiveRevisionRecordSchema,
  ObjectiveRunOccurrenceRecordSchema,
  ObjectiveCheckpointResumeCommandSchema,
  ObjectiveCheckpointRetryCommandSchema,
  ObjectiveCheckpointForkCommandSchema,
  ObjectivePortableCheckpointRecordSchema,
  ObjectiveHandoffEnvelopeSchema,
  ObjectiveHandoffCreateInputSchema,
  ObjectiveHandoffAcceptanceInputSchema,
  ObjectiveHandoffAcceptanceRecordSchema,
  objectiveHandoffHash,
  objectiveHandoffAcceptanceHash,
  objectiveHandoffReferenceHash,
  validateObjectiveHandoffTarget,
  isObjectivePolicyHashValid,
  stableJsonStringify,
  objectiveArtifactContentHash,
  objectiveArtifactContentSize,
  OBJECTIVE_ARTIFACT_MAX_INLINE_BYTES,
  projectWorkerEventPayload,
  nowIso,
  type BootstrapProjection,
  type AgentRecord,
  type AgentMessageDecision,
  type AgentMessageInput,
  type AgentMessageReceiptInput,
  type AgentMessageRecord,
  type Command,
  type CommandReceipt,
  type ConversationMessage,
  type EventEnvelope,
  type JsonValue,
  type ObjectiveActor,
  type ObjectiveApprovalRecord,
  type ObjectiveControlMutation,
  type ObjectiveControlNode,
  type ObjectiveControlSignalDeliveryInput,
  type ObjectiveControlPlan,
  type ObjectivePolicyRequest,
  type ObjectiveRunRecord,
  type ObjectiveAggregateRecord,
  type ObjectiveRevisionRecord,
  type ObjectiveRunOccurrenceRecord,
  type ObjectiveRunOccurrenceInput,
  type ObjectiveCheckpointResumeCommand,
  type ObjectiveCheckpointRetryCommand,
  type ObjectiveCheckpointForkCommand,
  type ObjectiveCheckpointRecord,
  type ObjectiveHandoffEnvelope,
  type ObjectiveHandoffAcceptanceRecord,
  type ObjectiveHandoffCreateInput,
  type ObjectiveHandoffAcceptanceInput,
  type ObjectiveOccurrenceOutcomeState,
  type ObjectiveTask,
  type ObjectiveArtifactActor,
  type ObjectiveArtifactRecord,
  type ObjectiveAttentionRecord,
  type ObjectiveAttentionRequest,
  type ObjectiveAttentionResolveRequest,
  type ProjectRecord,
  type ResolvedHarness,
  type UsageEvent,
  type WorkflowMission,
  type WorkspaceSpec,
  WorkspaceSpecSchema,
} from "@symphony/protocol";
import {
  AgentCoordinator,
  ModelRouter,
  PassiveObserver,
  UiUtilityService,
  buildSessionDiagnosticBundle,
  classifySessionDiagnosticRuntime,
  sessionDiagnosticJson,
} from "@symphony/runtime";
import {
  AgentMessageStore,
  createStore,
  ObjectiveAttentionRegistry,
  type AgentListCursor,
  type ChatThreadRecord,
  type SymphonyStore,
  type WorkflowRunOrigin,
} from "@symphony/storage";
import {
  ObjectiveRuntime,
  ObjectiveRuntimeError,
  ObjectiveStoreRepository,
  ObjectiveSupervisionRunner,
  ObjectiveApprovalExpiryProcessor,
  projectObjectiveAggregateSnapshot,
  TriggerManager,
  WorkflowCompiler,
  WorkflowEngine,
  WorkflowLoader,
  childWorkspaceGrant as containedChildWorkspaceGrant,
  canonicalWorkspacePath as containedCanonicalWorkspacePath,
  compileObjectiveControlPlan,
  WorkspaceContainmentError,
  objectiveHandoffExecutionPlan,
  loadWorkflowDirectory,
  type ObjectiveApprovalRequestInput,
  type ObjectiveCheckpointInput,
  type ObjectiveCreateInput,
  type ObjectivePlanCommitInput,
  type ObjectiveRuntimeAuthority,
  type WorkflowIr,
} from "@symphony/workflow";
import { HarnessMaintenance } from "./harness-maintenance.js";
import { resolveDaemonCredential, type DaemonCredential } from "./daemon-credential.js";
import { AgentMessageApiAdapter, AgentMessageApiAuthorizationError } from "./agent-message-api.js";
import { CapabilityApiAdapter } from "./capability-api.js";
import { CapabilityResultFeedbackApiAdapter } from "./capability-result-feedback-api.js";

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

/**
 * The daemon-side command callback is deliberately narrower than the wire
 * response. Storage owns the immutable command outcome; operation-specific
 * status fields remain inside `result` for API compatibility.
 */
type ObjectiveCommandExecution =
  | { status: "committed"; result: JsonValue }
  | { status: "rejected"; result: JsonValue; reason: string };

/**
 * Objective mutation bodies intentionally omit requestKey and actor fields.
 * The daemon binds both to the authenticated request so an agent cannot
 * smuggle a different delivery identity or authority envelope through JSON.
 */
const ObjectiveCreateInputSchema = z.object({
  runId: z.string().min(1).optional(),
  objectiveId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  workflowRevision: z.number().int().positive(),
  workflowHash: z.string().min(8),
  conductorAgentId: z.string().min(1).nullable().optional(),
  // Local users can explicitly pin the objective to a project workspace.
  // Authenticated agents cannot use this field to widen their inherited grant.
  workspace: WorkspaceSpecSchema.optional(),
  policy: ObjectivePolicyRequestSchema.optional(),
  spec: ObjectiveSpecSchema,
  tasks: z.array(ObjectiveTaskSchema).max(128).optional(),
  context: z.record(z.string(), JsonValueSchema).optional(),
  controlPlan: ObjectiveControlPlanSchema.nullable().optional(),
  /** Optional causal occurrence metadata; the daemon owns all identities. */
  occurrence: ObjectiveRunOccurrenceInputSchema.optional(),
}).strict();

const ObjectivePlanInputSchema = z.object({
  expectedPlanRevision: z.number().int().nonnegative(),
  tasks: z.array(ObjectiveTaskSchema).min(1).max(128),
  reason: z.string().min(1).max(2_000).optional(),
  policyHash: z.string().min(8).max(256).optional(),
}).strict();

const ObjectiveTaskUpdateInputSchema = z.object({
  taskId: z.string().min(1),
  state: z.enum(["queued", "waiting-approval", "running", "completed", "failed"]),
  attemptId: z.string().min(1).nullable().optional(),
  agentId: z.string().min(1).nullable().optional(),
  output: JsonValueSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
}).strict();

const ObjectiveCheckpointInputSchema = z.object({
  eventCursor: z.number().int().nonnegative(),
  policyHash: z.string().min(8).max(256).optional(),
  context: z.record(z.string(), JsonValueSchema).optional(),
  taskUpdates: z.array(ObjectiveTaskUpdateInputSchema).max(128).optional(),
  reason: z.string().min(1).max(2_000),
}).strict();

const ObjectiveApprovalInputSchema = z.object({
  kind: z.enum(["plan", "task", "completion"]),
  taskId: z.string().min(1).nullable().optional(),
  question: z.string().min(1).max(2_000),
  scope: z.record(z.string(), JsonValueSchema).optional(),
  operationId: z.string().min(1),
  requestHash: z.string().min(8).max(256),
  policyHash: z.string().min(8).max(256),
  sideEffectClass: ObjectiveSideEffectClassSchema,
  canonicalTarget: z.string().min(1).max(2_000),
  capability: z.string().min(1).optional(),
  expiresAt: z.string().nullable().optional(),
}).strict();

const ObjectiveApprovalResolutionInputSchema = z.object({
  status: z.enum(["approved", "rejected", "expired", "cancelled"]),
  decision: JsonValueSchema.nullable().optional(),
}).strict();

const ObjectiveAttentionInputSchema = ObjectiveAttentionRequestSchema;
const ObjectiveAttentionResolutionInputSchema = ObjectiveAttentionResolveRequestSchema;

const ObjectiveArtifactPublishRequestSchema = ObjectiveArtifactPublishInputSchema;
const ObjectiveArtifactReviewRequestSchema = ObjectiveArtifactReviewInputSchema;

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

const WorkflowTriggerPolicySchema = z.object({
  version: z.literal(1),
  workflowId: z.string().min(1),
  revision: z.number().int().positive(),
  hash: z.string().min(8),
  mode: z.enum(["active", "pending"]),
  source: z.enum(["user", "agent"]),
  updatedAt: z.string().min(1),
});

type WorkflowTriggerPolicy = z.infer<typeof WorkflowTriggerPolicySchema>;

const workflowTriggerPolicyKey = (workflowId: string): string => `workflow-trigger-policy:${workflowId}`;

/**
 * A standalone objective is not allowed to invent an arbitrary workflow
 * identity. The browser uses this exact deterministic identity when the user
 * deliberately selects "Standalone objective"; keep the rule at the daemon
 * boundary as the source of truth for non-browser callers too.
 */
function standaloneObjectiveWorkflowIdentity(objectiveId: string): {
  workflowId: string;
  workflowRevision: 1;
  workflowHash: string;
} {
  const slug = objectiveId
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80) || "objective";
  return {
    workflowId: `manual-${slug}`,
    workflowRevision: 1,
    workflowHash: `manual-workflow-${slug}`,
  };
}

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
const UI_EVENT_PREFIXES = ["workflow.", "plugin.", "objective."] as const;
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
    const thread = this.projectionThreadForEvent(event);
    if (!thread) return;
    const agent = this.store.getAgent(event.agentId as string);
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

  /**
   * Resolve a native source event to its chat before the conductor pointer is
   * persisted. Agent creation starts the native run and its first events can
   * arrive before settleCreatedTurn() links the agent on the chat row. The
   * chat workflow/run identity is durable on every event, so use it as the
   * recovery path while retaining the conductor pointer as the fast path.
   *
   * Only root conductor agents may use this fallback. Child agents share the
   * chat workflow/run IDs for graph visibility, but their native output must
   * not be projected as another assistant turn in the conductor conversation.
   */
  private projectionThreadForEvent(event: EventEnvelope): ChatThreadRecord | null {
    if (!event.agentId) return null;
    const linked = this.store.listThreads({ includeArchived: true }).find((item) => item.conductorAgentId === event.agentId);
    if (linked) return linked;

    const workflowThreadId = event.workflowId?.startsWith("chat:")
      ? event.workflowId.slice("chat:".length)
      : null;
    const runThreadId = event.runId?.startsWith("chat-run:")
      ? event.runId.slice("chat-run:".length)
      : null;
    if (workflowThreadId && runThreadId && workflowThreadId !== runThreadId) return null;
    const threadId = workflowThreadId ?? runThreadId;
    if (!threadId) return null;
    const thread = this.store.getThread(threadId);
    const agent = this.store.getAgent(event.agentId);
    if (!thread || !agent || agent.parentAgentId !== null) return null;
    if (agent.workflowId !== `chat:${thread.id}` || agent.runId !== `chat-run:${thread.id}`) return null;

    // An unlinked root is the normal create-conductor race. If this thread is
    // already linked to another conductor (for example during a harness
    // switch), require the per-turn work order to identify this root too.
    if (!thread.conductorAgentId) return thread;
    const workOrder = jsonRecord(this.store.getMetadata<JsonValue>(`work-order:${agent.id}`));
    const metadata = jsonRecord(workOrder.metadata);
    return firstString(metadata.threadId) === thread.id ? thread : null;
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
  readonly objectiveRepository: ObjectiveStoreRepository;
  readonly objectiveRuntime: ObjectiveRuntime;
  /** Durable cross-objective decision inbox; UI and MCP only project it. */
  readonly objectiveAttention: ObjectiveAttentionRegistry;
  readonly objectiveSupervisor: ObjectiveSupervisionRunner;
  readonly objectiveApprovalExpiry: ObjectiveApprovalExpiryProcessor;
  readonly workflows: WorkflowEngine;
  readonly triggers: TriggerManager;
  readonly plugins: PluginHost;
  readonly projects: ProjectService;
  readonly chats: ChatService;
  readonly harnessMaintenance: HarnessMaintenance;
  /** Daemon-owned typed capability registry and inter-agent message bus. */
  readonly capabilities: CapabilityApiAdapter;
  /** Daemon-owned immutable capability-result feedback authority. */
  readonly capabilityResultFeedback: CapabilityResultFeedbackApiAdapter;
  /** Short alias for daemon/SDK callers that use the feedback vocabulary. */
  readonly feedback: CapabilityResultFeedbackApiAdapter;
  readonly agentMessages: AgentMessageApiAdapter;
  readonly startedAt = nowIso();
  private server: Server | null = null;
  private ready = false;
  private controlPlaneReady = false;
  private catalogTimer: NodeJS.Timeout | null = null;
  private approvalExpiryTimer: NodeJS.Timeout | null = null;
  private approvalExpiryUnsubscribe: (() => void) | null = null;
  private approvalExpiryInFlight: Promise<void> | null = null;
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
    let openedAgentMessages: AgentMessageStore | null = null;
    let openedCapabilities: CapabilityApiAdapter | null = null;
    let openedCapabilityResultFeedback: CapabilityResultFeedbackApiAdapter | null = null;
    try {
      openedStore = createStore(this.loaded.dataDirectory);
      this.store = openedStore;
      openedAgentMessages = new AgentMessageStore(join(this.loaded.dataDirectory, "agent-messages.sqlite"));
      this.agentMessages = new AgentMessageApiAdapter(openedAgentMessages, this.agentMessageAuthority(), true);
      openedCapabilities = new CapabilityApiAdapter(join(this.loaded.dataDirectory, "capabilities.sqlite"));
      this.capabilities = openedCapabilities;
      openedCapabilityResultFeedback = new CapabilityResultFeedbackApiAdapter(join(this.loaded.dataDirectory, "capability-result-feedback.sqlite"));
      this.capabilityResultFeedback = openedCapabilityResultFeedback;
      this.feedback = openedCapabilityResultFeedback;
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
      this.objectiveRepository = new ObjectiveStoreRepository(this.store);
      this.objectiveAttention = new ObjectiveAttentionRegistry(this.store);
      this.objectiveRuntime = new ObjectiveRuntime(this.objectiveRepository, {
        // Resolve this on each admission so a config/settings update cannot
        // widen a new run beyond the current global safety ceilings.
        policyCeiling: () => this.objectiveGlobalPolicyCeiling(),
      });
      this.objectiveSupervisor = new ObjectiveSupervisionRunner(
        this.objectiveRuntime,
        this.objectiveRepository,
        this.agents,
        this.store,
        {
          authority: { actor: { type: "system", id: "objective-supervisor" }, permissionCeiling: "full-access" },
          attentionRegistry: this.objectiveAttention,
          feedbackRepository: openedCapabilityResultFeedback.repository,
          workspaceGrantForRun: (run) => this.objectiveWorkspaceGrant(run.runId),
        },
      );
      this.objectiveApprovalExpiry = new ObjectiveApprovalExpiryProcessor(
        this.objectiveRuntime,
        this.objectiveRepository,
        this.store,
        {
          onExpired: ({ approval, next, requestKey }) => {
          this.appendObjectiveEvent("objective.approval.expired", next, { type: "system", id: "objective-approval-expiry" }, {
              objectiveId: next.objectiveId,
              approvalId: approval.id,
              requestKey,
              status: "expired",
              state: next.state,
              expiresAt: approval.expiresAt,
            });
            this.resolveAttentionForApproval(next, approval, "expired", { reason: "approval-timeout", expiredAt: approval.expiresAt }, { type: "system", id: "objective-approval-expiry" }, requestKey);
          },
        },
      );
      this.workflows = new WorkflowEngine(this.loaded, this.store, this.agents);
      // Daemon-owned schedules stay paused until durable native agents,
      // workflows, and any claimed cron occurrences have been reconciled.
      this.triggers = new TriggerManager(this.store, this.workflows, { paused: true });
      this.plugins = new PluginHost(this.loaded, this.store, options.noPlugins ?? false);
      this.projects = new ProjectService(this.loaded, this.store);
      this.chats = new ChatService(this.loaded, this.store, this.agents, this.uiUtilities);
    } catch (error) {
      openedCapabilityResultFeedback?.close();
      openedCapabilities?.close();
      openedAgentMessages?.close();
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
        if (this.loaded.config.workflows.triggersEnabled) this.registerWorkflowTriggers(ir);
      }
    }
    await this.router.refresh();
    this.catalogTimer = setInterval(
      () => void this.router.refresh().catch(() => undefined),
      this.loaded.config.router.catalogRefreshMinutes * 60_000,
    );
    this.catalogTimer.unref();
    const loadedWorkflows = await loadWorkflowDirectory(
      this.loaded,
      this.store,
      this.workflows,
      undefined,
    );
    if (this.loaded.config.workflows.triggersEnabled) {
      for (const ir of loadedWorkflows) this.registerWorkflowTriggers(ir);
    }
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
          this.registerWorkflowTriggers(ir);
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
    // Approval expiry is daemon-owned and starts before native/objective
    // recovery. A browser that is closed must not keep an expired objective
    // blocked, and a restarted daemon must reconcile old requests promptly.
    this.approvalExpiryUnsubscribe = this.store.onEvent((event) => {
      if (event.type === "objective.approval.requested") this.runApprovalExpiryPass();
    });
    this.runApprovalExpiryPass();
    this.reconcileObjectiveAttentionExpiry();
    this.approvalExpiryTimer = setInterval(
      () => {
        this.runApprovalExpiryPass();
        this.reconcileObjectiveAttentionExpiry();
      },
      this.loaded.config.workflows.approvalExpiryScanMs,
    );
    this.approvalExpiryTimer.unref();
    await this.agents.recover();
    this.objectiveSupervisor.start();
    // Objective recovery is bounded and per-run isolated. It is deliberately
    // observed in the background so one malformed retained objective cannot
    // hold the daemon's readiness boundary hostage.
    void this.objectiveSupervisor.recover();
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
      if (this.approvalExpiryTimer) clearInterval(this.approvalExpiryTimer);
      this.approvalExpiryTimer = null;
      this.approvalExpiryUnsubscribe?.();
      this.approvalExpiryUnsubscribe = null;
      await this.approvalExpiryInFlight;
      this.approvalExpiryInFlight = null;
      this.chats.close();
      for (const response of this.eventResponses) response.end();
      this.eventResponses.clear();
      this.triggers.stop();
      await this.objectiveSupervisor.stop();
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
      this.agentMessages.close();
      this.capabilityResultFeedback.close();
      this.capabilities.close();
      this.store.close();
      if (this.lease) releaseDaemonLease(this.lease);
      this.lease = null;
    }
  }

  private runApprovalExpiryPass(): void {
    if (this.approvalExpiryInFlight) return;
    this.approvalExpiryInFlight = Promise.resolve()
      .then(() => this.objectiveApprovalExpiry.expireRequested())
      .then(() => undefined)
      .catch((error) => {
        this.store.appendEvent({
          type: "objective.approval.expiry-reconcile-failed",
          workflowId: null,
          runId: null,
          agentId: null,
          occurredAt: nowIso(),
          payload: { error: error instanceof Error ? error.message : String(error) },
          provenance: { source: "daemon" },
        });
      })
      .finally(() => {
        this.approvalExpiryInFlight = null;
      });
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
      if (url.pathname === "/v1/capability-result-feedback" || url.pathname.startsWith("/v1/capability-result-feedback/")) {
        return await this.handleCapabilityResultFeedbackRoute(request, response, url);
      }
      if (url.pathname.startsWith("/v1/capabilities")) {
        const capabilityMutation = request.method === "POST" && !url.pathname.endsWith("/prepare");
        const actor = this.capabilityRequestActor(request, capabilityMutation);
        const payload = request.method === "GET" ? undefined : await body(request);
        const capabilityRequest = {
          method: request.method ?? "GET",
          path: request.url ?? url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          ...(payload === undefined ? {} : { body: capabilityMutation ? this.bindCapabilityRequest(payload, actor, request) : payload }),
        };
        const result = await this.capabilities.handle(capabilityRequest);
        return this.json(response, result.status, result.body);
      }
      if (url.pathname === "/v1/agent-messages" || url.pathname.startsWith("/v1/agent-messages/")) {
        return await this.handleAgentMessageRoute(request, response, url);
      }
      if (url.pathname === "/v1/diagnostics" && request.method === "GET") {
        const agentId = z.string().min(1).parse(url.searchParams.get("agentId") ?? "");
        return await this.handleSessionDiagnostics(request, response, agentId, false);
      }
      if (url.pathname === "/v1/events" && request.method === "GET") {
        const scopedRunId = url.searchParams.get("runId");
        const objectiveRun = scopedRunId ? this.store.getObjectiveRun(scopedRunId) : null;
        if (objectiveRun) this.requireObjectiveAccess(request, objectiveRun, "read an objective event stream");
        return this.events(request, response, url);
      }
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
      if (url.pathname === "/v1/workflows" && request.method === "GET") return this.json(response, 200, this.workflowReadProjection());
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
      if (url.pathname === "/v1/objectives" && request.method === "GET") {
        return this.json(response, 200, this.objectiveList(request, url));
      }
      if (url.pathname === "/v1/objective-aggregates" && request.method === "GET") {
        const caller = this.objectiveCaller(request);
        const limit = z.coerce.number().int().min(1).max(2_000).default(200).parse(url.searchParams.get("limit") ?? 200);
        const aggregates = this.store.listObjectiveAggregates({ limit: 2_000 }).filter((aggregate) => {
          if (!caller) return true;
          const runs = this.store.listObjectiveRuns({ objectiveId: aggregate.objectiveId, limit: 2_000 });
          return runs.some((run) => this.objectiveVisibleToRequest(request, run));
        }).slice(0, limit);
        return this.json(response, 200, { aggregates, limit });
      }
      if (url.pathname === "/v1/objectives" && request.method === "POST") {
        return this.json(response, 201, this.createObjective(request, await body(request)));
      }
      // One atomic objective-workspace projection. The explicit suffix keeps
      // the legacy /objectives/:runId detail route compatible while allowing
      // the objective id to span many runs and conversations.
      const objectiveFeedback = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/feedback$/u);
      if (objectiveFeedback && request.method === "GET") {
        const objectiveId = decodeURIComponent(objectiveFeedback[1] as string);
        const runs = this.store.listObjectiveRuns({ objectiveId, limit: 2_000 });
        if (runs.length === 0) throw new HttpError(404, `Objective not found: ${objectiveId}`);
        if (!runs.some((run) => this.objectiveVisibleToRequest(request, run))) {
          throw new HttpError(403, "An authenticated agent may read only objectives in its root lineage.");
        }
        return this.json(response, 200, this.capabilityResultFeedback.objectiveSnapshot(objectiveId));
      }
      const objectiveSnapshot = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/(?:snapshot|workspace|aggregate)$/u);
      if (objectiveSnapshot && request.method === "GET") {
        return this.json(response, 200, this.objectiveAggregateSnapshot(request, decodeURIComponent(objectiveSnapshot[1] as string)));
      }
      if ((url.pathname === "/v1/attentions" || url.pathname === "/v1/attention") && request.method === "GET") {
        return this.json(response, 200, this.objectiveAttentionList(request, url));
      }
      // Tree-shaped objective control plans have a separate identity and CAS
      // head from the legacy flat objective plan. Keep both route spellings
      // for daemon/SDK clients while the strategy name remains the MCP/UI
      // vocabulary.
      const objectiveControlEvents = url.pathname.match(/^\/v1\/(?:objectives|runs)\/([^/]+)\/(?:strategy|control-plan|control)\/events$/u);
      if (objectiveControlEvents && request.method === "GET") {
        const runId = decodeURIComponent(objectiveControlEvents[1] as string);
        const run = this.store.getObjectiveRun(runId);
        if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
        this.requireObjectiveAccess(request, run, "read an objective control-plan event stream");
        return this.events(request, response, url, runId, ["objective.control-plan.changed", "objective.control.acknowledged", "objective.control.evaluation.completed", "objective.control.signal.delivered", "objective.attention.requested", "objective.attention.resolved", "objective.attention.expired", "objective.attention.escalated"]);
      }
      // Keep `/v1/runs/:runId/events` owned by the legacy workflow-run JSON
      // history route below. Objective clients use the explicit objective or
      // control-plan event aliases, so this route can never shadow that API.
      const objectiveEvents = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/events$/u);
      if (objectiveEvents && request.method === "GET") {
        const runId = decodeURIComponent(objectiveEvents[1] as string);
        const run = this.store.getObjectiveRun(runId);
        if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
        this.requireObjectiveAccess(request, run, "read an objective event stream");
        return this.events(request, response, url, runId, [
          "objective.control-plan.changed",
          "objective.control.acknowledged",
          "objective.control.evaluation.completed",
          "objective.control.signal.delivered",
          "objective.attention.requested",
          "objective.attention.resolved",
          "objective.attention.expired",
          "objective.attention.escalated",
          "objective.artifact.published",
          "objective.artifact.verified",
          "objective.artifact.rejected",
          "objective.artifact.superseded",
        ]);
      }
      const objectiveControl = url.pathname.match(/^\/v1\/(?:objectives|runs)\/([^/]+)\/(?:strategy|control-plan|control)$/u);
      if (objectiveControl && request.method === "GET") {
        return this.json(response, 200, this.objectiveControlProjection(
          request,
          decodeURIComponent(objectiveControl[1] as string),
        ));
      }
      const objectiveControlPreview = url.pathname.match(/^\/v1\/(?:objectives|runs)\/([^/]+)\/(?:strategy|control-plan|control)\/preview$/u);
      if (objectiveControlPreview && request.method === "POST") {
        return this.json(response, 200, this.previewObjectiveControl(
          request,
          decodeURIComponent(objectiveControlPreview[1] as string),
          await body(request),
        ));
      }
      if (objectiveControl && request.method === "POST") {
        const result = this.reviseObjectiveControl(
          request,
          decodeURIComponent(objectiveControl[1] as string),
          await body(request),
        );
        const conflict = typeof result === "object"
          && result !== null
          && !Array.isArray(result)
          && "status" in result
          && result.status === "conflict";
        return this.json(response, conflict ? 409 : 200, result);
      }
      const objectiveSignal = url.pathname.match(/^\/v1\/(?:objectives|runs)\/([^/]+)\/signals(?:\/([^/]+))?$/u);
      if (objectiveSignal && request.method === "POST") {
        const runId = decodeURIComponent(objectiveSignal[1] as string);
        const signalKey = objectiveSignal[2] === undefined ? undefined : decodeURIComponent(objectiveSignal[2]);
        let signalPayload = await body(request);
        if (signalKey !== undefined) {
          if (typeof signalPayload !== "object" || signalPayload === null || Array.isArray(signalPayload)) {
            throw new HttpError(400, "Signal delivery payload must be an object when signal key is in the route.");
          }
          const supplied = signalPayload as Record<string, unknown>;
          if (supplied.signalKey !== undefined && supplied.signalKey !== signalKey) {
            throw new HttpError(400, "Signal key in the route does not match the request body.");
          }
          signalPayload = { ...supplied, signalKey };
        }
        return this.json(response, 200, this.deliverObjectiveSignal(request, runId, signalPayload));
      }
      const objective = url.pathname.match(/^\/v1\/objectives\/([^/]+)$/u);
      if (objective && request.method === "GET") {
        return this.json(response, 200, this.objectiveDetail(request, decodeURIComponent(objective[1] as string), url));
      }
      const objectiveAttention = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/attentions$/u);
      if (objectiveAttention && request.method === "GET") {
        const runId = decodeURIComponent(objectiveAttention[1] as string);
        const scoped = new URL(url);
        scoped.searchParams.set("runId", runId);
        return this.json(response, 200, this.objectiveAttentionList(request, scoped));
      }
      if (objectiveAttention && request.method === "POST") {
        return this.json(response, 201, this.requestObjectiveAttention(
          request,
          decodeURIComponent(objectiveAttention[1] as string),
          await body(request),
        ));
      }
      const objectiveAttentionEvents = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/attentions\/events$/u);
      if (objectiveAttentionEvents && request.method === "GET") {
        const runId = decodeURIComponent(objectiveAttentionEvents[1] as string);
        const run = this.store.getObjectiveRun(runId);
        if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
        this.requireObjectiveAccess(request, run, "read objective attention events");
        return this.events(request, response, url, runId, ["objective.attention.requested", "objective.attention.resolved", "objective.attention.expired", "objective.attention.escalated"]);
      }
      const objectiveAttentionDetail = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/attentions\/([^/]+)$/u);
      if (objectiveAttentionDetail && request.method === "GET") {
        return this.json(response, 200, this.objectiveAttentionDetail(
          request,
          decodeURIComponent(objectiveAttentionDetail[1] as string),
          decodeURIComponent(objectiveAttentionDetail[2] as string),
        ));
      }
      const objectiveAttentionResolution = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/attentions\/([^/]+)\/resolve$/u);
      if (objectiveAttentionResolution && request.method === "POST") {
        return this.json(response, 200, this.resolveObjectiveAttention(
          request,
          decodeURIComponent(objectiveAttentionResolution[1] as string),
          decodeURIComponent(objectiveAttentionResolution[2] as string),
          await body(request),
        ));
      }
      const objectiveArtifactReview = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/artifacts\/([^/]+)\/review$/u);
      if (objectiveArtifactReview && request.method === "POST") {
        return this.json(response, 200, this.reviewObjectiveArtifact(
          request,
          decodeURIComponent(objectiveArtifactReview[1] as string),
          decodeURIComponent(objectiveArtifactReview[2] as string),
          await body(request),
        ));
      }
      const objectiveArtifactDetail = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/artifacts\/([^/]+)$/u);
      if (objectiveArtifactDetail && request.method === "GET") {
        return this.json(response, 200, this.objectiveArtifactDetail(
          request,
          decodeURIComponent(objectiveArtifactDetail[1] as string),
          decodeURIComponent(objectiveArtifactDetail[2] as string),
        ));
      }
      const objectiveArtifacts = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/artifacts$/u);
      if (objectiveArtifacts && request.method === "GET") {
        return this.json(response, 200, this.objectiveArtifactList(
          request,
          decodeURIComponent(objectiveArtifacts[1] as string),
          url,
        ));
      }
      if (objectiveArtifacts && request.method === "POST") {
        return this.json(response, 201, this.publishObjectiveArtifact(
          request,
          decodeURIComponent(objectiveArtifacts[1] as string),
          await body(request),
        ));
      }
      const objectivePlan = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/plans$/u);
      if (objectivePlan && request.method === "POST") {
        return this.json(response, 200, this.commitObjectivePlan(
          request,
          decodeURIComponent(objectivePlan[1] as string),
          await body(request),
        ));
      }
      const objectiveCheckpoint = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/checkpoints$/u);
      if (objectiveCheckpoint && request.method === "GET") {
        const runId = decodeURIComponent(objectiveCheckpoint[1] as string);
        const run = this.store.getObjectiveRun(runId);
        if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
        this.requireObjectiveAccess(request, run, "read objective checkpoints");
        return this.json(response, 200, {
          runId,
          objectiveId: run.objectiveId,
          latestCheckpointId: run.latestCheckpointId,
          checkpoints: this.store.listObjectiveCheckpoints(runId),
        });
      }
      if (objectiveCheckpoint && request.method === "POST") {
        return this.json(response, 200, this.commitObjectiveCheckpoint(
          request,
          decodeURIComponent(objectiveCheckpoint[1] as string),
          await body(request),
        ));
      }
      const objectiveCheckpointCommand = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/checkpoints\/([^/]+)\/(resume|retry|fork)$/u);
      if (objectiveCheckpointCommand && request.method === "POST") {
        const runId = decodeURIComponent(objectiveCheckpointCommand[1] as string);
        const checkpointId = decodeURIComponent(objectiveCheckpointCommand[2] as string);
        const operation = objectiveCheckpointCommand[3] as "resume" | "retry" | "fork";
        const commandPayload = await body(request);
        if (operation === "resume") return this.json(response, 200, this.resumeObjectiveCheckpoint(request, runId, checkpointId, commandPayload));
        if (operation === "retry") return this.json(response, 202, this.retryObjectiveCheckpoint(request, runId, checkpointId, commandPayload));
        return this.json(response, 201, this.forkObjectiveCheckpoint(request, runId, checkpointId, commandPayload));
      }
      const objectiveCheckpointDetail = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/checkpoints\/([^/]+)$/u);
      if (objectiveCheckpointDetail && request.method === "GET") {
        return this.json(response, 200, this.objectiveCheckpointDetail(
          request,
          decodeURIComponent(objectiveCheckpointDetail[1] as string),
          decodeURIComponent(objectiveCheckpointDetail[2] as string),
        ));
      }
      const objectiveHandoffs = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/handoffs$/u);
      if (objectiveHandoffs && request.method === "GET") {
        const runId = decodeURIComponent(objectiveHandoffs[1] as string);
        const run = this.store.getObjectiveRun(runId);
        if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
        this.requireObjectiveAccess(request, run, "read objective handoffs");
        return this.json(response, 200, {
          runId,
          objectiveId: run.objectiveId,
          handoffs: this.store.listObjectiveHandoffs(runId).map((envelope) => ({
            envelope,
            acceptance: this.store.getObjectiveHandoffAcceptance(envelope.id),
          })),
        });
      }
      if (objectiveHandoffs && request.method === "POST") {
        return this.json(response, 201, this.offerObjectiveHandoff(request, decodeURIComponent(objectiveHandoffs[1] as string), await body(request)));
      }
      const objectiveHandoffDetail = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/handoffs\/([^/]+)$/u);
      if (objectiveHandoffDetail && request.method === "GET") {
        return this.json(response, 200, this.objectiveHandoffDetail(request, decodeURIComponent(objectiveHandoffDetail[1] as string), decodeURIComponent(objectiveHandoffDetail[2] as string)));
      }
      const objectiveHandoffAccept = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/handoffs\/([^/]+)\/accept$/u);
      if (objectiveHandoffAccept && request.method === "POST") {
        return this.json(response, 200, this.acceptObjectiveHandoff(request, decodeURIComponent(objectiveHandoffAccept[1] as string), decodeURIComponent(objectiveHandoffAccept[2] as string), await body(request)));
      }
      const objectiveApproval = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/approvals$/u);
      if (objectiveApproval && request.method === "POST") {
        return this.json(response, 200, this.requestObjectiveApproval(
          request,
          decodeURIComponent(objectiveApproval[1] as string),
          await body(request),
        ));
      }
      const objectiveApprovalResolution = url.pathname.match(/^\/v1\/objectives\/([^/]+)\/approvals\/([^/]+)\/resolve$/u);
      if (objectiveApprovalResolution && request.method === "POST") {
        return this.json(response, 200, this.resolveObjectiveApproval(
          request,
          decodeURIComponent(objectiveApprovalResolution[1] as string),
          decodeURIComponent(objectiveApprovalResolution[2] as string),
          await body(request),
        ));
      }
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
      const status = error instanceof HttpError
        ? error.status
        : error instanceof AgentMessageApiAuthorizationError ? 403
          : error instanceof z.ZodError ? 400
          : objectiveRuntimeHttpStatus(error) ?? 500;
      try {
        this.json(response, status, { error: error instanceof Error ? error.message : String(error) });
      } catch {
        // Keep the request boundary fail-closed even if an error response
        // itself cannot be written. The server must not surface an unhandled
        // promise rejection or leave a half-open HTTP request behind.
        if (!response.headersSent && !response.writableEnded && !response.destroyed) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "The daemon could not serialize the error response." }));
        } else if (!response.destroyed) {
          response.destroy();
        }
      }
    }
  }

  private capabilityRequestActor(request: IncomingMessage, mutation: boolean): ObjectiveActor {
    const actor = this.authenticatedRequestActor(request, mutation ? "mutate the capability library" : "read the capability library", mutation);
    return actor;
  }

  private async handleCapabilityResultFeedbackRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const segments = url.pathname.split("/").filter(Boolean).slice(2).map((segment) => decodeURIComponent(segment));
    const method = (request.method ?? "GET").toUpperCase();
    const actor = this.authenticatedRequestActor(request, method === "POST" ? "submit capability-result feedback" : "read capability-result feedback", false);

    if (method === "POST" && segments.length === 0) {
      const requestKey = this.requireIdempotencyKey(request);
      const input = z.record(z.string(), JsonValueSchema).parse(await body(request));
      const suppliedAgentId = input.agentId === undefined || input.agentId === null
        ? null
        : z.string().min(1).max(256).parse(input.agentId);
      // An authenticated caller may only submit a record for its own durable
      // agent identity. Local-user submissions cannot forge an agent result.
      if (actor.type === "agent" && suppliedAgentId !== actor.id) {
        throw new HttpError(403, "Capability feedback agentId must match the authenticated agent.");
      }
      if (actor.type === "user" && suppliedAgentId !== null) {
        throw new HttpError(403, "A local user cannot submit feedback for an agent identity.");
      }
      const record = { ...input, agentId: suppliedAgentId, idempotencyKey: requestKey };
      const parsed = CapabilityResultFeedbackRecordSchema.parse(record);
      const run = this.store.getObjectiveRun(parsed.runId);
      if (!run) throw new HttpError(404, `Objective run not found: ${parsed.runId}`);
      if (run.objectiveId !== parsed.objectiveId) throw new HttpError(409, "Capability feedback objective identity does not match its run.");
      const result = this.capabilityResultFeedback.submitFeedback(parsed);
      return this.json(response, result.status, result.body);
    }

    if (method === "GET") {
      const runId = url.searchParams.get("runId");
      const objectiveId = url.searchParams.get("objectiveId");
      if (runId) {
        const run = this.store.getObjectiveRun(runId);
        if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
        this.requireObjectiveAccess(request, run, "read capability-result feedback");
      } else if (objectiveId) {
        const runs = this.store.listObjectiveRuns({ objectiveId, limit: 2_000 });
        if (runs.length === 0) throw new HttpError(404, `Objective not found: ${objectiveId}`);
        if (!runs.some((run) => this.objectiveVisibleToRequest(request, run))) {
          throw new HttpError(403, "An authenticated agent may read only objectives in its root lineage.");
        }
      }
      if (segments.length === 0) {
        const result = await this.capabilityResultFeedback.handle({
          method,
          path: request.url ?? url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
        });
        return this.json(response, result.status, result.body);
      }
      if (segments.length === 2 && ["feedback", "evaluation", "evaluations", "decision", "decisions"].includes(segments[0] as string)) {
        const result = await this.capabilityResultFeedback.handle({ method, path: request.url ?? url.pathname });
        if (result.status === 200 && result.body && typeof result.body === "object") {
          const record = result.body as { runId?: unknown };
          if (typeof record.runId === "string") {
            const run = this.store.getObjectiveRun(record.runId);
            if (!run) throw new HttpError(404, `Objective run not found: ${record.runId}`);
            this.requireObjectiveAccess(request, run, "read capability-result feedback");
          }
        }
        return this.json(response, result.status, result.body);
      }
    }
    throw new HttpError(404, "Capability-result feedback route not found");
  }

  private authenticatedRequestActor(request: IncomingMessage, action: string, fullAccess: boolean): ObjectiveActor {
    const callerId = request.headers["x-symphony-agent-id"];
    if (callerId === undefined) {
      if (request.headers["x-symphony-agent-token"] !== undefined) throw new HttpError(401, "Invalid agent coordination token");
      return { type: "user", id: "local-user" };
    }
    if (typeof callerId !== "string") throw new HttpError(401, "Invalid agent coordination token");
    const token = request.headers["x-symphony-agent-token"];
    if (typeof token !== "string" || !this.agents.authenticate(callerId, token)) {
      throw new HttpError(401, "Invalid agent coordination token");
    }
    if (fullAccess && this.agents.get(callerId).permissions !== "full-access") {
      throw new HttpError(403, `A read-only Symphony agent cannot ${action}.`);
    }
    return { type: "agent", id: callerId };
  }

  private bindCapabilityRequest(payload: unknown, actor: ObjectiveActor, request: IncomingMessage): unknown {
    const input = z.record(z.string(), JsonValueSchema).parse(payload);
    return { ...input, actor, requestKey: this.requireIdempotencyKey(request) };
  }

  private stripRequestIdentity(input: Record<string, JsonValue>): Record<string, JsonValue> {
    const output = { ...input };
    delete output.actor;
    delete output.actorId;
    delete output.requestKey;
    return output;
  }

  private async handleAgentMessageRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const actor = this.authenticatedRequestActor(request, "use the agent message bus", false);
    const actorId = actor.id;
    const segments = url.pathname.split("/").filter(Boolean).slice(2).map((segment) => decodeURIComponent(segment));
    if (segments.length === 0 && request.method === "POST") {
      const payload = z.record(z.string(), JsonValueSchema).parse(await body(request));
      const result = this.agentMessages.append({ ...this.stripRequestIdentity(payload), requestKey: this.requireIdempotencyKey(request) } as AgentMessageInput, actorId);
      return this.json(response, result.status === "committed" ? 201 : result.status === "replayed" ? 200 : 409, result);
    }
    if (segments.length === 0 && request.method === "GET") {
      const afterValue = url.searchParams.get("after") ?? url.searchParams.get("afterCursor");
      const beforeValue = url.searchParams.get("before") ?? url.searchParams.get("beforeCursor");
      const afterCursor = afterValue === null ? undefined : z.coerce.number().int().nonnegative().parse(afterValue);
      const limit = z.coerce.number().int().min(1).max(10_000).default(500).parse(url.searchParams.get("limit") ?? 500);
      const options = {
        ...(afterCursor === undefined ? {} : { afterCursor }),
        ...(beforeValue !== null ? { beforeCursor: z.coerce.number().int().nonnegative().parse(beforeValue) } : {}),
        ...(url.searchParams.has("senderId") ? { senderId: z.string().min(1).parse(url.searchParams.get("senderId")) } : {}),
        ...(url.searchParams.has("recipientId") ? { recipientId: z.string().min(1).parse(url.searchParams.get("recipientId")) } : {}),
        ...(url.searchParams.has("objectiveId") ? { objectiveId: z.string().min(1).parse(url.searchParams.get("objectiveId")) } : {}),
        ...(url.searchParams.has("runId") ? { runId: z.string().min(1).parse(url.searchParams.get("runId")) } : {}),
        ...(url.searchParams.has("kind") ? { kind: z.enum(["finding", "question", "status", "handoff", "control-request"]).parse(url.searchParams.get("kind")) } : {}),
        limit,
      };
      const messages = this.agentMessages.list(actorId, options);
      return this.json(response, 200, { messages, cursor: messages.at(-1)?.cursor ?? afterCursor ?? 0, hasMore: messages.length >= limit });
    }
    if (segments.length === 1 && segments[0] === "projection" && request.method === "GET") {
      return this.json(response, 200, this.agentMessageProjection(actorId));
    }
    if (segments.length === 1 && segments[0] === "cursor" && request.method === "GET") {
      return this.json(response, 200, this.agentMessages.cursorSnapshot());
    }
    if (segments.length === 1 && segments[0] === "replay" && request.method === "GET") {
      const afterCursor = z.coerce.number().int().nonnegative().default(0).parse(url.searchParams.get("after") ?? url.searchParams.get("afterCursor") ?? 0);
      const limit = z.coerce.number().int().min(1).max(10_000).default(500).parse(url.searchParams.get("limit") ?? 500);
      return this.json(response, 200, this.agentMessages.replay(afterCursor, actorId, { limit }));
    }
    if (segments.length < 1) throw new HttpError(404, "Agent message route not found");
    const messageId = segments[0] as string;
    if (segments.length === 1 && request.method === "GET") {
      const message = this.agentMessages.get(messageId, actorId);
      if (!message) throw new HttpError(404, `Agent message not found: ${messageId}`);
      return this.json(response, 200, message);
    }
    if (segments.length === 2 && segments[1] === "receipts") {
      if (request.method === "GET") {
        const message = this.agentMessages.get(messageId, actorId);
        if (!message) throw new HttpError(404, `Agent message not found: ${messageId}`);
        return this.json(response, 200, message);
      }
      if (request.method !== "POST") throw new HttpError(404, "Agent message route not found");
      const input = z.record(z.string(), JsonValueSchema).parse(await body(request));
      const receiptRequestKey = this.requireIdempotencyKey(request);
      const message = this.agentMessages.getMessage(messageId, actorId);
      if (!message) throw new HttpError(404, `Agent message not found: ${messageId}`);
      try {
        const result = this.agentMessages.receipt({
          ...this.stripRequestIdentity(input),
          messageId,
          recipientId: message.recipientId,
          actorId,
          requestKey: receiptRequestKey,
          recordedAt: nowIso(),
        } as AgentMessageReceiptInput, actorId);
        return this.json(response, result.status === "conflict" ? 409 : 200, result);
      } catch (error) {
        if (error instanceof AgentMessageApiAuthorizationError) throw new HttpError(403, error.message);
        throw error;
      }
    }
    if (segments.length === 2 && segments[1] === "reply" && request.method === "POST") {
      return this.json(response, 200, await this.replyAgentMessage(request, messageId, actorId, await body(request)));
    }
    if (segments.length !== 2 || request.method !== "POST") throw new HttpError(404, "Agent message route not found");
    const operation = segments[1];
    const requestKey = this.requireIdempotencyKey(request);
    const input = z.record(z.string(), JsonValueSchema).parse(await body(request));
    const reason = input.reason === undefined ? undefined : z.string().max(2_000).parse(input.reason);
    const deliveryState = input.state === undefined ? undefined : z.enum(["delivered", "failed"]).parse(input.state);
    const recordedAt = nowIso();
    const base = { requestKey, actorId, recordedAt, ...(reason === undefined ? {} : { reason }) };
    let result;
    try {
      if (operation === "deliver") result = this.agentMessages.deliver(messageId, { ...base, ...(deliveryState === undefined ? {} : { state: deliveryState }) });
      else if (operation === "failed") result = this.agentMessages.failed(messageId, base);
      else if (operation === "unknown") result = this.agentMessages.unknown(messageId, { ...base, reason: reason ?? "Delivery outcome could not be established." });
      else if (operation === "read") result = this.agentMessages.read(messageId, base);
      else if (operation === "handled") result = this.agentMessages.handled(messageId, { ...base, decision: z.enum(["acknowledged", "accepted", "rejected", "deferred", "cancelled"]).parse(input.decision) });
      else if (operation === "cancel") result = this.agentMessages.cancel(messageId, base);
      else if (operation === "expire") result = this.agentMessages.expire(messageId, base);
      else throw new HttpError(404, "Agent message route not found");
    } catch (error) {
      if (error instanceof AgentMessageApiAuthorizationError) throw new HttpError(403, error.message);
      if (error instanceof Error && error.message.startsWith("Agent message not found:")) throw new HttpError(404, error.message);
      throw error;
    }
    return this.json(response, result.status === "conflict" ? 409 : 200, result);
  }

  private agentMessageProjection(actorId: string): JsonValue {
    const records = this.agentMessages.list(actorId, { limit: 10_000 });
    const snapshots = records.map((message) => this.agentMessages.get(message.id, actorId)).filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
    const outbox = snapshots.filter((snapshot) => snapshot.message.senderId === actorId);
    const inbox = snapshots.filter((snapshot) => snapshot.message.senderId !== actorId);
    const cursors = this.agentMessages.cursorSnapshot();
    return {
      actorId: actorId === "local-user" ? null : actorId,
      messageCursor: cursors.messageCursor,
      receiptCursor: cursors.receiptCursor,
      inbox,
      outbox,
    } as unknown as JsonValue;
  }

  private async replyAgentMessage(request: IncomingMessage, messageId: string, actorId: string, payload: unknown): Promise<JsonValue> {
    const original = this.agentMessages.getMessage(messageId, actorId);
    if (!original) throw new HttpError(404, `Agent message not found: ${messageId}`);
    const input = z.object({
      recipientId: z.string().min(1).max(512).optional(),
      summary: z.string().min(1).max(20_000),
      payload: JsonValueSchema.optional(),
      artifactRefs: z.array(AgentMessageArtifactRefSchema).max(2_000).default([]),
      evidenceRefs: z.array(AgentMessageEvidenceRefSchema).max(2_000).default([]),
      expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    }).strict().parse(this.stripRequestIdentity(z.record(z.string(), JsonValueSchema).parse(payload)));
    const counterpart = actorId === original.senderId ? original.recipientId : original.senderId;
    if (input.recipientId !== undefined && input.recipientId !== counterpart) {
      throw new HttpError(403, "A reply recipient must be the original message counterpart.");
    }
    const reply = {
      version: 1 as const,
      requestKey: this.requireIdempotencyKey(request),
      kind: original.kind,
      senderId: actorId,
      recipientId: counterpart,
      parentId: original.parentId,
      parentAgentId: original.parentAgentId,
      objectiveId: original.objectiveId,
      runId: original.runId,
      attemptId: original.attemptId,
      correlationId: original.correlationId ?? original.id,
      replyToId: original.id,
      payload: input.payload ?? {},
      summary: input.summary,
      artifactRefs: input.artifactRefs,
      evidenceRefs: input.evidenceRefs,
      createdAt: nowIso(),
      expiresAt: input.expiresAt ?? null,
    } satisfies AgentMessageInput;
    const result = this.agentMessages.append(reply, actorId);
    if (result.status === "conflict") return result as unknown as JsonValue;
    if (!result.message) throw new HttpError(409, "Reply was accepted without a durable message record.");
    const snapshot = this.agentMessages.get(result.message.id, actorId);
    if (!snapshot) throw new HttpError(409, "Reply was committed but its durable projection is unavailable.");
    return snapshot as unknown as JsonValue;
  }

  private async handleSessionDiagnostics(request: IncomingMessage, response: ServerResponse, agentId: string, exportText: boolean): Promise<void> {
    this.requireAgentTargetAccess(request, agentId, "read session diagnostics");
    if (!this.store.getAgent(agentId)) throw new HttpError(404, `Agent not found: ${agentId}`);
    const agent = this.agents.get(agentId);
    const highWater = this.store.latestCursor();
    const events = agentEventsThroughCursor(this.store, agentId, highWater);
    const objectiveRun = this.store.getObjectiveRun(agent.runId);
    const driver = agent.harness && this.drivers.has(agent.harness) ? await this.harnessMaintenance.report(agent.harness).catch(() => null) : null;
    const lease = this.store.listWorkerProcessLeases({ agentId: agent.id }).at(-1) ?? null;
    const runtime = classifySessionDiagnosticRuntime({
      status: agent.status,
      hasReusableSession: this.agents.hasSession(agent.id),
      nativeSessionId: agent.nativeSessionId,
      leaseState: lease?.state ?? null,
      leaseNativeSessionId: lease?.nativeSessionId ?? null,
      leaseError: lease?.error ?? null,
    });
    const failures = events.filter((event) => ["agent.failed", "agent.interrupted", "driver.run.failed"].includes(event.type));
    const bundle = buildSessionDiagnosticBundle({
      identity: {
        objectiveId: objectiveRun?.objectiveId ?? null,
        runId: agent.runId,
        agentId: agent.id,
        attemptId: agent.objectiveAttemptId ?? null,
        nativeSessionId: agent.nativeSessionId,
        nativeRunId: agent.nativeRunId,
      },
      termination: runtime.termination,
      eventCursorRanges: events.length ? [{ from: events[0]?.cursor ?? 0, to: events.at(-1)?.cursor ?? 0 }] : [],
      harness: {
        harness: agent.harness ?? agent.requestedHarness,
        model: agent.model ?? agent.requestedModel,
        available: driver?.available ?? false,
        auth: driver ? (driver.authenticated ? "ready" : "missing") : "unknown",
        ...(driver?.detail ? { detail: driver.detail } : {}),
      },
      exits: failures.map((event) => ({ process: "native", state: "exited", code: null, signal: null, stderr: jsonRecord(event.payload).error ?? jsonRecord(event.payload).message ?? agent.error ?? "", at: event.occurredAt })),
      liveness: { state: runtime.liveness, recovery: runtime.recovery, reason: agent.error ?? lease?.error ?? runtime.reason },
      verificationCommands: [],
      provenance: { source: "daemon", generatedAt: nowIso(), generatorVersion: "0.1.0", parentHash: null },
    }, { source: "daemon", generatorVersion: "0.1.0" });
    if (exportText) {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("content-disposition", `attachment; filename="symphony-session-${agentId.replace(/[^A-Za-z0-9_.-]/gu, "_")}.json"`);
      response.statusCode = 200;
      response.end(sessionDiagnosticJson(bundle));
      return;
    }
    return this.json(response, 200, bundle);
  }

  private async resource(request: IncomingMessage, response: ServerResponse, resource: string, id: string, action: string, url: URL): Promise<void> {
    if (resource === "agents" && !action && request.method === "GET") {
      this.requireAgentTargetAccess(request, id, "read an agent's status");
      return this.json(response, 200, this.agents.get(id));
    }
    if (resource === "agents" && action === "messages" && request.method === "GET") {
      this.requireAgentTargetAccess(request, id, "read another agent's transcript");
      const agent = this.agents.get(id);
      const events = agentEventsThroughCursor(this.store, id, this.store.latestCursor());
      return this.json(response, 200, {
        agentId: id,
        messages: buildAgentTranscript(agent, events),
      });
    }
    if (resource === "agents" && action === "logs" && request.method === "GET") {
      this.requireAgentTargetAccess(request, id, "read an agent's logs");
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
    if (resource === "agents" && (action === "diagnostics" || action === "diagnostics/export") && request.method === "GET") {
      return this.handleSessionDiagnostics(request, response, id, action.endsWith("/export"));
    }
    if (resource === "agents" && action === "messages" && request.method === "POST") {
      const input = z.object({ content: z.string().min(1) }).parse(await body(request));
      this.requireAgentTargetAccess(request, id, "message an agent");
      return this.json(response, 202, await this.messageAgent(request, id, input.content));
    }
    if (resource === "agents" && action === "observe" && request.method === "GET") {
      this.requireAgentTargetAccess(request, id, "observe an agent");
      const level = z.enum(["tldr", "paragraph", "full"]).parse(url.searchParams.get("level") ?? "tldr");
      return this.json(response, 200, await this.agents.observe(id, level));
    }
    if (resource === "agents" && action === "cancel" && request.method === "POST") {
      this.requireFullAccessAgent(request, "cancel an agent");
      this.requireAgentTargetAccess(request, id, "cancel an agent");
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
      this.requireAgentRunAccess(request, id, "read workflow run events");
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
      this.requireAgentRunAccess(request, id, "cancel a workflow run");
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

  /**
   * Objectives are durable conductor projections. Mutations enter the
   * ObjectiveRuntime with an authority envelope derived at this boundary, and
   * the semantic event is committed in the same SQLite transaction as the
   * runtime receipt and projection.
   */
  private objectiveControlProjection(request: IncomingMessage, runId: string): JsonValue {
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, "read an objective control plan");
    const head = this.store.getObjectiveControlHead(runId);
    const revision = head ? this.store.getObjectiveControlPlanRevision(runId, head.activeRevision) : null;
    const snapshot = head ? this.store.getObjectiveControlSnapshot(runId, head.latestSnapshotSequence) : null;
    if (head && (!revision || !snapshot)) {
      throw new HttpError(409, "Objective control-plan head references missing durable state.");
    }
    const mutations = this.store.listObjectiveControlMutations(runId);
    return {
      runId,
      objectiveId: run.objectiveId,
      planId: head?.planId ?? null,
      head,
      revision,
      snapshot,
      mutations,
      // Explicit aliases keep the wire projection readable to both daemon
      // clients (head/revision/snapshot) and strategy surfaces (control*).
      controlHead: head,
      controlRevision: revision,
      controlSnapshot: snapshot,
      history: mutations,
    } as unknown as JsonValue;
  }

  /**
   * Bind one consequential objective mutation to its immutable request
   * identity. The callback runs inside the storage ledger transaction, so
   * objective projection changes, semantic events, and the generic receipt
   * commit together. Existing operation-specific receipts remain useful for
   * compatibility and nested idempotency, but the generic ledger is the
   * daemon command boundary.
   */
  private objectiveCommandLedger(
    request: IncomingMessage,
    runId: string,
    operation: string,
    payload: unknown,
    execute: (context: {
      requestKey: string;
      run: ObjectiveRunRecord;
      caller: AgentRecord | null;
      actor: ObjectiveActor;
    }) => ObjectiveCommandExecution,
    afterCommitted?: (context: {
      requestKey: string;
      run: ObjectiveRunRecord;
      caller: AgentRecord | null;
      actor: ObjectiveActor;
      }, result: JsonValue) => void,
    conflictMessage = "Objective command request identity conflict.",
  ): JsonValue {
    const requestKey = this.requireIdempotencyKey(request);
    const caller = this.objectiveCaller(request);
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    const actor: ObjectiveActor = caller
      ? { type: "agent", id: caller.id }
      : { type: "user", id: "local-user" };
    const fingerprint = createHash("sha256").update(stableJsonStringify({
      operation,
      runId,
      objectiveId: run.objectiveId,
      actor,
      payload,
    })).digest("hex");
    const context = { requestKey, run, caller, actor };
    const ledger = this.store.executeObjectiveCommand({
      requestKey,
      operation,
      fingerprint,
      actor,
      objectiveId: run.objectiveId,
      runId,
    }, () => {
      try {
        return execute(context);
      } catch (error) {
        // Validation and authority failures are deterministic rejections, not
        // uncertain effects. Persist enough transport metadata to reproduce
        // the same HTTP error on an exact retry; unexpected failures still
        // use the storage ledger's fail-closed unknown outcome.
        const status = error instanceof HttpError ? error.status : objectiveRuntimeHttpStatus(error);
        if (status !== null && status >= 400 && status < 500) {
          return {
            status: "rejected" as const,
            result: {
              __symphonyObjectiveCommandRejection: true,
              httpStatus: status,
              error: error instanceof Error ? error.message : String(error),
            } as unknown as JsonValue,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        throw error;
      }
    });
    if (ledger.status === "conflict") {
      throw new HttpError(409, conflictMessage);
    }
    if (ledger.status === "unknown") {
      throw new HttpError(409, ledger.reason ?? "Objective command outcome is unknown; reconciliation is required.");
    }
    if (ledger.status === "rejected") {
      const rejected = jsonRecord(ledger.result);
      if (rejected.__symphonyObjectiveCommandRejection === true) {
        const status = typeof rejected.httpStatus === "number" && Number.isInteger(rejected.httpStatus)
          ? rejected.httpStatus
          : 409;
        throw new HttpError(status, typeof rejected.error === "string" ? rejected.error : ledger.reason ?? "Objective command was rejected.");
      }
      return ledger.result;
    }
    if (ledger.status === "committed") afterCommitted?.(context, ledger.result);
    if (ledger.status === "replayed") {
      // Keep the original operation result fields byte-for-byte while making
      // the generic replay visible to existing API clients.
      return {
        ...jsonRecord(ledger.result),
        status: "replayed",
        replayed: true,
      } as unknown as JsonValue;
    }
    return ledger.result;
  }

  /**
   * Bind a typed wire mutation to the authenticated caller and delegate the
   * reduction/commit to storage. Resulting plans and snapshots never cross
   * this boundary from the network.
  */
  private reviseObjectiveControl(request: IncomingMessage, runId: string, payload: unknown): JsonValue {
    let cancellationAttemptIds: string[] = [];
    return this.objectiveCommandLedger(request, runId, "objective.control.revise", payload, ({ requestKey, run, caller }) => {
      // Parse authentication and lineage before mutation details so a caller
      // cannot use malformed payloads to probe unrelated objective runs.
      const { authority } = this.objectiveMutationContext(request, runId, "revise");
      this.requireFullAccessAgent(request, "revise an objective control plan");
      const head = this.store.getObjectiveControlHead(runId);
      if (!head) throw new HttpError(409, "Objective control plan has not been admitted for this run.");
      let parsed: z.infer<typeof ObjectiveControlMutationRequestSchema>;
      try {
        parsed = ObjectiveControlMutationRequestSchema.parse(payload);
      } catch {
        throw new HttpError(400, "Invalid typed objective control-plan mutation request.");
      }
      let mutation: ObjectiveControlMutation;
      try {
        mutation = ObjectiveControlMutationSchema.parse({
          ...parsed,
          version: 1,
          mutationId: `objective-control-mutation:${createHash("sha256").update(`${runId}\u0000${requestKey}`).digest("hex")}`,
          planId: head.planId,
          objectiveId: run.objectiveId,
          runId,
          requestKey,
          actor: caller ? { type: "agent", id: caller.id } : { type: "user", id: "local-user" },
        });
      } catch {
        throw new HttpError(400, "Invalid typed objective control-plan mutation request.");
      }
      this.assertObjectiveControlMutationAuthority(run, mutation, authority);
      const priorMutation = this.store.getObjectiveControlMutationByRequestKey(runId, requestKey);
      const currentRevision = this.store.getObjectiveControlPlanRevision(runId, head.activeRevision);
      const currentSnapshot = this.store.getObjectiveControlSnapshot(runId, head.latestSnapshotSequence);
      // A replay must not be revalidated against the now-advanced head: the
      // original receipt is the deterministic authority for that request key.
      const impactPreview = !priorMutation && currentRevision && currentSnapshot
        ? previewObjectiveControlMutation(currentRevision.plan, currentSnapshot, mutation, run.policy ? {
            policy: {
              effectivePermission: run.policy.effectivePermission,
              allowedCapabilities: run.policy.allowedCapabilities,
              workspace: run.policy.workspace,
              sideEffectClassCeiling: run.policy.sideEffectClassCeiling,
              budget: run.policy.budget,
            },
          } : {})
        : null;
      try {
        const committedState = this.objectiveRuntime.mutateControlPlan(runId, mutation, authority);
        const committedMutation = this.store.getObjectiveControlMutationByRequestKey(runId, requestKey);
        if (!committedMutation) {
          throw new HttpError(500, "Objective control mutation committed without a durable receipt.");
        }
        if (mutation.type === "remove-subtree" && impactPreview) {
          cancellationAttemptIds = [...impactPreview.impact.activeAttemptsCancelled];
        }
        return {
          status: "committed" as const,
          result: {
            status: "committed",
            head: committedState.head,
            revision: committedState.revision,
            snapshot: committedState.snapshot,
            mutation: committedMutation,
          } as unknown as JsonValue,
        };
      } catch (error) {
        if (!(error instanceof ObjectiveRuntimeError) || error.code !== "revision-conflict") throw error;
        const currentHead = this.store.getObjectiveControlHead(runId);
        return {
          status: "rejected" as const,
          result: {
            status: "conflict",
            conflict: true,
            reason: error.message,
            head: currentHead,
            currentRevision: currentHead?.activeRevision ?? null,
            expectedRevision: mutation.expectedRevision,
          } as unknown as JsonValue,
          reason: error.message,
        };
      }
    }, () => {
      // Native cancellation is a post-commit side effect. The durable
      // mutation receipt/snapshot is authoritative before a driver is asked
      // to stop an active attempt.
      for (const attemptId of cancellationAttemptIds) {
        const agent = this.store.getAgentByLogicalAgentId(attemptId);
        if (agent) void this.agents.cancel(agent.id).catch(() => undefined);
      }
    });
  }

  /**
   * Produce the exact candidate-plan diff that an apply would use. Preview is
   * authenticated and actor-bound, but deliberately does not advance the CAS
   * head or create a scheduler-visible revision.
   */
  private previewObjectiveControl(request: IncomingMessage, runId: string, payload: unknown): JsonValue {
    const requestKey = this.requireIdempotencyKey(request);
    const { run, authority, caller } = this.objectiveMutationContext(request, runId, "preview an objective control plan revision");
    this.requireFullAccessAgent(request, "preview an objective control plan revision");
    const head = this.store.getObjectiveControlHead(runId);
    if (!head) throw new HttpError(409, "Objective control plan has not been admitted for this run.");
    const revision = this.store.getObjectiveControlPlanRevision(runId, head.activeRevision);
    const snapshot = this.store.getObjectiveControlSnapshot(runId, head.latestSnapshotSequence);
    if (!revision || !snapshot) throw new HttpError(409, "Objective control-plan head references missing durable state.");
    let parsed: z.infer<typeof ObjectiveControlMutationRequestSchema>;
    try {
      parsed = ObjectiveControlMutationRequestSchema.parse(payload);
    } catch {
      throw new HttpError(400, "Invalid typed objective control-plan mutation preview request.");
    }
    if (parsed.expectedRevision !== head.activeRevision) {
      throw new HttpError(409, `Objective control-plan preview is stale: expected revision ${parsed.expectedRevision}, current revision ${head.activeRevision}.`);
    }
    const actor = caller ? { type: "agent" as const, id: caller.id } : { type: "user" as const, id: "local-user" };
    const mutation = ObjectiveControlMutationSchema.parse({
      ...parsed,
      version: 1,
      mutationId: `objective-control-preview:${createHash("sha256").update(`${runId}\u0000${requestKey}`).digest("hex")}`,
      planId: head.planId,
      objectiveId: run.objectiveId,
      runId,
      requestKey,
      actor,
    });
    this.assertObjectiveControlMutationAuthority(run, mutation, authority);
    const policy = run.policy ? {
      effectivePermission: run.policy.effectivePermission,
      allowedCapabilities: run.policy.allowedCapabilities,
      workspace: run.policy.workspace,
      sideEffectClassCeiling: run.policy.sideEffectClassCeiling,
      budget: run.policy.budget,
    } : undefined;
    try {
      return previewObjectiveControlMutation(revision.plan, snapshot, mutation, policy ? { policy } : {}) as unknown as JsonValue;
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Invalid objective control-plan mutation preview.");
    }
  }

  /**
   * Deliver one external event to the exact durable signal subscription. The
   * caller may be the local objective authority or the bound conductor; every
   * attached agent outside that conductor identity is rejected before payload
  * parsing can reveal the run's suspension state.
  */
  private deliverObjectiveSignal(request: IncomingMessage, runId: string, payload: unknown): JsonValue {
    return this.objectiveCommandLedger(request, runId, "objective.signal.deliver", payload, ({ requestKey, run, caller }) => {
      this.requireObjectiveAccess(request, run, "deliver an objective signal");
      if (caller && (run.conductorAgentId === null || caller.id !== run.conductorAgentId)) {
        throw new HttpError(403, "Only the bound objective conductor may deliver an external signal.");
      }
      let input: ObjectiveControlSignalDeliveryInput;
      try {
        input = ObjectiveControlSignalDeliveryInputSchema.parse(payload);
      } catch {
        throw new HttpError(400, "Invalid typed objective signal delivery.");
      }
      const authority = this.objectiveAuthority(caller, this.effectiveWorkspaceGrant(this.objectiveWorkspaceGrant(runId), caller));
      const delivered = this.objectiveRuntime.deliverControlSignal(runId, input, authority);
      return { status: "committed", result: { ...delivered, requestKey } as unknown as JsonValue };
    }, (_context, result) => {
      if (jsonRecord(result).status === "delivered") {
        // A delivery is already durably reduced before this wakeup. The
        // runner is nudged directly by the daemon event; the UI never polls
        // the suspension.
        void this.objectiveSupervisor.step(runId).catch(() => undefined);
      }
    });
  }

  private assertObjectiveControlMutationAuthority(
    run: ObjectiveRunRecord,
    mutation: ObjectiveControlMutation,
    authority: ObjectiveRuntimeAuthority,
  ): void {
    const visit = (node: ObjectiveControlNode): void => {
      if (node.type === "agent") {
        const permissionCeiling = run.policy?.effectivePermission ?? authority.permissionCeiling;
        if (node.permissions === "full-access" && permissionCeiling !== "full-access") {
          throw new HttpError(403, `Control node ${node.id} requests full-access above the objective authority ceiling.`);
        }
        const allowed = new Set(run.policy?.allowedCapabilities ?? authority.allowedCapabilities ?? []);
        for (const capability of node.capabilities ?? []) {
          if (!allowed.has(capability)) {
            throw new HttpError(403, `Control node ${node.id} requests unavailable capability ${capability}.`);
          }
        }
        if (node.workspace) {
          const grants = [run.policy?.workspace ?? null, authority.workspace ?? null].filter(
            (grant): grant is WorkspaceSpec => grant !== null,
          );
          if (grants.length === 0) {
            throw new HttpError(403, `Control node ${node.id} requests a workspace without an objective grant.`);
          }
          // Realpath-aware containment prevents a mutation from widening a
          // native agent's durable workspace grant through a symlink.
          for (const grant of grants) this.childWorkspaceGrant(grant, node.workspace);
        }
      }
      if (node.type === "sequence" || node.type === "parallel" || node.type === "while") node.steps.forEach(visit);
      else if (node.type === "if") {
        node.then.forEach(visit);
        node.else?.forEach(visit);
      }
    };
    if (mutation.type === "insert-node" || mutation.type === "replace-node" || mutation.type === "insert-branch" || mutation.type === "replace-branch" || mutation.type === "insert-evaluate" || mutation.type === "insert-evaluator" || mutation.type === "insert-timer" || mutation.type === "insert-signal" || mutation.type === "insert-checkpoint" || mutation.type === "insert-artifact") visit(mutation.node);
  }

  private objectiveList(request: IncomingMessage, url: URL): { objectives: ObjectiveRunRecord[]; limit: number } {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(url.searchParams.get("limit") ?? 50);
    const states = url.searchParams.getAll("state")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    const parsedStates = states.length ? ObjectiveRunStateSchema.array().parse(states) : undefined;
    const requestedRunId = url.searchParams.get("runId")?.trim() || null;
    const workflowId = url.searchParams.get("workflowId")?.trim() || null;
    // Validate a native caller even when the filtered result is empty. A
    // malformed capability must not look like a legitimate empty projection.
    this.objectiveCaller(request);
    const objectiveQuery = parsedStates ? { state: parsedStates, limit: 2_000 } : { limit: 2_000 };
    const candidates = requestedRunId
      ? (this.store.getObjectiveRun(requestedRunId) ? [this.store.getObjectiveRun(requestedRunId) as ObjectiveRunRecord] : [])
      : this.store.listObjectiveRuns(objectiveQuery);
    const objectives = candidates
      .filter((run) => !workflowId || run.workflowId === workflowId)
      .filter((run) => this.objectiveVisibleToRequest(request, run))
      .slice(0, limit);
    return { objectives, limit };
  }

  private objectiveDetail(request: IncomingMessage, runId: string, url: URL): JsonValue {
    const run = this.store.getObjectiveRun(runId);
    // New objective callers may address the aggregate directly. Preserve the
    // legacy run-detail response whenever the path names a run, and only fall
    // back to the aggregate snapshot when no run has that identity.
    if (!run && this.store.getObjectiveAggregate(runId)) return this.objectiveAggregateSnapshot(request, runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, "read an objective run");

    const limit = z.coerce.number().int().min(1).max(2_000).default(500).parse(url.searchParams.get("limit") ?? 500);
    const afterValue = url.searchParams.get("after");
    const after = afterValue === null
      ? null
      : z.coerce.number().int().min(0).parse(afterValue);
    const page = after === null
      ? this.store.recentEvents({ runId, limit: limit + 1 })
      : this.store.eventsAfter(after, { runId, limit: limit + 1 });
    const events = page.slice(0, limit);
    // Budget accounting is available only when this run has an authoritative
    // policy-backed ledger. Keep legacy (or partially migrated) runs explicit
    // about unavailable accounting instead of manufacturing empty usage.
    const budgetLedger = this.store.getObjectiveBudgetLedger(runId);
    const accountingLimit = 500;
    return {
      run,
      planRevisions: this.store.listObjectivePlanRevisions(runId),
      checkpoints: this.store.listObjectiveCheckpoints(runId),
      approvals: this.store.listObjectiveApprovals({ runId, limit: 2_000 }),
      attentions: this.store.listObjectiveAttentions({ runId, limit: 2_000 }),
      artifacts: this.store.listObjectiveArtifacts({ runId, limit: accountingLimit }),
      budgetLedger,
      reservations: budgetLedger
        ? this.store.listObjectiveBudgetReservations({ runId, limit: accountingLimit })
        : null,
      debits: budgetLedger
        ? this.store.listObjectiveBudgetDebits({ runId, limit: accountingLimit })
        : null,
      events,
      eventCursor: events.at(-1)?.cursor ?? after ?? 0,
      hasMore: page.length > limit,
    } as unknown as JsonValue;
  }

  private reconcileObjectiveAttentionExpiry(): void {
    this.store.durableTransaction(() => {
      const expired = this.objectiveAttention.expire(nowIso());
      for (const attention of expired) {
        const run = this.store.getObjectiveRun(attention.runId);
        if (!run || !attention.resolution) continue;
        this.appendObjectiveAttentionEvent("objective.attention.expired", run, attention, attention.resolution.resolvedBy);
      }
    });
  }

  private objectiveAttentionList(request: IncomingMessage, url: URL): JsonValue {
    // Expiry is reconciled at the authoritative read boundary as well as at
    // daemon startup. A disconnected browser therefore cannot leave stale
    // open records in the global inbox.
    this.reconcileObjectiveAttentionExpiry();
    const statusValues = url.searchParams.getAll("status")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    const query = ObjectiveAttentionListQuerySchema.parse({
      ...(url.searchParams.get("objectiveId") ? { objectiveId: url.searchParams.get("objectiveId") } : {}),
      ...(url.searchParams.get("runId") ? { runId: url.searchParams.get("runId") } : {}),
      ...(url.searchParams.get("nodeId") ? { nodeId: url.searchParams.get("nodeId") } : {}),
      ...(url.searchParams.get("attemptId") ? { attemptId: url.searchParams.get("attemptId") } : {}),
      ...(statusValues.length ? { status: statusValues } : {}),
      ...(url.searchParams.get("assigneeId") ? { assigneeId: url.searchParams.get("assigneeId") } : {}),
      limit: z.coerce.number().int().min(1).max(2_000).default(200).parse(url.searchParams.get("limit") ?? 200),
    });
    // Validate the capability even for an empty result. A malformed token
    // must never masquerade as an empty global inbox.
    this.objectiveCaller(request);
    if (query.runId) {
      const run = this.store.getObjectiveRun(query.runId);
      if (!run) throw new HttpError(404, `Objective run not found: ${query.runId}`);
      this.requireObjectiveAccess(request, run, "read objective attention");
    }
    const records = this.store.listObjectiveAttentions(query as Parameters<SymphonyStore["listObjectiveAttentions"]>[0]);
    const visible = records.filter((attention) => {
      const run = this.store.getObjectiveRun(attention.runId);
      return Boolean(run && this.objectiveVisibleToRequest(request, run));
    });
    return { attentions: visible.slice(0, query.limit), limit: query.limit } as unknown as JsonValue;
  }

  private objectiveAttentionDetail(request: IncomingMessage, runId: string, attentionId: string): JsonValue {
    this.reconcileObjectiveAttentionExpiry();
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, "read objective attention");
    const attention = this.store.getObjectiveAttention(attentionId, runId);
    if (!attention) throw new HttpError(404, `Objective attention not found: ${attentionId}`);
    return attention as unknown as JsonValue;
  }

  private objectiveAttentionActor(request: IncomingMessage, run: ObjectiveRunRecord, action: string): ObjectiveActor {
    const caller = this.objectiveCaller(request);
    if (!caller) return { type: "user", id: "local-user" };
    this.requireObjectiveAccess(request, run, action);
    return { type: "agent", id: caller.id };
  }

  private objectiveAttentionAuthority(request: IncomingMessage, run: ObjectiveRunRecord, action: string): ObjectiveActor {
    const actor = this.objectiveAttentionActor(request, run, action);
    if (actor.type === "agent" && run.conductorAgentId !== actor.id) {
      throw new HttpError(403, `Only the objective conductor may ${action} an attention item.`);
    }
    return actor;
  }

  private requestObjectiveAttention(request: IncomingMessage, runId: string, payload: unknown): JsonValue {
    const requestKey = this.requireIdempotencyKey(request);
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    const actor = this.objectiveAttentionActor(request, run, "request");
    let input: ObjectiveAttentionRequest;
    try {
      input = ObjectiveAttentionInputSchema.parse(payload);
    } catch {
      throw new HttpError(400, "Invalid objective attention request.");
    }
    const existingId = `attention:${createHash("sha256").update(`${runId}\u0000${requestKey}`).digest("hex")}`;
    const previous = this.store.getObjectiveAttention(existingId, runId);
    const attention = this.store.durableTransaction(() => {
      const created = this.objectiveAttention.create({
        objectiveId: run.objectiveId,
        runId,
        requestKey,
        requestedBy: actor,
        now: nowIso(),
        id: existingId,
      }, input);
      if (!previous) this.appendObjectiveAttentionEvent("objective.attention.requested", run, created, actor);
      return created;
    });
    return { attention, status: previous ? "replayed" : "committed", replayed: previous !== null } as unknown as JsonValue;
  }

  private resolveObjectiveAttention(request: IncomingMessage, runId: string, attentionId: string, payload: unknown): JsonValue {
    return this.objectiveCommandLedger(request, runId, "objective.attention.resolve", {
      attentionId,
      payload,
    }, ({ requestKey, run, actor }) => {
      const authorityActor = this.objectiveAttentionAuthority(request, run, "resolve");
      let input: ObjectiveAttentionResolveRequest;
      try {
        input = ObjectiveAttentionResolutionInputSchema.parse(payload);
      } catch {
        throw new HttpError(400, "Invalid objective attention resolution.");
      }
      const current = this.store.getObjectiveAttention(attentionId, runId);
      if (!current) throw new HttpError(404, `Objective attention not found: ${attentionId}`);
      const approval = this.attentionApprovalForRecord(run, current);
      const replayed = current.resolution?.requestKey === requestKey
        || (approval !== null && current.resolution?.requestKey === attentionApprovalResolutionKey(requestKey, attentionId));
      if (current.status !== "open" && !replayed) {
        throw new HttpError(409, `Objective attention ${attentionId} is already ${current.status}.`);
      }
      if (approval) {
        if (replayed && current.resolution && (
          current.resolution.status !== input.status
          || stableJson(current.resolution.decision) !== stableJson(input.decision ?? null)
        )) {
          throw new HttpError(409, "Objective attention resolution idempotency conflict.");
        }
        // Approval attention is still the same human control boundary as the
        // first-class approval route. A conductor agent may inspect it, but may
        // not use the inbox to bypass the existing local-user approval rule.
        if (authorityActor.type === "agent") throw new HttpError(403, "Only a local user may resolve approval attention.");
        if (!replayed && approval.status === "requested") {
          const approvalStatus = attentionApprovalStatus(input);
          if (!approvalStatus) {
            throw new HttpError(409, "No automated resolution exists for this attention item without an approved/rejected decision; use the objective approval command.");
          }
          const authority = this.objectiveAuthority(null);
          this.objectiveRuntime.resolveApproval(runId, approval.id, {
            status: approvalStatus,
            decision: input.decision ?? null,
            requestKey,
          }, authority);
        }
        const latestApproval = this.store.getObjectiveApproval(runId, approval.id) ?? approval;
        if (!replayed && latestApproval.status === "requested") {
          throw new HttpError(409, "Objective approval resolution did not settle the bound approval.");
        }
        const resolved = this.resolveAttentionForApproval(run, approval, latestApproval.status, input.decision ?? null, actor, requestKey);
        const attention = resolved.find((item) => item.id === attentionId) ?? this.store.getObjectiveAttention(attentionId, runId);
        if (!attention) throw new HttpError(500, "Objective approval resolved without an attention receipt.");
        return { status: "committed", result: { attention, status: "committed", replayed: false } as unknown as JsonValue };
      }
      // Generic recovery/native/budget/control attention has no safe generic
      // resume command. Refuse to manufacture a UI-only resolution; callers
      // must use the corresponding existing objective command or repair
      // evidence.
      throw new HttpError(409, "No automated resolution exists for this attention item; use the corresponding objective command or reconcile its durable evidence.");
    }, undefined, "Objective attention resolution idempotency conflict.");
  }

  private attentionApprovalForRecord(run: ObjectiveRunRecord, attention: ObjectiveAttentionRecord): ObjectiveApprovalRecord | null {
    return this.store.listObjectiveApprovals({ runId: run.runId, limit: 2_000 })
      .find((approval) => approval.operationId === attention.operationId) ?? null;
  }

  private resolveAttentionForApproval(
    run: ObjectiveRunRecord,
    approval: ObjectiveApprovalRecord,
    status: ObjectiveApprovalRecord["status"],
    decision: JsonValue,
    actor: ObjectiveActor,
    sourceRequestKey: string,
  ): ObjectiveAttentionRecord[] {
    const attentions = this.store.listObjectiveAttentions({ runId: run.runId, status: ["open"], limit: 2_000 })
      .filter((attention) => attention.operationId === approval.operationId);
    const attentionStatus: ObjectiveAttentionResolveRequest["status"] = status === "expired"
      ? "expired"
      : status === "cancelled"
        ? "cancelled"
        : "resolved";
    return attentions.map((attention) => {
      const requestKey = attentionApprovalResolutionKey(sourceRequestKey, attention.id);
      const resolved = this.objectiveAttention.resolve(run.runId, attention.id, {
        request: {
          status: attentionStatus,
          decision,
          evidenceRefs: [{ kind: "other", id: `approval:${approval.id}`, description: "Bound objective approval receipt." }],
        },
        resolvedBy: actor,
        now: nowIso(),
        requestKey,
      });
      this.appendObjectiveAttentionEvent("objective.attention.resolved", run, resolved, actor);
      return resolved;
    });
  }

  private appendObjectiveAttentionEvent(
    type: "objective.attention.requested" | "objective.attention.resolved" | "objective.attention.expired" | "objective.attention.escalated",
    run: ObjectiveRunRecord,
    attention: ObjectiveAttentionRecord,
    actor: ObjectiveActor,
  ): void {
    this.appendObjectiveEvent(type, run, actor, {
      objectiveId: attention.objectiveId,
      attentionId: attention.id,
      nodeId: attention.nodeId,
      attemptId: attention.attemptId,
      status: attention.status,
      risk: attention.risk,
      urgency: attention.urgency,
      confidence: attention.confidence,
      blockedResource: attention.blockedResource as unknown as JsonValue,
      proposedAction: attention.proposedAction,
      authorityBoundary: attention.authorityBoundary,
      evidenceRefs: attention.evidenceRefs as unknown as JsonValue,
      requestKey: attention.requestKey,
      resolution: attention.resolution as unknown as JsonValue,
    });
  }

  private objectiveArtifactList(request: IncomingMessage, runId: string, url: URL): JsonValue {
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, "read objective artifacts");
    const limit = z.coerce.number().int().min(1).max(2_000).default(500).parse(url.searchParams.get("limit") ?? 500);
    return {
      objectiveId: run.objectiveId,
      runId,
      artifacts: this.store.listObjectiveArtifacts({ runId, limit }),
    } as unknown as JsonValue;
  }

  private objectiveArtifactDetail(request: IncomingMessage, runId: string, artifactId: string): JsonValue {
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, "read objective artifacts");
    const artifact = this.store.getObjectiveArtifact(artifactId);
    if (!artifact || artifact.runId !== runId) throw new HttpError(404, `Objective artifact not found: ${artifactId}`);
    return {
      artifact,
      reviews: this.store.listObjectiveArtifactReviews(artifactId),
    } as unknown as JsonValue;
  }

  private objectiveArtifactAuthority(
    request: IncomingMessage,
    run: ObjectiveRunRecord,
    action: string,
  ): { actor: ObjectiveArtifactActor; caller: AgentRecord | null } {
    const caller = this.objectiveCaller(request);
    this.requireObjectiveAccess(request, run, action);
    if (caller) {
      // Agent workspace grants are capabilities. An agent cannot publish an
      // artifact from a different workspace merely by naming the objective.
      const workspace = run.policy?.workspace;
      if (workspace && !this.workspacePathWithin(caller.workspacePath, workspace.path)) {
        throw new HttpError(403, "Artifact action is outside the authenticated agent's objective workspace grant.");
      }
    }
    return { actor: caller ? { type: "agent", id: caller.id } : { type: "user", id: "local-user" }, caller };
  }

  private publishObjectiveArtifact(request: IncomingMessage, runId: string, payload: unknown): JsonValue {
    const requestKey = this.requireIdempotencyKey(request);
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    const { actor, caller } = this.objectiveArtifactAuthority(request, run, "publish objective artifacts");
    let parsed: z.infer<typeof ObjectiveArtifactPublishRequestSchema>;
    try {
      parsed = ObjectiveArtifactPublishRequestSchema.parse(payload);
    } catch {
      throw new HttpError(400, "Invalid objective artifact publication request.");
    }
    if (parsed.objectiveId !== undefined && parsed.objectiveId !== run.objectiveId) throw new HttpError(403, "Artifact objective identity does not match the run.");
    // Reconcile an exact retry before policy/capacity checks. A prior durable
    // receipt is authoritative even if another artifact has since consumed
    // the remaining storage envelope; a changed body under the same key is
    // still rejected as an idempotency conflict.
    const retryFingerprint = createHash("sha256").update(stableJsonStringify({
      runId,
      objectiveId: run.objectiveId,
      planRevision: parsed.planRevision,
      kind: parsed.kind,
      name: parsed.name,
      mediaType: parsed.mediaType,
      content: parsed.content,
      evidence: parsed.evidence,
      taskId: parsed.taskId ?? null,
      attemptId: parsed.attemptId ?? null,
      controlNodeId: parsed.controlNodeId ?? null,
      lineage: parsed.lineage,
      supersedes: parsed.supersedes,
      policyHash: parsed.policyHash ?? run.policyHash ?? null,
    })).digest("hex");
    const priorReceipt = this.store.getObjectiveArtifactReceipt(requestKey);
    if (priorReceipt) {
      if (priorReceipt.operation !== "publish" || priorReceipt.runId !== runId || priorReceipt.objectiveId !== run.objectiveId || priorReceipt.fingerprint !== retryFingerprint) {
        throw new HttpError(409, "Objective artifact publication idempotency conflict.");
      }
      const priorArtifact = this.store.getObjectiveArtifact(priorReceipt.artifactId);
      if (!priorArtifact) throw new HttpError(500, "Objective artifact publication receipt points to missing artifact.");
      const priorSuperseded = priorArtifact.supersedes
        ? this.store.listObjectiveArtifactReviews(priorArtifact.supersedes).filter((entry) => entry.state === "superseded")
        : [];
      return { status: "replayed", artifact: priorArtifact, superseded: priorSuperseded, reviews: priorSuperseded } as unknown as JsonValue;
    }
    if (!run.policy || !run.policyHash || !isObjectivePolicyHashValid(run.policy) || run.policy.policyHash !== run.policyHash) {
      throw new HttpError(409, "Objective artifact publication requires a valid immutable objective policy.");
    }
    if (run.policy.expiresAt !== null && Date.parse(run.policy.expiresAt) <= Date.now()) throw new HttpError(409, "Objective artifact policy has expired.");
    if (parsed.policyHash !== undefined && parsed.policyHash !== run.policyHash) throw new HttpError(403, "Artifact policy hash does not match the objective policy.");
    const canonicalSize = objectiveArtifactContentSize(parsed.content);
    if (canonicalSize > OBJECTIVE_ARTIFACT_MAX_INLINE_BYTES) throw new HttpError(413, "Inline objective artifact exceeds the daemon safety bound.");
    if (run.policy.budget.maxOutputBytes !== null && canonicalSize > run.policy.budget.maxOutputBytes) throw new HttpError(403, "Artifact exceeds the objective output-byte policy.");
    const storedBytes = this.store.listObjectiveArtifacts({ runId, limit: 5_000 }).reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    if (run.policy.budget.maxStorageBytes !== null && storedBytes + canonicalSize > run.policy.budget.maxStorageBytes) throw new HttpError(403, "Artifact exceeds the objective storage-byte policy.");
    if (parsed.evidence.eventCursor > this.store.latestCursor()) throw new HttpError(409, "Artifact evidence cursor is ahead of the durable event high-water mark.");
    if (parsed.evidence.eventIds.length > 0) {
      const events = this.store.eventsAfter(0, { runId, limit: 10_000 });
      const byId = new Map(events.map((event) => [event.id, event]));
      for (const eventId of parsed.evidence.eventIds) {
        const event = byId.get(eventId);
        if (!event) throw new HttpError(403, "Artifact evidence must reference events in the objective run.");
        if (event.cursor > parsed.evidence.eventCursor) throw new HttpError(409, "Artifact evidence cursor is behind a referenced event.");
      }
    }
    for (const observationId of parsed.evidence.observationIds) {
      const observation = this.store.getObservationById(observationId);
      const observationAgent = observation ? this.store.getAgent(observation.agentId) : null;
      if (!observation || !observationAgent || observationAgent.runId !== runId) throw new HttpError(403, "Artifact evidence must reference observations in the objective run.");
      if (observation.eventCursor > parsed.evidence.eventCursor) throw new HttpError(409, "Artifact evidence cursor is behind a referenced observation.");
    }

    const taskId = parsed.taskId ?? null;
    const task = taskId ? run.tasks.find((candidate) => candidate.task.id === taskId) : null;
    if (taskId && !task) throw new HttpError(404, `Objective task not found: ${taskId}`);
    const attemptId = parsed.attemptId ?? task?.attemptId ?? null;
    if (parsed.attemptId && (!task || task.attemptId !== parsed.attemptId)) throw new HttpError(403, "Artifact attempt is not the durable attempt assigned to the task.");
    if (task?.agentId) {
      const assignedProducer = this.store.getAgent(task.agentId);
      if (!assignedProducer || assignedProducer.runId !== runId || assignedProducer.workflowId !== run.workflowId) throw new HttpError(409, "Artifact producer is not a durable agent in this objective run.");
      if (run.policy.workspace && !this.workspacePathWithin(assignedProducer.workspacePath, run.policy.workspace.path)) throw new HttpError(403, "Artifact producer is outside the objective workspace grant.");
    }
    // A conductor may publish a child task's evidence; preserve the durable
    // assigned producer rather than attributing the output to the publisher.
    const producerAgentId = task?.agentId ?? caller?.id ?? null;
    if (caller && task?.agentId && task.agentId !== caller.id) {
      const producer = this.store.getAgent(task.agentId);
      if (!producer || !this.sharesAgentRoot(caller, producer)) throw new HttpError(403, "Artifact producer is outside the authenticated agent lineage.");
    }
    if (attemptId && (!task || task.attemptId !== attemptId || !task.agentId)) throw new HttpError(403, "Artifact attempt does not belong to a durable producer in this objective run.");
    if (parsed.controlNodeId) {
      const revision = this.store.getLatestObjectiveControlPlanRevision(runId);
      if (!revision || !this.objectiveControlNodeExists(revision.plan.root, parsed.controlNodeId)) throw new HttpError(404, `Objective control node not found: ${parsed.controlNodeId}`);
    }

    const artifact: ObjectiveArtifactRecord = ObjectiveArtifactRecordSchema.parse({
      version: 1,
      id: `artifact-${createHash("sha256").update(`${runId}\u0000${requestKey}`).digest("hex")}`,
      objectiveId: run.objectiveId,
      runId,
      planRevision: parsed.planRevision,
      taskId,
      producerAgentId,
      attemptId,
      controlNodeId: parsed.controlNodeId ?? null,
      kind: parsed.kind,
      name: parsed.name,
      mediaType: parsed.mediaType,
      content: parsed.content,
      hash: objectiveArtifactContentHash(parsed.content),
      sizeBytes: canonicalSize,
      evidence: parsed.evidence,
      lineage: parsed.lineage,
      supersedes: parsed.supersedes,
      reviewState: "pending",
      reviewReason: null,
      reviewedBy: null,
      reviewedAt: null,
      publishedBy: actor,
      publishedAt: nowIso(),
    });
    const fingerprint = retryFingerprint;
    return this.store.durableTransaction(() => {
      const result = this.store.publishObjectiveArtifact(artifact, { requestKey, fingerprint });
      if (result.status === "committed") {
        this.appendObjectiveEvent("objective.artifact.published", run, actor, {
          objectiveId: run.objectiveId,
          artifactId: result.artifact.id,
          hash: result.artifact.hash,
          kind: result.artifact.kind,
          name: result.artifact.name,
          mediaType: result.artifact.mediaType,
          sizeBytes: result.artifact.sizeBytes,
          planRevision: result.artifact.planRevision,
          evidence: result.artifact.evidence,
          supersedes: result.artifact.supersedes,
        });
        for (const review of result.superseded) this.appendObjectiveEvent("objective.artifact.superseded", run, review.actor, {
          objectiveId: run.objectiveId,
          artifactId: review.artifactId,
          supersededBy: result.artifact.id,
          reason: review.reason,
        });
      }
      return { ...result, reviews: result.superseded } as unknown as JsonValue;
    });
  }

  private reviewObjectiveArtifact(request: IncomingMessage, runId: string, artifactId: string, payload: unknown): JsonValue {
    return this.objectiveCommandLedger(request, runId, "objective.artifact.review", {
      artifactId,
      payload,
    }, ({ requestKey, run, actor }) => {
      const { actor: authorityActor } = this.objectiveArtifactAuthority(request, run, "review objective artifacts");
      let parsed: z.infer<typeof ObjectiveArtifactReviewRequestSchema>;
      try {
        parsed = ObjectiveArtifactReviewRequestSchema.parse({ ...(payload as Record<string, unknown>), artifactId });
      } catch {
        throw new HttpError(400, "Invalid objective artifact review request.");
      }
      const reviewRetryFingerprint = createHash("sha256").update(stableJsonStringify({ artifactId, state: parsed.state, reason: parsed.reason })).digest("hex");
      if (!run.policy || !run.policyHash || !isObjectivePolicyHashValid(run.policy) || run.policy.policyHash !== run.policyHash) {
        throw new HttpError(409, "Objective artifact review requires a valid immutable objective policy.");
      }
      if (run.policy.expiresAt !== null && Date.parse(run.policy.expiresAt) <= Date.now()) throw new HttpError(409, "Objective artifact policy has expired.");
      const artifact = this.store.getObjectiveArtifact(artifactId);
      if (!artifact || artifact.runId !== runId) throw new HttpError(404, `Objective artifact not found: ${artifactId}`);
      const review = ObjectiveArtifactReviewRecordSchema.parse({
        version: 1,
        id: `artifact-review-${createHash("sha256").update(`${artifactId}\u0000${requestKey}`).digest("hex")}`,
        artifactId,
        objectiveId: run.objectiveId,
        runId,
        fromState: artifact.reviewState,
        state: parsed.state,
        actor: authorityActor,
        reason: parsed.reason,
        requestKey,
        createdAt: nowIso(),
      });
      try {
        const result = this.store.reviewObjectiveArtifact(review, { fingerprint: reviewRetryFingerprint });
        if (result.status === "committed" && result.review) this.appendObjectiveEvent(`objective.artifact.${result.review.state}`, run, authorityActor, {
          objectiveId: run.objectiveId,
          artifactId,
          state: result.review.state,
          reason: result.review.reason,
          reviewId: result.review.id,
        });
        return { status: "committed", result: result as unknown as JsonValue };
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "Objective artifact review could not be committed.");
      }
    }, undefined, "Objective artifact review idempotency conflict.");
  }

  private objectiveControlNodeExists(node: unknown, id: string): boolean {
    if (!node || typeof node !== "object") return false;
    const candidate = node as Record<string, unknown>;
    if (candidate.id === id) return true;
    for (const key of ["steps", "then", "else"]) {
      const children = candidate[key];
      if (Array.isArray(children) && children.some((child) => this.objectiveControlNodeExists(child, id))) return true;
    }
    return false;
  }

  private workspacePathWithin(candidate: string, grant: string): boolean {
    const candidatePath = resolve(candidate);
    const grantPath = resolve(grant);
    const rel = relative(grantPath, candidatePath);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  }

  private objectiveCaller(request: IncomingMessage): AgentRecord | null {
    const callerId = request.headers["x-symphony-agent-id"];
    if (callerId === undefined) return null;
    const token = request.headers["x-symphony-agent-token"];
    if (typeof callerId !== "string" || typeof token !== "string") {
      throw new HttpError(401, "Invalid agent coordination token");
    }
    const caller = this.store.getAgent(callerId);
    if (!caller || !this.agents.authenticate(callerId, token)) {
      throw new HttpError(401, "Invalid agent coordination token");
    }
    return caller;
  }

  private objectiveVisibleToRequest(request: IncomingMessage, run: ObjectiveRunRecord): boolean {
    const caller = this.objectiveCaller(request);
    if (!caller) return true;
    const linkedAgentIds = new Set<string>();
    if (run.conductorAgentId) linkedAgentIds.add(run.conductorAgentId);
    for (const task of run.tasks) if (task.agentId) linkedAgentIds.add(task.agentId);
    // Include materialized run agents as a compatibility path while task
    // projections catch up after a restart or an in-flight assignment.
    for (const agent of this.store.listAgents({ runId: run.runId, limit: 2_000 })) linkedAgentIds.add(agent.id);
    return [...linkedAgentIds]
      .map((agentId) => this.store.getAgent(agentId))
      .some((agent): agent is AgentRecord => Boolean(agent && this.sharesAgentRoot(caller, agent)));
  }

  private requireObjectiveAccess(request: IncomingMessage, run: ObjectiveRunRecord, action: string): void {
    if (!this.objectiveVisibleToRequest(request, run)) {
      throw new HttpError(403, `An authenticated agent may ${action} only objectives in its root lineage.`);
    }
  }

  /**
   * Resolve workflow identity before ObjectiveRuntime admission. Registered
   * workflows are content-addressed durable records; an API caller may select
   * an existing revision but cannot supply a substitute hash. The only
   * unregistered exception is the explicit manual identity emitted by the
   * objective entry UI, derived from the objective id and fixed at revision 1.
   */
  private resolveObjectiveWorkflowIdentity(
    parsed: z.infer<typeof ObjectiveCreateInputSchema>,
    objectiveId: string,
    caller: AgentRecord | null,
  ): { workflowId: string; workflowRevision: number; workflowHash: string } {
    const requestedWorkflowId = caller?.workflowId ?? parsed.workflowId;
    if (!requestedWorkflowId) throw new HttpError(400, "Objective creation requires a workflow identity.");

    // A stored workflow id is authoritative even when a caller asks for a
    // revision that does not exist. Do not fall through to the manual rule.
    const latestStored = this.store.getWorkflow(requestedWorkflowId);
    if (latestStored) {
      const stored = this.store.getWorkflow(requestedWorkflowId, parsed.workflowRevision);
      if (!stored) {
        throw new HttpError(409, `Workflow ${requestedWorkflowId} revision ${parsed.workflowRevision} is not registered.`);
      }
      if (stored.hash !== parsed.workflowHash) {
        throw new HttpError(409, `Workflow ${requestedWorkflowId} revision ${stored.revision} hash does not match the stored workflow.`);
      }
      return { workflowId: stored.id, workflowRevision: stored.revision, workflowHash: stored.hash };
    }

    // Native callers may be operating against a legacy, unregistered
    // workflow run. Preserve that compatibility path, but never grant it to
    // a local user: local admission has one documented standalone identity.
    if (caller) {
      const lineage = this.store.getRun(caller.runId);
      if (lineage?.workflowId === requestedWorkflowId) {
        const lineageWorkflow = this.store.getWorkflow(requestedWorkflowId, lineage.workflowRevision);
        if (lineageWorkflow) {
          if (lineageWorkflow.hash !== parsed.workflowHash || lineageWorkflow.revision !== parsed.workflowRevision) {
            throw new HttpError(409, `Workflow ${requestedWorkflowId} revision/hash does not match the caller's stored workflow lineage.`);
          }
          return { workflowId: lineageWorkflow.id, workflowRevision: lineageWorkflow.revision, workflowHash: lineageWorkflow.hash };
        }
      }
      return {
        workflowId: requestedWorkflowId,
        workflowRevision: parsed.workflowRevision,
        workflowHash: parsed.workflowHash,
      };
    }

    const standalone = standaloneObjectiveWorkflowIdentity(objectiveId);
    if (
      requestedWorkflowId !== standalone.workflowId
      || parsed.workflowRevision !== standalone.workflowRevision
      || parsed.workflowHash !== standalone.workflowHash
    ) {
      throw new HttpError(
        409,
        `Unregistered objectives must use the explicit standalone workflow identity ${standalone.workflowId}@${standalone.workflowRevision}.`,
      );
    }
    return standalone;
  }

  /**
   * Bind a supplied conductor to a coherent, usable agent authority. A local
   * user has no ambient agent capability, so the pointer itself must prove a
   * valid root/lineage, workflow relationship, and workspace grant. An
   * authenticated agent may only nominate itself and must remain in its own
   * tree. Active statuses are admitted while a conductor is running; terminal
   * or idle conductors are admitted only when the coordinator still holds a
   * reusable native session.
   */
  private validateObjectiveConductor(
    requestedConductorAgentId: string | null,
    caller: AgentRecord | null,
    workflowId: string,
    objectiveWorkspace: WorkspaceSpec | null,
  ): string | null {
    if (caller && requestedConductorAgentId !== null && requestedConductorAgentId !== caller.id) {
      throw new HttpError(403, "An authenticated objective caller may only bind itself as conductor.");
    }
    const conductorAgentId = caller?.id ?? requestedConductorAgentId;
    if (!conductorAgentId) return null;
    const conductor = this.store.getAgent(conductorAgentId);
    if (!conductor) throw new HttpError(409, `Objective conductor agent not found: ${conductorAgentId}.`);
    if (caller && !this.sharesAgentRoot(caller, conductor)) {
      throw new HttpError(403, "Objective conductor must remain inside the authenticated caller's root lineage.");
    }

    const root = this.agentRoot(conductor);
    if (!root || root.id !== conductor.id || root.workflowId !== conductor.workflowId || root.runId !== conductor.runId) {
      throw new HttpError(409, "Objective conductor has an invalid root lineage.");
    }

    // A conductor normally comes from a chat workflow while the objective is
    // pinned to a saved/manual workflow. A non-chat conductor must instead be
    // on that exact workflow; this prevents a foreign workflow root from
    // being attached merely because an id was supplied.
    if (conductor.workflowId !== workflowId && !conductor.workflowId.startsWith("chat:")) {
      throw new HttpError(403, "Objective conductor is not bound to the requested workflow.");
    }

    const active = ["queued", "routing", "starting", "running", "waiting"].includes(conductor.status);
    const reusable = ["idle", "completed"].includes(conductor.status) && this.agents.hasSession(conductor.id);
    if (!active && !reusable) {
      throw new HttpError(409, "Objective conductor is not live or backed by a reusable native session.");
    }

    try {
      const conductorWorkspace = this.agentWorkspaceGrant(conductor);
      if (objectiveWorkspace && conductorWorkspace) {
        this.childWorkspaceGrant(conductorWorkspace, objectiveWorkspace);
      }
    } catch (error) {
      if (error instanceof HttpError) {
        throw new HttpError(403, `Objective conductor workspace is not eligible: ${error.message}`);
      }
      throw error;
    }
    return conductor.id;
  }

  /**
   * Check the immutable author pointer before probing conductor liveness. A
   * malformed conductor-authored plan must be rejected as an authority
   * violation even if the nominated conductor has since gone idle; otherwise
   * a forged author can be misclassified as a transient 409 and the caller can
   * learn lifecycle state that is irrelevant to its authorization.
   */
  private validateRequestedControlPlanAuthor(
    requestedPlan: ObjectiveControlPlan | null,
    requestedConductorAgentId: string | null,
    caller: AgentRecord | null,
  ): void {
    if (!requestedPlan || requestedPlan.source.kind !== "conductor-authored") return;
    if (
      requestedConductorAgentId === null
      || requestedPlan.source.authorAgentId !== requestedConductorAgentId
      || (caller !== null && caller.id !== requestedConductorAgentId)
    ) {
      throw new HttpError(403, "Conductor-authored control plans must be bound to the authenticated attached conductor.");
    }
  }

  /**
   * Control-plan admission is a security boundary, not a client-side hint.
   * Workflow-backed plans must exactly match the daemon's compilation of the
   * immutable stored workflow revision. Conductor-authored plans instead bind
   * to the authenticated attached conductor and still inherit node authority
   * limits before entering ObjectiveRuntime.
   */
  private validateObjectiveControlPlanAdmission(
    requestedPlan: ObjectiveControlPlan | null,
    workflow: { workflowId: string; workflowRevision: number; workflowHash: string },
    conductorAgentId: string | null,
    caller: AgentRecord | null,
    authority: ObjectiveRuntimeAuthority,
    policy: ObjectivePolicyRequest | undefined,
  ): ObjectiveControlPlan | null {
    if (!requestedPlan) return null;
    const plan = ObjectiveControlPlanSchema.parse(requestedPlan);
    if (plan.source.kind === "workflow-revision") {
      const stored = this.store.getWorkflow(workflow.workflowId, workflow.workflowRevision);
      if (!stored) {
        throw new HttpError(409, `Cannot admit a workflow-backed control plan without stored workflow ${workflow.workflowId}@${workflow.workflowRevision}.`);
      }
      const compiledWorkflow = new WorkflowCompiler().compile(stored.definition, stored.revision);
      if (compiledWorkflow.hash !== stored.hash || compiledWorkflow.hash !== workflow.workflowHash) {
        throw new HttpError(409, `Stored workflow ${workflow.workflowId}@${workflow.workflowRevision} failed its immutable hash check.`);
      }
      let canonical: ObjectiveControlPlan;
      try {
        canonical = compileObjectiveControlPlan(compiledWorkflow, {
          defaultMaxLoopIterations: this.loaded.config.workflows.maxLoopIterations,
        });
      } catch (error) {
        throw new HttpError(409, `Stored workflow ${workflow.workflowId}@${workflow.workflowRevision} cannot produce a control plan: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stableJson(plan) !== stableJson(canonical)) {
        throw new HttpError(409, "Workflow-backed control plans must equal the daemon-derived immutable workflow plan.");
      }
    } else {
      const conductor = conductorAgentId === null ? null : this.store.getAgent(conductorAgentId);
      if (
        conductor === null
        || plan.source.authorAgentId !== conductorAgentId
        || (caller !== null && caller.id !== conductorAgentId)
        || (plan.source.sessionId !== null && plan.source.sessionId !== conductor.nativeSessionId)
      ) {
        throw new HttpError(403, "Conductor-authored control plans must be bound to the authenticated attached conductor session.");
      }
    }

    // Runtime admission intersects the request with the authenticated
    // authority and daemon-wide policy. Mirror that intersection before the
    // plan reaches storage; otherwise a caller could submit a full-access
    // control tree while the global ceiling is read-only (or while its own
    // native token is read-only) and rely on the flat-task checks to miss it.
    const globalPolicy = this.objectiveGlobalPolicyCeiling();
    const permissionCeiling = [
      authority.permissionCeiling,
      authority.policy?.effectivePermission,
      globalPolicy.effectivePermission,
      policy?.effectivePermission,
    ].includes("read-only")
      ? "read-only"
      : "full-access";
    const allowedCapabilities = (authority.allowedCapabilities ?? []).filter(
      (capability) => policy?.allowedCapabilities === undefined || policy.allowedCapabilities.includes(capability),
    );
    const visit = (node: ObjectiveControlNode): void => {
      if (node.type === "agent") {
        if (node.permissions === "full-access" && permissionCeiling !== "full-access") {
          throw new HttpError(403, `Control node ${node.id} requests full-access above the objective authority ceiling.`);
        }
        for (const capability of node.capabilities ?? []) {
          if (!allowedCapabilities.includes(capability)) {
            throw new HttpError(403, `Control node ${node.id} requests unavailable capability ${capability}.`);
          }
        }
        if (node.workspace) {
          if (!authority.workspace) throw new HttpError(403, `Control node ${node.id} requests a workspace without an objective grant.`);
          this.childWorkspaceGrant(authority.workspace, node.workspace);
        }
      }
      if (node.type === "sequence" || node.type === "parallel" || node.type === "while") node.steps.forEach(visit);
      else if (node.type === "if") {
        node.then.forEach(visit);
        node.else?.forEach(visit);
      }
    };
    visit(plan.root);
    return plan;
  }

  private createObjective(request: IncomingMessage, payload: unknown): ObjectiveRunRecord {
    const requestKey = this.requireIdempotencyKey(request);
    const parsed = ObjectiveCreateInputSchema.parse(payload);
    const caller = this.objectiveCaller(request);
    if (parsed.objectiveId !== undefined && parsed.objectiveId !== parsed.spec.id) {
      throw new HttpError(400, "Objective id must match spec.id.");
    }
    // ObjectiveSpec is the canonical intent identity. Always pass the same
    // value downstream, including when an older caller omitted objectiveId.
    const objectiveId = parsed.spec.id;
    const workflow = this.resolveObjectiveWorkflowIdentity(parsed, objectiveId, caller);
    const workspaceGrant = this.objectiveWorkspaceGrantForCreate(parsed, caller);
    this.validateRequestedControlPlanAuthor(parsed.controlPlan ?? null, parsed.conductorAgentId ?? null, caller);
    const conductorAgentId = this.validateObjectiveConductor(
      parsed.conductorAgentId ?? null,
      caller,
      workflow.workflowId,
      workspaceGrant,
    );
    const tasks = this.normalizeObjectiveTasks(parsed.tasks ?? [], workspaceGrant, caller);
    const authority = this.objectiveAuthority(caller, this.effectiveWorkspaceGrant(workspaceGrant, caller));
    const controlPlan = this.validateObjectiveControlPlanAdmission(
      parsed.controlPlan ?? null,
      workflow,
      conductorAgentId,
      caller,
      authority,
      parsed.policy,
    );

    // A caller may retry or choose a stable run ID, but an agent may never
    // use creation as a way to attach itself to an unrelated objective tree.
    const existingByKey = this.store.getObjectiveRunByRequestKey(requestKey);
    if (caller && existingByKey) this.requireObjectiveAccess(request, existingByKey, "create an objective");
    if (caller && parsed.runId) {
      const existingByRunId = this.store.getObjectiveRun(parsed.runId);
      if (existingByRunId) this.requireObjectiveAccess(request, existingByRunId, "create an objective");
    }

    return this.store.durableTransaction(() => {
      // Select or append the immutable objective mission revision while the
      // same SQLite transaction also admits the run and occurrence. A crash
      // cannot leave an aggregate revision without its run or vice versa.
      const objectiveRevision = this.objectiveRevisionForCreate(
        objectiveId,
        parsed.spec,
        workspaceGrant,
        parsed.policy ?? null,
        authority.actor,
        requestKey,
      );
      const input: ObjectiveCreateInput = {
        ...(parsed.runId !== undefined ? { runId: parsed.runId } : {}),
        objectiveId,
        objectiveRevision,
        ...(parsed.tasks !== undefined ? { tasks } : {}),
        ...(parsed.context !== undefined ? { context: parsed.context } : {}),
        // Workflow identity and the conductor pointer are capability data,
        // never agent-authored fields. Preserve the caller's current workflow
        // lineage even when a hostile body supplies another workflow or pointer.
        workflowId: workflow.workflowId,
        workflowRevision: workflow.workflowRevision,
        workflowHash: workflow.workflowHash,
        conductorAgentId,
        workspace: workspaceGrant,
        ...(parsed.policy !== undefined ? { policy: parsed.policy } : {}),
        ...(controlPlan !== null ? { controlPlan } : {}),
        spec: parsed.spec,
        requestKey,
      };
      const replayed = this.objectiveRepository.getObjectiveActionReceipt(requestKey);
      const run = this.objectiveRuntime.create(input, authority);
      if (workspaceGrant) this.saveObjectiveWorkspaceGrant(run.runId, workspaceGrant, caller);
      this.saveObjectiveRunOccurrence(run, parsed.occurrence, authority.actor);
      if (!replayed) {
        this.appendObjectiveEvent("objective.created", run, authority.actor, {
          objectiveId: run.objectiveId,
          requestKey,
          workflowRevision: run.workflowRevision,
          workflowHash: run.workflowHash,
          conductorAgentId: run.conductorAgentId,
          state: run.state,
        });
        const revision = this.store.getObjectiveRevision(run.objectiveId, run.objectiveRevision ?? objectiveRevision);
        if (revision?.requestKey === requestKey) {
          this.appendObjectiveEvent("objective.revision.accepted", run, authority.actor, {
            objectiveId: run.objectiveId,
            requestKey,
            revision: revision.revision,
            revisionId: revision.id,
          });
        }
        this.appendObjectiveApprovalRequestedEvent(null, run, authority.actor);
      }
      return run;
    });
  }

  /** Select an existing mission revision or append one under the aggregate CAS. */
  private objectiveRevisionForCreate(
    objectiveId: string,
    spec: z.infer<typeof ObjectiveSpecSchema>,
    workspace: WorkspaceSpec | null,
    policy: ObjectivePolicyRequest | null,
    actor: ObjectiveActor,
    requestKey: string,
  ): number {
    const existing = this.store.getObjectiveAggregate(objectiveId);
    const now = nowIso();
    if (!existing) {
      const aggregate = ObjectiveAggregateRecordSchema.parse({
        version: 1,
        id: `objective:${objectiveId}`,
        objectiveId,
        activeRevision: 1,
        spec,
        statement: spec.statement,
        criteria: spec.criteria,
        policy,
        state: "active",
        latestRunId: null,
        latestOutcome: null,
        workspace,
        createdAt: now,
        updatedAt: now,
      });
      this.store.saveObjectiveAggregate(aggregate);
      const revision = ObjectiveRevisionRecordSchema.parse({
        version: 1,
        id: `objective-revision:${objectiveId}:1`,
        objectiveId,
        revision: 1,
        spec,
        workspace,
        createdBy: actor,
        requestKey,
        createdAt: now,
      });
      this.store.saveObjectiveRevision(revision);
      return 1;
    }

    if (stableJsonStringify(existing.workspace) !== stableJsonStringify(workspace)) {
      throw new HttpError(409, `Objective ${objectiveId} has an immutable workspace grant.`);
    }
    const current = this.store.getObjectiveRevision(objectiveId, existing.activeRevision);
    if (current && stableJsonStringify({ spec, workspace }) === stableJsonStringify({ spec: current.spec, workspace: current.workspace })) {
      return existing.activeRevision;
    }
    const nextRevision = existing.activeRevision + 1;
    const revision = ObjectiveRevisionRecordSchema.parse({
      version: 1,
      id: `objective-revision:${objectiveId}:${nextRevision}`,
      objectiveId,
      revision: nextRevision,
      spec,
      workspace,
      createdBy: actor,
      requestKey,
      createdAt: now,
    });
    try {
      this.store.saveObjectiveRevision(revision);
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : "Objective revision could not be committed.");
    }
    this.store.saveObjectiveAggregate({
      ...existing,
      activeRevision: nextRevision,
      spec,
      statement: spec.statement,
      criteria: spec.criteria,
      policy,
      state: existing.state === "abandoned" || existing.state === "superseded" ? "active" : existing.state,
      updatedAt: now,
    });
    return nextRevision;
  }

  /** Materialize the causal run occurrence after run identity is known. */
  private saveObjectiveRunOccurrence(
    run: ObjectiveRunRecord,
    requested: ObjectiveRunOccurrenceInput | undefined,
    actor: ObjectiveActor,
  ): void {
    const input = requested ?? {};
    const parsed = ObjectiveRunOccurrenceInputSchema.parse(input);
    const checkRelated = (id: string | null | undefined, label: string): void => {
      if (!id) return;
      const related = this.store.getObjectiveRunOccurrenceById(id);
      if (related && related.objectiveId !== run.objectiveId) throw new HttpError(403, `${label} belongs to another objective.`);
    };
    checkRelated(parsed.parentOccurrenceId, "Parent occurrence");
    checkRelated(parsed.forkedFromOccurrenceId, "Fork source occurrence");
    checkRelated(parsed.supersedesOccurrenceId, "Superseded occurrence");
    for (const [value, label] of [[parsed.parentRunId, "Parent run"], [parsed.forkedFromRunId, "Fork source run"], [parsed.supersedesRunId, "Superseded run"]] as const) {
      if (!value) continue;
      const related = this.store.getObjectiveRun(value);
      if (related && related.objectiveId !== run.objectiveId) throw new HttpError(403, `${label} belongs to another objective.`);
    }
    const occurrence = ObjectiveRunOccurrenceRecordSchema.parse({
      version: 1,
      id: `objective-occurrence:${run.runId}`,
      objectiveId: run.objectiveId,
      runId: run.runId,
      objectiveRevision: run.objectiveRevision ?? this.store.getObjectiveAggregate(run.objectiveId)?.activeRevision ?? 1,
      kind: parsed.kind,
      occurrenceKey: parsed.occurrenceKey ?? null,
      triggerId: parsed.triggerId ?? null,
      parentOccurrenceId: parsed.parentOccurrenceId ?? null,
      parentRunId: parsed.parentRunId ?? null,
      forkedFromOccurrenceId: parsed.forkedFromOccurrenceId ?? null,
      forkedFromRunId: parsed.forkedFromRunId ?? null,
      supersedesOccurrenceId: parsed.supersedesOccurrenceId ?? null,
      supersedesRunId: parsed.supersedesRunId ?? null,
      input: parsed.input ?? run.context,
      outcome: objectiveOccurrenceOutcomeFromRunState(run.state),
      output: run.output,
      error: run.error,
      scheduledAt: parsed.scheduledAt ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
    this.store.saveObjectiveRunOccurrence(occurrence);
    // A supersede edge is also reflected on the prior occurrence. This is a
    // history projection only; the old ObjectiveRunRecord remains immutable.
    if (occurrence.supersedesOccurrenceId || occurrence.supersedesRunId) {
      const prior = occurrence.supersedesOccurrenceId
        ? this.store.getObjectiveRunOccurrenceById(occurrence.supersedesOccurrenceId)
        : occurrence.supersedesRunId ? this.store.getObjectiveRunOccurrence(occurrence.supersedesRunId) : null;
      if (prior && prior.objectiveId === run.objectiveId && prior.outcome !== "superseded") {
        this.store.markObjectiveRunOccurrenceSuperseded(prior.id, run.updatedAt);
      }
    }
  }

  private objectiveAggregateSnapshot(request: IncomingMessage, objectiveId: string): JsonValue {
    const runs = this.store.listObjectiveRuns({ objectiveId, limit: 2_000 });
    const caller = this.objectiveCaller(request);
    if (caller && !runs.some((run) => this.objectiveVisibleToRequest(request, run))) {
      throw new HttpError(403, "An authenticated agent may read only objectives in its root lineage.");
    }
    const snapshot = this.store.objectiveAggregateSnapshot(objectiveId);
    if (!snapshot) throw new HttpError(404, `Objective not found: ${objectiveId}`);
    // The store snapshot is one SQLite-fenced input bundle. Projecting after
    // the read keeps workflow pure and avoids a storage -> workflow cycle;
    // every child projection receives the same eventCursor from this bundle.
    const projected = projectObjectiveAggregateSnapshot(snapshot);
    const feedback = this.capabilityResultFeedback.objectiveSnapshot(objectiveId);
    return ObjectiveAggregateSnapshotSchema.parse({
      ...snapshot,
      ...projected,
      capabilityResultFeedback: feedback,
    }) as unknown as JsonValue;
  }

  private commitObjectivePlan(request: IncomingMessage, runId: string, payload: unknown): ObjectiveRunRecord {
    const requestKey = this.requireIdempotencyKey(request);
    const parsed = ObjectivePlanInputSchema.parse(payload);
    const { run, caller } = this.objectiveMutationContext(request, runId, "mutate");
    const existingGrant = this.objectiveWorkspaceGrant(run.runId);
    const workspaceGrant = existingGrant ?? this.objectiveWorkspaceGrantForPlan(parsed.tasks, caller);
    const tasks = this.normalizeObjectiveTasks(parsed.tasks, workspaceGrant, caller);
    const authority = this.objectiveAuthority(caller, this.effectiveWorkspaceGrant(workspaceGrant, caller));
    return this.store.durableTransaction(() => {
      const replayed = this.objectiveRepository.getObjectiveActionReceipt(requestKey);
      const planInput: ObjectivePlanCommitInput = {
        expectedPlanRevision: parsed.expectedPlanRevision,
        tasks,
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
        ...(parsed.policyHash !== undefined
          ? { policyHash: parsed.policyHash }
          : run.policyHash
            ? { policyHash: run.policyHash }
            : {}),
        requestKey,
      };
      const next = this.objectiveRuntime.commitPlan(runId, planInput, authority);
      if (!existingGrant && workspaceGrant) this.saveObjectiveWorkspaceGrant(run.runId, workspaceGrant, caller);
      if (!replayed) {
        this.appendObjectiveEvent("objective.plan.committed", next, authority.actor, {
          objectiveId: next.objectiveId,
          requestKey,
          previousPlanRevision: run.activePlanRevision,
          planRevision: next.activePlanRevision,
          taskIds: next.tasks.slice(run.tasks.length).map((record) => record.task.id),
          state: next.state,
          reason: parsed.reason ?? null,
        });
        this.appendObjectiveApprovalRequestedEvent(run, next, authority.actor);
      }
      return next;
    });
  }

  private commitObjectiveCheckpoint(request: IncomingMessage, runId: string, payload: unknown): ObjectiveRunRecord {
    const requestKey = this.requireIdempotencyKey(request);
    const parsed = ObjectiveCheckpointInputSchema.parse(payload);
    const { run, authority } = this.objectiveMutationContext(request, runId, "checkpoint");
    return this.store.durableTransaction(() => {
      const replayed = this.objectiveRepository.getObjectiveActionReceipt(requestKey);
      // A cursor is a durable high-water mark, not a caller-supplied claim
      // about the future. Validate it while the write transaction is held so
      // a terminal event cannot race this checkpoint after the proof below.
      if (parsed.eventCursor > this.store.latestCursor()) {
        throw new ObjectiveRuntimeError(
          `Objective checkpoint event cursor ${parsed.eventCursor} is ahead of the durable event high-water mark.`,
          "revision-conflict",
        );
      }
      const terminalEvidence = this.assertPublicObjectiveCheckpointEvidence(
        this.store.getObjectiveRun(runId) ?? run,
        parsed.taskUpdates ?? [],
        parsed.eventCursor,
      );
      const evidenceEventIds = Object.values(terminalEvidence).flat();
      // Objective context is the existing durable place for evidence that is
      // not tied to a single criterion. Preserve the caller's context while
      // writing only event IDs returned by the durable evidence query.
      const checkpointContext = evidenceEventIds.length > 0
        ? {
            ...(parsed.context ?? {}),
            evidence: { eventCursor: parsed.eventCursor, eventIds: evidenceEventIds },
          }
        : parsed.context;
      const checkpointInput: ObjectiveCheckpointInput = {
        eventCursor: parsed.eventCursor,
        ...(parsed.policyHash !== undefined
          ? { policyHash: parsed.policyHash }
          : run.policyHash
            ? { policyHash: run.policyHash }
            : {}),
        ...(checkpointContext !== undefined ? { context: checkpointContext } : {}),
        ...(parsed.taskUpdates !== undefined
          ? {
              taskUpdates: parsed.taskUpdates.map((update) => ({
                taskId: update.taskId,
                state: update.state,
                ...(update.attemptId !== undefined ? { attemptId: update.attemptId } : {}),
                ...(update.agentId !== undefined ? { agentId: update.agentId } : {}),
                ...(update.output !== undefined ? { output: update.output } : {}),
                ...(update.error !== undefined ? { error: update.error } : {}),
                ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
                ...(update.finishedAt !== undefined ? { finishedAt: update.finishedAt } : {}),
              })),
            }
          : {}),
        reason: parsed.reason,
        requestKey,
        ...this.deriveObjectiveCheckpointEvidence(run, authority, parsed.eventCursor, evidenceEventIds),
      };
      const next = this.objectiveRuntime.checkpoint(runId, checkpointInput, authority);
      const committedCheckpoint = next.latestCheckpointId ? this.store.getObjectiveCheckpoint(runId, next.latestCheckpointId) : null;
      if (!committedCheckpoint || !ObjectivePortableCheckpointRecordSchema.safeParse(committedCheckpoint).success) {
        throw new HttpError(409, "Objective checkpoint did not commit a complete portable recovery boundary.");
      }
      if (!replayed) {
        this.appendObjectiveEvent("objective.checkpoint.committed", next, authority.actor, {
          objectiveId: next.objectiveId,
          requestKey,
          checkpointId: next.latestCheckpointId,
          eventCursor: parsed.eventCursor,
          planRevision: next.activePlanRevision,
          state: next.state,
          reason: parsed.reason,
          continuity: committedCheckpoint.continuity ?? { status: "unknown", capabilities: [], reason: "Unavailable" },
          artifactHashes: committedCheckpoint.artifactHashes ?? [],
          ...(Object.keys(terminalEvidence).length > 0
            ? {
                evidenceEventIds,
                evidenceByTask: terminalEvidence,
              }
            : {}),
        });
        this.appendObjectiveApprovalRequestedEvent(run, next, authority.actor);
      }
      return next;
    });
  }

  private deriveObjectiveCheckpointEvidence(
    run: ObjectiveRunRecord,
    authority: ObjectiveRuntimeAuthority,
    eventCursor: number,
    evidenceEventIds: readonly string[] = [],
  ): Pick<ObjectiveCheckpointInput, "objectiveRevision" | "workflowRevision" | "workflowHash" | "controlPlanRevision" | "controlPlanHash" | "artifactHashes" | "workspaceEvidence" | "nativeSessions" | "continuity" | "unresolvedExternalOperations" | "policySnapshotHash" | "configSnapshotHash" | "attemptHighWater" | "eventHighWater" | "provenance"> {
    const controlHead = this.store.getObjectiveControlHead(run.runId);
    const controlRevision = controlHead ? this.store.getObjectiveControlPlanRevision(run.runId, controlHead.activeRevision) : null;
    const artifactHashes = this.store.listObjectiveArtifacts({ runId: run.runId, limit: 2_000 }).map((artifact) => ({ id: artifact.id, hash: artifact.hash }));
    const nativeSessions: NonNullable<ObjectiveCheckpointRecord["nativeSessions"]> = [];
    for (const task of run.tasks) {
      if (!task.agentId) continue;
      const agent = this.store.getAgent(task.agentId);
      if (!agent) continue;
      const lease = this.store.listWorkerProcessLeases({ agentId: agent.id }).at(-1) ?? null;
      const strongTransport = lease?.transport.kind === "worker-host"
        && lease.transport.hostIdentity?.verification === "strong"
        && lease.transport.workerIdentity?.verification === "strong";
      const proven = Boolean(agent.nativeSessionId && strongTransport && ["running", "orphaned"].includes(lease?.state ?? ""));
      nativeSessions.push({
        agentId: agent.id,
        attemptId: task.attemptId,
        nativeSessionId: agent.nativeSessionId,
        nativeRunId: agent.nativeRunId,
        continuity: proven ? "proven" : "unknown",
        continuityCapabilities: [
          ...(agent.nativeSessionId ? ["native-session-id"] : []),
          ...(strongTransport ? ["worker-host-adoption", "durable-event-replay"] : []),
        ],
        evidence: lease?.lastEventCursor === null || lease?.lastEventCursor === undefined ? [] : [`cursor:${lease.lastEventCursor}`],
      });
    }
    const allProven = nativeSessions.length > 0 && nativeSessions.every((session) => session.continuity === "proven");
    const continuity: NonNullable<ObjectiveCheckpointRecord["continuity"]> = {
      status: allProven ? "proven" : "unknown",
      capabilities: [...new Set(nativeSessions.flatMap((session) => session.continuityCapabilities))],
      reason: allProven ? null : "At least one native session lacks strong retained transport/session continuity evidence.",
    };
    const workspace = authority.workspace ?? run.policy?.workspace ?? null;
    const workspaceEvidence: NonNullable<ObjectiveCheckpointRecord["workspaceEvidence"]> = {
      canonicalGrant: workspace,
      git: captureGitWorkspaceEvidence(workspace?.path ?? null),
      dirty: null,
      patchHash: null,
      worktree: null,
    };
    workspaceEvidence.dirty = workspaceEvidence.git.dirty;
    workspaceEvidence.patchHash = workspaceEvidence.git.patchHash;
    workspaceEvidence.worktree = workspaceEvidence.git.worktree;
    const unresolvedExternalOperations: NonNullable<ObjectiveCheckpointInput["unresolvedExternalOperations"]> = this.store
      .listObjectiveApprovals({ runId: run.runId, limit: 2_000 })
      .filter((approval) => approval.status === "requested" && ["external", "irreversible"].includes(approval.sideEffectClass))
      .map((approval) => ({
        operationId: approval.operationId,
        idempotencyKey: approval.requestKey,
        requestHash: approval.requestHash,
        receipt: null,
        status: "unresolved" as const,
      }));
    const configSnapshotHash = createHash("sha256").update(stableJsonStringify(this.loaded.config)).digest("hex");
    return {
      objectiveRevision: run.objectiveRevision ?? 1,
      workflowRevision: run.workflowRevision,
      workflowHash: run.workflowHash,
      controlPlanRevision: controlHead?.activeRevision ?? null,
      controlPlanHash: controlRevision?.hash ?? null,
      artifactHashes,
      workspaceEvidence,
      nativeSessions,
      continuity,
      unresolvedExternalOperations,
      policySnapshotHash: run.policyHash ?? null,
      configSnapshotHash,
      attemptHighWater: eventCursor,
      eventHighWater: eventCursor,
      provenance: {
        source: "daemon",
        actor: authority.actor,
        capturedAt: nowIso(),
        evidenceEventIds: [...evidenceEventIds],
        parentCheckpointId: run.latestCheckpointId,
        baseCheckpointId: run.latestCheckpointId,
      },
    };
  }

  /** Read one checkpoint with an explicit portability/capability projection. */
  private objectiveCheckpointDetail(request: IncomingMessage, runId: string, checkpointId: string): JsonValue {
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, "read an objective checkpoint");
    const checkpoint = this.store.getObjectiveCheckpoint(runId, checkpointId);
    if (!checkpoint) throw new HttpError(404, `Objective checkpoint not found: ${checkpointId}`);
    const portable = ObjectivePortableCheckpointRecordSchema.safeParse(checkpoint);
    return {
      runId,
      objectiveId: run.objectiveId,
      checkpoint,
      portable: portable.success,
      capability: portable.success
        ? portable.data.continuity ?? { status: "unknown", capabilities: [], reason: "Unavailable" }
        : { status: "legacy", reason: "This checkpoint predates portable recovery evidence." },
      commands: {
        resume: portable.success && portable.data.continuity?.status === "proven",
        retry: portable.success,
        fork: portable.success,
      },
    } as unknown as JsonValue;
  }

  /**
   * Offer an immutable, driver-neutral handoff at a committed checkpoint.
   * Handoffs carry references to durable evidence and workspace state; they
   * never copy a native transcript or claim that a process can be rewound.
   */
  private offerObjectiveHandoff(request: IncomingMessage, runId: string, payload: unknown): JsonValue {
    const requestKey = this.requireIdempotencyKey(request);
    const caller = this.objectiveCaller(request);
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, "offer an objective handoff");
    this.requireFullAccessAgent(request, "offer an objective handoff");

    let input: ObjectiveHandoffCreateInput;
    try {
      input = ObjectiveHandoffCreateInputSchema.parse(payload);
    } catch {
      throw new HttpError(400, "Invalid typed objective handoff request.");
    }
    const inputHash = objectiveHandoffReferenceHash(input);
    const prior = this.store.getObjectiveHandoffByRequestKey(runId, requestKey);
    if (prior) {
      if (prior.inputHash !== inputHash) throw new HttpError(409, "Objective handoff request key is already bound to a different request.");
      return {
        status: "replayed",
        envelope: prior,
        acceptance: this.store.getObjectiveHandoffAcceptance(prior.id),
        execution: null,
      } as unknown as JsonValue;
    }

    const policy = run.policy;
    if (!policy || !run.policyHash || !isObjectivePolicyHashValid(policy) || policy.policyHash !== run.policyHash || !/^[a-f0-9]{64}$/u.test(run.policyHash)) {
      throw new HttpError(409, "Objective handoff requires a current, hash-verifiable objective policy.");
    }
    const checkpoint = this.requirePortableObjectiveCheckpoint(run, input.checkpointId);
    if (!checkpoint.configSnapshotHash || !/^[a-f0-9]{64}$/u.test(checkpoint.configSnapshotHash)) {
      throw new HttpError(409, "Objective handoff requires a hash-verifiable configuration snapshot reference.");
    }
    if (input.taskId !== undefined && input.taskId !== null) {
      const task = run.tasks.find((candidate) => candidate.task.id === input.taskId);
      if (!task) throw new HttpError(409, `Objective handoff task is not part of run ${runId}: ${input.taskId}`);
      if (input.attemptId !== undefined && input.attemptId !== null && task.attemptId !== input.attemptId) {
        throw new HttpError(409, `Objective handoff attempt does not match task ${input.taskId}.`);
      }
    }
    if (input.nodeId !== undefined && input.nodeId !== null) {
      const head = this.store.getObjectiveControlHead(runId);
      const revision = head ? this.store.getObjectiveControlPlanRevision(runId, head.activeRevision) : null;
      if (!revision || !this.objectiveControlNodeExists(revision.plan.root, input.nodeId)) {
        throw new HttpError(409, `Objective handoff node is not part of the current control plan: ${input.nodeId}`);
      }
    }

    const sourceTask = input.taskId === undefined || input.taskId === null
      ? null
      : run.tasks.find((candidate) => candidate.task.id === input.taskId) ?? null;
    const sourceAgent = sourceTask?.agentId
      ? this.store.getAgent(sourceTask.agentId)
      : run.conductorAgentId
        ? this.store.getAgent(run.conductorAgentId)
        : caller;
    if (!sourceAgent) throw new HttpError(409, "Objective handoff source has no durable native agent identity.");
    // The caller was already authorized above. Keep the source binding
    // explicit rather than inferring lineage from a transcript or label.
    if (sourceAgent.runId !== runId || sourceAgent.workflowId !== run.workflowId) {
      throw new HttpError(403, "Objective handoff source agent is outside this objective run.");
    }
    const sourceHarness = sourceAgent.harness ?? (sourceAgent.requestedHarness === "auto" ? null : sourceAgent.requestedHarness);
    if (!sourceHarness) throw new HttpError(409, "Objective handoff source harness is unresolved; native continuity cannot be proven.");
    const nativeSessions = checkpoint.nativeSessions ?? [];
    const continuityEvidence = checkpoint.continuity ?? { status: "unknown" as const, capabilities: [], reason: "Unavailable" };
    const sourceSession = nativeSessions.find((session) => session.agentId === sourceAgent.id) ?? null;
    const continuityStatus = sourceSession?.continuity ?? "unknown";
    const continuityCapabilities = sourceSession?.continuityCapabilities ?? continuityEvidence.capabilities;

    const targetAgent = input.target.agentId ? this.store.getAgent(input.target.agentId) : null;
    if (input.target.agentId && !targetAgent) throw new HttpError(409, `Objective handoff target agent not found: ${input.target.agentId}`);
    if (targetAgent && (targetAgent.runId !== runId || (caller && !this.sharesAgentRoot(caller, targetAgent)))) {
      throw new HttpError(403, "Objective handoff target agent is outside the objective root lineage.");
    }
    const targetHarness = targetAgent?.harness ?? (targetAgent?.requestedHarness === "auto" ? null : targetAgent?.requestedHarness) ?? input.target.harness;
    if (!targetHarness || targetHarness !== input.target.harness) {
      throw new HttpError(409, `Objective handoff target harness ${input.target.harness} is not the target agent's resolved harness.`);
    }
    const targetOrder = targetAgent
      ? AgentWorkOrderSchema.safeParse(this.store.getMetadata<JsonValue>(`work-order:${targetAgent.id}`))
      : null;
    const availableCapabilities = targetOrder?.success && targetOrder.data.capabilities
      ? targetOrder.data.capabilities
      : policy.allowedCapabilities ?? [];
    const targetPermission = input.target.permission ?? targetAgent?.permissions ?? policy.effectivePermission;
    const targetModel = input.target.model === "auto"
      ? targetAgent?.model ?? targetAgent?.requestedModel ?? "auto"
      : input.target.model;
    if (targetAgent && input.target.model !== "auto" && targetAgent.model !== null && targetAgent.model !== input.target.model) {
      throw new HttpError(409, "Objective handoff target model does not match the native agent assignment.");
    }
    if (targetPermission === "full-access" && policy.effectivePermission !== "full-access") {
      throw new HttpError(403, "Objective handoff target requests full-access above the objective policy.");
    }
    if (targetAgent && targetPermission === "full-access" && targetAgent.permissions !== "full-access") {
      throw new HttpError(403, "Objective handoff target requests more permission than its native grant.");
    }
    const targetCapabilities = input.target.requiredCapabilities;
    const missingTargetCapabilities = targetCapabilities.filter((capability) => !availableCapabilities.includes(capability));
    if (missingTargetCapabilities.length > 0) {
      throw new HttpError(403, `Objective handoff target is missing required capabilities: ${missingTargetCapabilities.join(", ")}.`);
    }
    const targetCeiling = input.target.sideEffectClassCeiling ?? policy.sideEffectClassCeiling;
    if (sideEffectRank(targetCeiling) > sideEffectRank(policy.sideEffectClassCeiling)) {
      throw new HttpError(403, "Objective handoff target exceeds the objective side-effect ceiling.");
    }

    const parent = input.parentHandoffId ? this.store.getObjectiveHandoff(input.parentHandoffId) : null;
    if (input.parentHandoffId && (!parent || parent.runId !== runId || parent.objectiveId !== run.objectiveId)) {
      throw new HttpError(409, "Objective handoff parent is missing or belongs to another objective lineage.");
    }
    const chain = parent ? [parent.id, ...parent.lineage.chain] : [];
    if (chain.length > 128) throw new HttpError(409, "Objective handoff lineage exceeds the durable chain limit.");

    const eventRefs = input.evidenceEventIds.map((id) => {
      const event = this.store.getEventById(id);
      if (!event || event.runId !== runId || event.cursor > checkpoint.eventCursor) {
        throw new HttpError(409, `Objective handoff event evidence is unavailable: ${id}`);
      }
      return { id: event.id, cursor: event.cursor, hash: objectiveHandoffReferenceHash(event) };
    });
    const observationRefs = input.observationIds.map((id) => {
      const observation = this.store.getObservationById(id);
      const observationAgent = observation ? this.store.getAgent(observation.agentId) : null;
      if (!observation || !observationAgent || observationAgent.runId !== runId || observation.eventCursor > checkpoint.eventCursor) {
        throw new HttpError(409, `Objective handoff observation evidence is unavailable: ${id}`);
      }
      return { id: observation.id, agentId: observation.agentId, eventCursor: observation.eventCursor, hash: objectiveHandoffReferenceHash(observation) };
    });
    const checkpointArtifactRefs = new Set((checkpoint.artifactHashes ?? []).map((ref) => typeof ref === "string" ? ref : ref.id));
    const artifactRefs = input.artifactIds.map((id) => {
      const artifact = this.store.getObjectiveArtifact(id);
      if (!artifact || artifact.runId !== runId || artifact.objectiveId !== run.objectiveId || !checkpointArtifactRefs.has(id)) {
        throw new HttpError(409, `Objective handoff artifact evidence is unavailable at checkpoint ${checkpoint.id}: ${id}`);
      }
      return { id: artifact.id, hash: artifact.hash };
    });
    const workspaceEvidence = checkpoint.workspaceEvidence;
    const workspace = workspaceEvidence?.canonicalGrant
      ? {
          ...workspaceEvidence.canonicalGrant,
          git: workspaceEvidence.git,
          dirty: workspaceEvidence.dirty,
          patchHash: workspaceEvidence.patchHash,
          worktree: workspaceEvidence.worktree,
          snapshotHash: objectiveHandoffReferenceHash(workspaceEvidence),
        }
      : null;
    const taskObjective = input.taskObjective;
    const sourceAttemptId = input.attemptId ?? sourceTask?.attemptId ?? sourceAgent.objectiveAttemptId ?? null;
    const envelopeWithoutHash = {
      version: 1 as const,
      id: `handoff:${createHash("sha256").update(`${runId}\u0000${requestKey}`).digest("hex")}`,
      objectiveId: run.objectiveId,
      runId,
      objectiveRevision: run.objectiveRevision ?? 1,
      workflowId: run.workflowId,
      workflowRevision: run.workflowRevision,
      workflowHash: run.workflowHash,
      lineage: {
        objectiveId: run.objectiveId,
        runId,
        nodeId: input.nodeId ?? null,
        taskId: input.taskId ?? null,
        attemptId: sourceAttemptId,
        iterationKey: input.iterationKey ?? null,
        parentHandoffId: parent?.id ?? null,
        chain,
      },
      scope: {
        intent: input.intent,
        taskObjective,
        constraints: input.constraints,
        acceptanceCriteria: input.acceptanceCriteria,
      },
      source: {
        harness: sourceHarness,
        agentId: sourceAgent.id,
        attemptId: sourceAttemptId,
        nativeSessionId: sourceAgent.nativeSessionId,
        nativeRunId: sourceAgent.nativeRunId,
      },
      target: {
        harness: targetHarness,
        model: targetModel,
        agentId: targetAgent?.id ?? null,
        permission: targetPermission,
        requiredCapabilities: targetCapabilities,
        sideEffectClassCeiling: targetCeiling,
      },
      evidence: {
        eventCursor: checkpoint.eventCursor,
        eventRefs,
        observationRefs,
        artifactRefs,
        checkpoint: { id: checkpoint.id, sequence: checkpoint.sequence, hash: objectiveHandoffReferenceHash(checkpoint) },
      },
      workspace,
      continuity: {
        status: continuityStatus,
        sourceHarness,
        sourceAgentId: sourceAgent.id,
        nativeSessionId: sourceSession?.nativeSessionId ?? sourceAgent.nativeSessionId,
        nativeRunId: sourceSession?.nativeRunId ?? sourceAgent.nativeRunId,
        capabilities: [...new Set(continuityCapabilities)],
        evidenceEventIds: [],
        hints: continuityStatus === "proven" ? ["same-native-session-may-be-reused"] : ["new-attempt-required", "native-continuity-unproven"],
      },
      sideEffects: (checkpoint.unresolvedExternalOperations ?? checkpoint.unresolvedExternalSideEffects ?? []).map((operation) => ({ ...operation })),
      authority: {
        permission: policy.effectivePermission,
        // Policy allowedCapabilities are a ceiling, not a requirement. Only
        // capabilities explicitly required by this handoff belong here.
        requiredCapabilities: [...new Set(targetCapabilities)],
        sideEffectClassCeiling: policy.sideEffectClassCeiling,
        policySnapshotHash: run.policyHash,
        configSnapshotHash: checkpoint.configSnapshotHash,
      },
      createdAt: nowIso(),
      requestKey,
      inputHash,
      provenance: {
        source: "daemon" as const,
        actor: caller ? { type: "agent" as const, id: caller.id } : { type: "user" as const, id: "local-user" },
        requestKey,
        capturedAt: nowIso(),
        evidenceEventIds: input.evidenceEventIds,
      },
    };
    const contentHash = objectiveHandoffHash(envelopeWithoutHash as unknown as ObjectiveHandoffEnvelope);
    const envelope = ObjectiveHandoffEnvelopeSchema.parse({ ...envelopeWithoutHash, contentHash });
    let result;
    try {
      result = this.store.saveObjectiveHandoff(envelope, { fingerprint: inputHash });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, error instanceof Error ? error.message : "Objective handoff could not be committed.");
    }
    if (result.status === "committed") {
      this.appendObjectiveEvent("objective.handoff.offered", run, caller ? { type: "agent", id: caller.id } : { type: "user", id: "local-user" }, {
        objectiveId: run.objectiveId,
        handoffId: envelope.id,
        requestKey,
        checkpointId: checkpoint.id,
        targetHarness,
        targetAgentId: targetAgent?.id ?? null,
        continuity: envelope.continuity.status,
      });
    }
    return { status: result.status, envelope: result.envelope, acceptance: this.store.getObjectiveHandoffAcceptance(result.envelope.id), execution: null } as unknown as JsonValue;
  }

  private objectiveHandoffDetail(request: IncomingMessage, runId: string, handoffId: string): JsonValue {
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, "read an objective handoff");
    const envelope = this.store.getObjectiveHandoff(handoffId);
    if (!envelope || envelope.runId !== runId) throw new HttpError(404, `Objective handoff not found: ${handoffId}`);
    const acceptance = this.store.getObjectiveHandoffAcceptance(handoffId);
    let execution = null;
    if (acceptance?.status === "accepted") {
      try {
        execution = objectiveHandoffExecutionPlan(envelope, acceptance);
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "Objective handoff acceptance is incompatible.");
      }
    }
    return { envelope, acceptance, execution } as unknown as JsonValue;
  }

  /** Accept an envelope without mutating it; the supervisor may consume the returned plan. */
  private acceptObjectiveHandoff(request: IncomingMessage, runId: string, handoffId: string, payload: unknown): JsonValue {
    return this.objectiveCommandLedger(request, runId, "objective.handoff.accept", {
      handoffId,
      payload,
    }, () => ({ status: "committed", result: this.acceptObjectiveHandoffCore(request, runId, handoffId, payload) }), undefined, "Objective handoff acceptance is already bound to a different request.");
  }

  private acceptObjectiveHandoffCore(request: IncomingMessage, runId: string, handoffId: string, payload: unknown): JsonValue {
    const requestKey = this.requireIdempotencyKey(request);
    const caller = this.objectiveCaller(request);
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, "accept an objective handoff");
    const envelope = this.store.getObjectiveHandoff(handoffId);
    if (!envelope || envelope.runId !== runId) throw new HttpError(404, `Objective handoff not found: ${handoffId}`);
    const policy = run.policy;
    if (!policy || !run.policyHash || !isObjectivePolicyHashValid(policy) || policy.policyHash !== run.policyHash) {
      throw new HttpError(409, "Objective handoff acceptance requires a current, hash-verifiable objective policy.");
    }
    let input: ObjectiveHandoffAcceptanceInput;
    try {
      input = ObjectiveHandoffAcceptanceInputSchema.parse(payload);
    } catch {
      throw new HttpError(400, "Invalid typed objective handoff acceptance.");
    }
    if (input.envelopeId !== handoffId) throw new HttpError(400, "Handoff envelope id in the route and body must match.");
    const isRejection = input.decision === "rejected";
    const requestedRecipient = input.recipientAgentId ?? caller?.id ?? envelope.target.agentId;
    if (caller && requestedRecipient !== caller.id) throw new HttpError(403, "An authenticated agent may accept a handoff only for itself.");
    const recipient = requestedRecipient ? this.store.getAgent(requestedRecipient) : null;
    if (requestedRecipient && !recipient) throw new HttpError(409, `Objective handoff recipient not found: ${requestedRecipient}`);
    if (recipient && (recipient.runId !== runId || (caller && !this.sharesAgentRoot(caller, recipient)))) throw new HttpError(403, "Objective handoff recipient is outside the objective root lineage.");
    if (envelope.target.agentId && requestedRecipient !== envelope.target.agentId) throw new HttpError(409, "Objective handoff is addressed to a different recipient agent.");
    const recipientOrder = recipient ? AgentWorkOrderSchema.safeParse(this.store.getMetadata<JsonValue>(`work-order:${recipient.id}`)) : null;
    const capabilities = input.capabilities.length > 0
      ? input.capabilities
      : recipientOrder?.success && recipientOrder.data.capabilities
        ? recipientOrder.data.capabilities
        : policy.allowedCapabilities ?? [];
    const harness = input.harness ?? (recipient?.harness ?? (recipient?.requestedHarness === "auto" ? undefined : recipient?.requestedHarness)) ?? envelope.target.harness;
    const model = input.model ?? recipient?.model ?? recipient?.requestedModel ?? envelope.target.model;
    const permission = input.permission ?? recipient?.permissions ?? envelope.target.permission;
    if (!isRejection) {
      if (harness !== envelope.target.harness) throw new HttpError(409, `Handoff target harness mismatch: expected ${envelope.target.harness}, got ${harness}.`);
      if (envelope.target.model !== "auto" && model !== envelope.target.model) throw new HttpError(409, "Handoff target model is fixed by the immutable envelope.");
      if (permission !== envelope.target.permission) throw new HttpError(403, "Handoff acceptance cannot widen or narrow the immutable target authority.");
      if (recipient && (recipient.harness !== null && recipient.harness !== harness || recipient.permissions !== permission)) throw new HttpError(409, "Recipient native authority does not match the immutable handoff target.");
      const compatibility = validateObjectiveHandoffTarget(envelope, {
        harness,
        permission,
        requiredCapabilities: envelope.target.requiredCapabilities,
        capabilities,
      });
      if (!compatibility.ok) throw new HttpError(403, compatibility.reason);
    }
    const continuityStatus = input.continuityStatus;
    const sameNativeIdentity = continuityStatus === "proven"
      && harness === envelope.continuity.sourceHarness
      && input.nativeSessionId !== null
      && input.nativeSessionId === envelope.source.nativeSessionId
      && input.nativeRunId === envelope.source.nativeRunId;
    if (!isRejection && continuityStatus === "proven" && !sameNativeIdentity) {
      throw new HttpError(409, "Proven continuity requires the source harness and native session/run identities to match exactly.");
    }
    const eventRefIds = new Set(envelope.evidence.eventRefs.map((ref) => ref.id));
    const observationRefIds = new Set(envelope.evidence.observationRefs.map((ref) => ref.id));
    const artifactRefIds = new Set(envelope.evidence.artifactRefs.map((ref) => ref.id));
    for (const eventId of input.evidenceEventIds) {
      const event = this.store.getEventById(eventId);
      if (!event || event.runId !== runId || event.cursor > envelope.evidence.eventCursor || !eventRefIds.has(eventId)) {
        throw new HttpError(409, `Acceptance evidence is not included in the immutable handoff: ${eventId}`);
      }
    }
    for (const observationId of input.observationIds) {
      if (!observationRefIds.has(observationId)) throw new HttpError(409, `Acceptance observation evidence is not included in the immutable handoff: ${observationId}`);
      const observation = this.store.getObservationById(observationId);
      if (!observation || observation.eventCursor > envelope.evidence.eventCursor) throw new HttpError(409, `Acceptance observation evidence is unavailable: ${observationId}`);
    }
    for (const artifactId of input.artifactIds) {
      if (!artifactRefIds.has(artifactId)) throw new HttpError(409, `Acceptance artifact evidence is not included in the immutable handoff: ${artifactId}`);
      const artifact = this.store.getObjectiveArtifact(artifactId);
      if (!artifact || artifact.runId !== runId || artifact.objectiveId !== envelope.objectiveId) throw new HttpError(409, `Acceptance artifact evidence is unavailable: ${artifactId}`);
    }
    const acceptanceInput = {
      ...input,
      recipientAgentId: requestedRecipient ?? null,
      harness,
      model,
      permission,
      capabilities,
      nativeSessionId: !isRejection && sameNativeIdentity ? input.nativeSessionId : null,
      nativeRunId: !isRejection && sameNativeIdentity ? input.nativeRunId : null,
    };
    const inputHash = objectiveHandoffReferenceHash(acceptanceInput);
    const prior = this.store.getObjectiveHandoffAcceptance(handoffId);
    if (prior) {
      if (prior.inputHash !== inputHash || prior.requestKey !== requestKey) throw new HttpError(409, "Objective handoff acceptance is already bound to a different request.");
      const execution = prior.status === "accepted" ? objectiveHandoffExecutionPlan(envelope, prior) : null;
      return { status: "replayed", envelope, acceptance: prior, execution } as unknown as JsonValue;
    }
    const acceptedAt = nowIso();
    const recordWithoutHash = {
      version: 1 as const,
      id: `handoff-accept:${createHash("sha256").update(`${handoffId}\u0000${requestKey}`).digest("hex")}`,
      envelopeId: handoffId,
      objectiveId: envelope.objectiveId,
      runId,
      recipientAgentId: requestedRecipient ?? null,
      target: {
        harness: isRejection ? envelope.target.harness : harness,
        model: isRejection ? envelope.target.model : model,
        agentId: envelope.target.agentId,
        permission: isRejection ? envelope.target.permission : permission,
        requiredCapabilities: envelope.target.requiredCapabilities,
        sideEffectClassCeiling: envelope.target.sideEffectClassCeiling,
      },
      capabilities,
      nativeSessionId: !isRejection && sameNativeIdentity ? input.nativeSessionId : null,
      nativeRunId: !isRejection && sameNativeIdentity ? input.nativeRunId : null,
      continuityStatus: isRejection ? "unsupported" as const : sameNativeIdentity ? "proven" as const : "unknown" as const,
      evidenceEventIds: input.evidenceEventIds,
      status: isRejection ? "rejected" as const : "accepted" as const,
      reason: input.reason ?? null,
      requestKey,
      inputHash,
      acceptedAt,
      provenance: {
        source: "daemon" as const,
        actor: caller ? { type: "agent" as const, id: caller.id } : { type: "user" as const, id: "local-user" },
        requestKey,
        capturedAt: acceptedAt,
        evidenceEventIds: input.evidenceEventIds,
      },
    };
    const contentHash = objectiveHandoffAcceptanceHash(recordWithoutHash as ObjectiveHandoffAcceptanceRecord);
    const acceptance = ObjectiveHandoffAcceptanceRecordSchema.parse({ ...recordWithoutHash, contentHash });
    let execution: ReturnType<typeof objectiveHandoffExecutionPlan> | null = null;
    if (acceptance.status === "accepted") {
      try {
        execution = objectiveHandoffExecutionPlan(envelope, acceptance);
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "Objective handoff acceptance is incompatible.");
      }
    }
    let result;
    try {
      result = this.store.saveObjectiveHandoffAcceptance(acceptance, { fingerprint: inputHash });
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : "Objective handoff acceptance could not be committed.");
    }
    if (result.status === "committed") {
      this.appendObjectiveEvent("objective.handoff.accepted", run, caller ? { type: "agent", id: caller.id } : { type: "user", id: "local-user" }, {
        objectiveId: run.objectiveId,
        handoffId,
        requestKey,
        recipientAgentId: requestedRecipient ?? null,
        targetHarness: acceptance.status === "accepted" ? harness : envelope.target.harness,
        mode: execution?.mode ?? "rejected",
      });
    }
    return { status: result.status, envelope, acceptance: result.acceptance, execution } as unknown as JsonValue;
  }

  /**
   * Resume is deliberately a capability check, not a process rewind. A
   * native session may only be selected when the checkpoint proves continuity
   * and the session identity remains bound to the same objective attempt.
   */
  private resumeObjectiveCheckpoint(request: IncomingMessage, runId: string, checkpointId: string, payload: unknown): JsonValue {
    let fresh = false;
    const result = this.objectiveCommandLedger(request, runId, "objective.checkpoint.resume", {
      checkpointId,
      payload,
    }, () => ({ status: "committed", result: this.resumeObjectiveCheckpointCore(request, runId, checkpointId, payload, (isFresh) => {
      fresh = isFresh;
    }) }), () => {
      if (fresh) void this.objectiveSupervisor.step(runId).catch(() => undefined);
    });
    return result;
  }

  private resumeObjectiveCheckpointCore(request: IncomingMessage, runId: string, checkpointId: string, payload: unknown, onFresh?: (fresh: boolean) => void): JsonValue {
    const requestKey = this.requireIdempotencyKey(request);
    const parsed = ObjectiveCheckpointResumeCommandSchema.parse({
      ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}),
      runId,
      checkpointId,
    });
    const { run, authority } = this.objectiveMutationContext(request, runId, "resume an objective checkpoint");
    const checkpoint = this.requirePortableObjectiveCheckpoint(run, checkpointId);
    this.assertCheckpointSequence(checkpoint, parsed.expectedSequence);
    const native = checkpoint.nativeSessions ?? [];
    if (checkpoint.continuity?.status !== "proven" || native.length === 0 || native.some((session) => session.continuity !== "proven")) {
      throw new HttpError(409, "Cannot resume the same native session: continuity is not proven. Use retry to re-execute an activity or fork from this committed checkpoint. No process rewind is implied.");
    }
    for (const session of native) {
      const agent = this.store.getAgent(session.agentId);
      const lease = agent ? this.store.listWorkerProcessLeases({ agentId: agent.id }).at(-1) ?? null : null;
      const strongTransport = lease?.transport.kind === "worker-host"
        && lease.transport.hostIdentity?.verification === "strong"
        && lease.transport.workerIdentity?.verification === "strong";
      if (!agent || agent.runId !== runId || agent.nativeSessionId !== session.nativeSessionId || !strongTransport || !["running", "orphaned"].includes(lease?.state ?? "")) {
        throw new HttpError(409, `Cannot resume native session ${session.nativeSessionId ?? session.agentId}: current durable session continuity is no longer proven. Use retry or fork; no process rewind is implied.`);
      }
    }
    if (parsed.attemptId !== undefined && !native.some((session) => session.attemptId === parsed.attemptId && session.continuity === "proven")) {
      throw new HttpError(409, `Checkpoint ${checkpointId} does not prove continuity for attempt ${parsed.attemptId}.`);
    }
    const result = this.checkpointCommand(requestKey, authority, { operation: "resume", runId, checkpointId, expectedSequence: parsed.expectedSequence ?? null }, (isFresh) => {
      onFresh?.(isFresh);
      const output = {
        version: 1,
        operation: "resume",
        status: "scheduled",
        capability: "same-native-session",
        runId,
        checkpointId,
        attemptId: parsed.attemptId ?? null,
        nativeSessions: native,
        note: "The supervisor may reattach the proven native session; this command never rewinds a process.",
      };
      if (isFresh) this.appendObjectiveEvent("objective.checkpoint.resume.requested", run, authority.actor, {
        objectiveId: run.objectiveId,
        checkpointId,
        requestKey,
        capability: "same-native-session",
        continuity: checkpoint.continuity ?? { status: "unknown", capabilities: [], reason: "Unavailable" },
      });
      return output;
    });
    return result;
  }

  /** Retry names the exact task/control activity; it does not retry a whole run implicitly. */
  private retryObjectiveCheckpoint(request: IncomingMessage, runId: string, checkpointId: string, payload: unknown): JsonValue {
    let fresh = false;
    const result = this.objectiveCommandLedger(request, runId, "objective.checkpoint.retry", {
      checkpointId,
      payload,
    }, () => ({ status: "committed", result: this.retryObjectiveCheckpointCore(request, runId, checkpointId, payload, (isFresh) => {
      fresh = isFresh;
    }) }), () => {
      if (fresh) void this.objectiveSupervisor.step(runId).catch(() => undefined);
    });
    return result;
  }

  private retryObjectiveCheckpointCore(request: IncomingMessage, runId: string, checkpointId: string, payload: unknown, onFresh?: (fresh: boolean) => void): JsonValue {
    const requestKey = this.requireIdempotencyKey(request);
    const parsed = ObjectiveCheckpointRetryCommandSchema.parse({
      ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}),
      runId,
      checkpointId,
    });
    const { run, authority } = this.objectiveMutationContext(request, runId, "retry an objective checkpoint activity");
    const checkpoint = this.requirePortableObjectiveCheckpoint(run, checkpointId);
    this.assertCheckpointSequence(checkpoint, parsed.expectedSequence);
    if (parsed.activity.kind === "task") {
      const task = checkpoint.flatExecution?.tasks.find((candidate) => candidate.task.id === parsed.activity.id);
      if (!task) throw new HttpError(409, `Checkpoint retry task is not part of objective ${run.objectiveId}: ${parsed.activity.id}`);
      if (parsed.activity.attemptId !== undefined && parsed.activity.attemptId !== task.attemptId) {
        throw new HttpError(409, `Checkpoint retry attempt does not match task ${parsed.activity.id}'s committed attempt.`);
      }
      if (run.latestCheckpointId !== checkpoint.id) {
        throw new HttpError(409, "Checkpoint retry requires the latest committed checkpoint; re-read the objective and retry with its current boundary.");
      }
      const currentTask = run.tasks.find((candidate) => candidate.task.id === parsed.activity.id);
      if (!currentTask) throw new HttpError(409, `Checkpoint retry task is not present in the current objective projection: ${parsed.activity.id}`);
      if (["running", "waiting-approval"].includes(currentTask.state)) {
        throw new HttpError(409, `Objective task ${parsed.activity.id} still has an active or approval-held attempt; retry would risk duplicate execution.`);
      }
      const taskStates = new Map(run.tasks.map((candidate) => [candidate.task.id, candidate.state]));
      if (currentTask.task.dependsOn.some((dependencyId) => !["completed", "superseded"].includes(taskStates.get(dependencyId) ?? ""))) {
        throw new HttpError(409, `Objective task ${parsed.activity.id} is blocked by an unfinished dependency; retry the dependency first.`);
      }
      const downstream = run.tasks.filter((candidate) => candidate.task.dependsOn.includes(parsed.activity.id));
      if (downstream.some((candidate) => ["running", "completed", "waiting-approval"].includes(candidate.state))) {
        throw new HttpError(409, `Objective task ${parsed.activity.id} has downstream work that must be reconciled before an exact retry.`);
      }
    } else {
      const executions = checkpoint.treeExecution?.executions ?? [];
      const found = executions.some((execution) => execution.key.nodeId === parsed.activity.id || `${execution.key.nodeId}@${execution.key.iterationKey}` === parsed.activity.id);
      if (!found) throw new HttpError(409, `Checkpoint retry control activity is not part of its committed tree state: ${parsed.activity.id}`);
    }
    const activity = {
      kind: parsed.activity.kind,
      id: parsed.activity.id,
      ...(parsed.activity.attemptId === undefined ? {} : { attemptId: parsed.activity.attemptId }),
    };
    const result = this.checkpointCommand(requestKey, authority, { operation: "retry", runId, checkpointId, activity, expectedSequence: parsed.expectedSequence ?? null }, (isFresh) => {
      onFresh?.(isFresh);
      let retryCheckpointId: string | null = null;
      if (parsed.activity.kind === "task") {
        const current = this.store.getObjectiveRun(runId);
        if (!current || current.latestCheckpointId !== checkpoint.id) {
          throw new HttpError(409, "Checkpoint retry lost its latest-checkpoint compare-and-swap fence.");
        }
        const resetTasks = current.tasks.map((candidate) => candidate.task.id === parsed.activity.id
          ? {
              ...candidate,
              state: "queued" as const,
              attemptId: null,
              agentId: null,
              output: null,
              error: null,
              startedAt: null,
              finishedAt: null,
            }
          : candidate);
        const resetRun = ObjectiveRunRecordSchema.parse({
          ...current,
          state: "executing",
          tasks: resetTasks,
          output: null,
          error: null,
          finishedAt: null,
          updatedAt: nowIso(),
        });
        if (!this.store.updateObjectiveRun(resetRun, { expectedActivePlanRevision: current.activePlanRevision })) {
          throw new HttpError(409, "Checkpoint retry could not claim the current objective projection.");
        }
        const cursor = Math.max(this.store.latestCursor(), checkpoint.eventHighWater ?? checkpoint.eventCursor);
        const retryRun = this.objectiveRuntime.checkpoint(runId, {
          eventCursor: cursor,
          taskUpdates: [{ taskId: parsed.activity.id, state: "queued", attemptId: null, agentId: null, output: null, error: null, startedAt: null, finishedAt: null }],
          reason: `Retry requested for committed task ${parsed.activity.id}${parsed.activity.attemptId ? ` attempt ${parsed.activity.attemptId}` : ""}.`,
          requestKey: `${requestKey}:checkpoint`,
          ...this.deriveObjectiveCheckpointEvidence(resetRun, authority, cursor),
        }, authority);
        retryCheckpointId = retryRun.latestCheckpointId;
      }
      const output = {
        version: 1,
        operation: "retry",
        status: "scheduled",
        capability: "reexecute-named-activity",
        runId,
        checkpointId,
        retryCheckpointId,
        activity,
        note: "The named activity/attempt will be re-executed from committed state; no process rewind is implied.",
      };
      if (isFresh) this.appendObjectiveEvent("objective.checkpoint.retry.requested", run, authority.actor, {
        objectiveId: run.objectiveId,
        checkpointId,
        requestKey,
        activity,
      });
      return output;
    });
    return result;
  }

  /** Fork copies only committed state into a new run and records a new occurrence edge. */
  private forkObjectiveCheckpoint(request: IncomingMessage, runId: string, checkpointId: string, payload: unknown): JsonValue {
    return this.objectiveCommandLedger(request, runId, "objective.checkpoint.fork", {
      checkpointId,
      payload,
    }, () => ({ status: "committed", result: this.forkObjectiveCheckpointCore(request, runId, checkpointId, payload) }));
  }

  private forkObjectiveCheckpointCore(request: IncomingMessage, runId: string, checkpointId: string, payload: unknown): JsonValue {
    const requestKey = this.requireIdempotencyKey(request);
    const parsed = ObjectiveCheckpointForkCommandSchema.parse({
      ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}),
      runId,
      checkpointId,
    });
    const { run, caller, authority } = this.objectiveMutationContext(request, runId, "fork an objective checkpoint");
    const checkpoint = this.requirePortableObjectiveCheckpoint(run, checkpointId);
    this.assertCheckpointSequence(checkpoint, undefined);
    const forkRequestKey = `objective-checkpoint-fork:${requestKey}`;
    const sourceOccurrence = this.store.getObjectiveRunOccurrence(runId);
    const targetRunId = parsed.newRunId ?? `objective-fork-${checkpoint.id}-${requestKey}`;
    const existing = this.store.getObjectiveRun(targetRunId);
    const fingerprint = createHash("sha256").update(stableJsonStringify({ runId, checkpointId, targetRunId, reason: parsed.reason })).digest("hex");
    const result = this.checkpointCommand(requestKey, authority, { operation: "fork", runId, checkpointId, targetRunId, fingerprint }, () => {
      if (existing) {
        if (existing.objectiveId !== run.objectiveId) throw new HttpError(403, "Fork target run belongs to another objective.");
        const existingOccurrence = this.store.getObjectiveRunOccurrence(existing.runId);
        if (!existingOccurrence || existingOccurrence.forkedFromRunId !== runId || existingOccurrence.input === undefined) {
          throw new HttpError(409, "Fork target run already exists but is not the durable fork for this checkpoint command.");
        }
        return { version: 1, operation: "fork", status: "replayed", capability: "new-run-from-committed-state", runId, checkpointId, newRunId: existing.runId, occurrenceId: existingOccurrence.id };
      }
      const controlRevision = checkpoint.controlPlanRevision === null || checkpoint.controlPlanRevision === undefined
        ? null
        : this.store.getObjectiveControlPlanRevision(runId, checkpoint.controlPlanRevision);
      const flatTasks = checkpoint.flatExecution?.tasks ?? run.tasks;
      // A fork never carries native attempts across run boundaries. Preserve
      // only completed flat work (including its output); queued/running/
      // failed work is deliberately re-queued for a fresh attempt in the
      // child run. This keeps the fork a committed-state boundary without
      // pretending that an opaque process was cloned.
      const retainedTaskUpdates = flatTasks
        .filter((task) => task.state === "completed")
        .map((task) => ({
          taskId: task.task.id,
          state: "completed" as const,
          attemptId: null,
          agentId: null,
          output: task.output,
          error: null,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
        }));
      const forkPlan = controlRevision
        ? {
            ...controlRevision.plan,
            id: `${controlRevision.plan.id}:fork:${createHash("sha256").update(targetRunId).digest("hex").slice(0, 16)}`,
          }
        : null;
      const workspace = run.policy?.workspace ?? checkpoint.workspaceEvidence?.canonicalGrant ?? this.objectiveWorkspaceGrant(runId);
      const forkAuthority = this.objectiveAuthority(caller, workspace);
      const policy = run.policy ? {
        effectivePermission: run.policy.effectivePermission,
        allowedCapabilities: run.policy.allowedCapabilities,
        budget: run.policy.budget,
        sideEffectClassCeiling: run.policy.sideEffectClassCeiling,
        approvalPolicy: run.policy.approvalPolicy,
        expiresAt: run.policy.expiresAt,
      } : null;
      const next = this.objectiveRuntime.create({
        runId: targetRunId,
        objectiveId: run.objectiveId,
        objectiveRevision: run.objectiveRevision ?? 1,
        workflowId: run.workflowId,
        workflowRevision: run.workflowRevision,
        workflowHash: run.workflowHash,
        conductorAgentId: run.conductorAgentId,
        workspace,
        ...(policy ? { policy } : {}),
        spec: run.spec,
        tasks: flatTasks.map((record) => record.task),
        context: checkpoint.flatExecution?.context ?? checkpoint.context,
        ...(forkPlan ? { controlPlan: forkPlan } : {}),
        requestKey: forkRequestKey,
      }, forkAuthority);
      if (workspace) this.saveObjectiveWorkspaceGrant(next.runId, workspace, caller);
      const checkpointAuthority = next.policy
        ? {
            ...forkAuthority,
            permissionCeiling: next.policy.effectivePermission,
            allowedCapabilities: next.policy.allowedCapabilities,
            policy: {
              effectivePermission: next.policy.effectivePermission,
              allowedCapabilities: next.policy.allowedCapabilities,
              budget: next.policy.budget,
              sideEffectClassCeiling: next.policy.sideEffectClassCeiling,
              approvalPolicy: next.policy.approvalPolicy,
              expiresAt: next.policy.expiresAt,
            },
          }
        : forkAuthority;
      const forked = this.objectiveRuntime.checkpoint(next.runId, {
        eventCursor: checkpoint.eventHighWater ?? checkpoint.eventCursor,
        context: checkpoint.context,
        ...(retainedTaskUpdates.length > 0 ? { taskUpdates: retainedTaskUpdates } : {}),
        outputs: checkpoint.outputs ?? {},
        artifactHashes: checkpoint.artifactHashes ?? [],
        workspaceEvidence: checkpoint.workspaceEvidence,
        unresolvedExternalOperations: checkpoint.unresolvedExternalOperations ?? [],
        policySnapshotHash: next.policyHash ?? null,
        configSnapshotHash: checkpoint.configSnapshotHash ?? null,
        attemptHighWater: checkpoint.attemptHighWater ?? checkpoint.eventCursor,
        eventHighWater: checkpoint.eventHighWater ?? checkpoint.eventCursor,
        provenance: {
          source: "recovery",
          actor: checkpointAuthority.actor,
          capturedAt: nowIso(),
          evidenceEventIds: checkpoint.provenance?.evidenceEventIds ?? [],
          parentCheckpointId: checkpoint.id,
          baseCheckpointId: checkpoint.id,
        },
        reason: `Forked from committed checkpoint ${checkpoint.id}: ${parsed.reason}`,
        requestKey: `${forkRequestKey}:checkpoint`,
      }, checkpointAuthority);
      this.saveObjectiveRunOccurrence(next, {
        kind: "fork",
        occurrenceKey: parsed.occurrenceKey ?? `${checkpoint.id}:${targetRunId}`,
        parentRunId: runId,
        forkedFromRunId: runId,
        forkedFromOccurrenceId: sourceOccurrence?.id ?? null,
        input: checkpoint.flatExecution?.context ?? checkpoint.context,
      }, forkAuthority.actor);
      this.appendObjectiveEvent("objective.checkpoint.forked", next, forkAuthority.actor, {
        objectiveId: next.objectiveId,
        sourceRunId: runId,
        sourceCheckpointId: checkpointId,
        requestKey,
        capability: "new-run-from-committed-state",
        reason: parsed.reason,
      });
      return { version: 1, operation: "fork", status: "created", capability: "new-run-from-committed-state", runId, checkpointId, newRunId: forked.runId, newCheckpointId: forked.latestCheckpointId, occurrenceId: this.store.getObjectiveRunOccurrence(next.runId)?.id ?? null };
    });
    return result;
  }

  private requirePortableObjectiveCheckpoint(run: ObjectiveRunRecord, checkpointId: string): ObjectiveCheckpointRecord & Required<Pick<ObjectiveCheckpointRecord, "continuity" | "nativeSessions" | "flatExecution" | "workspaceEvidence" | "provenance">> {
    const checkpoint = this.store.getObjectiveCheckpoint(run.runId, checkpointId);
    if (!checkpoint) throw new HttpError(404, `Objective checkpoint not found: ${checkpointId}`);
    const parsed = ObjectivePortableCheckpointRecordSchema.safeParse(checkpoint);
    if (!parsed.success) throw new HttpError(409, `Checkpoint ${checkpointId} is legacy and has no portable recovery boundary. Commit a new checkpoint before using this command.`);
    return parsed.data as ObjectiveCheckpointRecord & Required<Pick<ObjectiveCheckpointRecord, "continuity" | "nativeSessions" | "flatExecution" | "workspaceEvidence" | "provenance">>;
  }

  private assertCheckpointSequence(checkpoint: ObjectiveCheckpointRecord, expectedSequence: number | undefined): void {
    if (expectedSequence !== undefined && checkpoint.sequence !== expectedSequence) {
      throw new HttpError(409, `Checkpoint compare-and-swap conflict: expected sequence ${expectedSequence}, found ${checkpoint.sequence}.`);
    }
  }

  private checkpointCommand(
    requestKey: string,
    authority: ObjectiveRuntimeAuthority,
    identity: Record<string, JsonValue>,
    produce: (fresh: boolean) => JsonValue,
  ): JsonValue {
    const fingerprintKey = `checkpoint-command-fingerprint:${createHash("sha256").update(requestKey).digest("hex")}`;
    return this.store.durableTransaction(() => {
      const fingerprint = createHash("sha256").update(stableJsonStringify({
        ...identity,
        actor: authority.actor,
        policy: authority.policy ?? null,
        workspace: authority.workspace ?? null,
      })).digest("hex");
      const priorFingerprint = this.store.getMetadata<string>(fingerprintKey);
      if (priorFingerprint && priorFingerprint !== fingerprint) throw new HttpError(409, `Checkpoint command ${requestKey} is already bound to a different operation.`);
      const prior = this.store.getCommandReceipt(requestKey);
      if (prior) {
        if (!priorFingerprint) throw new HttpError(409, `Checkpoint command ${requestKey} is already claimed by another operation.`);
        return prior.result;
      }
      this.store.setMetadata(fingerprintKey, fingerprint);
      const result = produce(true);
      const now = nowIso();
      if (!this.store.claimCommandReceipt(CommandReceiptSchema.parse({
        idempotencyKey: requestKey,
        accepted: true,
        state: "settled",
        result,
        createdAt: now,
        updatedAt: now,
      }))) throw new HttpError(409, `Checkpoint command ${requestKey} was concurrently claimed.`);
      return result;
    });
  }

  private requestObjectiveApproval(request: IncomingMessage, runId: string, payload: unknown): ObjectiveRunRecord {
    const requestKey = this.requireIdempotencyKey(request);
    const parsed = ObjectiveApprovalInputSchema.parse(payload);
    const { run, authority } = this.objectiveMutationContext(request, runId, "request approval for");
    return this.store.durableTransaction(() => {
      const replayed = this.objectiveRepository.getObjectiveActionReceipt(requestKey);
      const approvalInput: ObjectiveApprovalRequestInput = {
        kind: parsed.kind,
        question: parsed.question,
        operationId: parsed.operationId,
        requestHash: parsed.requestHash,
        policyHash: parsed.policyHash,
        sideEffectClass: parsed.sideEffectClass,
        canonicalTarget: parsed.canonicalTarget,
        ...(parsed.capability !== undefined ? { capability: parsed.capability } : {}),
        requestKey,
        ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
        ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
        ...(parsed.expiresAt !== undefined ? { expiresAt: parsed.expiresAt } : {}),
      };
      const next = this.objectiveRuntime.requestApproval(runId, approvalInput, authority);
      if (!replayed) this.appendObjectiveApprovalRequestedEvent(run, next, authority.actor);
      return next;
    });
  }

  private resolveObjectiveApproval(
    request: IncomingMessage,
    runId: string,
    approvalId: string,
    payload: unknown,
  ): ObjectiveRunRecord {
    const requestKey = this.requireIdempotencyKey(request);
    const parsed = ObjectiveApprovalResolutionInputSchema.parse(payload);
    const caller = this.objectiveCaller(request);
    // Approval resolution is deliberately a human control boundary. There
    // is no governing-agent policy field in the current objective contract,
    // so an authenticated agent cannot resolve it by implication.
    if (caller) throw new HttpError(403, "Only a local user may resolve objective approvals.");
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    const approval = this.store.getObjectiveApproval(runId, approvalId);
    if (!approval) throw new HttpError(404, `Objective approval not found: ${approvalId}`);
    // An exact retry of a previously settled action must replay its durable
    // receipt even if the approval's wall-clock expiry has since elapsed.
    // New approve/reject attempts against an expired, still-requested
    // approval remain blocked below; explicit expiry settlement is allowed.
    const replayed = this.objectiveRepository.getObjectiveActionReceipt(requestKey);
    const approvalExpired = approval.expiresAt !== null && Date.parse(approval.expiresAt) <= Date.now();
    if (!replayed && approvalExpired && parsed.status !== "expired") {
      throw new HttpError(409, `Objective approval ${approvalId} has expired.`);
    }
    const authority = this.objectiveAuthority(null);
    return this.store.durableTransaction(() => {
      const replayed = this.objectiveRepository.getObjectiveActionReceipt(requestKey);
      const resolutionInput = {
        status: parsed.status,
        ...(parsed.decision !== undefined ? { decision: parsed.decision } : {}),
        requestKey,
      } as const;
      const next = this.objectiveRuntime.resolveApproval(runId, approvalId, resolutionInput, authority);
      if (!replayed) {
        this.appendObjectiveEvent("objective.approval.resolved", next, authority.actor, {
          objectiveId: next.objectiveId,
          requestKey,
          approvalId,
          status: parsed.status,
          state: next.state,
        });
      }
      this.resolveAttentionForApproval(run, approval, parsed.status, parsed.decision ?? null, authority.actor, requestKey);
      return next;
    });
  }

  /**
   * Public checkpoint callers may report progress, but they cannot author a
   * terminal task result. A terminal update is accepted only when the durable
   * objective assignment and the native terminal projection agree on every
   * identity involved. The supervisor runner has a separate in-process path
   * through ObjectiveSupervisor.acknowledge, so this guard does not weaken
   * that daemon-owned reconciliation boundary.
   */
  private assertPublicObjectiveCheckpointEvidence(
    run: ObjectiveRunRecord,
    updates: readonly z.infer<typeof ObjectiveTaskUpdateInputSchema>[],
    eventCursor: number,
  ): Record<string, string[]> {
    const evidenceByTask: Record<string, string[]> = {};
    for (const update of updates) {
      if (update.state !== "completed" && update.state !== "failed") continue;
      const task = run.tasks.find((record) => record.task.id === update.taskId);
      // Let ObjectiveRuntime produce its normal unknown-task diagnostic; this
      // helper is only responsible for the terminal evidence boundary.
      if (!task) continue;
      if (!task.attemptId || !task.agentId) {
        throw new ObjectiveRuntimeError(
          `Objective task ${task.task.id} has no durable attempt assignment; terminal checkpoints require native evidence.`,
          "invalid-state",
        );
      }
      if (update.attemptId !== task.attemptId || update.agentId !== task.agentId) {
        throw new ObjectiveRuntimeError(
          `Objective task ${task.task.id} terminal checkpoint identity does not match its durable assignment.`,
          "authority-exceeded",
        );
      }

      const agent = this.store.getAgent(task.agentId);
      if (!agent || agent.runId !== run.runId || agent.workflowId !== run.workflowId || agent.logicalAgentId !== task.attemptId) {
        throw new ObjectiveRuntimeError(
          `Objective task ${task.task.id} is not bound to a native agent in this objective run.`,
          "authority-exceeded",
        );
      }
      const conductor = run.conductorAgentId ? this.store.getAgent(run.conductorAgentId) : null;
      const root = this.agentRoot(agent);
      const belongsToLineage = run.conductorAgentId !== null
        ? Boolean(conductor
          && conductor.workflowId === run.workflowId
          && this.sharesAgentRoot(agent, conductor)
          && this.objectiveAgentWorkspaceAuthorized(run, agent, conductor))
        : Boolean(root
          && root.runId === run.runId
          && root.workflowId === run.workflowId
          && this.objectiveAgentWorkspaceAuthorized(run, agent, null));
      if (!belongsToLineage) {
        throw new ObjectiveRuntimeError(
          `Objective task ${task.task.id} native agent is outside the objective root lineage.`,
          "authority-exceeded",
        );
      }

      const expectedStatus = update.state === "completed" ? "completed" : "failed";
      if (agent.status !== expectedStatus) {
        throw new ObjectiveRuntimeError(
          `Objective task ${task.task.id} claims ${update.state}, but its native agent is ${agent.status}.`,
          "invalid-state",
        );
      }
      const evidence = this.objectiveTerminalEvidence(run, agent, task.attemptId, update.state, eventCursor);
      if (evidence.length === 0) {
        throw new ObjectiveRuntimeError(
          `Objective task ${task.task.id} has no durable ${expectedStatus} evidence at or before checkpoint cursor ${eventCursor}.`,
          "invalid-state",
        );
      }
      evidenceByTask[task.task.id] = evidence.map((event) => event.id);
    }
    return evidenceByTask;
  }

  /**
   * The objective run and its conductor's chat run are distinct durable
   * resources. Workspace authority is the shared capability that binds the
   * worker assignment to the persisted objective/conductor lineage; do not
   * infer ownership from a matching conductor run ID.
   */
  private objectiveAgentWorkspaceAuthorized(
    run: ObjectiveRunRecord,
    agent: AgentRecord,
    conductor: AgentRecord | null,
  ): boolean {
    const workerWorkspace: WorkspaceSpec = {
      path: agent.workspacePath,
      dirtyPolicy: "local-only",
    };
    try {
      const objectiveGrant = this.objectiveWorkspaceGrant(run.runId);
      const workerGrant = this.agentWorkspaceGrant(agent);
      // Prefer the persisted work-order grant over the materialized path and
      // require the two to agree. This keeps a tampered AgentRecord path from
      // widening the workspace authority used by the terminal proof.
      if (workerGrant && this.canonicalWorkspacePath(workerWorkspace.path, "Agent workspace") !== workerGrant.path) {
        return false;
      }
      if (objectiveGrant) this.childWorkspaceGrant(objectiveGrant, workerWorkspace);
      if (conductor) {
        const conductorGrant = this.agentWorkspaceGrant(conductor);
        if (conductorGrant) this.childWorkspaceGrant(conductorGrant, workerWorkspace);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Find terminal events without trusting a caller's cursor or payload. */
  private objectiveTerminalEvidence(
    run: ObjectiveRunRecord,
    agent: AgentRecord,
    attemptId: string,
    state: "completed" | "failed",
    eventCursor: number,
  ): EventEnvelope[] {
    const types = state === "completed"
      ? ["agent.completed", "driver.run.completed"]
      : ["agent.failed", "driver.run.failed"];
    const evidence: EventEnvelope[] = [];
    let after = 0;
    while (after < eventCursor) {
      const page = this.store.eventsAfter(after, {
        runId: run.runId,
        agentId: agent.id,
        types,
        limit: 10_000,
      });
      if (page.length === 0) break;
      for (const event of page) {
        if (event.cursor > eventCursor) break;
        if (event.workflowId === run.workflowId && this.eventMatchesObjectiveAttempt(event, attemptId)) evidence.push(event);
      }
      const lastCursor = page.at(-1)?.cursor ?? after;
      if (lastCursor <= after) break;
      after = lastCursor;
      if (page.length < 10_000) break;
    }
    return evidence;
  }

  private eventMatchesObjectiveAttempt(event: EventEnvelope, attemptId: string): boolean {
    const payload = jsonRecord(event.payload);
    const explicitAttemptIds = ["objectiveAttemptId", "attemptId"]
      .filter((key) => Object.prototype.hasOwnProperty.call(payload, key))
      .map((key) => payload[key]);
    // Native terminal events historically carried only the durable agent ID.
    // AgentRecord.logicalAgentId is the assignment's attempt identity, so an
    // absent payload field remains provable through that durable binding.
    return explicitAttemptIds.length === 0
      || explicitAttemptIds.every((value) => typeof value === "string" && value === attemptId);
  }

  private objectiveMutationContext(
    request: IncomingMessage,
    runId: string,
    action: string,
  ): { run: ObjectiveRunRecord; authority: ObjectiveRuntimeAuthority; caller: AgentRecord | null } {
    // Validate the capability before looking at mutation details. This keeps
    // an invalid token from being confused with a legitimate empty/missing
    // objective projection.
    const caller = this.objectiveCaller(request);
    const run = this.store.getObjectiveRun(runId);
    if (!run) throw new HttpError(404, `Objective run not found: ${runId}`);
    this.requireObjectiveAccess(request, run, action);
    return { run, authority: this.objectiveAuthority(caller, this.effectiveWorkspaceGrant(this.objectiveWorkspaceGrant(run.runId), caller)), caller };
  }

  private objectiveAuthority(caller: AgentRecord | null, workspace: WorkspaceSpec | null = null): ObjectiveRuntimeAuthority {
    const global = this.objectiveGlobalPolicyCeiling();
    return caller
      ? {
          actor: { type: "agent", id: caller.id },
          permissionCeiling: caller.permissions,
          workspace,
          allowedCapabilities: global.allowedCapabilities ?? [],
          policy: { ...global, allowedCapabilities: global.allowedCapabilities ?? [], effectivePermission: caller.permissions },
        }
      : {
          actor: { type: "user", id: "local-user" },
          permissionCeiling: "full-access",
          workspace,
          allowedCapabilities: global.allowedCapabilities ?? [],
          policy: { ...global, allowedCapabilities: global.allowedCapabilities ?? [] },
        };
  }

  private objectiveGlobalPolicyCeiling(): ObjectivePolicyRequest {
    const configured = this.loaded.config.policy;
    const budget = {
      ...configured.budget,
      maxConcurrentAgents: intersectNullableLimit(configured.budget.maxConcurrentAgents, this.loaded.config.agents.maxConcurrent),
      maxDepth: intersectNullableLimit(configured.budget.maxDepth, this.loaded.config.agents.maxDepth),
    };
    return {
      effectivePermission: configured.effectivePermission,
      allowedCapabilities: configured.allowedCapabilities,
      budget,
      sideEffectClassCeiling: configured.sideEffectClassCeiling,
      approvalPolicy: configured.approvalPolicy,
      expiresAt: configured.expiresAt,
    };
  }

  /**
   * Resolve the immutable workspace capability for a newly-created
   * objective. An authenticated agent inherits its own native work-order
   * grant; body-provided workspace fields are only checked as children of
   * that grant. A local user can explicitly choose a project workspace.
   */
  private objectiveWorkspaceGrantForCreate(
    parsed: z.infer<typeof ObjectiveCreateInputSchema>,
    caller: AgentRecord | null,
  ): WorkspaceSpec | null {
    if (caller) {
      const inherited = this.agentWorkspaceGrant(caller);
      if (!inherited) throw new HttpError(409, "Authenticated objective creation requires an attached workspace grant.");
      if (parsed.workspace) this.childWorkspaceGrant(inherited, parsed.workspace);
      return inherited;
    }
    if (parsed.workspace) return this.canonicalWorkspaceSpec(parsed.workspace, "Objective workspace");
    const explicit = (parsed.tasks ?? []).map((task) => task.workspace).filter((workspace): workspace is WorkspaceSpec => Boolean(workspace));
    if (explicit.length === 0) return null;
    // Preserve compatibility with the compact API, which historically put
    // the selected project path on each first-plan task. Treat the first path
    // as the user's explicit project grant and require every sibling task to
    // remain beneath it.
    const grant = this.canonicalWorkspaceSpec(explicit[0] as WorkspaceSpec, "Objective workspace");
    for (const workspace of explicit) this.childWorkspaceGrant(grant, workspace);
    return grant;
  }

  private objectiveWorkspaceGrantForPlan(tasks: readonly ObjectiveTask[], caller: AgentRecord | null): WorkspaceSpec | null {
    if (caller) return this.agentWorkspaceGrant(caller);
    const explicit = tasks.map((task) => task.workspace).filter((workspace): workspace is WorkspaceSpec => Boolean(workspace));
    return explicit.length > 0 ? this.canonicalWorkspaceSpec(explicit[0] as WorkspaceSpec, "Objective workspace") : null;
  }

  /**
   * Normalize task workspace paths before ObjectiveRuntime sees them. The
   * check is repeated against the caller grant when a child agent contributes
   * a replan, so a broader objective grant cannot be used to widen that child.
   */
  private normalizeObjectiveTasks(
    tasks: readonly ObjectiveTask[],
    objectiveGrant: WorkspaceSpec | null,
    caller: AgentRecord | null,
  ): ObjectiveTask[] {
    const callerGrant = caller ? this.agentWorkspaceGrant(caller) : null;
    if (objectiveGrant && callerGrant) {
      // A caller whose current native grant is no longer inside the
      // objective's immutable grant cannot replan, even if it submits no
      // explicit task path (the runner would otherwise fall back to cwd).
      this.childWorkspaceGrant(objectiveGrant, callerGrant);
    }
    return tasks.map((task) => {
      if (!task.workspace) return task;
      let workspace = objectiveGrant
        ? this.childWorkspaceGrant(objectiveGrant, task.workspace)
        : this.canonicalWorkspaceSpec(task.workspace, "Objective task workspace");
      if (callerGrant) workspace = this.childWorkspaceGrant(callerGrant, workspace);
      return { ...task, workspace };
    });
  }

  private effectiveWorkspaceGrant(objectiveGrant: WorkspaceSpec | null, caller: AgentRecord | null): WorkspaceSpec | null {
    const callerGrant = caller ? this.agentWorkspaceGrant(caller) : null;
    if (!objectiveGrant) return callerGrant;
    if (!callerGrant) return objectiveGrant;
    try {
      return this.childWorkspaceGrant(objectiveGrant, callerGrant);
    } catch {
      // Keep the objective grant as the runtime ceiling. normalizeObjectiveTasks
      // performs the caller-specific check and returns the useful 403 detail.
      return objectiveGrant;
    }
  }

  private agentWorkspaceGrant(agent: AgentRecord): WorkspaceSpec | null {
    const raw = this.store.getMetadata<JsonValue>(`work-order:${agent.id}`);
    const parsed = raw ? AgentWorkOrderSchema.safeParse(raw) : null;
    const candidate = parsed?.success ? parsed.data.workspace : { path: agent.workspacePath, dirtyPolicy: "local-only" as const };
    try {
      return this.canonicalWorkspaceSpec(candidate, "Agent workspace grant");
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(409, `Agent workspace grant is unavailable: ${error.message}`);
      throw error;
    }
  }

  private objectiveWorkspaceGrant(runId: string): WorkspaceSpec | null {
    const raw = this.store.getMetadata<JsonValue>(objectiveWorkspaceKey(runId));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.version !== 1) throw new HttpError(409, "Objective workspace authority is malformed and cannot be verified.");
    const parsed = WorkspaceSpecSchema.safeParse(record.workspace);
    if (!parsed.success) throw new HttpError(409, "Objective workspace authority is malformed and cannot be verified.");
    try {
      return this.canonicalWorkspaceSpec(parsed.data, "Objective workspace grant");
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(409, `Objective workspace authority is unavailable: ${error.message}`);
      throw error;
    }
  }

  private saveObjectiveWorkspaceGrant(runId: string, workspace: WorkspaceSpec, caller: AgentRecord | null): void {
    const existing = this.objectiveWorkspaceGrant(runId);
    if (existing && existing.path !== workspace.path) {
      throw new HttpError(409, "Objective workspace authority is immutable and cannot be widened.");
    }
    this.store.setMetadata(objectiveWorkspaceKey(runId), {
      version: 1,
      runId,
      workspace: serializableWorkspaceSpec(workspace),
      source: caller ? "agent" : "user",
      conductorAgentId: caller?.id ?? null,
    });
  }

  private canonicalWorkspaceSpec(workspace: WorkspaceSpec, label: string): WorkspaceSpec {
    return { ...workspace, path: this.canonicalWorkspacePath(workspace.path, label) };
  }

  private appendObjectiveApprovalRequestedEvent(
    previous: ObjectiveRunRecord | null,
    next: ObjectiveRunRecord,
    actor: ObjectiveActor,
  ): void {
    const approvalId = next.pendingApprovalId;
    if (!approvalId || approvalId === previous?.pendingApprovalId) return;
    const approval = this.store.getObjectiveApproval(next.runId, approvalId);
    if (!approval) return;
    this.appendObjectiveEvent("objective.approval.requested", next, actor, {
      objectiveId: next.objectiveId,
      requestKey: approval.requestKey,
      approvalId: approval.id,
      kind: approval.kind,
      taskId: approval.taskId,
      status: approval.status,
      question: approval.question,
      planRevision: approval.planRevision,
      operationId: approval.operationId,
      sideEffectClass: approval.sideEffectClass,
      canonicalTarget: approval.canonicalTarget,
      expiresAt: approval.expiresAt,
    });
  }

  private appendObjectiveEvent(
    type: string,
    run: ObjectiveRunRecord,
    actor: ObjectiveActor,
    payload: Record<string, JsonValue>,
  ): void {
    this.store.appendEvent({
      type,
      workflowId: run.workflowId,
      runId: run.runId,
      agentId: actor.type === "agent" ? actor.id : run.conductorAgentId,
      occurredAt: nowIso(),
      payload: { ...payload, actor },
      provenance: { source: "daemon" },
    });
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
      outputSchema: z.record(z.string(), JsonValueSchema), routing: z.unknown().optional(), workspace: WorkspaceSpecSchema.optional(), inputs: z.array(z.unknown()).default([]),
    }).parse(payload);
    const parentWorkspace = WorkspaceSpecSchema.safeParse(parentOrder.workspace);
    if (!parentWorkspace.success) throw new HttpError(409, "Parent work order has no valid workspace grant.");
    const workspace = this.childWorkspaceGrant(parentWorkspace.data, child.workspace);
    const workOrder = {
      workflowId: parent.workflowId, runId: parent.runId, parentAgentId: parent.id, depth: parent.depth + 1,
      mission: parentOrder.mission, objective: child.objective, model: child.model, harness: child.harness,
      permissions: child.permissions ?? parent.permissions, outputSchema: child.outputSchema,
      ...(child.routing === undefined ? {} : { routing: child.routing }),
      workspace, inputs: child.inputs,
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

  private workflowRunOrigin(actor: Command["actor"]): WorkflowRunOrigin {
    if (actor.type !== "agent") {
      return {
        kind: "user",
        threadId: null,
        parentRunId: null,
        parentAgentId: null,
        baseDepth: -1,
        permissionCeiling: "full-access",
      };
    }
    if (!actor.id) throw new HttpError(401, "An agent workflow run requires an authenticated actor id.");
    const parent = this.agents.get(actor.id);
    const maxDepth = this.loaded.config.agents.maxDepth;
    if (maxDepth !== null && parent.depth + 1 > maxDepth) {
      throw new HttpError(403, `Maximum agent depth ${maxDepth} exceeded.`);
    }
    const parentRun = this.store.getRun(parent.runId);
    const threadId = parent.workflowId.startsWith("chat:")
      ? parent.workflowId.slice("chat:".length)
      : parentRun?.origin?.threadId ?? null;
    return {
      kind: "agent",
      threadId,
      parentRunId: parent.runId,
      parentAgentId: parent.id,
      baseDepth: parent.depth,
      permissionCeiling: parent.permissions,
    };
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

  /** Authority callbacks for the daemon-owned semantic message bus. */
  private agentMessageAuthority() {
    return {
      canAppend: (actorId: string, input: AgentMessageInput) => actorId === "local-user"
        || (input.senderId === actorId && this.agentMessageCanAccess(actorId, input)),
      canRead: (actorId: string, message: AgentMessageRecord) => this.agentMessageCanAccess(actorId, message),
      canHandle: (actorId: string, message: AgentMessageRecord, _decision: AgentMessageDecision) => actorId === "local-user"
        || this.agentMessageCanAccess(actorId, message),
      canCancel: (actorId: string, message: AgentMessageRecord) => actorId === "local-user"
        || this.agentMessageCanAccess(actorId, message),
      canExpire: (actorId: string, message: AgentMessageRecord) => actorId === "local-user"
        || actorId === "system:message-expiry"
        || this.agentMessageCanAccess(actorId, message),
    };
  }

  private agentMessageCanAccess(actorId: string, message: Pick<AgentMessageRecord, "senderId" | "recipientId" | "parentAgentId" | "objectiveId" | "runId">): boolean {
    if (actorId === "local-user") return true;
    const actor = this.store.getAgent(actorId);
    if (!actor) return false;
    if ([message.senderId, message.recipientId, message.parentAgentId].includes(actorId)) return true;
    for (const targetId of [message.senderId, message.recipientId, message.parentAgentId]) {
      if (!targetId) continue;
      const target = this.store.getAgent(targetId);
      if (target && (this.isAgentAncestor(actor, target) || this.isAgentAncestor(target, actor))) return true;
    }
    if (message.runId === actor.runId) return true;
    if (message.objectiveId !== null && this.store.listObjectiveRuns({ objectiveId: message.objectiveId, limit: 2_000 }).some((run) => run.runId === actor.runId)) return true;
    return false;
  }

  private isAgentAncestor(ancestor: AgentRecord, descendant: AgentRecord): boolean {
    let current: AgentRecord | null = descendant;
    const visited = new Set<string>();
    while (current.parentAgentId !== null) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);
      const parent = this.store.getAgent(current.parentAgentId);
      if (!parent) return false;
      if (parent.id === ancestor.id) return true;
      current = parent;
    }
    return false;
  }

  private requireAgentAuthentication(request: IncomingMessage, agentId: string): void {
    const callerId = request.headers["x-symphony-agent-id"];
    const token = request.headers["x-symphony-agent-token"];
    if (callerId !== agentId || typeof token !== "string" || !this.agents.authenticate(agentId, token)) {
      throw new HttpError(401, "Invalid agent coordination token");
    }
  }

  /**
   * Native agents get a capability token, not the broad user control plane.
   * Keep coordination operations inside the caller's durable agent tree so a
   * compromised or confused child cannot steer unrelated work in the store.
   */
  private requireAgentTargetAccess(request: IncomingMessage, targetAgentId: string, action: string): void {
    const callerId = request.headers["x-symphony-agent-id"];
    if (callerId === undefined) return;
    const token = request.headers["x-symphony-agent-token"];
    if (typeof callerId !== "string" || typeof token !== "string") {
      throw new HttpError(401, "Invalid agent coordination token");
    }
    const caller = this.store.getAgent(callerId);
    if (!caller || !this.agents.authenticate(callerId, token)) {
      throw new HttpError(401, "Invalid agent coordination token");
    }
    const target = this.store.getAgent(targetAgentId);
    if (!target) throw new HttpError(404, `Agent not found: ${targetAgentId}`);
    if (!this.sharesAgentRoot(caller, target)) {
      throw new HttpError(403, `An authenticated agent may ${action} only agents in its root lineage.`);
    }
  }

  /**
   * Workflow runs are a separate durable resource from their step agents. A
   * run must therefore be authorized from its immutable origin when present,
   * with the materialized run agents as a compatibility path for older runs.
   * An authenticated agent can never fall back to broad run access.
   */
  private requireAgentRunAccess(request: IncomingMessage, runId: string, action: string): void {
    const callerId = request.headers["x-symphony-agent-id"];
    if (callerId === undefined) return;
    const token = request.headers["x-symphony-agent-token"];
    if (typeof callerId !== "string" || typeof token !== "string") {
      throw new HttpError(401, "Invalid agent coordination token");
    }
    const caller = this.store.getAgent(callerId);
    if (!caller || !this.agents.authenticate(callerId, token)) {
      throw new HttpError(401, "Invalid agent coordination token");
    }
    const run = this.store.getRun(runId);
    if (!run) throw new HttpError(404, `Workflow run not found: ${runId}`);

    const originAgent = run.origin?.parentAgentId ? this.store.getAgent(run.origin.parentAgentId) : null;
    const runAgents = this.store.listAgents({ runId });
    const ownedByCaller = (originAgent && this.sharesAgentRoot(caller, originAgent))
      || runAgents.some((agent) => this.sharesAgentRoot(caller, agent));
    if (!ownedByCaller) {
      throw new HttpError(403, `An authenticated agent may ${action} only runs in its root lineage.`);
    }
  }

  private sharesAgentRoot(left: AgentRecord, right: AgentRecord): boolean {
    const leftRoot = this.agentRoot(left);
    const rightRoot = this.agentRoot(right);
    return Boolean(
      leftRoot
      && rightRoot
      && leftRoot.id === rightRoot.id
      && leftRoot.runId === rightRoot.runId,
    );
  }

  private agentRoot(agent: AgentRecord): AgentRecord | null {
    let current = agent;
    const visited = new Set<string>();
    while (current.parentAgentId !== null) {
      if (visited.has(current.id)) return null;
      visited.add(current.id);
      const parent = this.store.getAgent(current.parentAgentId);
      if (!parent) return null;
      current = parent;
    }
    return current;
  }

  /**
   * Canonicalize a child workspace before it enters an AgentWorkOrder. A
   * lexical path check alone is insufficient: symlinks can escape a grant
   * after normalization. Realpath both sides and compare path components.
   */
  private childWorkspaceGrant(parent: z.infer<typeof WorkspaceSpecSchema>, child?: z.infer<typeof WorkspaceSpecSchema>): z.infer<typeof WorkspaceSpecSchema> {
    try {
      return containedChildWorkspaceGrant(parent, child, this.loaded.rootDirectory);
    } catch (error) {
      if (error instanceof WorkspaceContainmentError) throw new HttpError(403, error.message);
      throw error;
    }
  }

  private canonicalWorkspacePath(inputPath: string, label: string): string {
    try {
      return containedCanonicalWorkspacePath(inputPath, this.loaded.rootDirectory, label);
    } catch (error) {
      if (error instanceof WorkspaceContainmentError) throw new HttpError(403, error.message);
      throw error;
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
            this.registerWorkflowTriggers(new WorkflowCompiler().compile(previous.definition, previous.revision));
          }
        } else {
          // Claim the activation policy before the workflow record becomes
          // visible. If the daemon dies between registration and trigger
          // startup, recovery still sees the agent proposal as pending.
          this.persistWorkflowTriggerPolicy(
            ir,
            command.actor.type === "agent" ? "pending" : "active",
            command.actor.type === "agent" ? "agent" : "user",
          );
          result = this.workflows.register(ir) as unknown as JsonValue;
          if (this.loaded.config.workflows.triggersEnabled) {
            this.registerWorkflowTriggers(ir);
          }
        }
      } else if (command.type === "workflow.run") {
        const payload = command.payload as Record<string, JsonValue>;
        result = this.workflows.start(
          String(payload.workflowId),
          payload.input ?? {},
          {
            runId: commandDerivedId("run", command.idempotencyKey),
            origin: this.workflowRunOrigin(command.actor),
          },
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
            if (this.loaded.config.workflows.triggersEnabled) this.registerWorkflowTriggers(candidate);
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
      workflows: this.workflowReadProjection() as unknown as JsonValue[],
      runs: runs as unknown as JsonValue[], agents,
      messages: [], attentions: this.store.listObjectiveAttentions({ limit: 2_000 }), projects: this.projects.list(), costs: summarizeUsage(usage),
      runCosts: Object.fromEntries(runs.map((run) => [run.id, summarizeUsage(usage.filter((event) => event.runId === run.id))])),
      agentCosts: Object.fromEntries(agents.map((agent) => [agent.id, summarizeUsage(usage.filter((event) => event.agentId === agent.id))])),
      plugins: this.store.listPluginStates() as unknown as JsonValue[],
      settings: this.settings(),
      daemon: { version: "0.1.0", startedAt: this.startedAt, noPlugins: this.options.noPlugins ?? false },
    };
  }

  private workflowTriggerPolicy(ir: WorkflowIr): WorkflowTriggerPolicy | null | "invalid" {
    const value = this.store.getMetadata<JsonValue>(workflowTriggerPolicyKey(ir.definition.id));
    if (value === null) return null;
    const parsed = WorkflowTriggerPolicySchema.safeParse(value);
    if (!parsed.success) return "invalid";
    return parsed.data;
  }

  /**
   * Rebuild a trigger only after consulting its durable activation policy.
   * Unknown legacy workflows default to active for backwards compatibility;
   * newly registered agent workflows always persist `pending` before their
   * workflow record is written, so a crash cannot silently activate them.
   */
  private registerWorkflowTriggers(ir: WorkflowIr): void {
    const policy = this.workflowTriggerPolicy(ir);
    const matches = policy !== null
      && policy !== "invalid"
      && policy.workflowId === ir.definition.id
      && policy.revision === ir.revision
      && policy.hash === ir.hash;
    const mode = policy === "invalid" ? "pending" : matches ? policy.mode : "active";
    if (policy === null || (policy !== "invalid" && !matches)) {
      this.persistWorkflowTriggerPolicy(ir, "active", "user");
    }
    this.triggers.register(ir, { mode });
  }

  private persistWorkflowTriggerPolicy(ir: WorkflowIr, mode: WorkflowTriggerPolicy["mode"], source: WorkflowTriggerPolicy["source"]): void {
    this.store.setMetadata(workflowTriggerPolicyKey(ir.definition.id), WorkflowTriggerPolicySchema.parse({
      version: 1,
      workflowId: ir.definition.id,
      revision: ir.revision,
      hash: ir.hash,
      mode,
      source,
      updatedAt: nowIso(),
    }) as unknown as JsonValue);
  }

  private workflowReadProjection(): Array<JsonValue> {
    return this.store.listWorkflows().map((record) => {
      const value = this.store.getMetadata<JsonValue>(workflowTriggerPolicyKey(record.id));
      const parsed = value === null ? null : WorkflowTriggerPolicySchema.safeParse(value);
      const policy = parsed === null ? null : parsed.success ? parsed.data : "invalid" as const;
      const matches = policy !== null
        && policy !== "invalid"
        && policy.workflowId === record.id
        && policy.revision === record.revision
        && policy.hash === record.hash;
      return {
        ...record,
        triggerState: policy === "invalid" ? "pending" : matches && policy.mode === "pending" ? "pending" : "active",
      } as unknown as JsonValue;
    });
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
      // The heatmap's contract is explicitly USD. Provider-reported amounts
      // in another currency are still recorded as usage, but remain unknown
      // here until a durable FX snapshot exists; never add EUR/JPY/etc. to a
      // number labelled USD.
      if (!isKnownUsdCost(event)) day.unknownEvents += 1;
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

  private events(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    scopedRunId?: string,
    scopedTypes?: readonly string[],
  ): void {
    const cursor = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
    const uiProjection = url.searchParams.get("projection") === "ui";
    const queryTypes = url.searchParams.getAll("type").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
    const queryPrefixes = url.searchParams.getAll("typePrefix").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
    // Explicit control-plan streams are semantic invalidation channels, not
    // generic UI projections. Keep their type scope authoritative even if a
    // caller appends `projection=ui` or unrelated query filters.
    const requestedTypes = scopedTypes ?? (uiProjection ? UI_EVENT_TYPES : queryTypes);
    const requestedPrefixes = scopedTypes ? [] : (uiProjection ? UI_EVENT_PREFIXES : queryPrefixes);
    const eventOptions = {
      ...((scopedRunId ?? url.searchParams.get("runId")) ? { runId: scopedRunId ?? url.searchParams.get("runId") as string } : {}),
      ...(requestedTypes.length > 0 ? { types: requestedTypes } : {}),
      ...(requestedPrefixes.length > 0 ? { typePrefixes: requestedPrefixes } : {}),
    };
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    // Flush an initial frame even when the client is already at the latest cursor.
    // Without it, fetch() does not resolve until the 15s heartbeat and a healthy
    // projection incorrectly remains in its "connecting" state after reload.
    response.write(": connected\n\n");
    this.eventResponses.add(response);
    let replaying = true;
    const buffered: EventEnvelope[] = [];
    const unsubscribe = this.store.onEvent((event) => {
      if (!eventMatchesFilter(event, eventOptions)) return;
      if (replaying) buffered.push(event);
      else {
        // Chat presentation events may persist only a message identity to
        // keep the event log bounded. Rehydrate that identity against the
        // authoritative transcript before sending the live UI projection so
        // live delivery has the same shape as replay after a reload.
        for (const projected of projectStoredBacklog(this.store, [event])) writeEvent(response, projected);
      }
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

/** Read-only Git evidence. Any command failure is retained as an unproven value. */
function captureGitWorkspaceEvidence(workspacePath: string | null): {
  repo: string | null;
  repository?: string;
  ref: string | null;
  commit: string | null;
  dirty: boolean | null;
  patchHash: string | null;
  worktree: string | null;
} {
  const empty = { repo: null, ref: null, commit: null, dirty: null, patchHash: null, worktree: null };
  if (!workspacePath) return empty;
  const git = (args: string[]): string | null => {
    try {
      const value = execFileSync("git", ["-C", workspacePath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 8 * 1024 * 1024,
      }).trim();
      return value || null;
    } catch {
      return null;
    }
  };
  const root = git(["rev-parse", "--show-toplevel"]);
  if (!root) return empty;
  const remote = redactGitRemote(git(["config", "--get", "remote.origin.url"]));
  const ref = git(["symbolic-ref", "--short", "HEAD"]);
  const commit = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  const patch = status ? git(["diff", "--binary", "HEAD"]) : null;
  return {
    repo: remote ?? root,
    ...(remote ? { repository: remote } : {}),
    ref,
    commit,
    dirty: status === null ? null : status.length > 0,
    patchHash: patch ? createHash("sha256").update(patch).digest("hex") : null,
    worktree: root,
  };
}

function redactGitRemote(remote: string | null): string | null {
  if (!remote) return null;
  try {
    const parsed = new URL(remote);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // SCP-style remotes have no URL parser representation. Do not persist a
    // potentially credential-bearing value; the canonical local worktree is
    // still a provable repository identity.
    return null;
  }
}

function sideEffectRank(value: "read" | "local" | "external" | "irreversible"): number {
  return value === "read" ? 0 : value === "local" ? 1 : value === "external" ? 2 : 3;
}

function intersectNullableLimit(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function objectiveRuntimeHttpStatus(error: unknown): number | null {
  if (!(error instanceof ObjectiveRuntimeError)) return null;
  switch (error.code) {
    case "not-found":
    case "approval-not-found":
      return 404;
    case "invalid-plan":
      return 400;
    case "authority-exceeded":
      return 403;
    case "invalid-authority":
      return 401;
    case "idempotency-conflict":
    case "revision-conflict":
    case "invalid-state":
    case "replan-limit":
    case "approval-required":
      return 409;
    case "policy-expired":
    case "policy-mismatch":
      return 409;
  }
}

function objectiveOccurrenceOutcomeFromRunState(
  state: ObjectiveRunRecord["state"],
): ObjectiveOccurrenceOutcomeState {
  switch (state) {
    case "planning": return "queued";
    case "awaiting-approval": return "waiting";
    case "executing":
    case "evaluating":
    case "replanning": return "running";
    case "succeeded": return "succeeded";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "interrupted": return "interrupted";
  }
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
  // The store sanitizes new writes. Re-project here as a defense-in-depth
  // boundary for legacy rows created before worker payload limits existed.
  const isWorkerEvent = event.provenance?.source === "driver" || event.provenance?.rawProvenance !== undefined;
  const provenance = isWorkerEvent && event.provenance?.rawProvenance
    ? {
      ...event.provenance,
      rawProvenance: {
        ...event.provenance.rawProvenance,
        payload: projectWorkerEventPayload(event.provenance.rawProvenance.payload) as JsonValue,
      },
    }
    : event.provenance;
  const exported = isWorkerEvent
    ? { ...event, payload: projectWorkerEventPayload(event.payload) as JsonValue, provenance }
    : event;
  response.write(`id: ${exported.cursor}\nevent: ${exported.type}\ndata: ${JSON.stringify(exported)}\n\n`);
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

export function summarizeUsage(events: UsageEvent[]): JsonValue {
  const byBasis: Record<string, number> = {};
  let knownTotal = 0;
  let unknownEvents = 0;
  for (const event of events) {
    // This projection is labelled USD. Do not silently treat a provider's
    // non-USD amount as dollars without a durable FX snapshot.
    if (!isKnownUsdCost(event)) {
      unknownEvents += 1;
      continue;
    }
    knownTotal += event.costAmount;
    byBasis[event.basis] = (byBasis[event.basis] ?? 0) + event.costAmount;
  }
  return { currency: "USD", knownTotal, unknownEvents, eventCount: events.length, byBasis };
}

function isKnownUsdCost(event: UsageEvent): event is UsageEvent & { costAmount: number } {
  return event.costAmount !== null && event.currency.trim().toUpperCase() === "USD";
}

function hashMission(statement: string, keyResults: string[]): string {
  return createHash("sha256").update(`${statement}\0${keyResults.join("\0")}`).digest("hex");
}

function projectIdForPath(workspacePath: string): string {
  return `project-${createHash("sha256").update(workspacePath).digest("hex").slice(0, 16)}`;
}

function objectiveWorkspaceKey(runId: string): string {
  return `objective-workspace:${runId}`;
}

function serializableWorkspaceSpec(workspace: WorkspaceSpec): JsonValue {
  return {
    path: workspace.path,
    dirtyPolicy: workspace.dirtyPolicy,
    ...(workspace.remoteRepository ? { remoteRepository: workspace.remoteRepository } : {}),
    ...(workspace.startingRef ? { startingRef: workspace.startingRef } : {}),
  };
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

function eventMatchesFilter(
  event: EventEnvelope,
  options: { runId?: string; types?: readonly string[]; typePrefixes?: readonly string[] },
): boolean {
  if (options.runId !== undefined && event.runId !== options.runId) return false;
  const typeMatch = options.types === undefined || options.types.length === 0 || options.types.includes(event.type);
  const prefixMatch = options.typePrefixes === undefined
    || options.typePrefixes.length === 0
    || options.typePrefixes.some((prefix) => event.type.startsWith(prefix));
  // Storage treats explicit type and prefix filters as an OR. Preserve that
  // contract for live events so an SSE subscriber sees the same stream during
  // replay and after the subscription high-water mark.
  if (options.types?.length && options.typePrefixes?.length) return typeMatch || prefixMatch;
  return typeMatch && prefixMatch;
}

function attentionApprovalStatus(
  input: ObjectiveAttentionResolveRequest,
): Extract<ObjectiveApprovalRecord["status"], "approved" | "rejected" | "expired" | "cancelled"> | null {
  if (input.status === "expired") return "expired";
  if (input.status === "cancelled") return "cancelled";
  const decision = input.decision;
  if (decision && typeof decision === "object" && !Array.isArray(decision) && typeof decision.approved === "boolean") {
    return decision.approved ? "approved" : "rejected";
  }
  if (decision === true || decision === "approved") return "approved";
  if (decision === false || decision === "rejected") return "rejected";
  return null;
}

function attentionApprovalResolutionKey(sourceRequestKey: string, attentionId: string): string {
  return `objective-attention-approval:${sourceRequestKey}:${attentionId}`;
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
