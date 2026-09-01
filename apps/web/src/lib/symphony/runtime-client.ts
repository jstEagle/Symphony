import type {
  AgentObservation,
  AgentSessionLog,
  AgentRecord,
  BootstrapEnvelope,
  ChatAttachment,
  ChatThreadRecord,
  CommandReceipt,
  CommandType,
  ConversationMessage,
  CostSummary,
  DriverReport,
  DriverAuthenticationResult,
  EventEnvelope,
  JsonValue,
  ModelDescriptor,
  ObjectiveDetailResponse,
  ObjectiveSnapshotResponse,
  ObjectiveAggregateListResponse,
  ObjectiveControlProjection,
  ObjectiveListResponse,
  ObjectiveRunRecord,
  ObservationLevel,
  PluginState,
  ProjectRecord,
  DirectoryListing,
  RuntimeSettings,
  UsageHeatmap,
  WorkflowRevisionRecord,
} from "./contracts";
import type {
  AgentMessageDecision,
  AgentMessageRecord,
  AgentMessageReceipt,
  AgentMessageSnapshot,
} from "../../../../../packages/protocol/src/agent-message.js";
import type {
  ObjectiveApprovalRecord,
  ObjectiveArtifactRecord,
  ObjectiveArtifactReviewRecord,
  ObjectivePolicyRequest,
  ObjectiveSpec,
  ObjectiveTask,
  ObjectiveTaskState,
  ObjectiveActor,
  WorkspaceSpec,
} from "../../../../../packages/protocol/src/index.js";
import type {
  CapabilityCompatibilityTarget,
  CapabilityDefinition,
  CapabilityExecutionDefaults,
  CapabilityProvenance,
  CapabilityTriggerBinding,
  CapabilityVersionRecord,
} from "../../../../../packages/protocol/src/capability-library.js";
import { previewEnvelope } from "./preview";
import { symphonyConfig } from "@/symphony.config";

export type RuntimeMode = "preview" | "runtime";
export type RuntimeCatalog = {
  drivers: DriverReport[];
  models: ModelDescriptor[];
};

/**
 * Keep a runtime reload recoverable when the daemon is between generations.
 * React Query retains errors after its bounded retry budget is exhausted, so
 * the provider must continue checking until an authoritative bootstrap is
 * available. Once data is healthy, the interval stops.
 */
export function runtimeBootstrapRefetchInterval(
  mode: RuntimeMode,
  state: { data?: unknown; error?: unknown },
): number | false {
  return mode === "runtime" && (!state.data || state.error) ? 3_000 : false;
}

/** Durable capability registry responses. The daemon remains authoritative. */
export type CapabilityMutationResult = Readonly<{
  status: "committed" | "replayed" | "conflict" | "rejected";
  version: CapabilityVersionRecord | null;
  reason?: string;
}>;

export type CapabilityActivationInput = Readonly<{
  parameters?: JsonValue;
  triggers?: readonly CapabilityTriggerBinding[];
  target?: CapabilityCompatibilityTarget;
}>;

export type CapabilityExecutionResolution = Readonly<{
  compatible: boolean;
  reasons: string[];
  parameters: JsonValue;
  defaults: CapabilityExecutionDefaults;
  version: CapabilityVersionRecord;
}>;

export type CapabilityCreateInput = Readonly<{
  capabilityId: string;
  version?: number;
  definition: CapabilityDefinition;
  provenance: CapabilityProvenance;
  actor?: ObjectiveActor;
}>;

const WEB_ACTOR: ObjectiveActor = { type: "user", id: "web-ui" };

/**
 * The durable agent-message surface is a daemon projection. The browser never
 * derives delivery state from native transcripts or keeps a second message
 * authority; every item includes the immutable message and its receipts.
 */
export type AgentMessageProjection = Readonly<{
  message: AgentMessageRecord;
  receipts: AgentMessageReceipt[];
  state: AgentMessageSnapshot["state"];
  delivery: AgentMessageReceipt | null;
  read: AgentMessageReceipt | null;
  handled: AgentMessageReceipt | null;
}>;

export type AgentMessageProjectionResponse = Readonly<{
  actorId: string | null;
  messageCursor: number;
  receiptCursor: number;
  inbox: AgentMessageProjection[];
  outbox: AgentMessageProjection[];
}>;

export type AgentMessageReplyRequest = Readonly<{
  recipientId?: string;
  summary: string;
  payload?: JsonValue;
  artifactRefs?: readonly JsonValue[];
  evidenceRefs?: readonly JsonValue[];
  expiresAt?: string | null;
}>;

export type AgentMessageReceiptMutationResponse = Readonly<{
  status: "committed" | "replayed" | "conflict";
  receipt: AgentMessageReceipt | null;
  reason?: string;
}>;

export type AgentMessageReplyResponse = AgentMessageProjection | Readonly<{
  status: "committed" | "replayed" | "conflict";
  message: AgentMessageRecord | null;
  reason?: string;
}>;

type DaemonBootstrap = {
  cursor: number;
  events: EventEnvelope[];
  workflows: WorkflowRevisionRecord[];
  runs: JsonValue[];
  agents: AgentRecord[];
  messages: ConversationMessage[];
  projects: ProjectRecord[];
  costs: JsonValue;
  runCosts: Record<string, JsonValue>;
  agentCosts: Record<string, JsonValue>;
  plugins: PluginState[];
  settings: RuntimeSettings;
  daemon: BootstrapEnvelope["daemon"];
};

export class RuntimeRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RuntimeRequestError";
    this.status = status;
  }
}

export function isRetryableRuntimeRequestError(error: unknown): boolean {
  if (!(error instanceof RuntimeRequestError)) return true;
  return error.status === 408
    || error.status === 425
    || error.status === 429
    || error.status >= 500;
}

async function request<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`${symphonyConfig.apiBasePath}${path}`, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let value: T | undefined;
  if (text) {
    try {
      value = JSON.parse(text) as T;
    } catch {
      // Error responses from a daemon/proxy are not guaranteed to be JSON.
      // Preserve the HTTP status so retry policy can make the right decision.
      value = undefined;
    }
  }
  if (!response.ok) {
    const error = typeof value === "object" && value && "error" in value ? String((value as { error: unknown }).error) : text;
    throw new RuntimeRequestError(response.status, error || `${response.status} ${response.statusText}`);
  }
  return value as T;
}

export async function getHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch("/health", {
      signal,
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

export async function fetchBootstrap(
  mode: RuntimeMode,
  signal?: AbortSignal,
): Promise<BootstrapEnvelope> {
  if (mode === "preview") return previewEnvelope();

  const [bootstrap, threads] = await Promise.all([
    request<DaemonBootstrap>("/bootstrap", { signal }),
    // An empty list is valid data, but it is not a safe fallback for a failed
    // authoritative query. Let the bootstrap fail so React Query can retain
    // the last known good projection instead of replacing it with a lie.
    request<ChatThreadRecord[]>("/threads", { signal }),
  ]);

  return {
    apiVersion: 1,
    runtimeEpoch: bootstrap.daemon.startedAt,
    cursor: bootstrap.cursor,
    events: bootstrap.events ?? [],
    mode: "runtime",
    directory: { activeConversationId: null, groups: [] },
    run: previewEnvelope().run,
    threads,
    messages: bootstrap.messages,
    projects: bootstrap.projects ?? [],
    workflows: bootstrap.workflows ?? [],
    agents: bootstrap.agents ?? [],
    runs: (bootstrap.runs as BootstrapEnvelope["runs"]) ?? [],
    costs: normalizeCost(bootstrap.costs),
    runCosts: normalizeCostMap(bootstrap.runCosts),
    agentCosts: normalizeCostMap(bootstrap.agentCosts),
    plugins: bootstrap.plugins ?? [],
    drivers: [],
    models: [],
    settings: bootstrap.settings,
    inbox: [],
    daemon: bootstrap.daemon,
  };
}

export async function fetchRuntimeCatalog(signal?: AbortSignal): Promise<RuntimeCatalog> {
  const [drivers, models] = await Promise.all([
    request<DriverReport[]>("/drivers", { signal }).catch(() => [] as DriverReport[]),
    request<ModelDescriptor[]>("/models", { signal }).catch(() => [] as ModelDescriptor[]),
  ]);
  return { drivers, models };
}

/** Read every immutable capability revision from the live daemon registry. */
export function fetchCapabilities(signal?: AbortSignal): Promise<CapabilityVersionRecord[]>;
export function fetchCapabilities(options?: { capabilityId?: string }, signal?: AbortSignal): Promise<CapabilityVersionRecord[]>;
export async function fetchCapabilities(
  optionsOrSignal: { capabilityId?: string } | AbortSignal = {},
  signal?: AbortSignal,
): Promise<CapabilityVersionRecord[]> {
  const options = isAbortSignal(optionsOrSignal) ? {} : optionsOrSignal;
  const requestSignal = isAbortSignal(optionsOrSignal) ? optionsOrSignal : signal;
  const query = options.capabilityId?.trim()
    ? `?capabilityId=${encodeURIComponent(options.capabilityId.trim())}`
    : "";
  return request<CapabilityVersionRecord[]>(`/capabilities${query}`, { signal: requestSignal });
}

/** Read one immutable capability revision. */
export async function fetchCapability(
  capabilityId: string,
  version: number,
  signal?: AbortSignal,
): Promise<CapabilityVersionRecord> {
  const id = capabilityId.trim();
  if (!id) throw new Error("Capability lookup requires an id.");
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Capability lookup requires a positive version.");
  return request<CapabilityVersionRecord>(`/capabilities/${encodeURIComponent(id)}/${version}`, { signal });
}

/** Register a new immutable capability revision with a durable idempotency key. */
export async function createCapability(
  input: CapabilityCreateInput,
  idempotencyKey: string,
): Promise<CapabilityMutationResult> {
  const actor = input.actor ?? WEB_ACTOR;
  return request<CapabilityMutationResult>("/capabilities", {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify({ ...input, actor, requestKey: idempotencyKey }),
  });
}

/** Activate one exact capability revision. A replay is returned as a success. */
export async function activateCapability(
  capabilityId: string,
  version: number,
  idempotencyKey: string,
  actor: ObjectiveActor = WEB_ACTOR,
  activation?: CapabilityActivationInput,
): Promise<CapabilityMutationResult> {
  return capabilityStateMutation("activate", capabilityId, version, idempotencyKey, actor, activation);
}

/** Deprecate one exact capability revision. A replay is returned as a success. */
export async function deprecateCapability(
  capabilityId: string,
  version: number,
  idempotencyKey: string,
  actor: ObjectiveActor = WEB_ACTOR,
): Promise<CapabilityMutationResult> {
  return capabilityStateMutation("deprecate", capabilityId, version, idempotencyKey, actor);
}

/** Validate typed parameters and resolve daemon-owned execution defaults. */
export async function prepareCapabilityExecution(
  capabilityId: string,
  version: number,
  parameters: JsonValue,
  target?: CapabilityCompatibilityTarget,
): Promise<CapabilityExecutionResolution> {
  return request<CapabilityExecutionResolution>(
    `/capabilities/${encodeURIComponent(capabilityId.trim())}/${version}/prepare`,
    {
      method: "POST",
      body: JSON.stringify({ parameters, ...(target === undefined ? {} : { target }) }),
    },
  );
}

/** Concise route-aligned alias for callers that model preparation as a command. */
export const prepareCapability = prepareCapabilityExecution;

async function capabilityStateMutation(
  operation: "activate" | "deprecate",
  capabilityId: string,
  version: number,
  idempotencyKey: string,
  actor: ObjectiveActor,
  activation?: CapabilityActivationInput,
): Promise<CapabilityMutationResult> {
  const id = capabilityId.trim();
  if (!id) throw new Error("Capability mutation requires an id.");
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Capability mutation requires a positive version.");
  return request<CapabilityMutationResult>(`/capabilities/${encodeURIComponent(id)}/${version}/${operation}`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify({ actor, requestKey: idempotencyKey, ...(activation ?? {}) }),
  });
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value;
}

export async function fetchThread(id: string, signal?: AbortSignal) {
  return request<{ thread: ChatThreadRecord; messages: ConversationMessage[] }>(`/threads/${id}`, { signal });
}

export type ObjectiveListOptions = {
  limit?: number;
  state?: ObjectiveRunRecord["state"] | ObjectiveRunRecord["state"][];
  runId?: string;
  workflowId?: string;
};

/** Fetch the authoritative list of durable objective runs from the daemon. */
export async function fetchObjectiveList(
  options: ObjectiveListOptions = {},
  signal?: AbortSignal,
): Promise<ObjectiveListResponse> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.runId?.trim()) params.set("runId", options.runId.trim());
  if (options.workflowId?.trim()) params.set("workflowId", options.workflowId.trim());
  const states = options.state === undefined
    ? []
    : Array.isArray(options.state) ? options.state : [options.state];
  if (states.length) params.set("state", states.join(","));
  const query = params.toString();
  return request<ObjectiveListResponse>(`/objectives${query ? `?${query}` : ""}`, { signal });
}

/** Fetch one complete objective projection from the daemon's atomic read model. */
export async function fetchObjectiveSnapshot(
  objectiveId: string,
  signal?: AbortSignal,
): Promise<ObjectiveSnapshotResponse> {
  const normalized = objectiveId.trim();
  if (!normalized) throw new Error("Objective snapshot requires an objective id.");
  return request<ObjectiveSnapshotResponse>(
    `/objectives/${encodeURIComponent(normalized)}/snapshot`,
    { signal },
  );
}

/** Fetch one authoritative artifact and its append-only review history. */
export async function fetchObjectiveArtifact(
  runId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<{ artifact: ObjectiveArtifactRecord; reviews: ObjectiveArtifactReviewRecord[] }> {
  if (!runId.trim() || !artifactId.trim()) throw new Error("Artifact lookup requires a run and artifact id.");
  return request(`/objectives/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`, { signal });
}

/** Fetch objective identities without falling back to chat or run ranking. */
export async function fetchObjectiveAggregates(
  limit = 200,
  signal?: AbortSignal,
): Promise<ObjectiveAggregateListResponse> {
  const bounded = Math.max(1, Math.min(2_000, Math.trunc(limit)));
  return request<ObjectiveAggregateListResponse>(`/objective-aggregates?limit=${bounded}`, { signal });
}

export type ObjectiveDetailOptions = {
  limit?: number;
  after?: number;
};

/** Fetch one run and its immutable plan/evidence projections. */
export async function fetchObjectiveDetail(
  runId: string,
  options: ObjectiveDetailOptions = {},
  signal?: AbortSignal,
): Promise<ObjectiveDetailResponse> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.after !== undefined) params.set("after", String(options.after));
  const query = params.toString();
  return request<ObjectiveDetailResponse>(
    `/objectives/${encodeURIComponent(runId)}${query ? `?${query}` : ""}`,
    { signal },
  );
}

/** Fetch the authoritative tree-shaped strategy snapshot when admitted. */
export async function fetchObjectiveControl(
  runId: string,
  signal?: AbortSignal,
): Promise<ObjectiveControlProjection | null> {
  const value = await request<{
    runId: string;
    objectiveId: string;
    planId: string | null;
    revision: ObjectiveControlProjection["revision"] | null;
    snapshot: ObjectiveControlProjection["snapshot"] | null;
  }>(`/objectives/${encodeURIComponent(runId)}/strategy`, { signal });
  if (!value.revision || !value.snapshot || !value.planId) return null;
  return {
    runId: value.runId,
    objectiveId: value.objectiveId,
    planId: value.planId,
    revision: value.revision,
    snapshot: value.snapshot,
  };
}

/** Register a complete workflow definition as an immutable daemon revision. */
export async function registerWorkflow(
  definition: JsonValue,
  idempotencyKey: string,
): Promise<WorkflowRevisionRecord> {
  return request<WorkflowRevisionRecord>("/workflows", {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify(definition),
  });
}

/** Promote an agent-authored workflow schedule after explicit user/agent review. */
export async function activateWorkflow(
  workflowId: string,
  idempotencyKey: string,
): Promise<WorkflowRevisionRecord> {
  return request<WorkflowRevisionRecord>(`/workflows/${encodeURIComponent(workflowId)}/activate`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: "{}",
  });
}

/** Pause one workflow's recurring triggers while retaining its immutable definition. */
export async function deactivateWorkflow(
  workflowId: string,
  idempotencyKey: string,
): Promise<WorkflowRevisionRecord> {
  return request<WorkflowRevisionRecord>(`/workflows/${encodeURIComponent(workflowId)}/deactivate`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: "{}",
  });
}

/**
 * Objective mutations deliberately keep the request key out of the JSON
 * payload. The daemon derives the durable request key from Idempotency-Key,
 * which keeps retries of the same intent replayable without trusting a
 * caller-supplied identity field in the body.
 */
export type ObjectiveCreateRequest = Readonly<{
  runId?: string;
  objectiveId?: string;
  workflowId: string;
  workflowRevision: number;
  workflowHash: string;
  conductorAgentId?: string | null;
  /** Explicit workspace capability requested for this objective admission. */
  workspace?: WorkspaceSpec;
  /** Requested policy ceilings; the daemon intersects them with authority. */
  policy?: ObjectivePolicyRequest;
  spec: ObjectiveSpec;
  tasks?: readonly ObjectiveTask[];
  context?: Readonly<Record<string, JsonValue>>;
}>;

export type ObjectivePlanCommitRequest = Readonly<{
  expectedPlanRevision: number;
  tasks: readonly ObjectiveTask[];
  reason?: string;
}>;

export type ObjectiveTaskUpdateRequest = Readonly<{
  taskId: string;
  state: Extract<ObjectiveTaskState, "queued" | "waiting-approval" | "running" | "completed" | "failed">;
  attemptId?: string | null;
  agentId?: string | null;
  output?: JsonValue | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}>;

export type ObjectiveCheckpointRequest = Readonly<{
  eventCursor: number;
  context?: Readonly<Record<string, JsonValue>>;
  taskUpdates?: readonly ObjectiveTaskUpdateRequest[];
  reason: string;
}>;

export type ObjectiveApprovalRequest = Readonly<{
  kind: ObjectiveApprovalRecord["kind"];
  taskId?: string | null;
  question: string;
  scope?: Readonly<Record<string, JsonValue>>;
  operationId: string;
  requestHash: string;
  policyHash: string;
  sideEffectClass: ObjectiveApprovalRecord["sideEffectClass"];
  canonicalTarget: string;
  expiresAt?: string | null;
}>;

export type ObjectiveApprovalResolutionRequest = Readonly<{
  status: Extract<ObjectiveApprovalRecord["status"], "approved" | "rejected" | "expired" | "cancelled">;
  decision?: JsonValue | null;
}>;

export type ObjectiveCheckpointResumeRequest = Readonly<{
  expectedSequence?: number;
  attemptId?: string | null;
}>;

export type ObjectiveCheckpointRetryRequest = Readonly<{
  activity: {
    kind: "task" | "control";
    id: string;
    attemptId?: string | null;
  };
  expectedSequence?: number;
}>;

function mutationHeaders(idempotencyKey: string): HeadersInit {
  if (!idempotencyKey.trim()) throw new Error("Objective mutations require an Idempotency-Key.");
  return { "Idempotency-Key": idempotencyKey };
}

/** Create a durable objective run. The returned run is authoritative. */
export async function createObjective(input: ObjectiveCreateRequest, idempotencyKey: string) {
  return request<ObjectiveRunRecord>("/objectives", {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify(input),
  });
}

/** Append a durable plan revision to an existing objective run. */
export async function commitObjectivePlan(
  runId: string,
  input: ObjectivePlanCommitRequest,
  idempotencyKey: string,
) {
  return request<ObjectiveRunRecord>(`/objectives/${encodeURIComponent(runId)}/plans`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify(input),
  });
}

/** Persist task/context evidence as a durable objective checkpoint. */
export async function commitObjectiveCheckpoint(
  runId: string,
  input: ObjectiveCheckpointRequest,
  idempotencyKey: string,
) {
  return request<ObjectiveRunRecord>(`/objectives/${encodeURIComponent(runId)}/checkpoints`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify(input),
  });
}

/** Create a durable approval request associated with an objective run. */
export async function requestObjectiveApproval(
  runId: string,
  input: ObjectiveApprovalRequest,
  idempotencyKey: string,
) {
  return request<ObjectiveApprovalRecord>(`/objectives/${encodeURIComponent(runId)}/approvals`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify(input),
  });
}

/** Resolve a human approval and return the daemon's resulting run projection. */
export async function resolveObjectiveApproval(
  runId: string,
  approvalId: string,
  input: ObjectiveApprovalResolutionRequest,
  idempotencyKey: string,
) {
  return request<ObjectiveRunRecord>(
    `/objectives/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/resolve`,
    {
      method: "POST",
      headers: mutationHeaders(idempotencyKey),
      body: JSON.stringify(input),
    },
  );
}

/** Request same-native-session recovery from one exact durable checkpoint. */
export async function resumeObjectiveCheckpoint(
  runId: string,
  checkpointId: string,
  input: ObjectiveCheckpointResumeRequest = {},
  idempotencyKey: string,
) {
  if (!runId.trim() || !checkpointId.trim()) throw new Error("Checkpoint resume requires a run and checkpoint id.");
  return request<JsonValue>(
    `/objectives/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/resume`,
    {
      method: "POST",
      headers: mutationHeaders(idempotencyKey),
      body: JSON.stringify(input),
    },
  );
}

/** Retry one named activity from the latest durable checkpoint boundary. */
export async function retryObjectiveCheckpoint(
  runId: string,
  checkpointId: string,
  input: ObjectiveCheckpointRetryRequest,
  idempotencyKey: string,
) {
  if (!runId.trim() || !checkpointId.trim()) throw new Error("Checkpoint retry requires a run and checkpoint id.");
  if (!input.activity.id.trim()) throw new Error("Checkpoint retry requires an activity id.");
  return request<JsonValue>(
    `/objectives/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/retry`,
    {
      method: "POST",
      headers: mutationHeaders(idempotencyKey),
      body: JSON.stringify(input),
    },
  );
}

/** Cancel one workflow/objective run through the daemon's durable command route. */
export async function cancelObjectiveRun(runId: string, idempotencyKey: string) {
  if (!runId.trim()) throw new Error("Objective cancellation requires a run id.");
  return request<JsonValue>(`/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
  });
}

/** Review one authoritative objective artifact with an idempotent mutation. */
export async function reviewObjectiveArtifact(
  runId: string,
  artifactId: string,
  input: { state: "verified" | "rejected"; reason: string },
  idempotencyKey: string,
) {
  return request<JsonValue>(
    `/objectives/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/review`,
    {
      method: "POST",
      headers: mutationHeaders(idempotencyKey),
      body: JSON.stringify(input),
    },
  );
}

export type ChatSearchResponse = {
  method: "openrouter-rerank" | "fuzzy";
  results: Array<{ threadId: string; title: string; groupId: string | null; score: number; snippet: string }>;
};

export async function searchChats(query: string, signal?: AbortSignal) {
  return request<ChatSearchResponse>(`/search/chats?q=${encodeURIComponent(query)}`, { signal });
}

export type ChatThreadCreateInput = {
  title?: string;
  projectId?: string;
  groupId?: string | null;
  workspacePath?: string;
  mission?: { statement: string; keyResults?: string[] };
};

export async function createThread(input: ChatThreadCreateInput, idempotencyKey: string) {
  return request<ChatThreadRecord>("/threads", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function createProject(input: { workspacePath: string; title?: string }) {
  return request<ProjectRecord>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function browseDirectories(path?: string, signal?: AbortSignal) {
  const query = path?.trim() ? `?path=${encodeURIComponent(path.trim())}` : "";
  return request<DirectoryListing>(`/filesystem/directories${query}`, { signal });
}

export async function updateThread(
  id: string,
  patch: { title?: string; groupId?: string | null; archived?: boolean },
) {
  return request<ChatThreadRecord>(`/threads/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function sendThreadMessage(
  threadId: string,
  input: { messageId: string; content: string; attachments: ChatAttachment[] },
) {
  return request<{ thread: ChatThreadRecord; agentId: string; messageId: string }>(
    `/threads/${threadId}/messages`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function updateRuntimeSettings(patch: Partial<Pick<RuntimeSettings, "conductor" | "agents" | "uiUtilities">>) {
  return request<RuntimeSettings>("/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function updateNativeHarness(driver: string, idempotencyKey: string) {
  return request<{ report: DriverReport; output: string }>(`/drivers/${encodeURIComponent(driver)}/update`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
}

export async function authenticateNativeHarness(driver: string, idempotencyKey: string) {
  return request<DriverAuthenticationResult>(`/drivers/${encodeURIComponent(driver)}/authenticate`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
}

export async function fetchUsageHeatmap(weeks = 12, signal?: AbortSignal): Promise<UsageHeatmap> {
  return request<UsageHeatmap>(`/usage/heatmap?weeks=${weeks}`, { signal });
}

export async function observeAgent(agentId: string, level: ObservationLevel, signal?: AbortSignal) {
  return request<AgentObservation | JsonValue>(`/agents/${agentId}/observe?level=${level}`, { signal });
}

export async function fetchAgentMessages(agentId: string, signal?: AbortSignal) {
  return request<{ agentId: string; messages: ConversationMessage[] }>(
    `/agents/${encodeURIComponent(agentId)}/messages`,
    { signal },
  );
}

/** Fetch the daemon's cross-agent inbox/outbox projection. */
export async function fetchAgentMessageProjection(signal?: AbortSignal): Promise<AgentMessageProjectionResponse> {
  return request<AgentMessageProjectionResponse>("/agent-messages/projection", { signal });
}

/** Reply to a durable message; the daemon assigns the new message identity. */
export async function replyToAgentMessage(
  messageId: string,
  input: AgentMessageReplyRequest,
  idempotencyKey: string,
): Promise<AgentMessageReplyResponse> {
  return request<AgentMessageReplyResponse>(`/agent-messages/${encodeURIComponent(messageId)}/reply`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify(input),
  });
}

/** Record an explicit parent decision on a durable message. */
export async function markAgentMessageHandled(
  messageId: string,
  decision: AgentMessageDecision,
  idempotencyKey: string,
  reason?: string,
): Promise<AgentMessageReceiptMutationResponse> {
  return request<AgentMessageReceiptMutationResponse>(`/agent-messages/${encodeURIComponent(messageId)}/handled`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify({ decision, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
  });
}

/** Cancel an unhandled message when the daemon authorizes that operation. */
export async function cancelAgentMessage(
  messageId: string,
  idempotencyKey: string,
  reason?: string,
): Promise<AgentMessageReceiptMutationResponse> {
  return request<AgentMessageReceiptMutationResponse>(`/agent-messages/${encodeURIComponent(messageId)}/cancel`, {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify({ ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
  });
}

export async function fetchAgentLogs(agentId: string, after = 0, limit = 500, signal?: AbortSignal) {
  const tail = after === 0 ? "&tail=true" : "";
  return request<AgentSessionLog>(`/agents/${encodeURIComponent(agentId)}/logs?after=${after}&limit=${limit}${tail}`, { signal });
}

export async function fetchRunEvents(runId: string, signal?: AbortSignal): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  let cursor = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await request<{
      runId: string;
      cursor: number;
      hasMore: boolean;
      events: EventEnvelope[];
    }>(`/runs/${encodeURIComponent(runId)}/events?after=${cursor}&limit=2000`, { signal });
    events.push(...page.events);
    hasMore = page.hasMore;
    if (page.cursor <= cursor) break;
    cursor = page.cursor;
  }
  return events;
}

export async function cancelAgent(agentId: string) {
  return request<void>(`/agents/${agentId}/cancel`, {
    method: "POST",
    headers: { "idempotency-key": `web:cancel-agent:${crypto.randomUUID()}` },
  });
}

export async function steerAgent(agentId: string, content: string) {
  return request<JsonValue>(`/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "idempotency-key": `web:message-agent:${crypto.randomUUID()}` },
    body: JSON.stringify({ content }),
  });
}

export async function postCommand(input: {
  type: CommandType;
  payload: JsonValue;
  idempotencyKey: string;
  actorId?: string | null;
}) {
  return request<CommandReceipt>("/commands", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: input.idempotencyKey,
      type: input.type,
      payload: input.payload,
      actor: { type: "user", id: input.actorId ?? null },
    }),
  });
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function normalizeCost(value: JsonValue): CostSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { amount: 0, currency: "USD", provenance: "unavailable" };
  }
  const record = value as Record<string, JsonValue>;
  const known = typeof record.knownTotal === "number" ? record.knownTotal : 0;
  const unknown = typeof record.unknownEvents === "number" ? record.unknownEvents : 0;
  const eventCount = typeof record.eventCount === "number" ? record.eventCount : 0;
  const byBasis =
    record.byBasis && typeof record.byBasis === "object" && !Array.isArray(record.byBasis)
      ? Object.fromEntries(
          Object.entries(record.byBasis).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
        )
      : {};
  return {
    amount: known,
    currency: typeof record.currency === "string" ? record.currency : "USD",
    provenance: unknown > 0 ? "pending" : eventCount > 0 ? "measured" : "unavailable",
    knownTotal: known,
    unknownEvents: unknown,
    eventCount,
    byBasis,
  };
}

function normalizeCostMap(value: Record<string, JsonValue> | undefined): Record<string, CostSummary> {
  return Object.fromEntries(Object.entries(value ?? {}).map(([id, cost]) => [id, normalizeCost(cost)]));
}

export function subscribeToRuntime(
  cursor: number | string,
  onEvent: (event: EventEnvelope) => void,
  onReset: () => void,
  onConnection: (state: "connecting" | "live" | "stale") => void,
) {
  const controller = new AbortController();
  let currentCursor = Number(cursor) || 0;
  let delay: number = symphonyConfig.reconnect.minDelayMs;
  let staleTimer: number | undefined;
  let retryTimer: number | undefined;
  let connecting = false;
  let stopped = false;

  const markLive = () => {
    onConnection("live");
    delay = symphonyConfig.reconnect.minDelayMs;
    if (staleTimer !== undefined) window.clearTimeout(staleTimer);
    staleTimer = window.setTimeout(() => onConnection("stale"), symphonyConfig.staleAfterMs);
  };

  const scheduleReconnect = () => {
    if (stopped || retryTimer !== undefined) return;
    onConnection("stale");
    const retryDelay = delay;
    delay = Math.min(delay * 2, symphonyConfig.reconnect.maxDelayMs);
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, retryDelay);
  };

  const connect = async () => {
    if (stopped || connecting) return;
    connecting = true;
    onConnection("connecting");
    try {
      const url = `${symphonyConfig.apiBasePath}/events?after=${currentCursor}&projection=ui`;
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: "same-origin",
        headers: {
          Accept: "text/event-stream",
          "Last-Event-ID": String(currentCursor),
        },
      });
      if (!response.ok || !response.body) throw new Error(`SSE failed with ${response.status}`);
      if (stopped) return;
      markLive();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { value, done } = await reader.read();
        if (stopped) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replaceAll("\r\n", "\n");
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
          const raw = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");
          if (!raw.trim() || raw.startsWith(":")) {
            markLive();
            continue;
          }
          const parsed = parseSse(raw);
          if (parsed.event === "reset") {
            // Close the current reader before opening a replacement stream.
            // Without this, the browser can keep the old HTTP connection
            // alive while the retry starts, producing duplicate projections.
            try {
              await reader.cancel();
            } catch {
              // The transport may already be closed; the retry is still safe.
            }
            onReset();
            // Reset is a recoverable cursor boundary, not a terminal state.
            // Keep this retry owned by the same subscription so a reset does
            // not create a second stream or strand the UI when the daemon
            // epoch remains unchanged.
            scheduleReconnect();
            return;
          }
          if (!parsed.data) continue;
          let envelope: EventEnvelope;
          try {
            envelope = JSON.parse(parsed.data) as EventEnvelope;
          } catch {
            // A malformed frame must not tear down the stream and replay the
            // same backlog forever. The daemon remains authoritative and a
            // later event can still advance the cursor normally.
            continue;
          }
          // The cursor is the durable ordering boundary. Never apply a
          // duplicate, an old replayed frame, or an untrusted non-integer
          // cursor. This keeps reconnects and multi-window projections
          // idempotent without relying on message identity.
          if (!Number.isSafeInteger(envelope.cursor) || envelope.cursor <= currentCursor) continue;
          currentCursor = envelope.cursor;
          onEvent(envelope);
          if (!stopped) markLive();
        }
      }
      throw new Error("SSE stream closed");
    } catch (error) {
      if (stopped || controller.signal.aborted) return;
      scheduleReconnect();
      if (error instanceof DOMException && error.name === "AbortError") return;
    } finally {
      connecting = false;
    }
  };

  void connect();

  return () => {
    stopped = true;
    if (staleTimer !== undefined) window.clearTimeout(staleTimer);
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    controller.abort();
  };
}

function parseSse(raw: string): { event?: string; data?: string; id?: string } {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, id, data: data.length ? data.join("\n") : undefined };
}

export async function resolveMode(requested: typeof symphonyConfig.dataMode, signal?: AbortSignal): Promise<RuntimeMode> {
  if (requested === "preview") return "preview";
  if (requested === "runtime") return "runtime";
  return (await getHealth(signal)) ? "runtime" : "preview";
}
