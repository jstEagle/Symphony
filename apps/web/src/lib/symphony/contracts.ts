import type {
  ObjectiveActor,
  ObjectiveApprovalRecord,
  ObjectiveBudgetDebitRecord,
  ObjectiveBudgetLedgerRecord,
  ObjectiveBudgetReservationRecord,
  ObjectiveCheckpointRecord,
  ObjectiveRunRecord,
  ObjectiveTaskRecord,
  ObjectiveControlPlanRevision,
  ObjectiveControlPlanSnapshot,
  ObjectiveAggregateSnapshot,
  ObjectiveAggregateRecord,
} from "../../../../../packages/protocol/src/index.js";

export type {
  ObjectiveActor,
  ObjectiveApprovalRecord,
  ObjectiveBudgetDebitRecord,
  ObjectiveBudgetLedgerRecord,
  ObjectiveBudgetReservationRecord,
  ObjectiveCheckpointRecord,
  ObjectivePolicySnapshot,
  ObjectiveRunRecord,
  ObjectiveTaskRecord,
  ObjectiveControlPlanRevision,
  ObjectiveControlPlanSnapshot,
  ObjectiveAggregateSnapshot,
  ObjectiveAggregateRecord,
} from "../../../../../packages/protocol/src/index.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentState =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale";

export type NativeAgentStatus =
  | "queued"
  | "routing"
  | "starting"
  | "running"
  | "idle"
  | "waiting"
  | "completed"
  | "failed"
  | "cancel-requested"
  | "cancelled"
  | "interrupted"
  | "lost";

export type AgentAccess = "read-only" | "full-access";

export type HarnessId =
  | "auto"
  | "codex"
  | "claude"
  | "cursor"
  | "opencode"
  | "pi"
  | "acp";

export type ConversationState = "idle" | "running" | "attention" | "completed";

export type LoaderKind = "square" | "circular" | "triangle";

export type ConnectionState = "preview" | "connecting" | "live" | "stale" | "offline";

export type ConversationSummary = {
  id: string;
  groupId: string;
  title: string;
  updatedLabel: string;
  updatedAt: string;
  state: ConversationState;
  pinned: boolean;
  unread?: boolean;
  loader?: LoaderKind;
  conductorAgentId?: string | null;
  workspacePath?: string;
  archived?: boolean;
};

export type ConversationGroup = {
  id: string;
  title: string;
  conversations: ConversationSummary[];
};

export type ConversationDirectory = {
  activeConversationId: string | null;
  groups: ConversationGroup[];
};

export type WorkflowMission = {
  statement: string;
  keyResults: string[];
  revision: string | number;
  hash?: string;
  id?: string;
};

export type WorkflowRevisionRecord = {
  id: string;
  revision: number;
  mission: JsonValue;
  definition: JsonValue;
  ir: JsonValue;
  hash: string;
  createdAt: string;
  triggerState?: "active" | "pending";
};

/** The immutable plan snapshot returned with a durable objective detail. */
export type ObjectivePlanRevisionRecord = Readonly<{
  version: 1;
  id: string;
  runId: string;
  objectiveId: string;
  workflowId: string;
  workflowRevision: number;
  workflowHash: string;
  planRevision: number;
  tasks: ObjectiveTaskRecord[];
  createdBy: ObjectiveActor;
  requestKey: string;
  createdAt: string;
}>;

/** Read-only objective endpoints are authoritative daemon projections. */
export type ObjectiveListResponse = {
  objectives: ObjectiveRunRecord[];
  limit: number;
};

/** One atomic objective projection. All child records share this cursor fence. */
export type ObjectiveSnapshotResponse = ObjectiveAggregateSnapshot;

export type ObjectiveAggregateListResponse = {
  aggregates: ObjectiveAggregateRecord[];
  limit: number;
};

export type ObjectiveDetailResponse = {
  run: ObjectiveRunRecord;
  planRevisions: ObjectivePlanRevisionRecord[];
  checkpoints: ObjectiveCheckpointRecord[];
  approvals: ObjectiveApprovalRecord[];
  /** Optional in the rolling API contract; absent on legacy daemon responses. */
  budgetLedger?: ObjectiveBudgetLedgerRecord | null;
  reservations?: ObjectiveBudgetReservationRecord[] | null;
  debits?: ObjectiveBudgetDebitRecord[] | null;
  events: EventEnvelope[];
  eventCursor: number;
  hasMore: boolean;
  /** Optional on older daemons; the dedicated strategy endpoint is preferred. */
  control?: ObjectiveControlProjection | null;
};

/** The immutable tree projection used by the Strategy surface when available. */
export type ObjectiveControlProjection = Readonly<{
  runId: string;
  objectiveId: string;
  planId: string;
  revision: ObjectiveControlPlanRevision;
  snapshot: ObjectiveControlPlanSnapshot;
}>;

export type Agent = {
  id: string;
  /** Stable work-order identity from the daemon's agent ledger. */
  logicalAgentId?: string;
  parentId?: string;
  /** Optional graph-only dependency references when a workflow supplies them. */
  dependsOn?: string[];
  depth: number;
  name: string;
  objective: string;
  model: string;
  harness: string;
  access: AgentAccess;
  state: AgentState;
  nativeStatus?: NativeAgentStatus;
  elapsed: string;
  cost: number;
  lastActivity: string;
  nativeSessionId?: string | null;
  nativeRunId?: string | null;
  workspacePath?: string;
  output?: JsonValue | null;
  error?: string | null;
  runId?: string;
  workflowId?: string;
  startedAt?: string | null;
  updatedAt?: string;
  finishedAt?: string | null;
};

export type WorkNode = {
  id: string;
  label: string;
  detail: string;
  agentId?: string;
  /** Durable identity used for graph reconciliation and React keys. */
  ledgerId?: string;
  runId?: string;
  rootId?: string;
  turn?: number;
  state: AgentState;
  x: number;
  y: number;
};

export type WorkEdge = {
  from: string;
  to: string;
  kind: "dependency" | "delegation";
};

export type ActivityEvent = {
  id: string;
  at: string;
  occurredAt?: string;
  kind: "delegation" | "tool" | "message" | "observation" | "system";
  title: string;
  detail: string;
  agentId?: string;
  nodeId?: string;
  source: "runtime-observed" | "agent-reported" | "client-inferred";
  cursor?: number;
};

export type CostSummary = {
  amount: number;
  currency: string;
  provenance: "measured" | "estimated" | "pending" | "unavailable";
  knownTotal?: number;
  unknownEvents?: number;
  eventCount?: number;
  byBasis?: Record<string, number>;
};

export type UsageHeatmapDay = {
  date: string;
  knownCost: number;
  eventCount: number;
  unknownEvents: number;
  future: boolean;
};

export type UsageHeatmap = {
  currency: string;
  weeks: number;
  startDate: string;
  endDate: string;
  days: UsageHeatmapDay[];
};

export type RunSnapshot = {
  runId: string;
  workflowId?: string;
  workspace: string;
  mode: "preview" | "live";
  mission: WorkflowMission;
  phase: string;
  cost: CostSummary;
  agents: Agent[];
  nodes: WorkNode[];
  edges: WorkEdge[];
  events: ActivityEvent[];
  traceEvents?: EventEnvelope[];
  runStatus?: string;
  cancelRequested?: boolean;
};

export type ObservationLevel = "tldr" | "paragraph" | "full";

export type AgentObservation = {
  level: ObservationLevel;
  summary: string;
  generatedBy: "deterministic" | "model";
  model?: string | null;
};

export type AgentDetail = Agent & {
  observations: Partial<Record<ObservationLevel, AgentObservation>>;
  children: Agent[];
  parent?: Agent;
  files: Array<{ path: string; detail?: string }>;
  artifacts: Array<{ id: string; label: string }>;
};

export type AgentLogEntry = {
  cursor: number;
  at: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  type: string;
  message: string;
  data: JsonValue;
};

export type AgentSessionLog = {
  agent: {
    id: string;
    status: NativeAgentStatus;
    harness: string;
    model: string;
    nativeSessionId: string | null;
    nativeRunId: string | null;
    workspacePath: string;
    error: string | null;
  };
  cursor: number;
  entries: AgentLogEntry[];
};

export type InboxItem = {
  id: string;
  conversationId?: string;
  agentId?: string;
  title: string;
  detail: string;
  at: string;
  severity: "info" | "attention" | "failure";
  read: boolean;
};

export type DriverReport = {
  driver: string;
  available: boolean;
  authenticated: boolean | null;
  version: string | null;
  detail: string;
  latestVersion?: string | null;
  updateAvailable?: boolean | null;
  updateSupported?: boolean;
  updateDetail?: string;
  checkedAt?: string;
  capabilities?: {
    streaming: boolean;
    resume: boolean;
    steer: boolean;
    passiveHistory: boolean;
    usage: boolean;
    mcp: boolean;
    local: boolean;
    cloud: boolean;
    readOnly: boolean;
  };
};

export type DriverAuthenticationResult = {
  authenticated: boolean;
  detail: string;
  loginUrl?: string;
};

export type PluginState = {
  id: string;
  version: string;
  status: "discovered" | "building" | "active" | "failed" | "disabled" | "quarantined";
  error: string | null;
  path?: string;
};

export type ModelDescriptor = {
  id: string;
  harness: string;
  model?: string;
  name: string;
  description?: string;
  contextTokens?: number;
};

export type RuntimeSettings = {
  configPath: string;
  conductor: {
    harness: Exclude<HarnessId, "auto">;
    model: string;
  };
  agents: {
    maxDepth: number | null;
    maxConcurrent: number | null;
    defaultPermissions: AgentAccess;
  };
  uiUtilities: {
    chatSearch: {
      rerankEnabled: boolean;
      reranker: string;
      prefilterLimit: number;
      maxDocumentCharacters: number;
      cacheTtlSeconds: number;
      requestTimeoutMs: number;
    };
  };
};

export type ChatAttachment = {
  id: string;
  name: string;
  type: string;
  contentType?: string;
  content: JsonValue[];
};

export type ChatThreadRecord = {
  id: string;
  title: string;
  groupId: string | null;
  conductorAgentId: string | null;
  mission: JsonValue;
  workspacePath: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectRecord = {
  id: string;
  title: string;
  workspacePath: string;
  isGitRepository: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DirectoryListing = {
  currentPath: string;
  parentPath: string | null;
  entries: Array<{
    name: string;
    path: string;
    isGitRepository: boolean;
  }>;
};

export type ConversationMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  parts: JsonValue[];
  streaming?: boolean;
  createdAt: string;
  updatedAt?: string;
};

export type AgentRecord = {
  id: string;
  logicalAgentId: string;
  workflowId: string;
  runId: string;
  parentAgentId: string | null;
  depth: number;
  objective: string;
  missionHash: string;
  requestedHarness: HarnessId;
  requestedModel: string;
  harness: Exclude<HarnessId, "auto"> | null;
  model: string | null;
  permissions: AgentAccess;
  status: NativeAgentStatus;
  nativeSessionId: string | null;
  nativeRunId: string | null;
  workspacePath: string;
  output: JsonValue | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowRunRecord = {
  id: string;
  workflowId: string;
  workflowRevision: number;
  status: string;
  input: JsonValue;
  output: JsonValue | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
};

export type EventEnvelope = {
  id: string;
  cursor: number;
  type: string;
  workflowId: string | null;
  runId: string | null;
  agentId: string | null;
  occurredAt: string;
  payload: JsonValue;
  provenance?: {
    source: "daemon" | "workflow" | "driver" | "plugin" | "observer" | "user";
    nativeEventId?: string;
    driver?: string;
  };
};

export type DaemonInfo = {
  version: string;
  startedAt: string;
  noPlugins: boolean;
};

export type BootstrapEnvelope = {
  apiVersion: 1;
  runtimeEpoch: string;
  cursor: number | string;
  events: EventEnvelope[];
  mode: "preview" | "runtime";
  directory: ConversationDirectory;
  run: RunSnapshot;
  threads: ChatThreadRecord[];
  messages: ConversationMessage[];
  projects: ProjectRecord[];
  workflows: WorkflowRevisionRecord[];
  agents: AgentRecord[];
  runs: WorkflowRunRecord[];
  costs: CostSummary;
  runCosts: Record<string, CostSummary>;
  agentCosts: Record<string, CostSummary>;
  plugins: PluginState[];
  drivers: DriverReport[];
  models: ModelDescriptor[];
  settings: RuntimeSettings;
  inbox: InboxItem[];
  daemon: DaemonInfo;
};

export type CommandType =
  | "agent.create"
  | "agent.message"
  | "agent.observe"
  | "agent.cancel"
  | "agent.present"
  | "workflow.register"
  | "workflow.run"
  | "workflow.cancel"
  | "plugin.invoke"
  | "driver.update"
  | "driver.authenticate";

export type CommandReceipt = {
  idempotencyKey: string;
  accepted: boolean;
  state: "dispatching" | "settled" | "failed";
  result: JsonValue;
  createdAt: string;
  updatedAt?: string;
};

export type PluginSlotName =
  | "sidebar.footer"
  | "settings.panel"
  | "run-details.section"
  | "composer.action"
  | "message.part"
  | "tool.result";
