/**
 * UI-owned projection contract for the living objective strategy.
 *
 * This deliberately does not import the daemon protocol. The daemon may add
 * fields, change storage, or introduce a new control node without making the
 * browser's rendering contract its source of truth. A single adapter can map
 * an authoritative daemon snapshot into this shape later.
 */

import type { ObjectiveControlProjection, JsonValue } from "./contracts";
import type { ObjectiveProjection, ObjectiveTaskProjection } from "./objective-project";

export type ObjectiveStrategyStatus =
  | "active"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "expired"
  | "waiting"
  | "skipped"
  | "undecided"
  | "idle";

export type ObjectiveStrategySource = {
  kind: "workflow-revision" | "manual" | "unknown";
  id: string | null;
  revision: number | null;
  hash: string | null;
};

export type ObjectiveStrategyNodeBase = {
  id: string;
  label: string;
  state: ObjectiveStrategyStatus;
  /** A runtime occurrence identity. Static plan nodes may omit this. */
  executionKey?: string | null;
  /** The loop iterations that produced this runtime occurrence, outermost first. */
  iterationPath?: readonly number[];
};

export type ObjectiveStrategyAgentNode = ObjectiveStrategyNodeBase & {
  kind: "agent";
  objective: string | null;
  agentId: string | null;
  harness: string | null;
  model: string | null;
  attempt: number;
  maxAttempts: number | null;
  error: string | null;
};

export type ObjectiveStrategySetNode = ObjectiveStrategyNodeBase & {
  kind: "set";
  /** A deterministic value/output, intentionally not a grouping node. */
  valueSummary: string | null;
};

export type ObjectiveStrategyEvaluateNode = ObjectiveStrategyNodeBase & {
  kind: "evaluate";
  metric: string;
  path: string;
  operator: string;
  target: JsonValue | null;
  actual: JsonValue | null;
  pass: boolean | null;
  /** Concrete execution scope, including nested loop/branch ancestry. */
  iterationContext?: string | null;
};

export type ObjectiveStrategySequenceNode = ObjectiveStrategyNodeBase & {
  kind: "sequence";
  children: ObjectiveStrategyNode[];
};

export type ObjectiveStrategyParallelNode = ObjectiveStrategyNodeBase & {
  kind: "parallel";
  children: ObjectiveStrategyNode[];
};

export type ObjectiveStrategyIfNode = ObjectiveStrategyNodeBase & {
  kind: "if";
  condition: string | null;
  selectedBranch: "then" | "else" | null;
  then: ObjectiveStrategyNode[];
  else: ObjectiveStrategyNode[];
};

export type ObjectiveStrategyWhileNode = ObjectiveStrategyNodeBase & {
  kind: "while";
  condition: string | null;
  iteration: number;
  maxIterations: number | null;
  exitReason: string | null;
  body: ObjectiveStrategyNode[];
};

export type ObjectiveStrategyTimerNode = ObjectiveStrategyNodeBase & {
  kind: "timer";
  durationMs: number;
  since: string | null;
  dueAt: string | null;
  expiresAt: string | null;
  suspensionStatus: "waiting" | "ready" | "delivered" | "cancelled" | "expired" | null;
};

export type ObjectiveStrategySignalNode = ObjectiveStrategyNodeBase & {
  kind: "signal";
  signalKey: string;
  subscriptionKey: string | null;
  since: string | null;
  expiresAt: string | null;
  suspensionStatus: "waiting" | "ready" | "delivered" | "cancelled" | "expired" | null;
};

export type ObjectiveStrategyNode =
  | ObjectiveStrategyAgentNode
  | ObjectiveStrategySetNode
  | ObjectiveStrategyEvaluateNode
  | ObjectiveStrategySequenceNode
  | ObjectiveStrategyParallelNode
  | ObjectiveStrategyIfNode
  | ObjectiveStrategyWhileNode
  | ObjectiveStrategyTimerNode
  | ObjectiveStrategySignalNode;

export type ObjectiveStrategyMutation = {
  id: string;
  revision: number;
  kind: string;
  summary: string;
  createdAt: string;
  actor: string | null;
};

export type ObjectiveStrategyReadyProjection = {
  kind: "ready";
  objectiveId: string;
  runId: string;
  revision: number;
  source: ObjectiveStrategySource;
  roots: ObjectiveStrategyNode[];
  frontierIds: string[];
  mutations: ObjectiveStrategyMutation[];
  updatedAt: string | null;
};

export type ObjectiveStrategyProjection =
  | ObjectiveStrategyReadyProjection
  | { kind: "empty"; detail?: string }
  | { kind: "error"; message: string; retryable?: boolean }
  | { kind: "legacy-null"; detail?: string; runId?: string | null };

/**
 * Adapt the daemon-backed objective projection into the UI strategy contract.
 *
 * Immutable task-plan records remain the compatibility projection for older
 * daemons. When the daemon publishes a control snapshot, the typed tree is the
 * source of truth, including data-only evaluation leaves and loop occurrences.
 */
export function projectObjectiveStrategy(projection: ObjectiveProjection): ObjectiveStrategyProjection {
  const plan = projection.planRevisions.find((candidate) => candidate.planRevision === projection.planRevision)
    ?? [...projection.planRevisions].sort((left, right) => right.planRevision - left.planRevision)[0];
  if (!plan && !projection.control) {
    return {
      kind: "legacy-null",
      runId: projection.runId,
      detail: "The daemon did not return an immutable plan revision for this objective.",
    };
  }

  const packets = new Map(projection.packets.map((packet) => [packet.id, packet]));
  const roots = projection.control
    ? projectControlRoots(projection.control)
    : plan!.tasks.map((record) => objectiveTaskStrategyNode(
      record.task.id,
      record.task.objective,
      record.task.model,
      record.task.harness,
      record.task.requiresApproval,
      packets.get(record.task.id),
    ));
  const mutations = [...projection.planRevisions]
    .sort((left, right) => left.planRevision - right.planRevision || left.createdAt.localeCompare(right.createdAt))
    .map((revision) => ({
      id: revision.id,
      revision: revision.planRevision,
      kind: "plan-revision",
      summary: `Plan revision ${revision.planRevision}`,
      createdAt: revision.createdAt,
      actor: revision.createdBy.id || revision.createdBy.type || null,
    }));

  return {
    kind: "ready",
    objectiveId: projection.objectiveId,
    runId: projection.runId,
    revision: projection.control?.revision.revision ?? plan!.planRevision,
    source: projection.control ? controlSource(projection.control) : {
      kind: "workflow-revision",
      id: `${plan!.workflowId}@${plan!.workflowRevision}`,
      revision: plan!.workflowRevision,
      hash: plan!.workflowHash,
    },
    roots,
    frontierIds: projection.control
      ? projection.control.snapshot.frontier.flatMap((execution) => [execution.nodeId, `${execution.nodeId}@${execution.iterationKey}`])
      : projection.frontier.flatMap((task) => [task.id, ...(task.attemptId ? [task.attemptId] : [])]),
    mutations,
    updatedAt: projection.control?.snapshot.createdAt ?? plan!.createdAt,
  };
}

function controlSource(control: ObjectiveControlProjection): ObjectiveStrategySource {
  const source = control.revision.source;
  if (source.kind === "workflow-revision") {
    return {
      kind: "workflow-revision",
      id: `${source.workflowId}@${source.workflowRevision}`,
      revision: source.workflowRevision,
      hash: source.workflowHash,
    };
  }
  return { kind: "unknown", id: control.revision.planId, revision: null, hash: control.revision.hash };
}

function projectControlRoots(control: ObjectiveControlProjection): ObjectiveStrategyNode[] {
  const plan = control.revision.plan;
  const snapshot = control.snapshot;
  const executions = new Map(snapshot.executions.map((execution) => [executionId(execution.key), execution]));
  const nodeStates = snapshot.nodeStates;
  const branches = snapshot.branches;

  const project = (node: ControlNode, execution: ControlExecutionKey): ObjectiveStrategyNode => {
    const id = executionId(execution);
    const record = executions.get(id);
    const base = {
      id: node.id,
      label: node.label ?? node.id,
      state: strategyControlState(record?.state ?? nodeStates[id] ?? nodeStates[node.id]),
      executionKey: record ? id : null,
      iterationPath: parseIterationPath(execution.iterationKey),
    };
    if (node.type === "agent") return { ...base, kind: "agent", objective: node.objective, agentId: record?.agentId ?? null, harness: node.harness, model: node.model, attempt: record?.attemptId ? 1 : 0, maxAttempts: null, error: record?.error ?? null };
    if (node.type === "set") return { ...base, kind: "set", valueSummary: record?.output === null || record?.output === undefined ? null : summarizeJson(record.output) };
    if (node.type === "evaluate") {
      const output = evaluationOutput(record?.output);
      return {
        ...base,
        kind: "evaluate",
        metric: node.metric ?? node.path,
        path: node.path,
        operator: node.operator ?? node.op ?? "eq",
        target: output?.target ?? node.target ?? null,
        actual: output?.actual ?? null,
        pass: output?.pass ?? null,
        iterationContext: execution.iterationKey,
      };
    }
    if (node.type === "timer") {
      const suspension = record?.suspension?.kind === "timer" ? record.suspension : null;
      return {
        ...base,
        kind: "timer",
        durationMs: node.durationMs,
        since: suspension?.since ?? null,
        dueAt: suspension?.dueAt ?? null,
        expiresAt: suspension?.expiresAt ?? null,
        suspensionStatus: suspension?.status ?? null,
      };
    }
    if (node.type === "signal") {
      const suspension = record?.suspension?.kind === "signal" ? record.suspension : null;
      return {
        ...base,
        kind: "signal",
        signalKey: node.signalKey,
        subscriptionKey: suspension?.subscriptionKey ?? null,
        since: suspension?.since ?? null,
        expiresAt: suspension?.expiresAt ?? null,
        suspensionStatus: suspension?.status ?? null,
      };
    }
    if (node.type === "if") {
      const branch = branches[id] ?? null;
      return {
        ...base,
        kind: "if",
        condition: formatCondition(node.condition),
        selectedBranch: branch,
        then: node.then.map((child) => project(child, branchChildExecution(execution, branch ?? "then", child.id))),
        else: node.else?.map((child) => project(child, "else" === branch ? branchChildExecution(execution, "else", child.id) : branchChildExecution(execution, "else", child.id))) ?? [],
      };
    }
    if (node.type === "while") {
      const iteration = snapshot.loopIterations[id] ?? maxRecordedIteration(executions, execution, node.id);
      const body: ObjectiveStrategyNode[] = [];
      for (let index = 1; index <= iteration; index += 1) {
        for (const child of node.steps) body.push(project(child, loopChildExecution(execution, index, child.id)));
      }
      return { ...base, kind: "while", condition: formatCondition(node.condition), iteration, maxIterations: node.maxIterations, exitReason: snapshot.exitReasons[id] ?? null, body };
    }
    if (node.type === "sequence" || node.type === "parallel") {
      const children = node.steps.map((child) => project(child, childExecution(execution, child.id)));
      return { ...base, kind: node.type, children };
    }
    throw new Error("Unsupported objective control node");
  };

  return plan.root.type === "sequence" ? plan.root.steps.map((child) => project(child, childExecution({ nodeId: plan.root.id, iterationKey: "root" }, child.id))) : [project(plan.root, { nodeId: plan.root.id, iterationKey: "root" })];

  type ControlNode = ObjectiveControlProjection["revision"]["plan"]["root"];
  type ControlExecutionKey = { nodeId: string; iterationKey: string };
  function executionId(key: ControlExecutionKey): string { return `${key.nodeId}@${key.iterationKey}`; }
  function childExecution(parent: ControlExecutionKey, childId: string): ControlExecutionKey { return { nodeId: childId, iterationKey: `${parent.iterationKey}/${parent.nodeId}/${childId}` }; }
  function branchChildExecution(parent: ControlExecutionKey, branch: "then" | "else", childId: string): ControlExecutionKey { return { nodeId: childId, iterationKey: `${parent.iterationKey}/${parent.nodeId}/${branch}/${childId}` }; }
  function loopChildExecution(parent: ControlExecutionKey, iteration: number, childId: string): ControlExecutionKey { return { nodeId: childId, iterationKey: `${parent.iterationKey}/${parent.nodeId}/iteration-${iteration}/${childId}` }; }
  function maxRecordedIteration(entries: ReadonlyMap<string, { key: ControlExecutionKey }>, parent: ControlExecutionKey, nodeId: string): number {
    const prefix = `${parent.iterationKey}/${parent.nodeId}/iteration-`;
    let result = 0;
    for (const entry of entries.values()) {
      if (entry.key.nodeId !== nodeId || !entry.key.iterationKey.startsWith(prefix)) continue;
      const value = Number(entry.key.iterationKey.slice(prefix.length).split("/", 1)[0]);
      if (Number.isInteger(value)) result = Math.max(result, value);
    }
    return result;
  }
  function parseIterationPath(path: string): number[] {
    return [...path.matchAll(/(?:^|\/)iteration-(\d+)(?:\/|$)/gu)].map((match) => Number(match[1])).filter(Number.isInteger);
  }
  function strategyControlState(state: string | undefined): ObjectiveStrategyStatus {
    if (state === "running") return "active";
    if (state === "completed") return "completed";
    if (state === "failed") return "failed";
    if (state === "blocked") return "blocked";
    if (state === "waiting") return "waiting";
    if (state === "skipped") return "skipped";
    if (state === "cancelled") return "cancelled";
    if (state === "expired") return "expired";
    return "undecided";
  }
  function evaluationOutput(value: JsonValue | null | undefined): { actual: JsonValue | null; target: JsonValue | null; pass: boolean } | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const output = value as Record<string, JsonValue>;
    return typeof output.pass === "boolean" ? { actual: output.actual ?? null, target: output.target ?? null, pass: output.pass } : null;
  }
  function summarizeJson(value: JsonValue): string { return typeof value === "string" ? value : JSON.stringify(value); }
  function formatCondition(value: { path: string; op: string; value?: JsonValue }): string { return `${value.path} ${value.op}${value.value === undefined ? "" : ` ${summarizeJson(value.value)}`}`; }
}

function objectiveTaskStrategyNode(
  id: string,
  objective: string,
  requestedModel: string,
  requestedHarness: string,
  requiresApproval: boolean,
  packet?: ObjectiveTaskProjection,
): ObjectiveStrategyAgentNode {
  const state = strategyTaskState(packet?.state ?? "queued");
  return {
    kind: "agent",
    id,
    label: objective,
    state,
    executionKey: packet?.attemptId ?? id,
    objective,
    agentId: packet?.agentId ?? null,
    harness: packet?.agent?.harness ?? requestedHarness,
    model: packet?.agent?.model ?? requestedModel,
    attempt: packet?.attemptId ? 1 : 0,
    maxAttempts: null,
    error: packet?.error ?? (requiresApproval && packet?.state === "waiting-approval" ? "Approval required" : null),
  };
}

function strategyTaskState(state: ObjectiveTaskProjection["state"]): ObjectiveStrategyStatus {
  if (state === "running") return "active";
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "blocked") return "blocked";
  if (state === "waiting-approval") return "waiting";
  if (state === "superseded") return "skipped";
  return "idle";
}

export type ObjectiveStrategyRow = {
  /** Unique rendering identity; node IDs can repeat across loop iterations. */
  key: string;
  id: string;
  label: string;
  kind: ObjectiveStrategyNode["kind"];
  state: ObjectiveStrategyStatus;
  depth: number;
  frontier: boolean;
  parentId: string | null;
  branch: "then" | "else" | null;
  iteration: number | null;
  executionKey: string | null;
  iterationPath: readonly number[];
};

export type ObjectiveStrategyViewModel = {
  kind: "ready";
  projection: ObjectiveStrategyReadyProjection;
  rows: ObjectiveStrategyRow[];
  counts: {
    total: number;
    active: number;
    completed: number;
    attention: number;
    frontier: number;
  };
  frontier: ObjectiveStrategyRow[];
  mutations: ObjectiveStrategyMutation[];
};

export function buildObjectiveStrategyViewModel(
  projection: ObjectiveStrategyProjection,
): ObjectiveStrategyViewModel | Exclude<ObjectiveStrategyProjection, ObjectiveStrategyReadyProjection> {
  if (projection.kind !== "ready") return projection;

  const frontierIds = new Set(projection.frontierIds);
  const rows: ObjectiveStrategyRow[] = [];

  const visit = (
    nodes: readonly ObjectiveStrategyNode[],
    depth: number,
    parentId: string | null,
    branch: "then" | "else" | null,
    iteration: number | null,
  ) => {
    for (const node of nodes) {
      rows.push({
        key: strategyExecutionKey(node),
        id: node.id,
        label: node.label,
        kind: node.kind,
        state: node.state,
        depth,
        frontier: frontierIds.has(node.id) || frontierIds.has(strategyExecutionKey(node)),
        parentId,
        branch,
        iteration: node.kind === "while" ? node.iteration : iteration,
        executionKey: node.executionKey ?? null,
        iterationPath: node.iterationPath ? [...node.iterationPath] : [],
      });

      if (node.kind === "sequence" || node.kind === "parallel") visit(node.children, depth + 1, node.id, branch, iteration);
      if (node.kind === "if") {
        visit(node.then, depth + 1, node.id, "then", iteration);
        visit(node.else, depth + 1, node.id, "else", iteration);
      }
      if (node.kind === "while") visit(node.body, depth + 1, node.id, branch, node.iteration);
    }
  };

  visit(projection.roots, 0, null, null, null);

  return {
    kind: "ready",
    projection,
    rows,
    counts: {
      total: rows.length,
      active: rows.filter((row) => row.state === "active").length,
      completed: rows.filter((row) => row.state === "completed").length,
      attention: rows.filter((row) => row.state === "failed" || row.state === "blocked" || row.state === "waiting").length,
      frontier: rows.filter((row) => row.frontier).length,
    },
    frontier: rows.filter((row) => row.frontier),
    mutations: [...projection.mutations].sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt)),
  };
}

export function strategyStatusLabel(status: ObjectiveStrategyStatus): string {
  return status === "idle" ? "ready" : status;
}

/**
 * Build a stable identity for one runtime occurrence. This lets a loop show
 * repeated agent executions without forcing consumers to invent React keys.
 */
export function strategyExecutionKey(node: Pick<ObjectiveStrategyNode, "id" | "executionKey" | "iterationPath">): string {
  if (node.executionKey) return node.executionKey;
  if (node.iterationPath && node.iterationPath.length > 0) return `${node.id}@${node.iterationPath.join(".")}`;
  return node.id;
}
