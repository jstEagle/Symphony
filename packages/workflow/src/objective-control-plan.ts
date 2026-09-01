import { createHash } from "node:crypto";
import {
  JsonValueSchema,
  ObjectiveControlPlanRevisionSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlPlanSnapshotSchema,
  ObjectiveControlContextRefSchema,
  ObjectiveControlEvidenceSchema,
  ObjectiveControlEvaluationOperatorSchema,
  ObjectiveControlEvaluationSchema,
  objectiveControlExecutionId,
  type JsonValue,
  type ObjectiveControlActor,
  type ObjectiveControlAgentNode,
  type ObjectiveControlBranch,
  type ObjectiveControlContextRef,
  type ObjectiveControlCondition,
  type ObjectiveControlEvaluateNode,
  type ObjectiveControlEvaluation,
  type ObjectiveControlEvaluationOperator,
  type ObjectiveControlExecutionKey,
  type ObjectiveControlExecutionRecord,
  type ObjectiveControlExitReason,
  type ObjectiveControlIfNode,
  type ObjectiveControlLimits,
  type ObjectiveControlNode,
  type ObjectiveControlNodeState,
  type ObjectiveControlParallelNode,
  type ObjectiveControlFanoutNode,
  type ObjectiveControlPlan,
  type ObjectiveControlPlanRevision,
  type ObjectiveControlPlanSnapshot,
  type ObjectiveControlSequenceNode,
  type ObjectiveControlSetNode,
  type ObjectiveControlWhileNode,
  type ObjectiveControlTimerNode,
  type ObjectiveControlSignalNode,
  ObjectiveControlSignalDeliveryInputSchema,
  ObjectiveControlSuspensionRecordSchema,
  objectiveControlSubscriptionKey,
  ObjectiveControlFanoutValueSchema,
  type ObjectiveControlFanoutValue,
  type ObjectiveControlFanoutScope,
  type WorkflowFanoutAggregation,
  type ObjectiveControlSignalDeliveryInput,
  type ObjectiveControlSignalSuspension,
  type ObjectiveControlTimerSuspension,
  type ObjectiveControlSuspensionRecord,
  type ObjectiveValueCharter,
} from "@symphony/protocol";
import { z } from "zod";
import { bindObjectiveValueCharterToPlan } from "./objective-values.js";
import type {
  AgentStep,
  Condition,
  WorkflowDefinition,
  WorkflowIr,
  WorkflowStep,
} from "./index.js";

/**
 * The control plan is a data-only execution tree. This module is deliberately
 * free of coordinator/store/driver imports: compiling, deriving an intent,
 * and applying an acknowledgement are all pure operations over durable data.
 */

export const OBJECTIVE_CONTROL_ROOT_ID = "root-control";

type WorkflowInput = WorkflowIr | WorkflowDefinition;

export type ObjectiveControlCompilerOptions = Readonly<{
  planId?: string;
  workflowRevision?: number;
  workflowHash?: string;
  defaultMaxLoopIterations?: number;
  limits?: Partial<ObjectiveControlLimits>;
}>;

const DEFAULT_LIMITS: ObjectiveControlLimits = {
  maxNodes: null,
  maxDepth: null,
  maxLoopIterations: null,
  maxConcurrentAgents: null,
};

function isWorkflowIr(value: WorkflowInput): value is WorkflowIr {
  return "definition" in value && "revision" in value && "hash" in value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function objectiveControlPlanHash(plan: ObjectiveControlPlan): string {
  return sha256(plan);
}

function normalizeLimits(options: ObjectiveControlCompilerOptions): ObjectiveControlLimits {
  return {
    ...DEFAULT_LIMITS,
    ...(options.limits ?? {}),
  };
}

function condition(condition: Condition): ObjectiveControlCondition {
  return {
    path: condition.path,
    op: condition.op,
    ...(condition.value === undefined ? {} : { value: condition.value }),
    ...(condition.default === undefined ? {} : { default: condition.default }),
  };
}

function evaluationOperator(node: Pick<ObjectiveControlEvaluateNode, "operator" | "op">): ObjectiveControlEvaluationOperator {
  const operator = node.operator ?? node.op;
  if (!operator) throw new Error("Evaluation node requires an operator.");
  return operator;
}

function mapAgent(step: AgentStep, sourcePath: string): ObjectiveControlAgentNode {
  return {
    id: step.id,
    sourceNodeId: step.id,
    sourcePath,
    dependsOn: [...(step.dependsOn ?? [])],
    label: step.id,
    type: "agent",
    objective: step.objective,
    model: step.model ?? "auto",
    harness: step.harness ?? "auto",
    ...(step.permissions === undefined ? {} : { permissions: step.permissions }),
    outputSchema: step.outputSchema,
    inputs: [],
    ...(step.routing === undefined ? {} : { routing: step.routing }),
    ...(step.workspace === undefined ? {} : { workspace: step.workspace }),
    ...(step.capabilityExecution === undefined ? {} : { capabilityExecution: step.capabilityExecution }),
    requiresApproval: false,
  };
}

type ParentRelation = Readonly<{
  parentId: string;
  kind: "sequence" | "parallel" | "if" | "while" | "fanout";
}>;

function mapStep(
  step: WorkflowStep,
  sourcePath: string,
  options: ObjectiveControlCompilerOptions,
  relations: Map<string, ParentRelation>,
  seen: Set<string>,
): ObjectiveControlNode {
  if (seen.has(step.id)) throw new Error(`Duplicate objective control node id: ${step.id}`);
  if (step.id === OBJECTIVE_CONTROL_ROOT_ID) throw new Error(`Workflow step id is reserved: ${OBJECTIVE_CONTROL_ROOT_ID}`);
  seen.add(step.id);

  const base = {
    id: step.id,
    sourceNodeId: step.id,
    sourcePath,
    dependsOn: [...(step.dependsOn ?? [])],
    label: step.id,
  };

  if (step.type === "agent") return mapAgent(step, sourcePath);
  if (step.type === "set") return { ...base, type: "set", value: step.value } satisfies ObjectiveControlSetNode;
  if (step.type === "evaluate") {
    return {
      ...base,
      type: "evaluate",
      ...(step.metric === undefined ? {} : { metric: step.metric }),
      path: step.path,
      operator: evaluationOperator(step),
      ...(step.target === undefined ? {} : { target: step.target }),
      ...(step.default === undefined ? {} : { default: step.default }),
    } satisfies ObjectiveControlEvaluateNode;
  }
  if (step.type === "timer") {
    return {
      ...base,
      type: "timer",
      durationMs: step.durationMs,
      expiresAfterMs: step.expiresAfterMs ?? null,
    } satisfies ObjectiveControlTimerNode;
  }
  if (step.type === "signal") {
    return {
      ...base,
      type: "signal",
      signalKey: step.signalKey,
      expiresAfterMs: step.expiresAfterMs ?? null,
      payloadSchema: step.payloadSchema ?? {},
    } satisfies ObjectiveControlSignalNode;
  }

  if (step.type === "sequence" || step.type === "parallel") {
    const children = step.steps.map((child, index) => {
      relations.set(child.id, { parentId: step.id, kind: step.type });
      return mapStep(child, `${sourcePath}.steps.${index}`, options, relations, seen);
    });
    return { ...base, type: step.type, steps: children } as ObjectiveControlSequenceNode | ObjectiveControlParallelNode;
  }

  if (step.type === "fanout") {
    // Keep the blueprint identity scoped to the fan-out. It must not collide
    // with sibling workflow step IDs, nor be counted as a materialized
    // execution before the source collection is resolved by the executor.
    const template = mapStep(
      step.itemTemplate,
      `${sourcePath}.itemTemplate`,
      options,
      new Map(relations),
      new Set(),
    );
    return {
      ...base,
      type: "fanout",
      source: step.source,
      itemTemplate: template,
      concurrency: step.concurrency ?? null,
      ...(step.aggregation === undefined ? {} : { aggregation: step.aggregation }),
    } satisfies ObjectiveControlFanoutNode;
  }

  if (step.type === "if") {
    const then = step.then.map((child, index) => {
      relations.set(child.id, { parentId: step.id, kind: "if" });
      return mapStep(child, `${sourcePath}.then.${index}`, options, relations, seen);
    });
    const otherwise = step.else?.map((child, index) => {
      relations.set(child.id, { parentId: step.id, kind: "if" });
      return mapStep(child, `${sourcePath}.else.${index}`, options, relations, seen);
    });
    return {
      ...base,
      type: "if",
      condition: condition(step.condition),
      then,
      ...(otherwise === undefined ? {} : { else: otherwise }),
    } satisfies ObjectiveControlIfNode;
  }

  const maxIterations = step.maxIterations ?? options.defaultMaxLoopIterations;
  if (maxIterations === undefined) {
    throw new Error(`Workflow loop ${step.id} omits maxIterations; pass the configured defaultMaxLoopIterations explicitly.`);
  }
  if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
    throw new Error(`Workflow loop ${step.id} must have a positive maxIterations bound.`);
  }
  const body = step.steps.map((child, index) => {
    relations.set(child.id, { parentId: step.id, kind: "while" });
    return mapStep(child, `${sourcePath}.steps.${index}`, options, relations, seen);
  });
  return {
    ...base,
    type: "while",
    condition: condition(step.condition),
    steps: body,
    maxIterations,
  } satisfies ObjectiveControlWhileNode;
}

function definitionAndPin(input: WorkflowInput, options: ObjectiveControlCompilerOptions): {
  definition: WorkflowDefinition;
  revision: number;
  workflowHash: string;
} {
  if (isWorkflowIr(input)) {
    return { definition: input.definition, revision: input.revision, workflowHash: input.hash };
  }
  return {
    definition: input,
    revision: options.workflowRevision ?? 1,
    workflowHash: options.workflowHash ?? sha256(input),
  };
}

/** Compile a saved WorkflowDefinition/WorkflowIr into one pinned tree. */
export function compileObjectiveControlPlan(
  input: WorkflowInput,
  options: ObjectiveControlCompilerOptions = {},
): ObjectiveControlPlan {
  const { definition, revision, workflowHash } = definitionAndPin(input, options);
  const relations = new Map<string, ParentRelation>();
  const seen = new Set<string>();
  const steps = definition.steps.map((step, index) => {
    relations.set(step.id, { parentId: OBJECTIVE_CONTROL_ROOT_ID, kind: "sequence" });
    return mapStep(step, `steps.${index}`, options, relations, seen);
  });
  const plan: ObjectiveControlPlan = {
    version: 1,
    id: options.planId ?? `objective-control:${definition.id}@${revision}`,
    source: {
      kind: "workflow-revision",
      workflowId: definition.id,
      workflowRevision: revision,
      workflowHash,
    },
    root: {
      id: OBJECTIVE_CONTROL_ROOT_ID,
      sourceNodeId: OBJECTIVE_CONTROL_ROOT_ID,
      sourcePath: "root",
      dependsOn: [],
      label: definition.name,
      type: "sequence",
      steps,
    },
    limits: normalizeLimits(options),
  };
  // This makes compiler output carry protocol defaults/graph validation even
  // though callers may have supplied an unparsed WorkflowIr from SQLite.
  return ObjectiveControlPlanSchema.parse(plan);
}

export class ObjectiveControlPlanCompiler {
  compile(input: WorkflowInput, options: ObjectiveControlCompilerOptions = {}): ObjectiveControlPlan {
    return compileObjectiveControlPlan(input, options);
  }
}

export type ObjectiveControlPlanPinOptions = Readonly<{
  objectiveId: string;
  runId: string;
  revision?: number;
  createdBy: ObjectiveControlActor;
  requestKey: string;
  createdAt: string;
  /** Optional objective charter inherited by this strategy revision. */
  valueCharter?: ObjectiveValueCharter | null;
}>;

/** Add the immutable revision envelope used by a durable plan repository. */
export function pinObjectiveControlPlan(
  plan: ObjectiveControlPlan,
  options: ObjectiveControlPlanPinOptions,
): ObjectiveControlPlanRevision {
  const revision = options.revision ?? 0;
  const boundPlan = bindObjectiveValueCharterToPlan(plan, options.valueCharter);
  return ObjectiveControlPlanRevisionSchema.parse({
    version: 1,
    planId: boundPlan.id,
    objectiveId: options.objectiveId,
    runId: options.runId,
    revision,
    source: boundPlan.source,
    plan: boundPlan,
    ...(boundPlan.valueCharterRevision === undefined ? {} : { valueCharterRevision: boundPlan.valueCharterRevision }),
    ...(boundPlan.valueCharterHash === undefined ? {} : { valueCharterHash: boundPlan.valueCharterHash }),
    hash: objectiveControlPlanHash(boundPlan),
    createdBy: options.createdBy,
    requestKey: options.requestKey,
    createdAt: options.createdAt,
  });
}

export type ObjectiveControlSnapshotOptions = Readonly<{
  objectiveId: string;
  runId: string;
  planRevision?: number;
  eventCursor?: number;
  sequence?: number;
  /** Durable references to the objective's initial input/context. */
  contextRefs?: readonly ObjectiveControlContextRef[];
  /** Durable objective context available to data-only conditions/evaluations. */
  context?: Readonly<Record<string, JsonValue>>;
  createdAt: string;
}>;

function key(nodeId: string, iterationKey: string): ObjectiveControlExecutionKey {
  return { nodeId, iterationKey };
}

function emptyExecution(
  executionKey: ObjectiveControlExecutionKey,
  state: ObjectiveControlNodeState = "queued",
  fanoutScope?: ObjectiveControlFanoutScope,
): ObjectiveControlExecutionRecord {
  return {
    key: executionKey,
    state,
    attemptId: null,
    agentId: null,
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    contextRefs: [],
    ...(fanoutScope === undefined ? {} : { fanoutScope }),
  };
}

/** Deterministic initial projection; no timer, store, or process state. */
export function createObjectiveControlSnapshot(
  plan: ObjectiveControlPlan,
  options: ObjectiveControlSnapshotOptions,
): ObjectiveControlPlanSnapshot {
  const rootKey = key(plan.root.id, "root");
  const rootId = objectiveControlExecutionId(rootKey);
  return ObjectiveControlPlanSnapshotSchema.parse({
    version: 1,
    planId: plan.id,
    objectiveId: options.objectiveId,
    runId: options.runId,
    planRevision: options.planRevision ?? 0,
    sequence: options.sequence ?? 1,
    eventCursor: options.eventCursor ?? 0,
    nodeStates: { [rootId]: "queued" },
    frontier: [rootKey],
    branches: {},
    loopIterations: {},
    exitReasons: {},
    attemptIds: { [rootId]: null },
    executions: [emptyExecution(rootKey)],
    context: options.context ?? {},
    contextRefs: options.contextRefs ?? [],
    reason: "Objective control plan initialized.",
    createdAt: options.createdAt,
  });
}

export type ObjectiveControlIntentBase = Readonly<{
  intentId: string;
  planId: string;
  objectiveId: string;
  runId: string;
  planRevision: number;
  expectedSequence: number;
  execution: ObjectiveControlExecutionKey;
  nodeId: string;
}>;

export type ObjectiveControlSequenceIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "sequence";
  node: ObjectiveControlSequenceNode;
  operation: "enter" | "join";
  children: ObjectiveControlExecutionKey[];
}>;
export type ObjectiveControlParallelIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "parallel";
  node: ObjectiveControlParallelNode;
  operation: "enter" | "join";
  children: ObjectiveControlExecutionKey[];
}>;
export type ObjectiveControlIfIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "if";
  node: ObjectiveControlIfNode;
  operation: "evaluate" | "join";
  condition: ObjectiveControlCondition;
  conditionValue: boolean | null;
  branch: ObjectiveControlBranch | null;
}>;
export type ObjectiveControlWhileIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "while";
  node: ObjectiveControlWhileNode;
  operation: "evaluate" | "bound-reached";
  condition: ObjectiveControlCondition;
  conditionValue: boolean | null;
  iteration: number;
}>;
export type ObjectiveControlSetIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "set";
  node: ObjectiveControlSetNode;
  operation: "apply";
  value: JsonValue;
}>;
export type ObjectiveControlEvaluateIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "evaluate";
  node: ObjectiveControlEvaluateNode;
  operation: "evaluate";
  metric: string;
  path: string;
  actual: JsonValue;
  target: JsonValue;
  operator: ObjectiveControlEvaluationOperator;
  pass: boolean;
  output: ObjectiveControlEvaluation;
}>;
export type ObjectiveControlFanoutIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "fanout";
  node: ObjectiveControlFanoutNode;
  operation: "materialize" | "join";
  source: string;
  sourceHash: string;
  items: ObjectiveControlFanoutValue[];
  concurrency: number | null;
  aggregation?: WorkflowFanoutAggregation | undefined;
}>;
export type ObjectiveControlAgentIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "agent";
  node: ObjectiveControlAgentNode;
  operation: "approval" | "dispatch" | "wait";
  attemptId: string;
  objective: string;
  model: string;
  harness: ObjectiveControlAgentNode["harness"];
  inputs: JsonValue[];
  approvalRequired: boolean;
}>;
export type ObjectiveControlJoinIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "join";
  node: ObjectiveControlSequenceNode | ObjectiveControlParallelNode | ObjectiveControlIfNode | ObjectiveControlWhileNode;
  children: ObjectiveControlExecutionKey[];
}>;
export type ObjectiveControlCompleteIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "complete";
  node: ObjectiveControlSequenceNode;
  operation: "finish";
  output: JsonValue;
}>;
export type ObjectiveControlWaitIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "wait";
  node: ObjectiveControlNode;
  operation: "await-agent";
  reason?: string;
  blockedBy?: string[];
}>;
export type ObjectiveControlTimerIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "timer";
  node: ObjectiveControlTimerNode;
  operation: "schedule" | "wait" | "due" | "expire";
  attemptId: string;
  since: string | null;
  dueAt: string | null;
  expiresAt: string | null;
}>;
export type ObjectiveControlSignalIntent = ObjectiveControlIntentBase & Readonly<{
  kind: "signal";
  node: ObjectiveControlSignalNode;
  operation: "subscribe" | "wait" | "deliver" | "expire";
  attemptId: string;
  since: string | null;
  expiresAt: string | null;
  signalKey: string;
  subscriptionKey: string | null;
}>;

export type ObjectiveControlIntent =
  | ObjectiveControlSequenceIntent
  | ObjectiveControlParallelIntent
  | ObjectiveControlIfIntent
  | ObjectiveControlWhileIntent
  | ObjectiveControlSetIntent
  | ObjectiveControlEvaluateIntent
  | ObjectiveControlFanoutIntent
  | ObjectiveControlAgentIntent
  | ObjectiveControlJoinIntent
  | ObjectiveControlCompleteIntent
  | ObjectiveControlWaitIntent
  | ObjectiveControlTimerIntent
  | ObjectiveControlSignalIntent;

export type ObjectiveControlAcknowledgementBase = Readonly<{
  intentId: string;
  requestKey: string;
  eventCursor?: number;
  reason?: string;
  evidence?: Readonly<{ eventCursor: number; eventIds?: readonly string[]; summary?: string }>;
  now?: string;
}>;

/** Validate acknowledgements at the reducer boundary before any projection mutation. */
export const ObjectiveControlAcknowledgementSchema = z.object({
  kind: z.enum(["sequence", "parallel", "if", "while", "set", "evaluate", "fanout", "agent", "join", "complete", "wait", "timer", "signal"]),
  intentId: z.string().min(1).max(2_048),
  requestKey: z.string().min(8).max(2_048),
  eventCursor: z.number().int().nonnegative().optional(),
  reason: z.string().max(2_000).optional(),
  evidence: ObjectiveControlEvidenceSchema.optional(),
  now: z.iso.datetime({ offset: true }).optional(),
  state: z.enum(["running", "completed", "failed", "cancelled", "expired"]).optional(),
  condition: z.boolean().optional(),
  output: JsonValueSchema.nullable().optional(),
  error: z.string().max(20_000).nullable().optional(),
  agentId: z.string().min(1).max(256).nullable().optional(),
  attemptId: z.string().min(1).max(2_048).optional(),
  approved: z.boolean().optional(),
  /** Deterministic evaluation result; direct fields keep the wire contract flat. */
  actual: JsonValueSchema.nullable().optional(),
  target: JsonValueSchema.nullable().optional(),
  operator: ObjectiveControlEvaluationOperatorSchema.optional(),
  pass: z.boolean().optional(),
  evaluation: ObjectiveControlEvaluationSchema.optional(),
  contextRefs: z.array(ObjectiveControlContextRefSchema).max(256).optional(),
  /** Daemon-owned suspension identity/evidence. */
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  signalKey: z.string().min(1).max(256).optional(),
  subscriptionKey: z.string().min(1).max(512).optional(),
  deliveryId: z.string().min(1).optional(),
  payload: JsonValueSchema.optional(),
  /** Echoed immutable materialization payload for a fan-out acknowledgement. */
  fanoutItems: z.array(ObjectiveControlFanoutValueSchema).max(1_024).optional(),
  sourceHash: z.string().min(8).max(256).optional(),
}).strict();
export type ObjectiveControlAcknowledgement = z.infer<typeof ObjectiveControlAcknowledgementSchema>;

/** Runtime parser for the flat, fully-materialized evaluation acknowledgement. */
export const ObjectiveControlEvaluateAcknowledgementSchema = ObjectiveControlAcknowledgementSchema.extend({
  kind: z.literal("evaluate"),
  actual: JsonValueSchema.nullable(),
  target: JsonValueSchema.nullable(),
  operator: ObjectiveControlEvaluationOperatorSchema,
  pass: z.boolean(),
}).strict();

/** Narrow wire acknowledgement for a deterministic evaluation execution. */
export type ObjectiveControlEvaluateAcknowledgement = ObjectiveControlAcknowledgement & Readonly<{
  kind: "evaluate";
  actual: JsonValue | null;
  target: JsonValue | null;
  operator: ObjectiveControlEvaluationOperator;
  pass: boolean;
  output?: JsonValue | null;
  evaluation?: ObjectiveControlEvaluation;
}>;

function snapshotExecutionMap(snapshot: ObjectiveControlPlanSnapshot): Map<string, ObjectiveControlExecutionRecord> {
  return new Map(snapshot.executions.map((execution) => [objectiveControlExecutionId(execution.key), execution]));
}

function nodeMap(plan: ObjectiveControlPlan): Map<string, ObjectiveControlNode> {
  const result = new Map<string, ObjectiveControlNode>();
  const visit = (node: ObjectiveControlNode): void => {
    if (result.has(node.id)) throw new Error(`Duplicate objective control node id ${node.id}`);
    result.set(node.id, node);
    if (node.type === "sequence" || node.type === "parallel" || node.type === "while") node.steps.forEach(visit);
    else if (node.type === "if") {
      node.then.forEach(visit);
      node.else?.forEach(visit);
    }
  };
  visit(plan.root);
  return result;
}

function findNodeInTree(root: ObjectiveControlNode, nodeId: string): ObjectiveControlNode | null {
  if (root.id === nodeId) return root;
  if (root.type === "sequence" || root.type === "parallel" || root.type === "while") {
    for (const child of root.steps) {
      const found = findNodeInTree(child, nodeId);
      if (found) return found;
    }
  } else if (root.type === "if") {
    for (const child of [...root.then, ...(root.else ?? [])]) {
      const found = findNodeInTree(child, nodeId);
      if (found) return found;
    }
  } else if (root.type === "fanout") {
    return findNodeInTree(root.itemTemplate, nodeId);
  }
  return null;
}

function fanoutTemplateNode(
  plan: ObjectiveControlPlan,
  scope: ObjectiveControlFanoutScope,
  snapshot: ObjectiveControlPlanSnapshot,
  trail: Set<string> = new Set(),
): ObjectiveControlNode | null {
  const fanoutExecutionId = objectiveControlExecutionId(scope.fanoutExecution);
  if (trail.has(fanoutExecutionId)) throw new Error(`Objective control fan-out scope cycle detected at ${fanoutExecutionId}`);
  const nextTrail = new Set(trail).add(fanoutExecutionId);
  const parentRecord = recordFor(snapshot, scope.fanoutExecution);
  const fanout = parentRecord?.fanoutScope
    ? fanoutTemplateNode(plan, parentRecord.fanoutScope, snapshot, nextTrail)
    : nodeMap(plan).get(scope.fanoutExecution.nodeId) ?? null;
  if (!fanout || fanout.type !== "fanout") return null;
  return findNodeInTree(fanout.itemTemplate, scope.templateNodeId);
}

function fanoutNodeForExecution(
  plan: ObjectiveControlPlan,
  execution: ObjectiveControlExecutionKey,
  snapshot: ObjectiveControlPlanSnapshot,
): ObjectiveControlFanoutNode | null {
  const record = recordFor(snapshot, execution);
  const node = record?.fanoutScope
    ? fanoutTemplateNode(plan, record.fanoutScope, snapshot)
    : nodeMap(plan).get(execution.nodeId);
  return node?.type === "fanout" ? node : null;
}

function nodeForExecution(
  plan: ObjectiveControlPlan,
  execution: ObjectiveControlExecutionKey,
  snapshot: ObjectiveControlPlanSnapshot,
): ObjectiveControlNode | undefined {
  const record = recordFor(snapshot, execution);
  if (record?.fanoutScope) {
    const templateNode = fanoutTemplateNode(plan, record.fanoutScope, snapshot);
    if (templateNode) return templateNode;
  }
  return nodeMap(plan).get(execution.nodeId);
}

function contextFromSnapshot(snapshot: ObjectiveControlPlanSnapshot, fanoutScope?: ObjectiveControlFanoutScope): JsonValue {
  const context: Record<string, JsonValue> = { ...(snapshot.context ?? {}) };
  const steps: Record<string, JsonValue> = {};
  for (const execution of snapshot.executions) {
    if (execution.output !== null && (execution.state === "completed" || execution.state === "skipped")) {
      // Later loop executions intentionally overwrite earlier values. Their
      // iteration path remains available in the execution record itself.
      steps[execution.key.nodeId] = execution.output;
    }
  }
  return fanoutScope
    ? { ...context, steps, item: fanoutScope.item, itemIndex: fanoutScope.itemIndex, itemKey: fanoutScope.itemKey }
    : { ...context, steps };
}

function getPath(root: JsonValue, rawPath: string): JsonValue | undefined {
  const path = rawPath.replace(/^\$\.?/u, "").split(".").filter(Boolean);
  let current: JsonValue | undefined = root;
  for (const part of path) {
    if (Array.isArray(current)) current = current[Number(part)];
    else if (current !== null && typeof current === "object") current = current[part];
    else return undefined;
  }
  return current;
}

function compareJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return stableJson(left) === stableJson(right);
}

export function evaluateObjectiveControlCondition(
  condition: ObjectiveControlCondition,
  snapshot: ObjectiveControlPlanSnapshot,
): boolean {
  const actual = getPath(contextFromSnapshot(snapshot), condition.path) ?? condition.default;
  if (condition.op === "exists") return actual !== undefined && actual !== null;
  if (condition.op === "eq") return compareJson(actual, condition.value);
  if (condition.op === "neq") return !compareJson(actual, condition.value);
  if (typeof actual !== "number" || typeof condition.value !== "number") return false;
  if (condition.op === "gt") return actual > condition.value;
  if (condition.op === "gte") return actual >= condition.value;
  if (condition.op === "lt") return actual < condition.value;
  return actual <= condition.value;
}

/** Resolve a declarative evaluation entirely from the immutable snapshot. */
export function evaluateObjectiveControlNode(
  node: ObjectiveControlEvaluateNode,
  snapshot: ObjectiveControlPlanSnapshot,
): ObjectiveControlEvaluation {
  const resolved = getPath(contextFromSnapshot(snapshot), node.path);
  const actual = resolved ?? node.default ?? null;
  const target = node.target ?? null;
  const operator = evaluationOperator(node);
  const pass = operator === "exists"
    ? actual !== undefined && actual !== null
    : operator === "eq"
      ? compareJson(actual, target)
      : operator === "neq"
        ? !compareJson(actual, target)
        : typeof actual === "number" && typeof target === "number"
          ? operator === "gt" ? actual > target
            : operator === "gte" ? actual >= target
              : operator === "lt" ? actual < target
                : actual <= target
          : false;
  return { actual, target, operator, pass };
}

function interpolate(value: JsonValue, snapshot: ObjectiveControlPlanSnapshot, fanoutScope?: ObjectiveControlFanoutScope): JsonValue {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_match, path: string) => {
      const resolved = getPath(contextFromSnapshot(snapshot, fanoutScope), path);
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved ?? null);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => interpolate(entry, snapshot, fanoutScope));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, interpolate(entry, snapshot, fanoutScope)]));
  }
  return value;
}

function findParentRelation(plan: ObjectiveControlPlan, childId: string): ParentRelation | null {
  let result: ParentRelation | null = null;
  const visit = (node: ObjectiveControlNode): void => {
    if (result) return;
    const children = node.type === "if" ? [...node.then, ...(node.else ?? [])]
      : node.type === "sequence" || node.type === "parallel" || node.type === "while" ? node.steps : [];
    if (children.some((child) => child.id === childId)) {
      const kind = node.type === "if" || node.type === "sequence" || node.type === "parallel" || node.type === "while"
        ? node.type
        : null;
      if (kind) result = { parentId: node.id, kind };
      return;
    }
    children.forEach(visit);
  };
  visit(plan.root);
  return result;
}

function findParentRelationInTree(root: ObjectiveControlNode, childId: string): ParentRelation | null {
  let result: ParentRelation | null = null;
  const visit = (node: ObjectiveControlNode): void => {
    if (result) return;
    const children = node.type === "if" ? [...node.then, ...(node.else ?? [])]
      : node.type === "sequence" || node.type === "parallel" || node.type === "while" ? node.steps : [];
    if (children.some((child) => child.id === childId)) {
      if (node.type === "if" || node.type === "sequence" || node.type === "parallel" || node.type === "while") {
        result = { parentId: node.id, kind: node.type };
      }
      return;
    }
    children.forEach(visit);
  };
  visit(root);
  return result;
}

function parentRelationFor(
  plan: ObjectiveControlPlan,
  execution: ObjectiveControlExecutionKey,
  snapshot?: ObjectiveControlPlanSnapshot,
): ParentRelation | null {
  const scope = snapshot ? recordFor(snapshot, execution)?.fanoutScope : undefined;
  if (!snapshot || !scope) return findParentRelation(plan, execution.nodeId);
  if (execution.nodeId === scope.templateNodeId) return { parentId: scope.fanoutExecution.nodeId, kind: "fanout" };
  const fanout = fanoutNodeForExecution(plan, scope.fanoutExecution, snapshot);
  if (!fanout) return null;
  return findParentRelationInTree(fanout.itemTemplate, execution.nodeId);
}

function parentExecutionFor(
  plan: ObjectiveControlPlan,
  execution: ObjectiveControlExecutionKey,
  snapshot?: ObjectiveControlPlanSnapshot,
): ObjectiveControlExecutionKey | null {
  if (execution.nodeId === plan.root.id) return null;
  const scope = snapshot ? recordFor(snapshot, execution)?.fanoutScope : undefined;
  const relation = parentRelationFor(plan, execution, snapshot);
  if (!relation) throw new Error(`Unknown control-node parent for ${execution.nodeId}`);
  if (relation.kind === "fanout") return scope?.fanoutExecution ?? null;
  const base = `/${relation.parentId}/`;
  if (relation.kind === "if") {
    for (const branch of ["then", "else"] as const) {
      const suffix = `${base}${branch}/${execution.nodeId}`;
      if (execution.iterationKey.endsWith(suffix)) {
        return key(relation.parentId, execution.iterationKey.slice(0, -suffix.length) || "root");
      }
    }
    return null;
  }
  if (relation.kind === "while") {
    const marker = `${base}iteration-`;
    const markerIndex = execution.iterationKey.lastIndexOf(marker);
    const suffix = `/${execution.nodeId}`;
    if (markerIndex >= 0 && execution.iterationKey.endsWith(suffix)) {
      return key(relation.parentId, execution.iterationKey.slice(0, markerIndex) || "root");
    }
    return null;
  }
  const suffix = `${base}${execution.nodeId}`;
  if (!execution.iterationKey.endsWith(suffix)) return null;
  return key(relation.parentId, execution.iterationKey.slice(0, -suffix.length) || "root");
}

function childKey(parent: ObjectiveControlExecutionKey, childId: string): ObjectiveControlExecutionKey {
  return key(childId, `${parent.iterationKey}/${parent.nodeId}/${childId}`);
}

function branchChildKey(parent: ObjectiveControlExecutionKey, branch: ObjectiveControlBranch, childId: string): ObjectiveControlExecutionKey {
  return key(childId, `${parent.iterationKey}/${parent.nodeId}/${branch}/${childId}`);
}

function loopChildKey(parent: ObjectiveControlExecutionKey, iteration: number, childId: string): ObjectiveControlExecutionKey {
  return key(childId, `${parent.iterationKey}/${parent.nodeId}/iteration-${iteration}/${childId}`);
}

function recordFor(snapshot: ObjectiveControlPlanSnapshot, execution: ObjectiveControlExecutionKey): ObjectiveControlExecutionRecord | undefined {
  const id = objectiveControlExecutionId(execution);
  return snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === id);
}

function activeFrontier(snapshot: ObjectiveControlPlanSnapshot): ObjectiveControlExecutionKey[] {
  const active = snapshot.frontier.filter((execution) => {
    const record = recordFor(snapshot, execution);
    return record && !isTerminal(record.state);
  });
  // Parallel expansion persists all children at once. Always dispatch queued
  // siblings before waiting on a running one, otherwise the first child can
  // monopolize the frontier and the remaining children never launch.
  return active.sort((left, right) => {
    const leftState = recordFor(snapshot, left)?.state;
    const rightState = recordFor(snapshot, right)?.state;
    const rank = (state: ObjectiveControlNodeState | undefined): number => state === "queued" ? 0 : state === "waiting" ? 1 : 2;
    return rank(leftState) - rank(rightState);
  });
}

function hasApproval(snapshot: ObjectiveControlPlanSnapshot, execution: ObjectiveControlExecutionKey): boolean {
  return snapshot.contextRefs.some((ref) => ref.kind === "event" && ref.id === `control-approval:${objectiveControlExecutionId(execution)}`);
}

function dependencyExecutionKeys(
  plan: ObjectiveControlPlan,
  execution: ObjectiveControlExecutionKey,
  dependencyId: string,
  snapshot: ObjectiveControlPlanSnapshot,
): ObjectiveControlExecutionKey[] {
  const parent = parentExecutionFor(plan, execution, snapshot);
  if (!parent) return dependencyId === plan.root.id ? [key(plan.root.id, "root")] : [];
  if (dependencyId === parent.nodeId) return [parent];
  const parentNode = nodeForExecution(plan, parent, snapshot);
  if (!parentNode) return [];
  if (parentNode.type === "sequence" || parentNode.type === "parallel") {
    if (parentNode.steps.some((child) => child.id === dependencyId)) return [childKey(parent, dependencyId)];
  } else if (parentNode.type === "if") {
    const branch = snapshot.branches[objectiveControlExecutionId(parent)];
    const branchSteps = branch === "then" ? parentNode.then : branch === "else" ? parentNode.else ?? [] : [];
    if (branchSteps.some((child) => child.id === dependencyId) && branch) return [branchChildKey(parent, branch, dependencyId)];
  } else if (parentNode.type === "while") {
    const iteration = currentLoopIteration(parentNode, parent, snapshot);
    if (iteration > 0 && parentNode.steps.some((child) => child.id === dependencyId)) return [loopChildKey(parent, iteration, dependencyId)];
  }
  // A conductor-authored node may depend on a node in another control scope.
  // Only concrete executions are eligible; never treat a source node id as a
  // durable execution identity.
  return snapshot.executions.filter((entry) => entry.key.nodeId === dependencyId).map((entry) => entry.key);
}

function pendingDependencies(
  plan: ObjectiveControlPlan,
  execution: ObjectiveControlExecutionKey,
  node: ObjectiveControlNode,
  snapshot: ObjectiveControlPlanSnapshot,
): string[] {
  const pending: string[] = [];
  for (const dependencyId of node.dependsOn) {
    const candidates = dependencyExecutionKeys(plan, execution, dependencyId, snapshot);
    if (!candidates.some((candidate) => isSuccess(recordFor(snapshot, candidate)?.state ?? "blocked"))) pending.push(dependencyId);
  }
  return pending;
}

function runningAgentCount(plan: ObjectiveControlPlan, snapshot: ObjectiveControlPlanSnapshot): number {
  return snapshot.executions.filter((entry) => {
    if (entry.state !== "running" && entry.state !== "waiting") return false;
    return nodeForExecution(plan, entry.key, snapshot)?.type === "agent";
  }).length;
}

function executionBlockReason(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  execution: ObjectiveControlExecutionKey,
  node: ObjectiveControlNode,
): { reason: string; blockedBy?: string[] } | null {
  const blockedBy = pendingDependencies(plan, execution, node, snapshot);
  if (blockedBy.length > 0) return { reason: "dependencies-pending", blockedBy };
  const record = recordFor(snapshot, execution);
  if (
    node.type === "agent"
    && record?.state === "queued"
    && plan.limits.maxConcurrentAgents !== null
    && runningAgentCount(plan, snapshot) >= plan.limits.maxConcurrentAgents
  ) {
    return { reason: "max-concurrent-agents" };
  }
  return null;
}

function isTerminal(state: ObjectiveControlNodeState): boolean {
  return state === "completed" || state === "failed" || state === "skipped" || state === "blocked" || state === "cancelled" || state === "expired";
}

function isSuccess(state: ObjectiveControlNodeState): boolean {
  return state === "completed" || state === "skipped";
}

function deriveIntentId(snapshot: ObjectiveControlPlanSnapshot, payload: unknown): string {
  return `objective-control:${sha256({
    planId: snapshot.planId,
    objectiveId: snapshot.objectiveId,
    runId: snapshot.runId,
    sequence: snapshot.sequence,
    payload,
  })}`;
}

function baseIntent(snapshot: ObjectiveControlPlanSnapshot, execution: ObjectiveControlExecutionKey, kind: string, payload: unknown): ObjectiveControlIntentBase {
  return {
    intentId: deriveIntentId(snapshot, { kind, execution, payload }),
    planId: snapshot.planId,
    objectiveId: snapshot.objectiveId,
    runId: snapshot.runId,
    planRevision: snapshot.planRevision,
    expectedSequence: snapshot.sequence,
    execution,
    nodeId: execution.nodeId,
  };
}

function childrenFor(
  node: ObjectiveControlNode,
  execution: ObjectiveControlExecutionKey,
  snapshot: ObjectiveControlPlanSnapshot,
): ObjectiveControlExecutionKey[] {
  if (node.type === "sequence" || node.type === "parallel") return node.steps.map((child) => childKey(execution, child.id));
  if (node.type === "if") {
    const branch = snapshot.branches[objectiveControlExecutionId(execution)];
    if (!branch) return [];
    return (branch === "then" ? node.then : node.else ?? []).map((child) => branchChildKey(execution, branch, child.id));
  }
  if (node.type === "while") {
    const iteration = currentLoopIteration(node, execution, snapshot);
    return iteration <= 0 ? [] : node.steps.map((child) => loopChildKey(execution, iteration, child.id));
  }
  return [];
}

/**
 * Older snapshots stored one counter per source node. Derive the counter from
 * the concrete execution path as well, so the same while node can safely be
 * reached again from an outer loop after a restart. The durable child paths
 * are the source of truth for repeated executions.
 */
function currentLoopIteration(
  node: ObjectiveControlWhileNode,
  execution: ObjectiveControlExecutionKey,
  snapshot: ObjectiveControlPlanSnapshot,
): number {
  const executionId = objectiveControlExecutionId(execution);
  let current = snapshot.loopIterations[executionId] ?? 0;
  const prefix = `${execution.iterationKey}/${execution.nodeId}/iteration-`;
  for (const entry of snapshot.executions) {
    if (!entry.key.iterationKey.startsWith(prefix)) continue;
    const raw = entry.key.iterationKey.slice(prefix.length).split("/", 1)[0];
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > current) current = parsed;
  }
  // Pre-execution snapshots from the first control-plan prototype used bare
  // node ids. Read that value only when this concrete execution already has
  // durable body history; it can repair an existing execution, but can never
  // seed a newly reached outer-loop execution. New writes are always scoped by
  // objectiveControlExecutionId(execution).
  if (current === 0 && snapshot.loopIterations[node.id] !== undefined) {
    const hasConcreteHistory = snapshot.executions.some((entry) => entry.key.iterationKey.startsWith(prefix));
    if (hasConcreteHistory) current = snapshot.loopIterations[node.id]!;
  }
  return current;
}

function firstMissingOrUnfinished(
  node: ObjectiveControlSequenceNode | ObjectiveControlIfNode | ObjectiveControlWhileNode,
  execution: ObjectiveControlExecutionKey,
  snapshot: ObjectiveControlPlanSnapshot,
): { key: ObjectiveControlExecutionKey; record?: ObjectiveControlExecutionRecord } | null {
  let children: ObjectiveControlExecutionKey[];
  if (node.type === "sequence") children = node.steps.map((child) => childKey(execution, child.id));
  else if (node.type === "if") {
    const branch = snapshot.branches[objectiveControlExecutionId(execution)];
    children = !branch ? [] : (branch === "then" ? node.then : node.else ?? []).map((child) => branchChildKey(execution, branch, child.id));
  } else {
    const iteration = currentLoopIteration(node, execution, snapshot);
    children = iteration <= 0 ? [] : node.steps.map((child) => loopChildKey(execution, iteration, child.id));
  }
  for (const child of children) {
    const record = recordFor(snapshot, child);
    if (!record || !isTerminal(record.state)) return { key: child, ...(record ? { record } : {}) };
  }
  return null;
}

function attemptIdFor(snapshot: ObjectiveControlPlanSnapshot, execution: ObjectiveControlExecutionKey): string {
  const id = objectiveControlExecutionId(execution);
  return snapshot.attemptIds[id] ?? `objective-attempt:${sha256({ runId: snapshot.runId, execution })}`;
}

function controlNow(snapshot: ObjectiveControlPlanSnapshot, now?: string): string {
  return now ?? snapshot.createdAt;
}

function suspensionFor(snapshot: ObjectiveControlPlanSnapshot, execution: ObjectiveControlExecutionKey): ObjectiveControlSuspensionRecord | null {
  return recordFor(snapshot, execution)?.suspension ?? null;
}

function timerIntent(
  snapshot: ObjectiveControlPlanSnapshot,
  execution: ObjectiveControlExecutionKey,
  node: ObjectiveControlTimerNode,
  now?: string,
): ObjectiveControlTimerIntent {
  const suspension = suspensionFor(snapshot, execution);
  const attemptId = suspension?.attemptId ?? attemptIdFor(snapshot, execution);
  const since = suspension?.since ?? null;
  const dueAt = suspension?.kind === "timer" ? suspension.dueAt : null;
  const expiresAt = suspension?.expiresAt ?? null;
  const current = Date.parse(controlNow(snapshot, now));
  const due = dueAt !== null && Date.parse(dueAt) <= current;
  const expired = expiresAt !== null && Date.parse(expiresAt) <= current && !due;
  const operation: ObjectiveControlTimerIntent["operation"] = suspension === null
    ? "schedule"
    : expired
      ? "expire"
      : due
        ? "due"
        : "wait";
  const base = baseIntent(snapshot, execution, "timer", { operation, attemptId, since, dueAt, expiresAt });
  return { ...base, kind: "timer", node, operation, attemptId, since, dueAt, expiresAt };
}

function signalIntent(
  snapshot: ObjectiveControlPlanSnapshot,
  execution: ObjectiveControlExecutionKey,
  node: ObjectiveControlSignalNode,
  now?: string,
): ObjectiveControlSignalIntent {
  const suspension = suspensionFor(snapshot, execution);
  const attemptId = suspension?.attemptId ?? attemptIdFor(snapshot, execution);
  const since = suspension?.since ?? null;
  const expiresAt = suspension?.expiresAt ?? null;
  const subscriptionKey = suspension?.kind === "signal"
    ? suspension.subscriptionKey
    : null;
  const expired = expiresAt !== null && Date.parse(expiresAt) <= Date.parse(controlNow(snapshot, now));
  const operation: ObjectiveControlSignalIntent["operation"] = suspension === null
    ? "subscribe"
    : expired
      ? "expire"
      : suspension.kind === "signal" && suspension.status === "ready"
        ? "deliver"
        : "wait";
  const base = baseIntent(snapshot, execution, "signal", { operation, attemptId, since, expiresAt, signalKey: node.signalKey, subscriptionKey });
  return { ...base, kind: "signal", node, operation, attemptId, since, expiresAt, signalKey: node.signalKey, subscriptionKey };
}

function fanoutItemKey(item: JsonValue, index: number, keyPath?: string): string {
  const explicit = keyPath === undefined ? undefined : getPath(item, keyPath);
  if (keyPath !== undefined && explicit === undefined) {
    throw new Error(`Objective fan-out item is missing key path ${keyPath} at index ${index}.`);
  }
  const candidate = explicit ?? (
    item !== null && typeof item === "object" && !Array.isArray(item)
      && (typeof item.id === "string" || typeof item.id === "number")
      ? item.id
      : undefined
  );
  if (typeof candidate === "string") return candidate;
  if (typeof candidate === "number" || typeof candidate === "boolean" || candidate === null) return String(candidate);
  if (candidate !== undefined) return stableJson(candidate);
  return createHash("sha256").update(stableJson(item)).digest("hex").slice(0, 24);
}

function resolveFanoutItems(
  node: ObjectiveControlFanoutNode,
  snapshot: ObjectiveControlPlanSnapshot,
  scope?: ObjectiveControlFanoutScope,
): ObjectiveControlFanoutValue[] {
  const source = getPath(contextFromSnapshot(snapshot, scope), node.source);
  if (!Array.isArray(source)) throw new Error(`Objective fan-out ${node.id} source ${node.source} must resolve to an array.`);
  // Snapshot execution/frontier caps are durable safety boundaries. Refuse an
  // expansion that cannot be represented atomically instead of partially
  // materializing work and leaving the objective unrecoverably stuck.
  if (source.length > 1_024) {
    throw new Error(`Objective fan-out ${node.id} has ${source.length} items; durable materialization is limited to 1024 items.`);
  }
  const seen = new Map<string, number>();
  return source.map((value, index) => {
    const baseKey = fanoutItemKey(value, index, node.aggregation?.keyPath);
    const count = (seen.get(baseKey) ?? 0) + 1;
    seen.set(baseKey, count);
    return { key: count === 1 ? baseKey : `${baseKey}#${count}`, index, value };
  });
}

function fanoutSourceHash(node: ObjectiveControlFanoutNode, items: readonly ObjectiveControlFanoutValue[]): string {
  return sha256({ nodeId: node.id, source: node.source, items });
}

function fanoutItemExecutionKey(
  fanoutExecution: ObjectiveControlExecutionKey,
  node: ObjectiveControlFanoutNode,
  item: ObjectiveControlFanoutValue,
): ObjectiveControlExecutionKey {
  return key(
    node.itemTemplate.id,
    `${fanoutExecution.iterationKey}/${fanoutExecution.nodeId}/item/${encodeURIComponent(item.key)}/${node.itemTemplate.id}`,
  );
}

function fanoutItemRecords(
  snapshot: ObjectiveControlPlanSnapshot,
  fanoutExecution: ObjectiveControlExecutionKey,
  node: ObjectiveControlFanoutNode,
): ObjectiveControlExecutionRecord[] {
  const fanoutId = objectiveControlExecutionId(fanoutExecution);
  return snapshot.executions
    .filter((entry) => entry.fanoutScope
      && objectiveControlExecutionId(entry.fanoutScope.fanoutExecution) === fanoutId
      && entry.fanoutScope.templateNodeId === node.itemTemplate.id
      && entry.key.nodeId === node.itemTemplate.id)
    .sort((left, right) => (left.fanoutScope?.itemIndex ?? 0) - (right.fanoutScope?.itemIndex ?? 0));
}

function aggregateObjectiveFanout(
  records: readonly ObjectiveControlExecutionRecord[],
  aggregation?: WorkflowFanoutAggregation,
): JsonValue {
  const mode = aggregation?.mode ?? "array";
  if (mode === "array") return records.map((record) => record.output);
  if (mode === "object") {
    const output: Record<string, JsonValue> = {};
    for (const record of records) {
      const itemKey = record.fanoutScope?.itemKey;
      if (!itemKey || Object.prototype.hasOwnProperty.call(output, itemKey)) throw new Error("Objective fan-out produced duplicate result key.");
      output[itemKey] = record.output;
    }
    return output;
  }
  const merged: Record<string, JsonValue> = {};
  records.forEach((record, index) => {
    if (record.output === null || typeof record.output !== "object" || Array.isArray(record.output)) {
      throw new Error(`Objective fan-out merge requires object output at index ${index}.`);
    }
    Object.assign(merged, record.output);
  });
  return merged;
}

function advanceFanoutFrontier(
  snapshot: ObjectiveControlPlanSnapshot,
  fanoutExecution: ObjectiveControlExecutionKey,
  node: ObjectiveControlFanoutNode,
): ObjectiveControlPlanSnapshot {
  const records = fanoutItemRecords(snapshot, fanoutExecution, node);
  const active = records.filter((record) => record.state === "running" || record.state === "waiting").length;
  const capacity = node.concurrency === null ? Number.POSITIVE_INFINITY : Math.max(0, node.concurrency - active);
  const queued = records.filter((record) => record.state === "queued").slice(0, capacity).map((record) => record.key);
  return { ...snapshot, frontier: addFrontier(snapshot.frontier, queued) };
}

function makeIntent(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  now?: string,
): ObjectiveControlIntent {
  const records = snapshotExecutionMap(snapshot);
  const frontier = activeFrontier(snapshot);
  const execution = frontier.find((candidate) => {
    const candidateNode = nodeForExecution(plan, candidate, snapshot);
    return candidateNode !== undefined && executionBlockReason(plan, snapshot, candidate, candidateNode) === null;
  }) ?? frontier[0];
  if (!execution) {
    const root = key(plan.root.id, "root");
    const rootRecord = records.get(objectiveControlExecutionId(root));
    if (rootRecord?.state === "completed") {
      const base = baseIntent(snapshot, root, "complete", { output: contextFromSnapshot(snapshot) });
      return { ...base, kind: "complete", node: plan.root as ObjectiveControlSequenceNode, operation: "finish", output: contextFromSnapshot(snapshot) };
    }
    const base = baseIntent(snapshot, root, "wait", { reason: "frontier-empty" });
    return { ...base, kind: "wait", node: plan.root, operation: "await-agent", reason: "frontier-empty" };
  }
  const record = records.get(objectiveControlExecutionId(execution));
  if (!record) throw new Error(`Control frontier references missing execution ${objectiveControlExecutionId(execution)}.`);
  const node = nodeForExecution(plan, execution, snapshot);
  if (!node) throw new Error(`Control execution references unknown node ${execution.nodeId}.`);
  const block = executionBlockReason(plan, snapshot, execution, node);
  if (block) {
    const base = baseIntent(snapshot, execution, "wait", block);
    return { ...base, kind: "wait", node, operation: "await-agent", reason: block.reason, ...(block.blockedBy ? { blockedBy: block.blockedBy } : {}) };
  }
  if (node.type === "timer") return timerIntent(snapshot, execution, node, now);
  if (node.type === "signal") return signalIntent(snapshot, execution, node, now);
  if (record.state === "running" || record.state === "waiting") {
    if (node.type === "agent") {
      const base = baseIntent(snapshot, execution, "agent", { operation: "wait", attemptId: attemptIdFor(snapshot, execution) });
      return { ...base, kind: "agent", node, operation: "wait", attemptId: attemptIdFor(snapshot, execution), objective: interpolate(node.objective, snapshot, record.fanoutScope) as string, model: node.model, harness: node.harness, inputs: interpolate(node.inputs, snapshot, record.fanoutScope) as JsonValue[], approvalRequired: node.requiresApproval };
    }
    if ((node.type === "sequence" || node.type === "parallel") && !firstMissingOrUnfinished(node as ObjectiveControlSequenceNode, execution, snapshot)) {
      const children = childrenFor(node, execution, snapshot);
      const base = baseIntent(snapshot, execution, "join", { children });
      return { ...base, kind: "join", node, children };
    }
    if (node.type === "if" && !firstMissingOrUnfinished(node, execution, snapshot)) {
      const children = childrenFor(node, execution, snapshot);
      const base = baseIntent(snapshot, execution, "join", { children });
      return { ...base, kind: "join", node, children };
    }
    if (node.type === "while" && !firstMissingOrUnfinished(node, execution, snapshot)) {
      const iteration = currentLoopIteration(node, execution, snapshot);
      const operation = iteration >= node.maxIterations ? "bound-reached" : "evaluate";
      const base = baseIntent(snapshot, execution, "while", { operation, iteration });
      return { ...base, kind: "while", node, operation, condition: node.condition, conditionValue: operation === "evaluate" ? evaluateObjectiveControlCondition(node.condition, snapshot) : null, iteration };
    }
  }
  if (node.type === "sequence") {
    const children = node.steps.map((child) => childKey(execution, child.id));
    const base = baseIntent(snapshot, execution, "sequence", { operation: "enter", children });
    return { ...base, kind: "sequence", node, operation: "enter", children };
  }
  if (node.type === "parallel") {
    const children = node.steps.map((child) => childKey(execution, child.id));
    const base = baseIntent(snapshot, execution, "parallel", { operation: "enter", children });
    return { ...base, kind: "parallel", node, operation: "enter", children };
  }
  if (node.type === "if") {
    const value = evaluateObjectiveControlCondition(node.condition, snapshot);
    const base = baseIntent(snapshot, execution, "if", { operation: "evaluate", value });
    return { ...base, kind: "if", node, operation: "evaluate", condition: node.condition, conditionValue: value, branch: null };
  }
  if (node.type === "while") {
    const iteration = currentLoopIteration(node, execution, snapshot);
    const operation = iteration >= node.maxIterations ? "bound-reached" : "evaluate";
    const value = operation === "evaluate" ? evaluateObjectiveControlCondition(node.condition, snapshot) : null;
    const base = baseIntent(snapshot, execution, "while", { operation, iteration, value });
    return { ...base, kind: "while", node, operation, condition: node.condition, conditionValue: value, iteration };
  }
  if (node.type === "evaluate") {
    const output = evaluateObjectiveControlNode(node, snapshot);
    const base = baseIntent(snapshot, execution, "evaluate", output);
    return {
      ...base,
      kind: "evaluate",
      node,
      operation: "evaluate",
      metric: node.metric ?? node.path,
      path: node.path,
      actual: output.actual,
      target: output.target,
      operator: output.operator,
      pass: output.pass,
      output,
    };
  }
  if (node.type === "set") {
    const value = interpolate(node.value, snapshot, record.fanoutScope);
    const base = baseIntent(snapshot, execution, "set", { value });
    return { ...base, kind: "set", node, operation: "apply", value };
  }
  if (node.type === "fanout") {
    const items = resolveFanoutItems(node, snapshot, record.fanoutScope);
    const sourceHash = fanoutSourceHash(node, items);
    const itemRecords = fanoutItemRecords(snapshot, execution, node);
    const operation: ObjectiveControlFanoutIntent["operation"] = itemRecords.length === items.length && itemRecords.length > 0 && itemRecords.every((item) => isTerminal(item.state))
      ? "join"
      : "materialize";
    const base = baseIntent(snapshot, execution, "fanout", { operation, sourceHash, items });
    return {
      ...base,
      kind: "fanout",
      node,
      operation,
      source: node.source,
      sourceHash,
      items,
      concurrency: node.concurrency,
      ...(node.aggregation === undefined ? {} : { aggregation: node.aggregation }),
    };
  }
  // Checkpoint/artifact leaves are intentionally data-only extension points.
  // Until their dedicated durable publication acknowledgements are supplied
  // by the runner, fail closed as an explicit wait instead of accidentally
  // treating them as executable agent nodes.
  if (node.type === "checkpoint" || node.type === "artifact") {
    const base = baseIntent(snapshot, execution, "wait", { reason: `control-${node.type}-publication-required` });
    return { ...base, kind: "wait", node, operation: "await-agent", reason: `control-${node.type}-publication-required` };
  }
  const attemptId = attemptIdFor(snapshot, execution);
  if (node.requiresApproval && !hasApproval(snapshot, execution)) {
    const base = baseIntent(snapshot, execution, "agent", { operation: "approval", attemptId });
    return { ...base, kind: "agent", node, operation: "approval", attemptId, objective: interpolate(node.objective, snapshot) as string, model: node.model, harness: node.harness, inputs: interpolate(node.inputs, snapshot) as JsonValue[], approvalRequired: true };
  }
  const base = baseIntent(snapshot, execution, "agent", { operation: "dispatch", attemptId });
  return { ...base, kind: "agent", node, operation: "dispatch", attemptId, objective: interpolate(node.objective, snapshot, record.fanoutScope) as string, model: node.model, harness: node.harness, inputs: interpolate(node.inputs, snapshot, record.fanoutScope) as JsonValue[], approvalRequired: node.requiresApproval };
}

/** Derive exactly one deterministic next control action. */
export function nextObjectiveControlIntent(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  now?: string,
): ObjectiveControlIntent {
  return makeIntent(plan, snapshot, now);
}

function addFrontier(frontier: ObjectiveControlExecutionKey[], entries: ObjectiveControlExecutionKey[]): ObjectiveControlExecutionKey[] {
  const seen = new Set(frontier.map((entry) => objectiveControlExecutionId(entry)));
  return [...frontier, ...entries.filter((entry) => {
    const id = objectiveControlExecutionId(entry);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  })];
}

function removeFrontier(frontier: ObjectiveControlExecutionKey[], execution: ObjectiveControlExecutionKey): ObjectiveControlExecutionKey[] {
  const id = objectiveControlExecutionId(execution);
  return frontier.filter((entry) => objectiveControlExecutionId(entry) !== id);
}

function replaceExecution(
  snapshot: ObjectiveControlPlanSnapshot,
  execution: ObjectiveControlExecutionKey,
  patch: Partial<ObjectiveControlExecutionRecord>,
): ObjectiveControlPlanSnapshot {
  const id = objectiveControlExecutionId(execution);
  const previous = recordFor(snapshot, execution) ?? emptyExecution(execution);
  const nextRecord = { ...previous, ...patch, key: execution };
  const executions = snapshot.executions.some((entry) => objectiveControlExecutionId(entry.key) === id)
    ? snapshot.executions.map((entry) => objectiveControlExecutionId(entry.key) === id ? nextRecord : entry)
    : [...snapshot.executions, nextRecord];
  return {
    ...snapshot,
    executions,
    nodeStates: { ...snapshot.nodeStates, [id]: nextRecord.state },
    attemptIds: { ...snapshot.attemptIds, [id]: nextRecord.attemptId },
  };
}

function ensureExecutions(
  snapshot: ObjectiveControlPlanSnapshot,
  children: ObjectiveControlExecutionKey[],
  fanoutScope?: ObjectiveControlFanoutScope,
): ObjectiveControlPlanSnapshot {
  let current = snapshot;
  for (const child of children) {
    if (recordFor(current, child)) continue;
    current = replaceExecution(current, child, emptyExecution(child, "queued", fanoutScope));
  }
  return current;
}

function markFailedAndPropagate(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  execution: ObjectiveControlExecutionKey,
  error: string,
  now: string,
): ObjectiveControlPlanSnapshot {
  let current = replaceExecution(snapshot, execution, { state: "failed", error, finishedAt: now });
  current = {
    ...current,
    frontier: removeFrontier(current.frontier, execution),
    exitReasons: { ...current.exitReasons, [objectiveControlExecutionId(execution)]: "failed" },
  };
  return settleParent(plan, current, execution, now);
}

function isDescendantOf(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  candidate: ObjectiveControlExecutionKey,
  ancestor: ObjectiveControlExecutionKey,
): boolean {
  let current = candidate;
  for (let depth = 0; depth < 256; depth += 1) {
    const parent = parentExecutionFor(plan, current, snapshot);
    if (!parent) return false;
    if (objectiveControlExecutionId(parent) === objectiveControlExecutionId(ancestor)) return true;
    current = parent;
  }
  throw new Error("Objective control execution ancestry exceeded 256 levels.");
}

/** Mark sibling work as durably cancelled when a parallel child fails. */
function cancelParallelSiblings(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  parent: ObjectiveControlExecutionKey,
  failedChild: ObjectiveControlExecutionKey,
  now: string,
): ObjectiveControlPlanSnapshot {
  const parentNode = nodeForExecution(plan, parent, snapshot);
  if (!parentNode || parentNode.type !== "parallel") return snapshot;
  const siblings = childrenFor(parentNode, parent, snapshot).filter((candidate) => objectiveControlExecutionId(candidate) !== objectiveControlExecutionId(failedChild));
  let current = snapshot;
  for (const entry of snapshot.executions) {
    if (!siblings.some((sibling) => objectiveControlExecutionId(sibling) === objectiveControlExecutionId(entry.key) || isDescendantOf(plan, snapshot, entry.key, sibling))) continue;
    if (isTerminal(entry.state)) continue;
    const waitingSuspension = entry.suspension?.status === "waiting" ? {
      ...entry.suspension,
      status: "cancelled" as const,
      terminalReason: "cancelled" as const,
      settledAt: now,
    } : null;
    current = replaceExecution(current, entry.key, {
      // External waits have a distinct terminal suspension state. Keeping a
      // waiting timer/signal attached to a failed sibling leaves an impossible
      // projection that cannot be resumed or cancelled after a restart.
      state: waitingSuspension ? "cancelled" : "failed",
      error: "Cancelled because a parallel sibling failed.",
      finishedAt: now,
      ...(waitingSuspension ? { suspension: waitingSuspension } : {}),
    });
    current = {
      ...current,
      frontier: removeFrontier(current.frontier, entry.key),
      exitReasons: { ...current.exitReasons, [objectiveControlExecutionId(entry.key)]: "cancelled" },
    };
  }
  return current;
}

/** Fail-fast fan-out semantics: a failed item cancels queued/running siblings
 * in the same materialization so a restart cannot resurrect work that can no
 * longer contribute to the aggregate. */
function cancelFanoutSiblings(
  snapshot: ObjectiveControlPlanSnapshot,
  parent: ObjectiveControlExecutionKey,
  failedChild: ObjectiveControlExecutionKey,
  now: string,
): ObjectiveControlPlanSnapshot {
  const failedScope = recordFor(snapshot, failedChild)?.fanoutScope;
  if (!failedScope) return snapshot;
  const parentId = objectiveControlExecutionId(parent);
  let current = snapshot;
  for (const entry of snapshot.executions) {
    const scope = entry.fanoutScope;
    if (!scope || objectiveControlExecutionId(scope.fanoutExecution) !== parentId) continue;
    if (objectiveControlExecutionId(entry.key) === objectiveControlExecutionId(failedChild) || isTerminal(entry.state)) continue;
    current = replaceExecution(current, entry.key, {
      state: "cancelled",
      error: "Cancelled because a fan-out item failed.",
      finishedAt: now,
    });
    current = {
      ...current,
      frontier: removeFrontier(current.frontier, entry.key),
      exitReasons: { ...current.exitReasons, [objectiveControlExecutionId(entry.key)]: "cancelled" },
    };
  }
  return current;
}

function settleParent(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  childExecution: ObjectiveControlExecutionKey,
  now: string,
): ObjectiveControlPlanSnapshot {
  let current = snapshot;
  let child = childExecution;
  while (true) {
    const parent = parentExecutionFor(plan, child, current);
    if (!parent) {
      const root = key(plan.root.id, "root");
      if (objectiveControlExecutionId(child) === objectiveControlExecutionId(root)) return current;
      return current;
    }
    const parentRecord = recordFor(current, parent);
    if (!parentRecord) return current;
    const childRecord = recordFor(current, child);
    const parentNode = nodeForExecution(plan, parent, current);
    if (!parentNode || !childRecord) return current;

    if (!isSuccess(childRecord.state)) {
      current = cancelParallelSiblings(plan, current, parent, child, now);
      current = cancelFanoutSiblings(current, parent, child, now);
      current = replaceExecution(current, parent, { state: "failed", error: childRecord.error ?? "Child control execution failed.", finishedAt: now });
      current = {
        ...current,
        frontier: removeFrontier(current.frontier, parent),
        exitReasons: { ...current.exitReasons, [objectiveControlExecutionId(parent)]: "failed" },
      };
      child = parent;
      continue;
    }

    if (parentNode.type === "fanout") {
      const itemRecords = fanoutItemRecords(current, parent, parentNode);
      const active = itemRecords.some((entry) => entry.state === "running" || entry.state === "waiting");
      const allTerminal = itemRecords.length > 0 && itemRecords.every((entry) => isTerminal(entry.state));
      current = { ...current, frontier: removeFrontier(current.frontier, child) };
      if (allTerminal) {
        current = { ...current, frontier: addFrontier(current.frontier, [parent]) };
      } else if (!active) {
        current = advanceFanoutFrontier(current, parent, parentNode);
      } else {
        current = advanceFanoutFrontier(current, parent, parentNode);
      }
      return current;
    }

    if (parentNode.type === "sequence" || parentNode.type === "if" || parentNode.type === "while") {
      const next = firstMissingOrUnfinished(parentNode, parent, current);
      if (next) {
        current = ensureExecutions(current, [next.key], parentRecord.fanoutScope);
        current = { ...current, frontier: addFrontier(removeFrontier(current.frontier, child), [next.key]) };
        return current;
      }
      if (parentNode.type === "while") {
        // The while node itself re-enters the frontier to evaluate its next
        // condition (or reach its explicit bound).
        current = { ...current, frontier: addFrontier(removeFrontier(current.frontier, child), [parent]) };
        return current;
      }
      current = { ...current, frontier: addFrontier(removeFrontier(current.frontier, child), [parent]) };
      return current;
    }

    const children = childrenFor(parentNode, parent, current);
    const failed = children.some((entry) => recordFor(current, entry)?.state === "failed");
    const allTerminal = children.length > 0 && children.every((entry) => {
      const record = recordFor(current, entry);
      return record !== undefined && isTerminal(record.state);
    });
    if (failed) {
      current = replaceExecution(current, parent, { state: "failed", error: "A parallel child failed.", finishedAt: now });
      current = {
        ...current,
        frontier: removeFrontier(current.frontier, parent),
        exitReasons: { ...current.exitReasons, [objectiveControlExecutionId(parent)]: "failed" },
      };
      child = parent;
      continue;
    }
    if (allTerminal) {
      current = { ...current, frontier: addFrontier(removeFrontier(current.frontier, child), [parent]) };
    }
    return current;
  }
}

function markCompletedAndPropagate(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  execution: ObjectiveControlExecutionKey,
  output: JsonValue | null,
  now: string,
): ObjectiveControlPlanSnapshot {
  let current = replaceExecution(snapshot, execution, {
    state: "completed",
    output,
    error: null,
    finishedAt: now,
  });
  const executionId = objectiveControlExecutionId(execution);
  if (output !== null) {
    const previous = recordFor(current, execution);
    current = replaceExecution(current, execution, {
      contextRefs: [
        ...(previous?.contextRefs ?? []),
        { kind: "node-output", id: executionId, hash: sha256(output) } as ObjectiveControlContextRef,
      ],
    });
  }
  current = {
    ...current,
    frontier: removeFrontier(current.frontier, execution),
    exitReasons: { ...current.exitReasons, [executionId]: current.exitReasons[executionId] ?? "completed" },
  };
  const parent = parentExecutionFor(plan, execution, current);
  if (!parent) return current;
  return settleParent(plan, current, execution, now);
}

function ackHash(ack: ObjectiveControlAcknowledgement): string {
  return sha256(ack);
}

function acknowledgementEvaluation(ack: ObjectiveControlAcknowledgement): ObjectiveControlEvaluation | null {
  if (ack.evaluation) {
    const directFields = [ack.actual, ack.target, ack.operator, ack.pass];
    if (directFields.some((field) => field !== undefined)) {
      if (ack.actual === undefined || ack.target === undefined || ack.operator === undefined || ack.pass === undefined) {
        throw new Error("Evaluation acknowledgement direct fields must be supplied together with evaluation.");
      }
      const direct: ObjectiveControlEvaluation = { actual: ack.actual, target: ack.target, operator: ack.operator, pass: ack.pass };
      if (!sameEvaluation(ack.evaluation, direct)) throw new Error("Evaluation acknowledgement fields conflict with evaluation.");
    }
    return ack.evaluation;
  }
  if (ack.actual === undefined || ack.target === undefined || ack.operator === undefined || ack.pass === undefined) return null;
  return { actual: ack.actual, target: ack.target, operator: ack.operator, pass: ack.pass };
}

function acknowledgedRef(snapshot: ObjectiveControlPlanSnapshot, intentId: string): ObjectiveControlPlanSnapshot["contextRefs"][number] | undefined {
  return snapshot.contextRefs.find((ref) => ref.kind === "event" && ref.id === `control-ack:${intentId}`);
}

function acknowledgedSignalDelivery(snapshot: ObjectiveControlPlanSnapshot, subscriptionKey: string, deliveryId: string): ObjectiveControlPlanSnapshot["contextRefs"][number] | undefined {
  return snapshot.contextRefs.find((ref) => ref.kind === "event" && ref.id === signalDeliveryRefId(subscriptionKey, deliveryId));
}

/** Context-ref IDs are bounded protocol values even when a stable subscription key is long. */
function signalDeliveryRefId(subscriptionKey: string, deliveryId: string): string {
  return `control-signal-delivery:${sha256({ subscriptionKey, deliveryId })}`;
}

/** Apply one acknowledgement, including duplicate replay fencing. */
export function applyObjectiveControlAcknowledgement(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  rawAcknowledgement: ObjectiveControlAcknowledgement,
): ObjectiveControlPlanSnapshot {
  const acknowledgement = ObjectiveControlAcknowledgementSchema.parse(rawAcknowledgement);
  if (acknowledgement.kind === "signal" && acknowledgement.deliveryId && acknowledgement.subscriptionKey) {
    const delivery = acknowledgedSignalDelivery(snapshot, acknowledgement.subscriptionKey, acknowledgement.deliveryId);
    if (delivery) {
      const hash = ackHash(acknowledgement);
      if (delivery.hash !== hash) throw new Error(`Signal delivery ${acknowledgement.deliveryId} conflicts with its durable receipt.`);
      return snapshot;
    }
  }
  const existing = acknowledgedRef(snapshot, acknowledgement.intentId);
  const hash = ackHash(acknowledgement);
  if (existing) {
    if (existing.hash !== hash) throw new Error(`Control acknowledgement ${acknowledgement.intentId} conflicts with its durable receipt.`);
    return snapshot;
  }
  const intent = nextObjectiveControlIntent(plan, snapshot, acknowledgement.now);
  if (intent.intentId !== acknowledgement.intentId) throw new Error(`Control acknowledgement ${acknowledgement.requestKey} is stale.`);
  if (acknowledgement.kind !== intent.kind) throw new Error(`Control acknowledgement kind ${acknowledgement.kind} does not match ${intent.kind}.`);
  const eventCursor = acknowledgement.eventCursor ?? acknowledgement.evidence?.eventCursor ?? snapshot.eventCursor;
  if (eventCursor < snapshot.eventCursor) throw new Error(`Control acknowledgement event cursor ${eventCursor} is behind ${snapshot.eventCursor}.`);
  const now = acknowledgement.now ?? snapshot.createdAt;
  let current: ObjectiveControlPlanSnapshot = {
    ...snapshot,
    sequence: snapshot.sequence + 1,
    eventCursor,
    reason: acknowledgement.reason ?? `Control acknowledgement ${acknowledgement.requestKey} applied.`,
    contextRefs: [...snapshot.contextRefs, { kind: "event", id: `control-ack:${acknowledgement.intentId}`, hash }],
  };
  const execution = intent.execution;

  if (intent.kind === "sequence" || intent.kind === "parallel") {
    if (intent.operation !== "enter") throw new Error(`${intent.kind} acknowledgement is not an enter operation.`);
    const children = intent.children;
    current = replaceExecution(current, execution, { state: "running", startedAt: now });
    current = ensureExecutions(current, children, recordFor(current, execution)?.fanoutScope);
    current = {
      ...current,
      frontier: addFrontier(removeFrontier(current.frontier, execution), intent.kind === "sequence" ? children.slice(0, 1) : children),
    };
    return ObjectiveControlPlanSnapshotSchema.parse(current);
  }

  if (intent.kind === "if") {
    if (intent.operation === "join") {
      const children = childrenFor(intent.node, execution, current);
      if (children.some((child) => !isSuccess(recordFor(current, child)?.state ?? "blocked"))) throw new Error("Cannot join an unsuccessful if branch.");
      return ObjectiveControlPlanSnapshotSchema.parse(markCompletedAndPropagate(plan, current, execution, { branch: current.branches[objectiveControlExecutionId(execution)] ?? "else" }, now));
    }
    if (acknowledgement.condition === undefined) throw new Error("If acknowledgement requires condition evidence.");
    if (acknowledgement.condition !== intent.conditionValue) {
      throw new Error(`If acknowledgement condition ${String(acknowledgement.condition)} does not match deterministic value ${String(intent.conditionValue)}.`);
    }
    const branch: ObjectiveControlBranch = acknowledgement.condition ? "then" : "else";
    const children = branch === "then" ? intent.node.then : intent.node.else ?? [];
    current = replaceExecution(current, execution, { state: "running", startedAt: now });
    current = {
      ...current,
      branches: { ...current.branches, [objectiveControlExecutionId(execution)]: branch },
      ...(acknowledgement.condition ? {} : { exitReasons: { ...current.exitReasons, [objectiveControlExecutionId(execution)]: "condition-false" as const } }),
    };
    if (children.length === 0) return ObjectiveControlPlanSnapshotSchema.parse(markCompletedAndPropagate(plan, current, execution, { branch }, now));
    const childKeys = children.map((child) => branchChildKey(execution, branch, child.id));
    current = ensureExecutions(current, childKeys.slice(0, 1), recordFor(current, execution)?.fanoutScope);
    current = { ...current, frontier: addFrontier(removeFrontier(current.frontier, execution), childKeys.slice(0, 1)) };
    return ObjectiveControlPlanSnapshotSchema.parse(current);
  }

  if (intent.kind === "while") {
    if (intent.operation === "bound-reached") {
      current = { ...current, exitReasons: { ...current.exitReasons, [objectiveControlExecutionId(execution)]: "bound-reached" } };
      return ObjectiveControlPlanSnapshotSchema.parse(markCompletedAndPropagate(plan, current, execution, { iterations: intent.iteration }, now));
    }
    if (acknowledgement.condition === undefined) throw new Error("While acknowledgement requires condition evidence.");
    if (acknowledgement.condition !== intent.conditionValue) {
      throw new Error(`While acknowledgement condition ${String(acknowledgement.condition)} does not match deterministic value ${String(intent.conditionValue)}.`);
    }
    if (!acknowledgement.condition) {
      current = { ...current, exitReasons: { ...current.exitReasons, [objectiveControlExecutionId(execution)]: "condition-false" } };
      return ObjectiveControlPlanSnapshotSchema.parse(markCompletedAndPropagate(plan, current, execution, { iterations: intent.iteration }, now));
    }
    const iteration = intent.iteration + 1;
    if (iteration > intent.node.maxIterations) throw new Error(`While ${intent.node.id} exceeded ${intent.node.maxIterations} iterations.`);
    current = replaceExecution(current, execution, { state: "running", startedAt: current.executions.find((entry) => objectiveControlExecutionId(entry.key) === objectiveControlExecutionId(execution))?.startedAt ?? now });
    current = { ...current, loopIterations: { ...current.loopIterations, [objectiveControlExecutionId(execution)]: iteration } };
    const childKeys = intent.node.steps.map((child) => loopChildKey(execution, iteration, child.id));
    current = ensureExecutions(current, childKeys.slice(0, 1), recordFor(current, execution)?.fanoutScope);
    current = { ...current, frontier: addFrontier(removeFrontier(current.frontier, execution), childKeys.slice(0, 1)) };
    return ObjectiveControlPlanSnapshotSchema.parse(current);
  }

  if (intent.kind === "set") {
    return ObjectiveControlPlanSnapshotSchema.parse(markCompletedAndPropagate(plan, current, execution, acknowledgement.output ?? intent.value, now));
  }

  if (intent.kind === "evaluate") {
    const result = acknowledgementEvaluation(acknowledgement);
    if (!result) throw new Error("Evaluation acknowledgement requires actual, target, operator, and pass evidence.");
    if (!sameEvaluation(result, intent.output)) {
      throw new Error("Evaluation acknowledgement does not match the deterministic snapshot result.");
    }
    if (acknowledgement.output !== undefined && !compareJson(acknowledgement.output, intent.output)) {
      throw new Error("Evaluation acknowledgement output does not match the deterministic snapshot result.");
    }
    return ObjectiveControlPlanSnapshotSchema.parse(markCompletedAndPropagate(plan, current, execution, intent.output, now));
  }

  if (intent.kind === "fanout") {
    if (acknowledgement.sourceHash !== undefined && acknowledgement.sourceHash !== intent.sourceHash) {
      throw new Error("Fan-out acknowledgement source hash does not match the durable source expansion.");
    }
    if (acknowledgement.fanoutItems !== undefined && !compareJson(acknowledgement.fanoutItems, intent.items)) {
      throw new Error("Fan-out acknowledgement items do not match the durable source expansion.");
    }
    if (intent.operation === "materialize") {
      const existingItems = fanoutItemRecords(current, execution, intent.node);
      if (existingItems.length > 0) return ObjectiveControlPlanSnapshotSchema.parse(advanceFanoutFrontier(current, execution, intent.node));
      current = replaceExecution(current, execution, { state: "running", startedAt: now, output: null, error: null });
      for (const item of intent.items) {
        const child = fanoutItemExecutionKey(execution, intent.node, item);
        const scope: ObjectiveControlFanoutScope = {
          fanoutExecution: execution,
          itemKey: item.key,
          itemIndex: item.index,
          item: item.value,
          templateNodeId: intent.node.itemTemplate.id,
        };
        current = ensureExecutions(current, [child], scope);
      }
      if (intent.items.length === 0) {
        return ObjectiveControlPlanSnapshotSchema.parse(markCompletedAndPropagate(plan, current, execution, aggregateObjectiveFanout([], intent.aggregation), now));
      }
      current = {
        ...current,
        frontier: addFrontier(removeFrontier(current.frontier, execution), intent.items
          .slice(0, intent.concurrency === null ? intent.items.length : Math.max(0, intent.concurrency))
          .map((item) => fanoutItemExecutionKey(execution, intent.node, item))),
      };
      return ObjectiveControlPlanSnapshotSchema.parse(current);
    }
    const itemRecords = fanoutItemRecords(current, execution, intent.node);
    if (itemRecords.some((item) => item.state === "failed" || item.state === "cancelled" || item.state === "blocked")) {
      const failed = itemRecords.find((item) => !isSuccess(item.state));
      return ObjectiveControlPlanSnapshotSchema.parse(markFailedAndPropagate(plan, current, execution, failed?.error ?? "A fan-out item failed.", now));
    }
    if (itemRecords.length !== intent.items.length || itemRecords.some((item) => !isSuccess(item.state))) {
      throw new Error("Cannot join a fan-out before every item has settled successfully.");
    }
    return ObjectiveControlPlanSnapshotSchema.parse(markCompletedAndPropagate(plan, current, execution, aggregateObjectiveFanout(itemRecords, intent.aggregation), now));
  }

  if (intent.kind === "agent") {
    if (intent.operation === "approval") {
      if (acknowledgement.approved === undefined) throw new Error("Agent approval acknowledgement requires approved evidence.");
      if (!acknowledgement.approved) {
        return ObjectiveControlPlanSnapshotSchema.parse(markFailedAndPropagate(plan, current, execution, "Agent approval was denied.", now));
      }
      const approvalId = objectiveControlExecutionId(execution);
      current = {
        ...current,
        contextRefs: [
          ...current.contextRefs,
          { kind: "event", id: `control-approval:${approvalId}`, hash: sha256({ intentId: intent.intentId, requestKey: acknowledgement.requestKey }) },
        ],
        reason: acknowledgement.reason ?? `Approval granted for ${approvalId}.`,
      };
      return ObjectiveControlPlanSnapshotSchema.parse(current);
    }
    if (acknowledgement.attemptId !== intent.attemptId) {
      throw new Error(`Agent acknowledgement attempt ${acknowledgement.attemptId ?? "missing"} does not match dispatched attempt ${intent.attemptId}.`);
    }
    const state = acknowledgement.state ?? "completed";
    if (state === "running") {
      current = replaceExecution(current, execution, { state: "running", attemptId: intent.attemptId, agentId: acknowledgement.agentId ?? null, startedAt: now });
      return ObjectiveControlPlanSnapshotSchema.parse(current);
    }
    if (state === "failed") {
      return ObjectiveControlPlanSnapshotSchema.parse(markFailedAndPropagate(plan, current, execution, acknowledgement.error ?? "Agent execution failed.", now));
    }
    current = replaceExecution(current, execution, { state: "completed", attemptId: intent.attemptId, agentId: acknowledgement.agentId ?? null, output: acknowledgement.output ?? null, contextRefs: acknowledgement.contextRefs ? [...acknowledgement.contextRefs] : [], finishedAt: now });
    const output = acknowledgement.output ?? null;
    const executionId = objectiveControlExecutionId(execution);
    current = replaceExecution(current, execution, {
      contextRefs: [
        ...(acknowledgement.contextRefs ?? []),
        ...(output === null ? [] : [{ kind: "node-output", id: executionId, hash: sha256(output) } as ObjectiveControlContextRef]),
      ],
    });
    return ObjectiveControlPlanSnapshotSchema.parse(settleParent(plan, { ...current, frontier: removeFrontier(current.frontier, execution) }, execution, now));
  }

  if (intent.kind === "timer") {
    const timerNode = intent.node;
    const executionId = objectiveControlExecutionId(execution);
    const previous = recordFor(current, execution);
    if (intent.operation === "schedule") {
      const since = acknowledgement.since ?? now;
      const dueAt = acknowledgement.dueAt;
      if (!dueAt) throw new Error("Timer scheduling acknowledgement requires daemon-owned dueAt.");
      const dueTimestamp = Date.parse(dueAt);
      if (!Number.isFinite(dueTimestamp) || dueTimestamp < Date.parse(since)) throw new Error("Timer dueAt must be at or after its daemon-owned since time.");
      const expiresAt = acknowledgement.expiresAt
        ?? (timerNode.expiresAfterMs === null ? null : new Date(Date.parse(since) + (timerNode.expiresAfterMs ?? timerNode.durationMs)).toISOString());
      const expectedDueAt = new Date(Date.parse(since) + timerNode.durationMs).toISOString();
      if (dueAt !== expectedDueAt) throw new Error("Timer dueAt does not match the declared duration from since.");
      if (expiresAt !== null && Date.parse(expiresAt) < dueTimestamp) throw new Error("Timer expiry must be at or after dueAt.");
      const suspension: ObjectiveControlTimerSuspension = {
        version: 1,
        kind: "timer",
        objectiveId: current.objectiveId,
        runId: current.runId,
        nodeId: execution.nodeId,
        execution,
        attemptId: intent.attemptId,
        since,
        dueAt,
        expiresAt,
        status: "waiting",
        terminalReason: null,
        settledAt: null,
      };
      current = replaceExecution(current, execution, { state: "waiting", attemptId: intent.attemptId, startedAt: since, suspension });
      return ObjectiveControlPlanSnapshotSchema.parse(current);
    }
    const suspension = previous?.suspension;
    if (!suspension || suspension.kind !== "timer") throw new Error(`Timer ${executionId} has no durable suspension record.`);
    if (acknowledgement.state === "cancelled") {
      const cancelled = { ...suspension, status: "cancelled" as const, terminalReason: "cancelled" as const, settledAt: now };
      current = replaceExecution(current, execution, { state: "cancelled", suspension: cancelled, error: acknowledgement.reason ?? "Timer suspension cancelled.", finishedAt: now });
      current = { ...current, frontier: removeFrontier(current.frontier, execution), exitReasons: { ...current.exitReasons, [executionId]: "cancelled" } };
      return ObjectiveControlPlanSnapshotSchema.parse(settleParent(plan, current, execution, now));
    }
    if (intent.operation === "wait") throw new Error(`Timer ${executionId} is not due yet.`);
    if (acknowledgement.dueAt !== undefined && acknowledgement.dueAt !== suspension.dueAt) throw new Error("Timer acknowledgement dueAt does not match its durable suspension.");
    if (intent.operation === "expire") {
      const expired = { ...suspension, status: "expired" as const, terminalReason: "expired" as const, settledAt: now };
      current = replaceExecution(current, execution, { state: "expired", suspension: expired, error: "Timer suspension expired.", finishedAt: now });
      current = { ...current, frontier: removeFrontier(current.frontier, execution), exitReasons: { ...current.exitReasons, [executionId]: "expired" } };
      return ObjectiveControlPlanSnapshotSchema.parse(settleParent(plan, current, execution, now));
    }
    const delivered = { ...suspension, status: "delivered" as const, terminalReason: "due" as const, settledAt: now };
    current = replaceExecution(current, execution, { state: "completed", suspension: delivered, output: { dueAt: suspension.dueAt }, finishedAt: now });
    current = { ...current, frontier: removeFrontier(current.frontier, execution), exitReasons: { ...current.exitReasons, [executionId]: "completed" } };
    return ObjectiveControlPlanSnapshotSchema.parse(settleParent(plan, current, execution, now));
  }

  if (intent.kind === "signal") {
    const executionId = objectiveControlExecutionId(execution);
    const previous = recordFor(current, execution);
    if (intent.operation === "subscribe") {
      const since = acknowledgement.since ?? now;
      const expiresAt = acknowledgement.expiresAt
        ?? (intent.node.expiresAfterMs === null ? null : new Date(Date.parse(since) + (intent.node.expiresAfterMs ?? 0)).toISOString());
      const subscriptionKey = objectiveControlSubscriptionKey({
        objectiveId: current.objectiveId,
        runId: current.runId,
        nodeId: execution.nodeId,
        execution,
        attemptId: intent.attemptId,
        signalKey: intent.signalKey,
      });
      if (acknowledgement.signalKey !== undefined && acknowledgement.signalKey !== intent.signalKey) throw new Error("Signal acknowledgement key does not match its plan node.");
      if (acknowledgement.subscriptionKey !== undefined && acknowledgement.subscriptionKey !== subscriptionKey) throw new Error("Signal subscription key is not daemon-derived for this execution.");
      const suspension: ObjectiveControlSignalSuspension = {
        version: 1,
        kind: "signal",
        objectiveId: current.objectiveId,
        runId: current.runId,
        nodeId: execution.nodeId,
        execution,
        attemptId: intent.attemptId,
        since,
        expiresAt,
        status: "waiting",
        terminalReason: null,
        settledAt: null,
        signalKey: intent.signalKey,
        subscriptionKey,
        deliveryId: null,
        deliveredAt: null,
        payload: null,
      };
      current = replaceExecution(current, execution, { state: "waiting", attemptId: intent.attemptId, startedAt: since, suspension });
      return ObjectiveControlPlanSnapshotSchema.parse(current);
    }
    const suspension = previous?.suspension;
    if (!suspension || suspension.kind !== "signal") throw new Error(`Signal ${executionId} has no durable subscription record.`);
    if (acknowledgement.state === "cancelled") {
      const cancelled = { ...suspension, status: "cancelled" as const, terminalReason: "cancelled" as const, settledAt: now };
      current = replaceExecution(current, execution, { state: "cancelled", suspension: cancelled, error: acknowledgement.reason ?? "Signal suspension cancelled.", finishedAt: now });
      current = { ...current, frontier: removeFrontier(current.frontier, execution), exitReasons: { ...current.exitReasons, [executionId]: "cancelled" } };
      return ObjectiveControlPlanSnapshotSchema.parse(settleParent(plan, current, execution, now));
    }
    if (intent.operation === "wait" && !acknowledgement.deliveryId) throw new Error(`Signal ${executionId} is waiting for ${suspension.signalKey}.`);
    if (acknowledgement.signalKey !== undefined && acknowledgement.signalKey !== suspension.signalKey) throw new Error("Signal delivery key does not match its durable subscription.");
    if (acknowledgement.subscriptionKey !== undefined && acknowledgement.subscriptionKey !== suspension.subscriptionKey) throw new Error("Signal delivery subscription does not match its durable subscription.");
    if (intent.operation === "expire") {
      const expired = { ...suspension, status: "expired" as const, terminalReason: "expired" as const, settledAt: now };
      current = replaceExecution(current, execution, { state: "expired", suspension: expired, error: "Signal suspension expired.", finishedAt: now });
      current = { ...current, frontier: removeFrontier(current.frontier, execution), exitReasons: { ...current.exitReasons, [executionId]: "expired" } };
      return ObjectiveControlPlanSnapshotSchema.parse(settleParent(plan, current, execution, now));
    }
    if (!acknowledgement.deliveryId || acknowledgement.payload === undefined) throw new Error("Signal delivery requires deliveryId and payload.");
    const delivered = { ...suspension, status: "delivered" as const, terminalReason: "delivered" as const, settledAt: now, deliveryId: acknowledgement.deliveryId, deliveredAt: now, payload: acknowledgement.payload };
    current = replaceExecution(current, execution, { state: "completed", suspension: delivered, output: acknowledgement.payload, finishedAt: now, error: null });
    current = {
      ...current,
      frontier: removeFrontier(current.frontier, execution),
      contextRefs: [...current.contextRefs, { kind: "event", id: signalDeliveryRefId(suspension.subscriptionKey, acknowledgement.deliveryId), hash: ackHash(acknowledgement) }],
      exitReasons: { ...current.exitReasons, [executionId]: "completed" },
    };
    return ObjectiveControlPlanSnapshotSchema.parse(settleParent(plan, current, execution, now));
  }

  if (intent.kind === "join") {
    if (intent.children.some((child) => !isSuccess(recordFor(current, child)?.state ?? "blocked"))) throw new Error("Cannot join unsuccessful control children.");
    const output = intent.node.type === "parallel"
      ? Object.fromEntries(intent.children.map((child) => [child.nodeId, recordFor(current, child)?.output ?? null]))
      : intent.node.type === "sequence"
        ? Object.fromEntries(intent.node.steps.map((child) => [child.id, recordFor(current, childKey(execution, child.id))?.output ?? null]))
        : null;
    return ObjectiveControlPlanSnapshotSchema.parse(markCompletedAndPropagate(plan, current, execution, output, now));
  }

  // Complete/wait acknowledgements are useful for a conductor that records a
  // final receipt but do not change the already durable terminal projection.
  return ObjectiveControlPlanSnapshotSchema.parse(current);
}

function sameEvaluation(left: ObjectiveControlEvaluation, right: ObjectiveControlEvaluation): boolean {
  return left.operator === right.operator
    && left.pass === right.pass
    && compareJson(left.actual, right.actual)
    && compareJson(left.target, right.target);
}

export const compileControlPlan = compileObjectiveControlPlan;
export const createControlSnapshot = createObjectiveControlSnapshot;
export const nextControlIntent = nextObjectiveControlIntent;
export const applyControlAcknowledgement = applyObjectiveControlAcknowledgement;
