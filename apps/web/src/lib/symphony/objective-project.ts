import type {
  ObjectiveApprovalRecord,
  ObjectiveBudgetDebitRecord,
  ObjectiveBudgetLedgerRecord,
  ObjectiveBudgetLimits,
  ObjectiveBudgetReservationRecord,
  ObjectiveBudgetUsage,
  ObjectiveCheckpointRecord,
  ObjectivePolicySnapshot,
  ObjectiveRunRecord,
  ObjectiveTaskRecord,
  ObjectiveTaskState,
} from "../../../../../packages/protocol/src/index.js";
import type { AgentRecord, EventEnvelope, JsonValue, ObjectiveControlProjection, ObjectivePlanRevisionRecord } from "./contracts";

export type ObjectiveTaskProjection = {
  id: string;
  objective: string;
  state: ObjectiveTaskState;
  attemptId: string | null;
  agentId: string | null;
  agent: {
    name: string;
    harness: string;
    model: string;
    status: AgentRecord["status"];
  } | null;
  dependencies: Array<{
    id: string;
    satisfied: boolean;
    state: ObjectiveTaskState | null;
  }>;
  blockedBy: string[];
  requiresApproval: boolean;
  outputPresent: boolean;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  latestEvent: ObjectiveEventProjection | null;
};

export type ObjectiveEventProjection = {
  id: string;
  cursor: number;
  type: string;
  at: string;
  title: string;
  detail: string;
  agentId: string | null;
  taskId: string | null;
  attemptId: string | null;
  planRevision: number | null;
};

export type ObjectiveCriterionProjection = {
  id: string;
  description: string;
  required: boolean;
  passed: boolean | null;
  actual: JsonValue | null;
  expected: JsonValue | null;
  evidenceEventIds: string[];
  evaluatedAt: string | null;
};

export type ObjectiveApprovalProjection = {
  id: string;
  /** Stable operation identity used to safely reconcile approval decisions. */
  operationId: string;
  requestHash: string;
  policyHash: string;
  sideEffectClass: ObjectiveApprovalRecord["sideEffectClass"];
  canonicalTarget: string;
  kind: ObjectiveApprovalRecord["kind"];
  planRevision: number;
  taskId: string | null;
  question: string;
  status: ObjectiveApprovalRecord["status"];
  requestedBy: ObjectiveApprovalRecord["requestedBy"];
  requestedAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  isExpired: boolean;
  isPending: boolean;
};

export type ObjectiveCheckpointProjection = {
  id: string;
  sequence: number;
  planRevision: number;
  eventCursor: number;
  reason: string;
  createdAt: string;
  criteriaPassed: number;
  criteriaTotal: number;
  evidenceEventCount: number;
};

export type ObjectivePolicyProjection = {
  available: boolean;
  hash: string | null;
  effectivePermission: ObjectivePolicySnapshot["effectivePermission"] | null;
  sideEffectClassCeiling: ObjectivePolicySnapshot["sideEffectClassCeiling"] | null;
  workspacePath: string | null;
  dirtyPolicy: NonNullable<ObjectivePolicySnapshot["workspace"]>["dirtyPolicy"] | null;
  expiresAt: string | null;
};

export type ObjectiveBudgetProjection = {
  /** False means no authoritative ledger was returned, not zero consumption. */
  available: boolean;
  status: ObjectiveBudgetLedgerRecord["status"] | null;
  pauseReason: string | null;
  limits: ObjectiveBudgetLimits | null;
  consumed: ObjectiveBudgetUsage | null;
  reserved: ObjectiveBudgetUsage | null;
  activeReservations: ObjectiveBudgetReservationRecord[];
  reservationsAvailable: boolean;
  debits: ObjectiveBudgetDebitRecord[];
  debitsAvailable: boolean;
  unknownCost: boolean;
};

export type ObjectiveProjection = {
  runId: string;
  objectiveId: string;
  workflowId: string;
  mission: {
    statement: string;
    criteria: ObjectiveCriterionProjection[];
    revision: number;
    hash: string;
  };
  state: ObjectiveRunRecord["state"];
  policy: ObjectivePolicyProjection;
  budget: ObjectiveBudgetProjection;
  terminal: boolean;
  terminalReason: string | null;
  error: string | null;
  output: JsonValue | null;
  planRevision: number;
  replanCount: number;
  /** Immutable plan snapshots returned by the daemon, kept intact for history views. */
  planRevisions: ObjectivePlanRevisionRecord[];
  /** Optional tree-shaped control projection from the strategy endpoint. */
  control?: ObjectiveControlProjection | null;
  frontier: ObjectiveTaskProjection[];
  packets: ObjectiveTaskProjection[];
  approvals: ObjectiveApprovalProjection[];
  pendingApproval: ObjectiveApprovalProjection | null;
  checkpoints: ObjectiveCheckpointProjection[];
  latestCheckpoint: ObjectiveCheckpointProjection | null;
  evidence: {
    eventCursor: number;
    eventCount: number;
    checkpointCount: number;
    linkedEventCount: number;
  };
  progress: {
    completed: number;
    total: number;
    active: number;
    blocked: number;
    failed: number;
    pendingApproval: number;
  };
  events: ObjectiveEventProjection[];
};

export type ObjectiveProjectionInput = {
  run: ObjectiveRunRecord;
  planRevisions?: readonly ObjectivePlanRevisionRecord[];
  checkpoints?: readonly ObjectiveCheckpointRecord[];
  approvals?: readonly ObjectiveApprovalRecord[];
  budgetLedger?: ObjectiveBudgetLedgerRecord | null;
  reservations?: readonly ObjectiveBudgetReservationRecord[] | null;
  debits?: readonly ObjectiveBudgetDebitRecord[] | null;
  events?: readonly EventEnvelope[];
  agents?: readonly ObjectiveAgentSource[];
  control?: ObjectiveControlProjection | null;
  /** Optional deterministic clock for rendering approval expiry in tests/replays. */
  asOf?: string;
};

export type ObjectiveSelectionContext = {
  /** The workflow projected by the currently open conversation. */
  workflowId?: string | null;
  /** A direct objective/run identity when the conversation is itself a run. */
  runId?: string | null;
  /** The conductor that owns the currently open conversation's agent tree. */
  conductorAgentId?: string | null;
  /** Optional materialized lineage IDs, useful while the root is recovering. */
  agentIds?: readonly string[];
};

/**
 * The runline distinguishes an authoritative empty result from an unavailable
 * authority. An errored query may retain React Query's last data value, so
 * errors take precedence over cached data and the chat-derived fallback.
 */
export type ObjectiveProjectionState = "disabled" | "loading" | "no-objective" | "ready" | "unavailable";

export type ObjectiveProjectionStateInput = {
  enabled: boolean;
  live: boolean;
  listPending: boolean;
  listFetching: boolean;
  listError: unknown;
  objectiveRun: ObjectiveRunRecord | null;
  snapshotPending: boolean;
  snapshotFetching: boolean;
  snapshotError: unknown;
  snapshotReady: boolean;
};

/** Resolve the truthful Runline surface state from authoritative query state. */
export function objectiveProjectionState(input: ObjectiveProjectionStateInput): ObjectiveProjectionState {
  if (!input.enabled || !input.live) return "disabled";
  if (input.listError || input.snapshotError) return "unavailable";
  if (input.listPending || input.listFetching) return "loading";
  if (!input.objectiveRun) return "no-objective";
  if (input.snapshotPending || input.snapshotFetching || !input.snapshotReady) return "loading";
  return "ready";
}

/**
 * Select the newest objective owned by one conversation without mutating input.
 *
 * A workflow ID is only a compatibility fallback: generic workflow IDs can be
 * shared by many conversations. When a conductor or materialized lineage is
 * available, ownership wins and unrelated objectives on that workflow are
 * deliberately excluded from the projection.
 *
 * The string overload remains for callers that only have the old exact-workflow
 * boundary. New callers should pass the richer context object.
 */
export function selectLatestObjective(
  objectives: readonly ObjectiveRunRecord[],
  contextOrWorkflowId: ObjectiveSelectionContext | string,
): ObjectiveRunRecord | null {
  const context: ObjectiveSelectionContext = typeof contextOrWorkflowId === "string"
    ? { workflowId: contextOrWorkflowId }
    : contextOrWorkflowId;
  const workflowId = normalizeIdentity(context.workflowId);
  const runId = normalizeIdentity(context.runId);
  const conductorAgentId = normalizeIdentity(context.conductorAgentId);
  const agentIds = new Set(
    (context.agentIds ?? [])
      .map(normalizeIdentity)
      .filter((value): value is string => value !== null),
  );
  if (conductorAgentId) agentIds.add(conductorAgentId);

  const owned = objectives
    .map((objective) => ({ objective, rank: objectiveSelectionRank(objective, { workflowId, runId, conductorAgentId, agentIds }) }))
    .filter((candidate): candidate is { objective: ObjectiveRunRecord; rank: number } => candidate.rank > 0);
  const candidates = owned.some((candidate) => candidate.rank >= 2)
    ? owned.filter((candidate) => candidate.rank >= 2)
    : owned;

  return candidates
    .sort((left, right) => {
      const byOwnership = right.rank - left.rank;
      if (byOwnership !== 0) return byOwnership;
      const byUpdated = Date.parse(right.objective.updatedAt) - Date.parse(left.objective.updatedAt);
      return Number.isFinite(byUpdated) && byUpdated !== 0
        ? byUpdated
        : right.objective.runId.localeCompare(left.objective.runId);
    })[0]?.objective ?? null;
}

function objectiveSelectionRank(
  objective: ObjectiveRunRecord,
  context: {
    workflowId: string | null;
    runId: string | null;
    conductorAgentId: string | null;
    agentIds: ReadonlySet<string>;
  },
): number {
  if (context.runId && objective.runId === context.runId) return 4;
  if (context.conductorAgentId && objective.conductorAgentId === context.conductorAgentId) return 3;
  if (objective.conductorAgentId && context.agentIds.has(objective.conductorAgentId)) return 2;
  if (context.workflowId && objective.workflowId === context.workflowId) return 1;
  return 0;
}

function normalizeIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function projectPolicy(run: ObjectiveRunRecord): ObjectivePolicyProjection {
  const policy = run.policy ?? null;
  return {
    available: policy !== null,
    hash: policy?.policyHash ?? run.policyHash ?? null,
    effectivePermission: policy?.effectivePermission ?? null,
    sideEffectClassCeiling: policy?.sideEffectClassCeiling ?? null,
    workspacePath: policy?.workspace?.path ?? null,
    dirtyPolicy: policy?.workspace?.dirtyPolicy ?? null,
    expiresAt: policy?.expiresAt ?? null,
  };
}

function projectBudget({
  run,
  policy,
  budgetLedger,
  reservations,
  debits,
}: {
  run: ObjectiveRunRecord;
  policy: ObjectivePolicyProjection;
  budgetLedger: ObjectiveBudgetLedgerRecord | null;
  reservations: readonly ObjectiveBudgetReservationRecord[] | null;
  debits: readonly ObjectiveBudgetDebitRecord[] | null;
}): ObjectiveBudgetProjection {
  const activeReservations = (reservations ?? []).filter((reservation) =>
    reservation.runId === run.runId
    && reservation.objectiveId === run.objectiveId
    && reservation.state === "reserved",
  );
  const pauseReason = run.pauseReason ?? budgetLedger?.pauseReason ?? null;
  const unknownCost = !budgetLedger
    || pauseReason === "budget-unknown-usage"
    || (debits ?? []).some((debit) => debit.usageKnown === false);
  return {
    available: budgetLedger !== null,
    status: budgetLedger?.status ?? null,
    pauseReason,
    limits: budgetLedger?.limits ?? (policy.available ? run.policy?.budget ?? null : null),
    consumed: budgetLedger?.consumed ?? null,
    reserved: budgetLedger?.reserved ?? null,
    activeReservations,
    reservationsAvailable: reservations !== null,
    debits: [...(debits ?? [])],
    debitsAvailable: debits !== null,
    unknownCost,
  };
}

/** The small, already-projected agent shape needed by objective task packets. */
export type ObjectiveAgentSource = Pick<
  AgentRecord,
  "id" | "objective" | "harness" | "requestedHarness" | "model" | "requestedModel" | "status"
>;

const terminalRunStates = new Set<ObjectiveRunRecord["state"]>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
const terminalTaskStates = new Set<ObjectiveTaskState>(["completed", "superseded"]);
const activeTaskStates = new Set<ObjectiveTaskState>(["running", "queued", "blocked", "waiting-approval"]);

/**
 * Convert the durable objective records into UI facts. The adapter is deliberately
 * run-scoped: an event is only evidence for this projection when its runId is an
 * exact match, so a shared daemon event stream cannot bleed into another run.
 */
export function projectObjectiveRun({
  run,
  planRevisions = [],
  checkpoints = [],
  approvals = [],
  budgetLedger = null,
  reservations = null,
  debits = null,
  events = [],
  agents = [],
  control = null,
  asOf = new Date().toISOString(),
}: ObjectiveProjectionInput): ObjectiveProjection {
  const scopedEvents = events
    .filter((event) => event.runId === run.runId)
    .sort((left, right) => left.cursor - right.cursor);
  const scopedPlanRevisions = planRevisions
    .filter((plan) => plan.runId === run.runId && plan.objectiveId === run.objectiveId && plan.workflowId === run.workflowId)
    .sort((left, right) => left.planRevision - right.planRevision || left.createdAt.localeCompare(right.createdAt));
  const scopedCheckpoints = checkpoints
    .filter((checkpoint) => checkpoint.runId === run.runId && checkpoint.objectiveId === run.objectiveId)
    .sort((left, right) => left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt));
  const scopedApprovals = approvals
    .filter((approval) => approval.runId === run.runId && approval.objectiveId === run.objectiveId)
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt) || right.id.localeCompare(left.id));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const taskById = new Map(run.tasks.map((record) => [record.task.id, record]));
  const eventByTaskId = latestEventByTask(scopedEvents);
  const packets = run.tasks.map((record) => projectTask(record, taskById, agentById, eventByTaskId));
  const frontier = packets.filter((packet) => isFrontier(packet));
  const projectedEvents = scopedEvents.map(projectEvent);
  const projectedCheckpoints = scopedCheckpoints.map((checkpoint) => projectCheckpoint(checkpoint));
  const latestCheckpoint = projectedCheckpoints.at(-1) ?? null;
  const projectedApprovals = scopedApprovals.map((approval) => projectApproval(approval, asOf));
  const pendingApproval = projectedApprovals.find((approval) => approval.id === run.pendingApprovalId && approval.isPending)
    ?? projectedApprovals.find((approval) => approval.isPending)
    ?? null;
  const latestCheckpointRecord = scopedCheckpoints.at(-1) ?? null;
  const linkedEventIds = new Set(latestCheckpointRecord?.criteria.flatMap((criterion) => criterion.evidenceEventIds) ?? []);
  const linkedEventCount = projectedEvents.filter((event) => linkedEventIds.has(event.id)).length;
  const terminal = terminalRunStates.has(run.state);
  const error = run.error ?? packets.find((packet) => packet.error)?.error ?? null;
  const policy = projectPolicy(run);
  const budget = projectBudget({ run, policy, budgetLedger, reservations, debits });

  return {
    runId: run.runId,
    objectiveId: run.objectiveId,
    workflowId: run.workflowId,
    mission: {
      statement: run.spec.statement,
      criteria: projectCriteria(run, latestCheckpointRecord),
      revision: run.workflowRevision,
      hash: run.workflowHash,
    },
    state: run.state,
    policy,
    budget,
    terminal,
    terminalReason: terminal ? (error ?? (run.state === "succeeded" ? "Objective completed." : `Objective ${run.state}.`)) : null,
    error,
    output: run.output,
    planRevision: run.activePlanRevision,
    replanCount: run.replanCount,
    planRevisions: scopedPlanRevisions,
    control: control && control.runId === run.runId && control.objectiveId === run.objectiveId ? control : null,
    frontier,
    packets,
    approvals: projectedApprovals,
    pendingApproval,
    checkpoints: projectedCheckpoints,
    latestCheckpoint,
    evidence: {
      eventCursor: Math.max(0, latestCheckpoint?.eventCursor ?? 0, ...scopedEvents.map((event) => event.cursor)),
      eventCount: projectedEvents.length,
      checkpointCount: projectedCheckpoints.length,
      linkedEventCount,
    },
    progress: {
      completed: packets.filter((packet) => packet.state === "completed").length,
      total: packets.length,
      active: packets.filter((packet) => packet.state === "running").length,
      blocked: packets.filter((packet) => packet.state === "blocked").length,
      failed: packets.filter((packet) => packet.state === "failed").length,
      pendingApproval: projectedApprovals.filter((approval) => approval.isPending).length,
    },
    events: projectedEvents,
  };
}

function projectTask(
  record: ObjectiveTaskRecord,
  taskById: ReadonlyMap<string, ObjectiveTaskRecord>,
  agentById: ReadonlyMap<string, ObjectiveAgentSource>,
  eventByTaskId: ReadonlyMap<string, ObjectiveEventProjection>,
): ObjectiveTaskProjection {
  const dependencies = record.task.dependsOn.map((id) => {
    const dependency = taskById.get(id);
    return { id, satisfied: dependency ? terminalTaskStates.has(dependency.state) : false, state: dependency?.state ?? null };
  });
  const agent = record.agentId ? agentById.get(record.agentId) : undefined;
  return {
    id: record.task.id,
    objective: record.task.objective,
    state: record.state,
    attemptId: record.attemptId,
    agentId: record.agentId,
    agent: agent
      ? { name: agent.objective, harness: agent.harness ?? agent.requestedHarness, model: agent.model ?? agent.requestedModel, status: agent.status }
      : null,
    dependencies,
    blockedBy: dependencies.filter((dependency) => !dependency.satisfied).map((dependency) => dependency.id),
    requiresApproval: record.task.requiresApproval,
    outputPresent: record.output !== null,
    error: record.error,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    latestEvent: eventByTaskId.get(record.task.id) ?? null,
  };
}

function isFrontier(packet: ObjectiveTaskProjection): boolean {
  if (terminalTaskStates.has(packet.state)) return false;
  if (packet.state === "queued") return packet.blockedBy.length === 0;
  return activeTaskStates.has(packet.state) || packet.state === "failed";
}

function projectCriteria(run: ObjectiveRunRecord, checkpoint: ObjectiveCheckpointRecord | null): ObjectiveCriterionProjection[] {
  const results = new Map((checkpoint?.criteria ?? []).map((result) => [result.criterionId, result]));
  return run.spec.criteria.map((criterion) => {
    const result = results.get(criterion.id);
    return {
      id: criterion.id,
      description: criterion.description,
      required: criterion.required,
      passed: result?.passed ?? null,
      actual: result?.actual ?? null,
      expected: result?.expected ?? criterion.value ?? criterion.default ?? null,
      evidenceEventIds: result?.evidenceEventIds ?? [],
      evaluatedAt: result?.evaluatedAt ?? null,
    };
  });
}

function projectCheckpoint(checkpoint: ObjectiveCheckpointRecord): ObjectiveCheckpointProjection {
  return {
    id: checkpoint.id,
    sequence: checkpoint.sequence,
    planRevision: checkpoint.planRevision,
    eventCursor: checkpoint.eventCursor,
    reason: checkpoint.reason,
    createdAt: checkpoint.createdAt,
    criteriaPassed: checkpoint.criteria.filter((criterion) => criterion.passed).length,
    criteriaTotal: checkpoint.criteria.length,
    evidenceEventCount: checkpoint.criteria.reduce((total, criterion) => total + criterion.evidenceEventIds.length, 0),
  };
}

function projectApproval(approval: ObjectiveApprovalRecord, asOf: string): ObjectiveApprovalProjection {
  const isExpired = approval.status === "expired"
    || (approval.expiresAt !== null && Date.parse(approval.expiresAt) <= Date.parse(asOf));
  return {
    id: approval.id,
    operationId: approval.operationId,
    requestHash: approval.requestHash,
    policyHash: approval.policyHash,
    sideEffectClass: approval.sideEffectClass,
    canonicalTarget: approval.canonicalTarget,
    kind: approval.kind,
    planRevision: approval.planRevision,
    taskId: approval.taskId,
    question: approval.question,
    status: approval.status,
    requestedBy: approval.requestedBy,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    resolvedAt: approval.resolvedAt,
    isExpired,
    isPending: approval.status === "requested" && !isExpired,
  };
}

function projectEvent(event: EventEnvelope): ObjectiveEventProjection {
  const payload = recordPayload(event.payload);
  const taskId = stringValue(payload?.taskId) ?? stringValue(payload?.objectiveTaskId);
  const attemptId = stringValue(payload?.attemptId);
  const planRevision = numberValue(payload?.planRevision);
  const detail = stringValue(payload?.error) ?? stringValue(payload?.summary) ?? stringValue(payload?.message) ?? stringValue(payload?.reason) ?? event.type;
  return {
    id: event.id,
    cursor: event.cursor,
    type: event.type,
    at: event.occurredAt,
    title: event.type.replaceAll(".", " · "),
    detail,
    agentId: event.agentId,
    taskId,
    attemptId,
    planRevision,
  };
}

function latestEventByTask(events: readonly EventEnvelope[]): Map<string, ObjectiveEventProjection> {
  const result = new Map<string, ObjectiveEventProjection>();
  for (const event of events) {
    const projected = projectEvent(event);
    if (projected.taskId) result.set(projected.taskId, projected);
  }
  return result;
}

function recordPayload(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
