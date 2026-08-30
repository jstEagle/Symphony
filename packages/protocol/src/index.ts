import { z } from "zod";

export const IdSchema = z.string().min(1);
export const IsoDateSchema = z.iso.datetime({ offset: true });
export const JsonValueSchema = z.json();

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const PermissionSchema = z.enum(["read-only", "full-access"]);
export type Permission = z.infer<typeof PermissionSchema>;

export const HarnessSchema = z.enum([
  "auto",
  "codex",
  "claude",
  "cursor",
  "opencode",
  "pi",
  "acp",
]);
export type Harness = z.infer<typeof HarnessSchema>;
export type ResolvedHarness = Exclude<Harness, "auto">;

export const AgentStatusSchema = z.enum([
  "queued",
  "routing",
  "starting",
  "running",
  "idle",
  "waiting",
  "completed",
  "failed",
  "cancel-requested",
  "cancelled",
  "interrupted",
  "lost",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const WorkflowMissionSchema = z.object({
  id: IdSchema,
  revision: z.number().int().positive(),
  hash: z.string().min(8),
  statement: z.string().min(1).max(2_000),
  keyResults: z.array(z.string().min(1).max(500)).max(12).default([]),
});
export type WorkflowMission = z.infer<typeof WorkflowMissionSchema>;

export const ArtifactRefSchema = z.object({
  kind: z.literal("artifact"),
  id: IdSchema,
  mediaType: z.string().optional(),
});
export const FileRefSchema = z.object({
  kind: z.literal("file"),
  path: z.string().min(1),
  revision: z.string().optional(),
});
export const AgentOutputRefSchema = z.object({
  kind: z.literal("agent-output"),
  agentId: IdSchema,
  path: z.string().optional(),
});
export const SkillRefSchema = z.object({
  kind: z.literal("skill"),
  path: z.string().min(1),
});
export const AgentInputSchema = z.discriminatedUnion("kind", [
  ArtifactRefSchema,
  FileRefSchema,
  AgentOutputRefSchema,
  SkillRefSchema,
]);
export type AgentInput = z.infer<typeof AgentInputSchema>;

export const RoutingIntentSchema = z.object({
  taskKind: z
    .enum(["frontend", "coding", "research", "summarization", "general"])
    .optional(),
  prioritize: z
    .array(
      z.enum([
        "human-preference",
        "intelligence",
        "coding-success",
        "agentic-success",
        "lowest-cost-per-task",
        "fewest-turns",
        "large-context",
      ]),
    )
    .optional(),
  requires: z
    .object({
      modalities: z.array(z.enum(["text", "image", "audio", "video"])).optional(),
      minimumContextTokens: z.number().int().positive().optional(),
      structuredOutput: z.boolean().optional(),
    })
    .optional(),
});
export type RoutingIntent = z.infer<typeof RoutingIntentSchema>;

export const WorkspaceSpecSchema = z.object({
  path: z.string().min(1),
  remoteRepository: z.string().url().optional(),
  startingRef: z.string().min(1).optional(),
  dirtyPolicy: z.enum(["local-only", "require-clean", "explicit-checkpoint"]).default("local-only"),
});
export type WorkspaceSpec = z.infer<typeof WorkspaceSpecSchema>;

export const AgentWorkOrderSchema = z.object({
  id: IdSchema.optional(),
  workflowId: IdSchema,
  runId: IdSchema,
  parentAgentId: IdSchema.nullable().default(null),
  depth: z.number().int().nonnegative(),
  mission: WorkflowMissionSchema,
  objective: z.string().min(1).max(20_000),
  model: z.string().min(1).default("auto"),
  harness: HarnessSchema.default("auto"),
  permissions: PermissionSchema.default("full-access"),
  outputSchema: z.record(z.string(), JsonValueSchema),
  inputs: z.array(AgentInputSchema).default([]),
  routing: RoutingIntentSchema.optional(),
  workspace: WorkspaceSpecSchema,
  metadata: z.record(z.string(), JsonValueSchema).default({}),
});
export type AgentWorkOrder = z.infer<typeof AgentWorkOrderSchema>;

export const AgentRecordSchema = z.object({
  id: IdSchema,
  logicalAgentId: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  parentAgentId: IdSchema.nullable(),
  depth: z.number().int().nonnegative(),
  objective: z.string(),
  missionHash: z.string(),
  requestedHarness: HarnessSchema,
  requestedModel: z.string(),
  harness: HarnessSchema.exclude(["auto"]).nullable(),
  model: z.string().nullable(),
  permissions: PermissionSchema,
  status: AgentStatusSchema,
  nativeSessionId: z.string().nullable(),
  nativeRunId: z.string().nullable(),
  workspacePath: z.string(),
  output: JsonValueSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export const DriverCapabilitySchema = z.object({
  streaming: z.boolean(),
  resume: z.boolean(),
  steer: z.boolean(),
  passiveHistory: z.boolean(),
  usage: z.boolean(),
  mcp: z.boolean(),
  local: z.boolean(),
  cloud: z.boolean(),
  readOnly: z.boolean(),
});
export type DriverCapability = z.infer<typeof DriverCapabilitySchema>;

export const ModelDescriptorSchema = z.object({
  id: z.string().min(1),
  harness: HarnessSchema.exclude(["auto"]),
  name: z.string().min(1),
  description: z.string().default(""),
  contextTokens: z.number().int().positive().optional(),
  modalities: z.array(z.string()).default(["text"]),
  structuredOutput: z.boolean().default(false),
  pricing: z
    .object({
      inputPerMillion: z.number().nonnegative().optional(),
      outputPerMillion: z.number().nonnegative().optional(),
    })
    .default({}),
  metadata: z.record(z.string(), JsonValueSchema).default({}),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const DriverSessionSchema = z.object({
  driver: HarnessSchema.exclude(["auto"]),
  nativeSessionId: z.string().min(1),
  nativeRunId: z.string().nullable().default(null),
  state: z.enum(["starting", "running", "idle", "completed", "failed", "cancelled", "unknown"]),
  startedAt: z.string(),
  metadata: z.record(z.string(), JsonValueSchema).default({}),
});
export type DriverSession = z.infer<typeof DriverSessionSchema>;

export const ProcessIdentitySchema = z.object({
  pid: z.number().int().positive(),
  processGroupId: z.number().int().positive().nullable(),
  platform: z.string().min(1),
  capturedAt: IsoDateSchema,
  executable: z.string().min(1).nullable(),
  startToken: z.string().min(1).nullable(),
  verification: z.enum(["strong", "weak", "unverified"]),
});
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;

export const WorkerTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct") }),
  z.object({
    kind: z.literal("worker-host"),
    protocolVersion: z.literal(1),
    endpoint: z.string().min(1),
    spoolPath: z.string().min(1),
    hostInstanceId: z.string().min(1),
    hostIdentity: ProcessIdentitySchema.nullable(),
    workerIdentity: ProcessIdentitySchema.nullable(),
    controllerOwnerId: z.string().min(1),
    ownerEpoch: z.number().int().nonnegative(),
    processedOutputSeq: z.number().int().nonnegative(),
    ackedOutputSeq: z.number().int().nonnegative(),
    producedOutputSeq: z.number().int().nonnegative(),
    spoolBytes: z.number().int().nonnegative(),
    spoolState: z.enum(["healthy", "overflow"]),
  }),
]);
export type WorkerTransport = z.infer<typeof WorkerTransportSchema>;

export const DriverProcessSpecSchema = z.object({
  role: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).nullable(),
  adapterVersion: z.string().min(1).nullable(),
});
export type DriverProcessSpec = z.infer<typeof DriverProcessSpecSchema>;

export const WorkerProcessLeaseStateSchema = z.enum([
  "reserved",
  "running",
  "exited",
  "orphaned",
  "identity-mismatch",
  "unverified",
]);
export type WorkerProcessLeaseState = z.infer<typeof WorkerProcessLeaseStateSchema>;

export const WorkerProcessLeaseSchema = z.object({
  id: IdSchema,
  daemonOwnerId: IdSchema,
  agentId: IdSchema,
  attemptId: IdSchema,
  driver: HarnessSchema.exclude(["auto"]),
  role: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).nullable(),
  workspacePath: z.string().min(1),
  permission: PermissionSchema,
  adapterVersion: z.string().min(1).nullable(),
  transport: WorkerTransportSchema.default({ kind: "direct" }),
  adapterState: JsonValueSchema.default({}),
  identity: ProcessIdentitySchema.nullable(),
  nativeSessionId: z.string().min(1).nullable(),
  nativeRunId: z.string().min(1).nullable(),
  activeTurnId: z.string().min(1).nullable(),
  lastEventCursor: z.number().int().nonnegative().nullable(),
  state: WorkerProcessLeaseStateSchema,
  reservedAt: IsoDateSchema,
  attachedAt: IsoDateSchema.nullable(),
  updatedAt: IsoDateSchema,
  releasedAt: IsoDateSchema.nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
  error: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative(),
});
export type WorkerProcessLease = z.infer<typeof WorkerProcessLeaseSchema>;

export type DriverProcessLeaseUpdate = Partial<
  Pick<
    WorkerProcessLease,
    "nativeSessionId" | "nativeRunId" | "activeTurnId" | "lastEventCursor" | "error" | "transport" | "adapterState"
  >
>;

export type DriverWorkerHostPlan = {
  mode: "launch" | "reconnect";
  protocolVersion: 1;
  hostCommand: string;
  hostArgs: string[];
  capability: string;
  controllerOwnerId: string;
  ownerEpoch: number;
  endpoint: string;
  spoolPath: string;
  afterSeq: number;
  maxSpoolBytes: number;
  maxSpoolFrames: number;
};

export interface DriverProcessSupervisor {
  /** A durable process from an earlier daemon generation must be reattached before probing shared infrastructure. */
  readonly retainedProcess?: boolean;
  reserveProcess(spec: DriverProcessSpec): WorkerProcessLease;
  attachProcess(leaseId: string, identity: ProcessIdentity): WorkerProcessLease;
  adoptProcess?(
    leaseId: string,
    expectedRevision: number,
    transport: WorkerProcessLease["transport"],
  ): WorkerProcessLease;
  updateProcess(leaseId: string, patch: DriverProcessLeaseUpdate): WorkerProcessLease;
  releaseProcess(
    leaseId: string,
    result: { exitCode: number | null; signal: string | null; error?: string | null },
  ): WorkerProcessLease;
  workerHostPlan?(leaseId: string): DriverWorkerHostPlan | null;
}

export const DriverEventKindSchema = z.enum([
  "session.started",
  "run.started",
  "message.delta",
  "message.completed",
  "reasoning.delta",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "file.changed",
  "command.started",
  "command.completed",
  "approval.requested",
  "usage.recorded",
  "output.completed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "log",
]);
export type DriverEventKind = z.infer<typeof DriverEventKindSchema>;

export const DriverEventSchema = z.object({
  kind: DriverEventKindSchema,
  nativeEventId: z.string().optional(),
  occurredAt: z.string(),
  payload: JsonValueSchema,
});
export type DriverEvent = z.infer<typeof DriverEventSchema>;

export const DriverStartRequestSchema = z.object({
  agentId: IdSchema,
  workOrder: AgentWorkOrderSchema,
  resolvedModel: z.string().min(1),
  coordination: z.object({
    daemonUrl: z.string().url(),
    token: z.string().min(1),
    mcpCommand: z.string().min(1),
    mcpArgs: z.array(z.string()).default([]),
    canCreate: z.boolean(),
    maxDepth: z.number().int().nonnegative().nullable(),
  }),
});
export type DriverStartRequest = z.infer<typeof DriverStartRequestSchema>;

export type DriverLifecycleOptions = {
  /**
   * Aborted when Symphony no longer accepts a lifecycle result. Drivers must
   * stop provisional local resources and must not retain a late session.
   */
  signal: AbortSignal;
  /** Persist directly-owned adapter processes before they can outlive setup. */
  processSupervisor?: DriverProcessSupervisor;
};

export const DriverAuthenticationResultSchema = z.object({
  authenticated: z.boolean(),
  detail: z.string(),
  loginUrl: z.string().url().optional(),
});
export type DriverAuthenticationResult = z.infer<typeof DriverAuthenticationResultSchema>;

export interface WorkerDriver {
  readonly id: ResolvedHarness;
  readonly capabilities: DriverCapability;
  doctor(): Promise<DriverDoctorResult>;
  listModels(): Promise<ModelDescriptor[]>;
  /** Start the harness's documented interactive authentication flow. */
  authenticate?(): Promise<DriverAuthenticationResult>;
  start(
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession>;
  resume(
    session: DriverSession,
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession>;
  sendMessage(session: DriverSession, message: string): Promise<{
    receiptId: string;
    queued: boolean;
    /** The preceding native result won the boundary; persist this as a new turn. */
    terminalBoundary?: boolean;
    /**
     * A follow-up can allocate a new native run. The runtime must durably
     * replace its session/run checkpoint before it records delivery.
     */
    session?: DriverSession;
  }>;
  cancel(session: DriverSession): Promise<void>;
  /** Release this daemon's transport ownership without terminating durable native work. */
  detach?(session: DriverSession): Promise<void>;
  forceTerminate?(session: DriverSession): Promise<void>;
  dispose?(): Promise<void>;
}

export const DriverDoctorResultSchema = z.object({
  driver: HarnessSchema.exclude(["auto"]),
  available: z.boolean(),
  authenticated: z.boolean().nullable(),
  version: z.string().nullable(),
  capabilities: DriverCapabilitySchema,
  detail: z.string(),
  latestVersion: z.string().nullable().optional(),
  updateAvailable: z.boolean().nullable().optional(),
  updateSupported: z.boolean().optional(),
  updateDetail: z.string().optional(),
  checkedAt: z.string().optional(),
});
export type DriverDoctorResult = z.infer<typeof DriverDoctorResultSchema>;

export const EventEnvelopeSchema = z.object({
  id: IdSchema,
  cursor: z.number().int().positive(),
  type: z.string().min(1),
  workflowId: IdSchema.nullable(),
  runId: IdSchema.nullable(),
  agentId: IdSchema.nullable(),
  occurredAt: z.string(),
  payload: JsonValueSchema,
  provenance: z
    .object({
      source: z.enum(["daemon", "workflow", "driver", "plugin", "observer", "user"]),
      nativeEventId: z.string().optional(),
      driver: HarnessSchema.exclude(["auto"]).optional(),
    })
    .optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const UsageEventSchema = z.object({
  id: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  agentId: IdSchema.nullable(),
  model: z.string().nullable(),
  harness: HarnessSchema.exclude(["auto"]).nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  costAmount: z.number().nonnegative().nullable(),
  currency: z.string().default("USD"),
  basis: z.enum([
    "provider-reported",
    "harness-reported",
    "token-priced-estimate",
    "reconstructed-estimate",
    "unknown",
  ]),
  priceSnapshotId: z.string().nullable(),
  recordedAt: z.string(),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const ObservationLevelSchema = z.enum(["tldr", "paragraph", "full"]);
export type ObservationLevel = z.infer<typeof ObservationLevelSchema>;

export const ObservationSchema = z.object({
  id: IdSchema,
  agentId: IdSchema,
  level: ObservationLevelSchema,
  eventCursor: z.number().int().nonnegative(),
  summary: z.string(),
  state: AgentStatusSchema,
  claims: z.array(
    z.object({
      text: z.string(),
      eventIds: z.array(IdSchema),
      confidence: z.number().min(0).max(1),
    }),
  ),
  generatedBy: z.enum(["deterministic", "model"]),
  model: z.string().nullable(),
  costAmount: z.number().nonnegative().nullable(),
  createdAt: z.string(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const RoutingTraceSchema = z.object({
  id: IdSchema,
  workOrderId: IdSchema,
  catalogSnapshotId: IdSchema,
  query: z.string(),
  eligibleCandidateIds: z.array(z.string()),
  anonymousCards: z.array(
    z.object({ opaqueId: z.string(), text: z.string(), candidateId: z.string() }),
  ),
  method: z.enum(["explicit", "openrouter-rerank", "neutral-lexical"]),
  reranker: z.string().nullable(),
  scores: z.record(z.string(), z.number()),
  selectedCandidateId: z.string(),
  createdAt: z.string(),
});
export type RoutingTrace = z.infer<typeof RoutingTraceSchema>;

export const CommandSchema = z.object({
  idempotencyKey: z.string().min(8),
  type: z.enum([
    "agent.create",
    "agent.message",
    "agent.observe",
    "agent.cancel",
    "agent.present",
    "workflow.register",
    "workflow.run",
    "workflow.cancel",
    "plugin.invoke",
    "driver.update",
    "driver.authenticate",
  ]),
  payload: JsonValueSchema,
  actor: z.object({ type: z.enum(["user", "agent", "system"]), id: z.string().nullable() }),
});
export type Command = z.infer<typeof CommandSchema>;

export const CommandReceiptSchema = z.object({
  idempotencyKey: z.string(),
  accepted: z.boolean(),
  state: z.enum(["dispatching", "settled", "failed"]).default("settled"),
  result: JsonValueSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

export const ConversationMessageSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  role: z.enum(["user", "assistant", "system", "tool"]),
  parts: z.array(JsonValueSchema),
  streaming: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ProjectRecordSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(200),
  workspacePath: z.string().min(1),
  isGitRepository: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const DirectoryListingSchema = z.object({
  currentPath: z.string().min(1),
  parentPath: z.string().nullable(),
  entries: z.array(z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    isGitRepository: z.boolean(),
  })),
});
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

export const BootstrapProjectionSchema = z.object({
  cursor: z.number().int().nonnegative(),
  events: z.array(EventEnvelopeSchema).default([]),
  workflows: z.array(JsonValueSchema),
  runs: z.array(JsonValueSchema),
  agents: z.array(AgentRecordSchema),
  messages: z.array(ConversationMessageSchema),
  projects: z.array(ProjectRecordSchema).default([]),
  costs: JsonValueSchema,
  runCosts: z.record(z.string(), JsonValueSchema).default({}),
  agentCosts: z.record(z.string(), JsonValueSchema).default({}),
  plugins: z.array(JsonValueSchema),
  settings: z.object({
    configPath: z.string(),
    conductor: z.object({
      harness: HarnessSchema.exclude(["auto"]),
      model: z.string(),
    }),
    agents: z.object({
      maxDepth: z.number().int().nonnegative().nullable(),
      maxConcurrent: z.number().int().positive().nullable(),
      defaultPermissions: PermissionSchema,
    }),
  }),
  daemon: z.object({
    version: z.string(),
    startedAt: z.string(),
    noPlugins: z.boolean(),
  }),
});
export type BootstrapProjection = z.infer<typeof BootstrapProjectionSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted", "lost"].includes(status);
}

export function resolveChildPermission(parent: Permission, requested?: Permission): Permission {
  if (parent === "read-only") return "read-only";
  return requested ?? "full-access";
}
