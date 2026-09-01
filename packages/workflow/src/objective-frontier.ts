import {
  ObjectiveFrontierInputSchema,
  ObjectiveFrontierProjectionSchema,
  ObjectiveRunlineProjectionSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlPlanSnapshotSchema,
  ObjectiveAggregateFrontierProjectionSchema,
  ObjectiveAggregateRunlineProjectionSchema,
  type ObjectiveAttemptLineage,
  type ObjectiveFrontierInput,
  type ObjectiveFrontierItem,
  type ObjectiveFrontierEvaluationSummary,
  type ObjectiveFrontierProjection,
  type ObjectiveFrontierStatus,
  type ObjectiveProjectionEvidence,
  type ObjectiveRunlineEntry,
  type ObjectiveRunlineEventType,
  type ObjectiveAggregateFrontierProjection,
  type ObjectiveAggregateRunlineProjection,
} from "@symphony/protocol";
import type {
  ObjectiveControlExecutionRecord,
  ObjectiveControlNode,
  ObjectiveControlPlan,
  ObjectiveControlPlanRevision,
  ObjectiveControlSuspensionRecord,
} from "@symphony/protocol";

/**
 * Pure objective read-model projection.
 *
 * There is intentionally no store, clock, scheduler, driver, or web
 * dependency here. Callers provide the asOf instant and durable input bundle;
 * equal input therefore produces equal output after JSON serialization.
 */

type AnyRecord = Record<string, unknown>;

const TERMINAL_STATUSES = new Set<ObjectiveFrontierStatus>([
  "completed", "failed", "cancelled", "expired",
]);

function record(value: unknown): AnyRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function executionId(nodeId: string, iterationKey: string): string {
  return nodeId + "@" + iterationKey;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value as AnyRecord).sort().map((key) => JSON.stringify(key) + ":" + stable((value as AnyRecord)[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function uniqueSorted(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

function mergeEvidence(...evidence: readonly (Partial<ObjectiveProjectionEvidence> | null | undefined)[]): ObjectiveProjectionEvidence {
  return {
    eventCursor: Math.max(0, ...evidence.map((item) => item?.eventCursor ?? 0)),
    eventIds: uniqueSorted(evidence.flatMap((item) => item?.eventIds ?? [])),
    attemptIds: uniqueSorted(evidence.flatMap((item) => item?.attemptIds ?? [])),
    artifactIds: uniqueSorted(evidence.flatMap((item) => item?.artifactIds ?? [])),
    checkpointIds: uniqueSorted(evidence.flatMap((item) => item?.checkpointIds ?? [])),
    attentionIds: uniqueSorted(evidence.flatMap((item) => item?.attentionIds ?? [])),
    contextRefs: uniqueSorted(evidence.flatMap((item) => item?.contextRefs ?? [])),
  };
}

function planFrom(value: ObjectiveFrontierInput["controlPlan"]): ObjectiveControlPlan | null {
  if (!value) return null;
  return ("plan" in value ? value.plan : value) as ObjectiveControlPlan;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Normalize aggregate storage snapshots and the original flat workflow shape. */
function normalizeInput(parsed: ObjectiveFrontierInput): ObjectiveFrontierInput {
  const run = parsed.run;
  const control = record(parsed.control);
  const mutations = record(parsed.mutations);
  const runTasks = run ? arrayValue(run.tasks) : [];
  const runAttempts = run ? arrayValue(run.attempts) : [];
  const controlExecutions = control ? arrayValue(control.executions) : [];
  const controlSuspensions = control ? arrayValue(control.suspensions) : [];
  const controlEvaluations = control ? arrayValue(control.evaluations) : [];
  const planMutations = mutations ? [...arrayValue(mutations.plans), ...arrayValue(mutations.control)] : [];
  const nestedPlanValue = control?.plan ?? parsed.plan;
  const nestedPlan = !parsed.controlPlan && nestedPlanValue ? ObjectiveControlPlanSchema.safeParse(nestedPlanValue).data : undefined;
  const nestedSnapshot = !parsed.controlSnapshot && control?.snapshot ? ObjectiveControlPlanSnapshotSchema.safeParse(control.snapshot).data : undefined;
  const runContext = run && record(run.context) ? run.context as Record<string, unknown> : {};
  const observedCursors = parsed.events.map((event) => numberValue(record(event)?.cursor)).filter((value): value is number => value !== null);
  const eventCursor = Math.max(parsed.eventCursor, ...observedCursors, nestedSnapshot?.eventCursor ?? 0);
  return {
    ...parsed,
    runState: parsed.runState ?? stringValue(run?.state) ?? undefined,
    runOutput: parsed.runOutput ?? (run?.output === undefined ? undefined : run.output),
    runError: parsed.runError ?? (typeof run?.error === "string" || run?.error === null ? run.error : undefined),
    context: { ...runContext, ...parsed.context } as ObjectiveFrontierInput["context"],
    eventCursor,
    controlPlan: parsed.controlPlan ?? nestedPlan,
    controlSnapshot: parsed.controlSnapshot ?? nestedSnapshot,
    tasks: [...parsed.tasks, ...parsed.legacyTasks, ...runTasks] as ObjectiveFrontierInput["tasks"],
    attempts: [...parsed.attempts, ...parsed.stepAttempts, ...runAttempts] as ObjectiveFrontierInput["attempts"],
    controlExecutions: [...parsed.controlExecutions, ...parsed.controlExecutionRecords, ...controlExecutions] as ObjectiveFrontierInput["controlExecutions"],
    suspensions: [...parsed.suspensions, ...parsed.controlSuspensions, ...parsed.timerSuspensions, ...parsed.signalSuspensions, ...controlSuspensions] as ObjectiveFrontierInput["suspensions"],
    evaluations: [...parsed.evaluations, ...parsed.evaluationNodes, ...controlEvaluations] as ObjectiveFrontierInput["evaluations"],
    retries: parsed.retries,
    unknownOutcomes: [...parsed.unknownOutcomes, ...parsed.unknownNativeOutcomes],
    reconciliations: [...parsed.reconciliations, ...parsed.reconciliationRecords],
    approvals: [...parsed.approvals, ...parsed.approvalRecords],
    attentions: [...parsed.attentions, ...parsed.attentionRecords],
    artifacts: [...parsed.artifacts, ...parsed.artifactRecords],
    checkpoints: [...parsed.checkpoints, ...parsed.checkpointRecords],
    planMutations: [...parsed.planMutations, ...parsed.planChanges, ...planMutations] as ObjectiveFrontierInput["planMutations"],
  };
}

function flattenNodes(plan: ObjectiveControlPlan | null): Map<string, ObjectiveControlNode> {
  const result = new Map<string, ObjectiveControlNode>();
  const visit = (node: ObjectiveControlNode): void => {
    result.set(node.id, node);
    if (node.type === "sequence" || node.type === "parallel" || node.type === "while") {
      node.steps.forEach(visit);
    } else if (node.type === "if") {
      node.then.forEach(visit);
      node.else?.forEach(visit);
    }
  };
  if (plan) visit(plan.root);
  return result;
}

function controlExecutions(input: ObjectiveFrontierInput): ObjectiveControlExecutionRecord[] {
  const snapshot = input.controlSnapshot;
  if (snapshot && (snapshot.objectiveId !== input.objectiveId || snapshot.runId !== input.runId)) return [];
  const all = [...(snapshot?.executions ?? []), ...input.controlExecutions];
  const byId = new Map<string, ObjectiveControlExecutionRecord>();
  const snapshotRows = new Set(snapshot?.executions ?? []);
  for (const item of all) {
    const id = executionId(item.key.nodeId, item.key.iterationKey);
    if (!byId.has(id) || snapshotRows.has(item)) byId.set(id, item);
  }
  return [...byId.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item);
}

function suspensionMap(input: ObjectiveFrontierInput): Map<string, ObjectiveControlSuspensionRecord> {
  const map = new Map<string, ObjectiveControlSuspensionRecord>();
  for (const item of input.suspensions) {
    if (item.objectiveId !== input.objectiveId || item.runId !== input.runId) continue;
    map.set(executionId(item.execution.nodeId, item.execution.iterationKey), item);
  }
  const snapshotMatches = input.controlSnapshot?.objectiveId === input.objectiveId && input.controlSnapshot.runId === input.runId;
  for (const item of snapshotMatches ? input.controlSnapshot?.executions ?? [] : []) {
    const id = executionId(item.key.nodeId, item.key.iterationKey);
    if (item.suspension && !map.has(id)) map.set(id, item.suspension);
  }
  return map;
}

function matchingId(item: AnyRecord): string | null {
  const nodeId = stringValue(item.nodeId);
  const iterationKey = stringValue(item.iterationKey);
  return stringValue(item.executionId)
    ?? stringValue(item.controlExecutionId)
    ?? (nodeId && iterationKey ? executionId(nodeId, iterationKey) : null)
    ?? stringValue(item.taskId);
}

function matches(item: AnyRecord, id: string, taskId: string | null, attemptId: string | null): boolean {
  const candidate = matchingId(item);
  return candidate === id || candidate === taskId || candidate === attemptId || stringValue(item.attemptId) === attemptId;
}

function openAttentionIds(input: ObjectiveFrontierInput, id: string, taskId: string | null, attemptId: string | null): string[] {
  const ids = input.attentions
    .filter((attention) => attention.objectiveId === input.objectiveId && attention.runId === input.runId)
    .filter((attention) => attention.status === "open")
    .filter((attention) => {
      const boundId = attention.nodeId ?? attention.attemptId;
      return boundId === null || boundId === id || boundId === taskId || boundId === attemptId;
    })
    .map((attention) => attention.id);
  const approvals = input.approvals
    .filter((approval) => {
      const status = stringValue(approval.status);
      return status === "requested" || status === "open" || status === "pending";
    })
    .filter((approval) => {
      const runId = stringValue(approval.runId);
      const objectiveId = stringValue(approval.objectiveId);
      if (runId && runId !== input.runId) return false;
      if (objectiveId && objectiveId !== input.objectiveId) return false;
      return matches(approval, id, taskId, attemptId);
    })
    .map((approval) => stringValue(approval.id))
    .filter((value): value is string => value !== null);
  return uniqueSorted([...ids, ...approvals]);
}

function agentIdFromAttempt(attempt: ObjectiveFrontierInput["attempts"][number]): string | null {
  const input = record(attempt.input);
  return input ? stringValue(input.agentId) : null;
}

function attemptLineage(
  input: ObjectiveFrontierInput,
  stepId: string,
  iterationKey: string,
  fallbackAttemptId: string | null,
  agentId: string | null,
  fallbackStatus: ObjectiveAttemptLineage["status"] = "unknown",
): ObjectiveAttemptLineage[] {
  const attempts = input.attempts
    .filter((attempt) => attempt.runId === input.runId && attempt.stepId === stepId && attempt.iterationKey === iterationKey)
    .sort((left, right) => left.attempt - right.attempt || left.id.localeCompare(right.id));
  const lineage: ObjectiveAttemptLineage[] = attempts.map((attempt, index) => ({
    attemptId: attempt.id,
    attemptNumber: attempt.attempt,
    status: attempt.status,
    parentAttemptId: index > 0 ? attempts[index - 1]!.id : null,
    replacementOf: index > 0 ? attempts[index - 1]!.id : null,
    agentId: agentIdFromAttempt(attempt) ?? agentId,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    evidence: mergeEvidence({ attemptIds: [attempt.id], eventCursor: input.eventCursor }),
  }));
  if (fallbackAttemptId && !lineage.some((item) => item.attemptId === fallbackAttemptId)) {
    const previous = lineage.at(-1)?.attemptId ?? null;
    lineage.push({
      attemptId: fallbackAttemptId,
      attemptNumber: null,
      status: fallbackStatus,
      parentAttemptId: previous,
      replacementOf: previous,
      agentId,
      startedAt: null,
      finishedAt: null,
      evidence: mergeEvidence({ attemptIds: [fallbackAttemptId], eventCursor: input.eventCursor }),
    });
  }
  return lineage;
}

function retryFor(input: ObjectiveFrontierInput, id: string, taskId: string | null, attemptId: string | null) {
  return input.retries
    .filter((retry) => (!retry.objectiveId || retry.objectiveId === input.objectiveId) && (!retry.runId || retry.runId === input.runId))
    .filter((retry) => matches(retry as unknown as AnyRecord, id, taskId, attemptId))
    .sort((left, right) => Date.parse(left.retryAt) - Date.parse(right.retryAt) || left.id.localeCompare(right.id))[0] ?? null;
}

function unknownFor(input: ObjectiveFrontierInput, id: string, taskId: string | null, attemptId: string | null) {
  return input.unknownOutcomes
    .filter((unknown) => (!unknown.objectiveId || unknown.objectiveId === input.objectiveId) && (!unknown.runId || unknown.runId === input.runId))
    .filter((unknown) => matches(unknown as unknown as AnyRecord, id, taskId, attemptId))
    .map((unknown) => {
      const reconciliation = input.reconciliations.find((item) => item.unknownOutcomeId === unknown.id && (!item.objectiveId || item.objectiveId === input.objectiveId) && (!item.runId || item.runId === input.runId));
      return { unknown, reconciliation };
    })
    .filter(({ reconciliation }) => !reconciliation || reconciliation.status === "pending" || reconciliation.status === "conflicted")
    .sort((left, right) => left.unknown.id.localeCompare(right.unknown.id))[0] ?? null;
}

function terminalStatus(state: string): ObjectiveFrontierStatus | null {
  if (state === "completed" || state === "succeeded" || state === "skipped" || state === "superseded") return "completed";
  if (state === "failed" || state === "abandoned" || state === "interrupted") return "failed";
  if (state === "cancelled") return "cancelled";
  if (state === "expired") return "expired";
  return null;
}

function attemptStatus(state: string): ObjectiveAttemptLineage["status"] {
  if (state === "running") return "running";
  if (state === "waiting" || state === "waiting-approval") return "waiting";
  if (state === "completed" || state === "succeeded" || state === "skipped" || state === "superseded") return "completed";
  if (state === "failed" || state === "abandoned" || state === "interrupted") return "failed";
  if (state === "cancelled") return "cancelled";
  return "queued";
}

function itemEvidence(input: ObjectiveFrontierInput, attemptId: string | null, contextRefs: readonly string[] = [], attentionIds: readonly string[] = []): ObjectiveProjectionEvidence {
  return mergeEvidence({
    eventCursor: input.eventCursor,
    attemptIds: attemptId ? [attemptId] : [],
    attentionIds: [...attentionIds],
    contextRefs: [...contextRefs],
  });
}

function evaluationFor(input: ObjectiveFrontierInput, nodeId: string, iterationKey: string): ObjectiveFrontierEvaluationSummary | null {
  const evaluation = input.evaluations.find((item) => item.nodeId === nodeId && item.iterationKey === iterationKey);
  return evaluation ? {
    id: evaluation.id,
    metric: evaluation.metric,
    actual: evaluation.actual,
    target: evaluation.target,
    operator: evaluation.operator,
    pass: evaluation.pass,
  } : null;
}

function taskItems(input: ObjectiveFrontierInput): ObjectiveFrontierItem[] {
  const seen = new Set<string>();
  return input.tasks.filter((raw) => {
    const task = (record(raw)?.task as AnyRecord | undefined) ?? raw as unknown as AnyRecord;
    const id = stringValue(task.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((raw) => {
    const rawRecord = raw as unknown as AnyRecord;
    const wrapped = record(raw)?.task ? raw as { task: AnyRecord; state: string; attemptId: string | null; agentId: string | null } : null;
    const task = wrapped?.task ?? rawRecord;
    const id = stringValue(task.id)!;
    const state = stringValue(wrapped?.state ?? rawRecord.state) ?? "queued";
    const attemptId = wrapped?.attemptId ?? stringValue(rawRecord.attemptId);
    const agentId = wrapped?.agentId ?? stringValue(rawRecord.agentId);
    const dependencyIds = Array.isArray(task.dependsOn) ? uniqueSorted(task.dependsOn.map((value) => stringValue(value))) : [];
    const attentionIds = openAttentionIds(input, id, id, attemptId);
    const retry = retryFor(input, id, id, attemptId);
    const unknown = unknownFor(input, id, id, attemptId);
    const terminal = terminalStatus(state);
    let status: ObjectiveFrontierStatus = terminal ?? "runnable";
    if (!terminal) {
      if (unknown) status = "outcome-unknown";
      else if (retry && Date.parse(retry.retryAt) > Date.parse(input.asOf)) status = "retry-scheduled";
      else if (attentionIds.length > 0 || state === "waiting-approval") status = "waiting-attention";
      else if (state === "running") status = "running";
      else if (state === "blocked") status = "blocked-dependency";
    }
    return {
      id,
      kind: "task",
      taskId: id,
      executionId: null,
      nodeId: null,
      iterationKey: null,
      label: stringValue(task.objective) ?? id,
      status,
      sourceState: state,
      dependencyIds,
      blockedBy: status === "blocked-dependency" ? dependencyIds : [],
      attemptId,
      agentId,
      attemptLineage: attemptLineage(input, id, "root", attemptId, agentId, attemptStatus(state)),
      dueAt: null,
      signalKey: null,
      attentionIds,
      retryAt: retry && Date.parse(retry.retryAt) > Date.parse(input.asOf) ? retry.retryAt : null,
      unknownReason: unknown?.unknown.reason ?? null,
      terminalReason: terminal ? state : null,
      evaluation: null,
      evidence: itemEvidence(input, attemptId, [], attentionIds),
    };
  });
}

function controlItems(input: ObjectiveFrontierInput): ObjectiveFrontierItem[] {
  const nodes = flattenNodes(planFrom(input.controlPlan));
  const frontierIds = new Set((input.controlSnapshot?.frontier ?? []).map((key) => executionId(key.nodeId, key.iterationKey)));
  const authoritativeFrontier = input.controlSnapshot !== undefined;
  const suspensions = suspensionMap(input);
  return controlExecutions(input).map((execution) => {
    const node = nodes.get(execution.key.nodeId);
    const id = executionId(execution.key.nodeId, execution.key.iterationKey);
    const sourceState = execution.state;
    const terminal = terminalStatus(sourceState);
    const taskId = node?.type === "agent" ? node.id : null;
    const attemptId = execution.attemptId;
    const attentionIds = openAttentionIds(input, id, taskId, attemptId);
    const retry = retryFor(input, id, taskId, attemptId);
    const unknown = unknownFor(input, id, taskId, attemptId);
    const suspension = suspensions.get(id);
    const dependencyIds = uniqueSorted(node?.dependsOn ?? []);
    let status: ObjectiveFrontierStatus = terminal ?? "runnable";
    if (!terminal) {
      if (unknown) status = "outcome-unknown";
      else if (retry && Date.parse(retry.retryAt) > Date.parse(input.asOf)) status = "retry-scheduled";
      else if (attentionIds.length > 0) status = "waiting-attention";
      else if (suspension?.kind === "timer" && (suspension.status === "waiting" || suspension.status === "ready")) status = "waiting-timer";
      else if (suspension?.kind === "signal" && (suspension.status === "waiting" || suspension.status === "ready")) status = "waiting-signal";
      else if (sourceState === "running") status = "running";
      else if (sourceState === "blocked") status = "blocked-dependency";
      else if (authoritativeFrontier && !frontierIds.has(id)) status = "blocked-dependency";
    }
    const dueAt = suspension?.kind === "timer" ? suspension.dueAt : null;
    const signalKey = suspension?.kind === "signal" ? suspension.signalKey : null;
    const contextRefs = execution.contextRefs.map((ref) => ref.id);
    return {
      id,
      kind: "control",
      taskId,
      executionId: id,
      nodeId: execution.key.nodeId,
      iterationKey: execution.key.iterationKey,
      label: node?.label ?? node?.sourceNodeId ?? execution.key.nodeId,
      status,
      sourceState,
      dependencyIds,
      blockedBy: status === "blocked-dependency" ? dependencyIds : [],
      attemptId,
      agentId: execution.agentId,
      attemptLineage: attemptLineage(input, execution.key.nodeId, execution.key.iterationKey, attemptId, execution.agentId, attemptStatus(sourceState)),
      dueAt,
      signalKey,
      attentionIds,
      retryAt: retry && Date.parse(retry.retryAt) > Date.parse(input.asOf) ? retry.retryAt : null,
      unknownReason: unknown?.unknown.reason ?? null,
      terminalReason: terminal ? sourceState : null,
      evaluation: evaluationFor(input, execution.key.nodeId, execution.key.iterationKey),
      evidence: itemEvidence(input, attemptId, contextRefs, attentionIds),
    };
  });
}

function resolveDependencies(items: ObjectiveFrontierItem[], authoritativeControlFrontier: ReadonlySet<string> | null): ObjectiveFrontierItem[] {
  const byId = new Map<string, ObjectiveFrontierItem>();
  for (const item of items) byId.set(item.id, item);
  return items.map((item) => {
    if (item.status !== "runnable" && item.status !== "blocked-dependency") return item;
    if (item.kind === "control" && item.sourceState === "queued" && authoritativeControlFrontier && !authoritativeControlFrontier.has(item.id)) return item;
    const blockedBy = item.dependencyIds.filter((dependencyId) => {
      const direct = byId.get(dependencyId);
      if (direct) return direct.status !== "completed";
      if (item.kind === "control" && item.iterationKey) {
        const scoped = items.find((candidate) => candidate.kind === "control" && candidate.nodeId === dependencyId && candidate.iterationKey === item.iterationKey);
        return !scoped || scoped.status !== "completed";
      }
      return true;
    });
    return blockedBy.length > 0 ? { ...item, status: "blocked-dependency", blockedBy } : { ...item, status: "runnable", blockedBy: [] };
  });
}

function countStatuses(items: readonly ObjectiveFrontierItem[]) {
  const counts = {
    total: items.length, runnable: 0, running: 0, blockedDependency: 0,
    waitingTimer: 0, waitingSignal: 0, waitingAttention: 0, retryScheduled: 0,
    outcomeUnknown: 0, completed: 0, failed: 0, cancelled: 0, expired: 0,
  };
  for (const item of items) {
    if (item.status === "runnable") counts.runnable += 1;
    else if (item.status === "running") counts.running += 1;
    else if (item.status === "blocked-dependency") counts.blockedDependency += 1;
    else if (item.status === "waiting-timer") counts.waitingTimer += 1;
    else if (item.status === "waiting-signal") counts.waitingSignal += 1;
    else if (item.status === "waiting-attention") counts.waitingAttention += 1;
    else if (item.status === "retry-scheduled") counts.retryScheduled += 1;
    else if (item.status === "outcome-unknown") counts.outcomeUnknown += 1;
    else if (item.status === "completed") counts.completed += 1;
    else if (item.status === "failed") counts.failed += 1;
    else if (item.status === "cancelled") counts.cancelled += 1;
    else if (item.status === "expired") counts.expired += 1;
  }
  return counts;
}

function phrase(count: number, singular: string, plural: string = singular + "s"): string {
  return String(count) + " " + (count === 1 ? singular : plural);
}

function frontierSummary(counts: ReturnType<typeof countStatuses>): string {
  if (counts.total === 0) return "No executable work is recorded.";
  if (counts.completed === counts.total) return "All " + phrase(counts.total, "work item") + " completed.";
  const parts: string[] = [];
  if (counts.running) parts.push(phrase(counts.running, "item running"));
  if (counts.runnable) parts.push(phrase(counts.runnable, "item runnable"));
  if (counts.blockedDependency) parts.push(phrase(counts.blockedDependency, "item blocked by dependency"));
  if (counts.waitingTimer) parts.push(phrase(counts.waitingTimer, "item waiting for a timer"));
  if (counts.waitingSignal) parts.push(phrase(counts.waitingSignal, "item waiting for a signal"));
  if (counts.waitingAttention) parts.push(phrase(counts.waitingAttention, "item waiting for attention"));
  if (counts.retryScheduled) parts.push(phrase(counts.retryScheduled, "retry scheduled"));
  if (counts.outcomeUnknown) parts.push(phrase(counts.outcomeUnknown, "outcome unknown"));
  if (counts.failed) parts.push(phrase(counts.failed, "item failed"));
  if (counts.cancelled) parts.push(phrase(counts.cancelled, "item cancelled"));
  if (counts.expired) parts.push(phrase(counts.expired, "item expired"));
  if (parts.length === 0) return "No unfinished work can advance.";
  return parts.length === 1 ? parts[0] + "." : parts.slice(0, -1).join(", ") + ", and " + parts.at(-1) + ".";
}

function projectionState(input: ObjectiveFrontierInput, counts: ReturnType<typeof countStatuses>): ObjectiveFrontierProjection["state"] {
  if (counts.outcomeUnknown > 0) return "outcome-unknown";
  if (input.runState === "waiting") return "waiting";
  const runState = terminalStatus(input.runState ?? "");
  if (runState === "completed" || runState === "failed" || runState === "cancelled" || runState === "expired") return runState;
  if (counts.total > 0 && counts.completed + counts.failed + counts.cancelled + counts.expired === counts.total) {
    if (counts.failed) return "failed";
    if (counts.cancelled) return "cancelled";
    if (counts.expired) return "expired";
    return "completed";
  }
  const waiting = counts.waitingTimer + counts.waitingSignal + counts.waitingAttention + counts.retryScheduled;
  return waiting > 0 && counts.running === 0 && counts.runnable === 0 ? "waiting" : "active";
}

function allEvidence(items: readonly ObjectiveFrontierItem[], eventCursor: number): ObjectiveProjectionEvidence {
  return mergeEvidence({ eventCursor }, ...items.map((item) => item.evidence));
}

/** Project the complete current objective frontier from durable records. */
export function projectObjectiveFrontier(input: ObjectiveFrontierInput | unknown): ObjectiveFrontierProjection {
  const parsed = normalizeInput(ObjectiveFrontierInputSchema.parse(input));
  const authoritativeControlFrontier = parsed.controlSnapshot ? new Set(parsed.controlSnapshot.frontier.map((key) => executionId(key.nodeId, key.iterationKey))) : null;
  const merged = resolveDependencies([...taskItems(parsed), ...controlItems(parsed)].sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind)), authoritativeControlFrontier);
  const counts = countStatuses(merged);
  return ObjectiveFrontierProjectionSchema.parse({
    version: 1 as const,
    objectiveId: parsed.objectiveId,
    runId: parsed.runId,
    asOf: parsed.asOf,
    eventCursor: parsed.eventCursor,
    state: projectionState(parsed, counts),
    items: merged,
    frontier: merged.filter((item) => !TERMINAL_STATUSES.has(item.status)),
    counts,
    summary: frontierSummary(counts),
    evidence: allEvidence(merged, parsed.eventCursor),
  });
}

type RunlineCandidate = Omit<ObjectiveRunlineEntry, "collapsedCount"> & { collapsedCount?: number };

function semanticEventType(type: string, payload: AnyRecord): ObjectiveRunlineEventType | null {
  const value = type.toLowerCase();
  if (/delta|token|tool|chat\.message|message\.|stream/.test(value)) return null;
  if (/plan|revision/.test(value)) return "plan-revised";
  if (/branch|\bif\b/.test(value)) return "branch-selected";
  if (/loop|iteration|while/.test(value)) return /stop|exit|bound/.test(value) ? "loop-stopped" : "loop-iteration";
  if (/evaluat|criterion|metric|score/.test(value)) return "evaluation";
  if (/artifact/.test(value)) return /supersed/.test(value) ? "artifact-superseded" : "artifact-published";
  if (/checkpoint/.test(value)) return "checkpoint-committed";
  if (/retry/.test(value)) return "retry-scheduled";
  if (/attention|approval/.test(value)) return /resolv|approv|reject|cancel|expire/.test(value) ? "attention-resolved" : "attention-requested";
  if (/suspension|timer|signal|wait/.test(value)) return /settled|deliver|expire|cancel|due/.test(value) ? "suspension-settled" : "suspension-created";
  if (/unknown|reconcil/.test(value)) return /reconcil/.test(value) ? "reconciliation" : "outcome-unknown";
  if (/run\.(complete|success|succeed)|workflow\.(complete|success|succeed)/.test(value)) return "run-completed";
  if (/run\.(fail|failed)|workflow\.(fail|failed)/.test(value)) return "run-failed";
  if (/run\.(cancel|cancelled)|workflow\.(cancel|cancelled)/.test(value)) return "run-cancelled";
  if (/run\.(expire|expired)|workflow\.(expire|expired)/.test(value)) return "run-expired";
  if (/delegat|dispatch|agent\.create|agent\.start|task\.start|stage\.enter/.test(value)) return /agent/.test(value) ? "agent-delegated" : "stage-entered";
  if (/agent\.(settle|complete|success)|task\.(complete|settle)|stage\.exit/.test(value)) return /agent/.test(value) ? "agent-settled" : "stage-exited";
  if (/agent\.(fail|failed)|task\.(fail|failed)/.test(value)) return "agent-failed";
  if (/observe|native|driver/.test(value)) return "observation";
  return payload.summary || payload.message ? "observation" : null;
}

function payloadSubject(payload: AnyRecord): { id: string | null; kind: ObjectiveRunlineEntry["subjectKind"] } {
  const id = stringValue(payload.executionId)
    ?? stringValue(payload.controlExecutionId)
    ?? stringValue(payload.taskId)
    ?? stringValue(payload.nodeId)
    ?? stringValue(payload.agentId)
    ?? stringValue(payload.attemptId)
    ?? stringValue(payload.artifactId)
    ?? stringValue(payload.checkpointId)
    ?? null;
  if (!id) return { id: null, kind: null };
  if (payload.artifactId) return { id, kind: "artifact" };
  if (payload.checkpointId) return { id, kind: "checkpoint" };
  if (payload.attentionId || payload.approvalId) return { id, kind: "attention" };
  if (payload.attemptId) return { id, kind: "attempt" };
  if (payload.agentId) return { id, kind: "agent" };
  if (payload.executionId || payload.controlExecutionId || payload.nodeId) return { id, kind: "control" };
  if (payload.taskId) return { id, kind: "task" };
  return { id, kind: "native" };
}

function eventCandidate(input: ObjectiveFrontierInput, raw: AnyRecord): RunlineCandidate | null {
  const id = stringValue(raw.id);
  const type = stringValue(raw.type);
  if (!id || !type) return null;
  const rawRunId = stringValue(raw.runId);
  const rawObjectiveId = stringValue(raw.objectiveId);
  if ((rawRunId && rawRunId !== input.runId) || (rawObjectiveId && rawObjectiveId !== input.objectiveId)) return null;
  const payload = record(raw.payload) ?? raw;
  const semanticType = semanticEventType(type, payload);
  if (!semanticType) return null;
  const cursor = numberValue(raw.cursor) ?? numberValue(payload.eventCursor) ?? 0;
  const subject = payloadSubject(payload);
  const summary = stringValue(payload.summary) ?? stringValue(payload.message) ?? type.replace(/[._-]+/g, " ");
  return {
    version: 1,
    id: "event:" + id,
    type: semanticType,
    cursor,
    occurredAt: iso(raw.occurredAt ?? payload.occurredAt, input.asOf),
    subjectId: subject.id,
    subjectKind: subject.kind,
    summary,
    evidence: mergeEvidence({
      eventCursor: cursor,
      eventIds: [id],
      attemptIds: [stringValue(payload.attemptId)].filter((value): value is string => value !== null),
      artifactIds: [stringValue(payload.artifactId)].filter((value): value is string => value !== null),
      checkpointIds: [stringValue(payload.checkpointId)].filter((value): value is string => value !== null),
      attentionIds: [stringValue(payload.attentionId), stringValue(payload.approvalId)].filter((value): value is string => value !== null),
      contextRefs: Array.isArray(payload.contextRefs) ? payload.contextRefs.map(stringValue).filter((v): v is string => v !== null) : [],
    }),
    attemptLineage: [],
  };
}

function recordCandidate(
  input: ObjectiveFrontierInput,
  id: string,
  type: ObjectiveRunlineEventType,
  subjectId: string | null,
  subjectKind: ObjectiveRunlineEntry["subjectKind"],
  summary: string,
  evidence: Partial<ObjectiveProjectionEvidence> = {},
  occurredAt: string = input.asOf,
): RunlineCandidate {
  return {
    version: 1, id, type, cursor: evidence.eventCursor ?? null, occurredAt,
    subjectId, subjectKind, summary,
    evidence: mergeEvidence({ eventCursor: input.eventCursor }, evidence),
    attemptLineage: [],
  };
}

function generatedCandidates(input: ObjectiveFrontierInput, projection: ObjectiveFrontierProjection): RunlineCandidate[] {
  const candidates: RunlineCandidate[] = [];
  for (const mutation of input.planMutations) {
    const mutationRunId = stringValue(mutation.runId);
    const mutationObjectiveId = stringValue(mutation.objectiveId);
    if ((mutationRunId && mutationRunId !== input.runId) || (mutationObjectiveId && mutationObjectiveId !== input.objectiveId)) continue;
    // Control mutation records use `mutationId` (rather than the legacy
    // workflow `id`).  Prefer that durable identity so a record cannot turn
    // its full, potentially large JSON payload into a projection key.  The
    // bounded fallback keeps older unidentifiable records deterministic while
    // respecting the public id field limit.
    const id = stringValue(mutation.id) ?? stringValue(mutation.mutationId) ?? stringValue(mutation.requestKey) ?? "plan-" + stable(mutation).slice(0, 400);
    candidates.push(recordCandidate(input, "plan:" + id, "plan-revised", id, "plan", stringValue(mutation.reason) ?? "Plan revision accepted.", { eventCursor: numberValue(mutation.eventCursor) ?? input.eventCursor }, iso(mutation.createdAt, input.asOf)));
  }
  for (const retry of input.retries) {
    if ((retry.objectiveId && retry.objectiveId !== input.objectiveId) || (retry.runId && retry.runId !== input.runId)) continue;
    candidates.push(recordCandidate(input, "retry:" + retry.id, "retry-scheduled", retry.executionId ?? retry.taskId, retry.executionId ? "control" : "task", retry.reason, retry.evidence ?? {}, retry.retryAt));
  }
  for (const unknown of input.unknownOutcomes) {
    if ((unknown.objectiveId && unknown.objectiveId !== input.objectiveId) || (unknown.runId && unknown.runId !== input.runId)) continue;
    candidates.push(recordCandidate(input, "unknown:" + unknown.id, "outcome-unknown", unknown.executionId ?? unknown.taskId ?? unknown.attemptId, unknown.executionId ? "control" : unknown.attemptId ? "attempt" : "task", unknown.reason, unknown.evidence ?? {}));
  }
  for (const reconciliation of input.reconciliations) {
    if ((reconciliation.objectiveId && reconciliation.objectiveId !== input.objectiveId) || (reconciliation.runId && reconciliation.runId !== input.runId)) continue;
    candidates.push(recordCandidate(input, "reconciliation:" + reconciliation.id, "reconciliation", reconciliation.attemptId ?? reconciliation.unknownOutcomeId, reconciliation.attemptId ? "attempt" : "native", reconciliation.reason, reconciliation.evidence ?? {}));
  }
  for (const attention of input.attentions) {
    if (attention.objectiveId !== input.objectiveId || attention.runId !== input.runId) continue;
    candidates.push(recordCandidate(input, "attention:" + attention.id, attention.status === "open" ? "attention-requested" : "attention-resolved", attention.id, "attention", attention.reason, { attentionIds: [attention.id] }, attention.updatedAt));
  }
  for (const artifact of input.artifacts) {
    if (artifact.objectiveId !== input.objectiveId || artifact.runId !== input.runId) continue;
    candidates.push(recordCandidate(input, "artifact:" + artifact.id, artifact.supersedes ? "artifact-superseded" : "artifact-published", artifact.id, "artifact", artifact.supersedes ? artifact.name + " superseded " + artifact.supersedes + "." : artifact.name + " published.", { artifactIds: [artifact.id], eventCursor: artifact.evidence.eventCursor }, artifact.publishedAt));
  }
  for (const checkpoint of input.checkpoints) {
    if ((stringValue(checkpoint.objectiveId) && stringValue(checkpoint.objectiveId) !== input.objectiveId) || (stringValue(checkpoint.runId) && stringValue(checkpoint.runId) !== input.runId)) continue;
    const id = stringValue(checkpoint.id) ?? "checkpoint-" + stable(checkpoint);
    candidates.push(recordCandidate(input, "checkpoint:" + id, "checkpoint-committed", id, "checkpoint", stringValue(checkpoint.reason) ?? "Checkpoint committed.", { checkpointIds: [id], eventCursor: numberValue(checkpoint.eventCursor) ?? input.eventCursor }, iso(checkpoint.createdAt, input.asOf)));
  }
  for (const evaluation of input.evaluations) {
    candidates.push(recordCandidate(input, "evaluation:" + evaluation.id, "evaluation", evaluation.nodeId, "control", (evaluation.metric ?? evaluation.nodeId) + ": " + (evaluation.pass ? "passed." : "did not pass."), { eventCursor: evaluation.eventCursor }));
  }
  for (const suspension of input.suspensions) {
    if (suspension.objectiveId !== input.objectiveId || suspension.runId !== input.runId) continue;
    const id = executionId(suspension.execution.nodeId, suspension.execution.iterationKey);
    const settled = suspension.status !== "waiting";
    const detail = settled ? suspension.kind + " wait " + suspension.status + "." : suspension.kind === "timer" ? "Waiting for timer until " + suspension.dueAt + "." : "Waiting for signal " + suspension.signalKey + ".";
    candidates.push(recordCandidate(input, "suspension:" + id, settled ? "suspension-settled" : "suspension-created", id, "control", detail, { attemptIds: [suspension.attemptId] }, suspension.settledAt ?? suspension.since));
  }
  if (input.events.length === 0) {
    for (const item of projection.items) {
      if (item.status === "runnable" || item.status === "running") {
        candidates.push(recordCandidate(input, "state:" + item.kind + ":" + item.id + ":" + item.status, item.status === "running" ? "stage-entered" : "observation", item.id, item.kind === "control" ? "control" : "task", item.label + " is " + item.status + ".", item.evidence));
      } else if (item.status === "completed" || item.status === "failed" || item.status === "cancelled" || item.status === "expired") {
        const type = item.status === "completed" ? "stage-exited" : item.status === "failed" ? "agent-failed" : item.status === "cancelled" ? "run-cancelled" : "run-expired";
        candidates.push(recordCandidate(input, "state:" + item.kind + ":" + item.id + ":" + item.status, type, item.id, item.kind === "control" ? "control" : "task", item.label + " is " + item.status + ".", item.evidence));
      }
    }
  }
  return candidates;
}

function collapseCandidates(candidates: RunlineCandidate[]): ObjectiveRunlineEntry[] {
  const ordered = [...candidates].sort((left, right) => (left.cursor ?? Number.MAX_SAFE_INTEGER) - (right.cursor ?? Number.MAX_SAFE_INTEGER) || left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  const groups = new Map<string, RunlineCandidate & { collapsedCount: number }>();
  for (const candidate of ordered) {
    const key = candidate.type + "|" + (candidate.subjectId ?? "") + "|" + candidate.summary;
    const current = groups.get(key);
    if (!current) groups.set(key, { ...candidate, collapsedCount: 1 });
    else {
      current.collapsedCount += 1;
      current.evidence = mergeEvidence(current.evidence, candidate.evidence);
      current.attemptLineage = [...current.attemptLineage, ...candidate.attemptLineage];
      if ((candidate.cursor ?? 0) > (current.cursor ?? 0)) current.cursor = candidate.cursor;
      if (candidate.occurredAt > current.occurredAt) current.occurredAt = candidate.occurredAt;
    }
  }
  return [...groups.values()]
    .sort((left, right) => (left.cursor ?? Number.MAX_SAFE_INTEGER) - (right.cursor ?? Number.MAX_SAFE_INTEGER) || left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
    .map((candidate) => ({ ...candidate, collapsedCount: candidate.collapsedCount }));
}

/** Project typed semantic history; raw chat/tool deltas never become entries. */
export function projectObjectiveRunline(input: ObjectiveFrontierInput | unknown, frontier?: ObjectiveFrontierProjection): ReturnType<typeof ObjectiveRunlineProjectionSchema.parse> {
  const parsed = normalizeInput(ObjectiveFrontierInputSchema.parse(input));
  const projection = frontier ?? projectObjectiveFrontier(parsed);
  const candidates = parsed.events.map((event) => eventCandidate(parsed, event as unknown as AnyRecord)).filter((value): value is RunlineCandidate => value !== null);
  candidates.push(...generatedCandidates(parsed, projection));
  const entries = collapseCandidates(candidates).map((entry) => {
    const subject = projection.items.find((item) => item.id === entry.subjectId || item.attemptId === entry.subjectId);
    return { ...entry, attemptLineage: subject?.attemptLineage ?? entry.attemptLineage };
  });
  return ObjectiveRunlineProjectionSchema.parse({
    version: 1 as const,
    objectiveId: parsed.objectiveId,
    runId: parsed.runId,
    eventCursor: parsed.eventCursor,
    entries,
    summary: entries.length > 0 ? String(entries.length) + " semantic runline " + (entries.length === 1 ? "entry" : "entries") + "; " + projection.summary : projection.summary,
    evidence: mergeEvidence({ eventCursor: parsed.eventCursor }, ...entries.map((entry) => entry.evidence)),
  });
}

/** Stable convenience boundary for consumers that need both projections. */
export function projectObjectiveWorkspace(input: ObjectiveFrontierInput | unknown): { frontier: ObjectiveFrontierProjection; runline: ReturnType<typeof ObjectiveRunlineProjectionSchema.parse> } {
  const frontier = projectObjectiveFrontier(input);
  return { frontier, runline: projectObjectiveRunline(input, frontier) };
}

type AggregateSnapshotInput = {
  objective: { objectiveId: string; updatedAt: string };
  eventCursor: number;
  runs: AnyRecord[];
  currentRuns?: AnyRecord[];
  plan?: AnyRecord;
  tasks?: unknown[];
  attempts?: unknown[];
  checkpoints?: unknown[];
  approvals?: unknown[];
  attentions?: unknown[];
  artifacts?: unknown[];
  suspensions?: unknown[];
  controlExecutions?: unknown[];
  evaluations?: unknown[];
  retries?: unknown[];
  unknownOutcomes?: unknown[];
  reconciliations?: unknown[];
  events?: unknown[];
  mutations?: AnyRecord;
};

function latestDate(values: unknown[], fallback: string): string {
  const valid = values
    .filter((value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return valid[0] ?? fallback;
}

function recordList(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter((item): item is AnyRecord => record(item) !== null).map((item) => item as AnyRecord) : [];
}

function isAtCursor(value: AnyRecord, eventCursor: number): boolean {
  const cursor = numberValue(value.eventCursor ?? value.cursor);
  return cursor === null || cursor <= eventCursor;
}

function aggregateProjectionState(projections: readonly ObjectiveFrontierProjection[]): ObjectiveAggregateFrontierProjection["state"] {
  if (projections.some((projection) => projection.state === "outcome-unknown")) return "outcome-unknown";
  if (projections.length > 0 && projections.every((projection) => ["completed", "failed", "cancelled", "expired"].includes(projection.state))) {
    if (projections.some((projection) => projection.state === "failed")) return "failed";
    if (projections.some((projection) => projection.state === "cancelled")) return "cancelled";
    if (projections.some((projection) => projection.state === "expired")) return "expired";
    return "completed";
  }
  if (projections.length > 0 && projections.every((projection) => projection.state === "waiting")) return "waiting";
  return "active";
}

function sumCounts(projections: readonly ObjectiveFrontierProjection[]) {
  const counts = {
    total: 0, runnable: 0, running: 0, blockedDependency: 0,
    waitingTimer: 0, waitingSignal: 0, waitingAttention: 0, retryScheduled: 0,
    outcomeUnknown: 0, completed: 0, failed: 0, cancelled: 0, expired: 0,
  };
  for (const projection of projections) {
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] += projection.counts[key];
  }
  return counts;
}

/**
 * Project every run in one atomic aggregate snapshot. The input is structural
 * so storage can call this without introducing a storage/workflow dependency
 * cycle; the returned value is parsed by the protocol aggregate schema.
 */
export function projectObjectiveAggregateSnapshot(snapshot: unknown): {
  frontierProjection: ObjectiveAggregateFrontierProjection;
  runline: ObjectiveAggregateRunlineProjection;
} {
  const source = snapshot as AggregateSnapshotInput;
  const runs = [...(source.runs ?? [])]
    .filter((run) => run.objectiveId === source.objective.objectiveId && typeof run.runId === "string")
    .sort((left, right) => String(left.runId).localeCompare(String(right.runId)));
  const plan = source.plan ?? {};
  const revisions = recordList(plan.revisions);
  const planSnapshots = recordList(plan.snapshots);
  const allCheckpoints = recordList(source.checkpoints);
  const allApprovals = recordList(source.approvals);
  const allAttentions = recordList(source.attentions);
  const allArtifacts = recordList(source.artifacts);
  const allSuspensions = recordList(source.suspensions);
  const allControlExecutions = recordList(source.controlExecutions);
  const allEvaluations = recordList(source.evaluations);
  const allRetries = recordList(source.retries);
  const allUnknownOutcomes = recordList(source.unknownOutcomes);
  const allReconciliations = recordList(source.reconciliations);
  const allEvents = recordList(source.events);
  const allAttempts = recordList(source.attempts);
  const mutationRecord = source.mutations ?? {};
  const allPlanMutations = [...recordList(mutationRecord.plans), ...recordList(mutationRecord.control)];
  const runProjections: Array<{ runId: string; projection: ObjectiveFrontierProjection; runline: ReturnType<typeof ObjectiveRunlineProjectionSchema.parse> }> = [];

  for (const run of runs) {
    const runId = String(run.runId);
    const runRevisions = revisions
      .filter((revision) => revision.runId === runId)
      .sort((left, right) => Number(right.revision ?? right.planRevision ?? 0) - Number(left.revision ?? left.planRevision ?? 0) || stable(left).localeCompare(stable(right)));
    const controlPlan = runRevisions.find((revision) => record(revision.plan) !== null);
    const runSnapshots = planSnapshots
      .filter((controlSnapshot) => controlSnapshot.runId === runId && isAtCursor(controlSnapshot, source.eventCursor))
      .sort((left, right) => Number(right.sequence ?? 0) - Number(left.sequence ?? 0) || stable(left).localeCompare(stable(right)));
    const controlSnapshot = runSnapshots[0];
    const runEvents = allEvents.filter((event) => event.runId === runId && isAtCursor(event, source.eventCursor));
    const runInput = {
      version: 1 as const,
      objectiveId: source.objective.objectiveId,
      runId,
      asOf: latestDate([run.updatedAt, ...runEvents.map((event) => event.occurredAt), source.objective.updatedAt], source.objective.updatedAt),
      eventCursor: source.eventCursor,
      runState: typeof run.state === "string" ? run.state : undefined,
      runOutput: run.output === undefined ? null : run.output,
      runError: typeof run.error === "string" || run.error === null ? run.error : null,
      tasks: run.tasks ?? [],
      attempts: allAttempts.filter((attempt) => attempt.runId === runId && isAtCursor(attempt, source.eventCursor)),
      ...(controlPlan ? { controlPlan } : {}),
      ...(controlSnapshot ? { controlSnapshot } : {}),
      checkpoints: allCheckpoints.filter((checkpoint) => checkpoint.runId === runId && isAtCursor(checkpoint, source.eventCursor)),
      approvals: allApprovals.filter((approval) => approval.runId === runId && isAtCursor(approval, source.eventCursor)),
      attentions: allAttentions.filter((attention) => attention.runId === runId && isAtCursor(attention, source.eventCursor)),
      artifacts: allArtifacts.filter((artifact) => artifact.runId === runId && isAtCursor(artifact, source.eventCursor)),
      suspensions: allSuspensions.filter((suspension) => suspension.runId === runId && isAtCursor(suspension, source.eventCursor)),
      controlExecutions: allControlExecutions.filter((execution) => execution.runId === runId && isAtCursor(execution, source.eventCursor)),
      evaluations: allEvaluations.filter((evaluation) => evaluation.runId === runId && isAtCursor(evaluation, source.eventCursor)),
      retries: allRetries.filter((retry) => retry.runId === runId && isAtCursor(retry, source.eventCursor)),
      unknownOutcomes: allUnknownOutcomes.filter((unknown) => unknown.runId === runId && isAtCursor(unknown, source.eventCursor)),
      reconciliations: allReconciliations.filter((reconciliation) => reconciliation.runId === runId && isAtCursor(reconciliation, source.eventCursor)),
      planMutations: allPlanMutations.filter((mutation) => mutation.runId === runId && isAtCursor(mutation, source.eventCursor)),
      events: runEvents,
    };
    const projected = projectObjectiveFrontier(runInput);
    runProjections.push({ runId, projection: projected, runline: projectObjectiveRunline(runInput, projected) });
  }

  const projections = runProjections.map((entry) => entry.projection);
  const counts = sumCounts(projections);
  const frontier = runProjections
    .flatMap((entry) => entry.projection.frontier.map((item) => ({ ...item, runId: entry.runId })))
    .sort((left, right) => left.runId.localeCompare(right.runId) || left.id.localeCompare(right.id));
  const state = aggregateProjectionState(projections);
  const summary = state === "waiting"
    ? "Objective is waiting: " + frontierSummary(counts)
    : frontierSummary(counts);
  const evidence = mergeEvidence({ eventCursor: source.eventCursor }, ...projections.map((projection) => projection.evidence));
  const aggregateFrontier = ObjectiveAggregateFrontierProjectionSchema.parse({
    version: 1,
    objectiveId: source.objective.objectiveId,
    eventCursor: source.eventCursor,
    runs: runProjections.map(({ runId, projection }) => ({ runId, projection })),
    frontier,
    counts,
    state,
    summary,
    evidence,
  });
  const entries = runProjections
    .flatMap(({ runId, runline }) => runline.entries.map((entry) => ({ ...entry, runId })))
    .sort((left, right) => (left.cursor ?? Number.MAX_SAFE_INTEGER) - (right.cursor ?? Number.MAX_SAFE_INTEGER) || left.occurredAt.localeCompare(right.occurredAt) || left.runId.localeCompare(right.runId) || left.id.localeCompare(right.id));
  return {
    frontierProjection: aggregateFrontier,
    runline: ObjectiveAggregateRunlineProjectionSchema.parse({
      version: 1,
      objectiveId: source.objective.objectiveId,
      eventCursor: source.eventCursor,
      runs: runProjections.map(({ runId, runline }) => ({ runId, projection: runline })),
      entries,
      summary: entries.length > 0 ? String(entries.length) + " semantic runline entries; " + summary : summary,
      evidence: mergeEvidence({ eventCursor: source.eventCursor }, ...runProjections.map((entry) => entry.runline.evidence)),
    }),
  };
}

export const ObjectiveFrontierOutputSchema = ObjectiveFrontierProjectionSchema;
export const ObjectiveRunlineOutputSchema = ObjectiveRunlineProjectionSchema;
export function parseObjectiveFrontierProjection(value: unknown): ObjectiveFrontierProjection {
  return ObjectiveFrontierProjectionSchema.parse(value);
}

export function parseObjectiveRunlineProjection(value: unknown) {
  return ObjectiveRunlineProjectionSchema.parse(value);
}
