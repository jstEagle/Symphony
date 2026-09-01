import { z } from "zod";
import {
  ObjectiveControlSignalSpecSchema,
  ObjectiveControlSuspensionRecordSchema,
  ObjectiveControlTimerSpecSchema,
  type ObjectiveControlSignalSpec,
  type ObjectiveControlSuspensionRecord,
  type ObjectiveControlTimerSpec,
} from "./objective-suspension.js";
import { CapabilityExecutionBindingSchema } from "./capability-execution.js";
import {
  ObjectiveValueCharterMutationCitationSchema,
  type ObjectiveValueCharterMutationCitation,
} from "./objective-values.js";
import {
  WorkflowFanoutAggregationSchema,
  type WorkflowFanoutAggregation,
} from "./workflow.js";

/**
 * The control plan is deliberately a data-only protocol.  It describes the
 * shape of work and the durable state of that shape; it never contains a
 * callback, expression, or executable code.  The daemon/reducer is the only
 * authority allowed to interpret it.
 */

const JsonValueSchema = z.json();
const IdSchema = z.string().min(1).max(256);
const NodeIdSchema = IdSchema.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const IsoDateSchema = z.iso.datetime({ offset: true });

export type ObjectiveControlNodeId = z.infer<typeof NodeIdSchema>;
export type NodeId = ObjectiveControlNodeId;

export const ObjectiveControlActorSchema = z
  .object({
    type: z.enum(["user", "agent", "system"]),
    id: IdSchema,
  })
  .strict();
export type ObjectiveControlActor = z.infer<typeof ObjectiveControlActorSchema>;

/** A stable identity in the source workflow or in a conductor-authored plan. */
export const ObjectiveControlSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workflow-revision"),
      workflowId: IdSchema,
      workflowRevision: z.number().int().positive(),
      workflowHash: z.string().min(8).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("conductor-authored"),
      authorAgentId: IdSchema,
      sessionId: IdSchema.nullable().default(null),
    })
    .strict(),
]);
export type ObjectiveControlSource = z.infer<typeof ObjectiveControlSourceSchema>;

/**
 * Conditions intentionally match the saved workflow condition semantics. A
 * condition is only a JSON path lookup plus a fixed comparison operator.
 */
export const ObjectiveControlConditionSchema = z
  .object({
    path: z.string().min(1).max(1_000),
    op: z.enum(["exists", "eq", "neq", "gt", "gte", "lt", "lte"]),
    value: JsonValueSchema.optional(),
    default: JsonValueSchema.optional(),
  })
  .strict();
export type ObjectiveControlCondition = z.infer<typeof ObjectiveControlConditionSchema>;
export const ControlConditionSchema = ObjectiveControlConditionSchema;
export type ControlCondition = ObjectiveControlCondition;

/** Operators supported by data-only evaluation nodes. */
export const ObjectiveControlEvaluationOperatorSchema = z.enum([
  "exists",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);
export type ObjectiveControlEvaluationOperator = z.infer<typeof ObjectiveControlEvaluationOperatorSchema>;

/** The stable, serializable result stored by an evaluation execution. */
export const ObjectiveControlEvaluationSchema = z
  .object({
    actual: JsonValueSchema.nullable(),
    target: JsonValueSchema.nullable(),
    operator: ObjectiveControlEvaluationOperatorSchema,
    pass: z.boolean(),
  })
  .strict();
export type ObjectiveControlEvaluation = z.infer<typeof ObjectiveControlEvaluationSchema>;

export const ObjectiveControlRoutingSchema = z
  .object({
    taskKind: z.enum(["frontend", "coding", "research", "summarization", "general"]).optional(),
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
      .strict()
      .optional(),
  })
  .strict();
export type ObjectiveControlRouting = z.infer<typeof ObjectiveControlRoutingSchema>;

export const ObjectiveControlWorkspaceSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    remoteRepository: z.string().url().optional(),
    startingRef: z.string().min(1).max(512).optional(),
    dirtyPolicy: z.enum(["local-only", "require-clean", "explicit-checkpoint"]).default("local-only"),
  })
  .strict();
export type ObjectiveControlWorkspace = z.infer<typeof ObjectiveControlWorkspaceSchema>;

/** Null means explicitly unlimited, matching objective budget semantics. */
export const ObjectiveControlLimitsSchema = z
  .object({
    maxNodes: z.number().int().positive().nullable().default(null),
    maxDepth: z.number().int().positive().nullable().default(null),
    maxLoopIterations: z.number().int().positive().nullable().default(null),
    maxConcurrentAgents: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type ObjectiveControlLimits = z.infer<typeof ObjectiveControlLimitsSchema>;

const ObjectiveControlNodeBaseSchema = z
  .object({
    /** The identity used by the reducer and durable snapshots. */
    id: NodeIdSchema,
    /** Identity of the originating workflow/conductor node. */
    sourceNodeId: IdSchema,
    /** Stable source path, e.g. `steps.1.then.0`. */
    sourcePath: z.string().min(1).max(2_000),
    /** Optional explicit dependency references between control nodes. */
    dependsOn: z.array(NodeIdSchema).max(256).default([]),
    label: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((node, context) => {
    const seen = new Set<string>();
    for (const [index, dependencyId] of node.dependsOn.entries()) {
      if (seen.has(dependencyId)) {
        context.addIssue({
          code: "custom",
          path: ["dependsOn", index],
          message: `Duplicate control-node dependency ${dependencyId}`,
        });
      }
      if (dependencyId === node.id) {
        context.addIssue({
          code: "custom",
          path: ["dependsOn", index],
          message: `Control node ${node.id} cannot depend on itself`,
        });
      }
      seen.add(dependencyId);
    }
  });

export type ObjectiveControlAgentNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "agent";
  objective: string;
  model: string;
  harness: "auto" | "codex" | "claude" | "cursor" | "opencode" | "pi" | "acp";
  permissions?: "read-only" | "full-access" | undefined;
  outputSchema: Record<string, z.infer<typeof JsonValueSchema>>;
  inputs: z.infer<typeof JsonValueSchema>[];
  routing?: ObjectiveControlRouting | undefined;
  workspace?: ObjectiveControlWorkspace | undefined;
  capabilities?: string[] | undefined;
  /** Exact activated capability input, when this node opts into one. */
  capabilityExecution?: import("./capability-execution.js").CapabilityExecutionBinding | undefined;
  requiresApproval: boolean;
};
export type ObjectiveControlSetNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "set";
  value: z.infer<typeof JsonValueSchema>;
};
export type ObjectiveControlEvaluateNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "evaluate";
  /** Human-readable metric label; falls back to path when omitted. */
  metric?: string | undefined;
  /** A JSON path resolved against the durable snapshot context. */
  path: string;
  /** `operator` is canonical; `op` is accepted for workflow compatibility. */
  operator?: ObjectiveControlEvaluationOperator | undefined;
  op?: ObjectiveControlEvaluationOperator | undefined;
  target?: z.infer<typeof JsonValueSchema> | undefined;
  default?: z.infer<typeof JsonValueSchema> | undefined;
};
export type ObjectiveControlSequenceNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "sequence";
  steps: ObjectiveControlNode[];
};
export type ObjectiveControlParallelNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "parallel";
  steps: ObjectiveControlNode[];
};
/**
 * A dynamic map/fan-out blueprint. The template is intentionally kept as a
 * control node so agent-authored plans can fan out any existing declarative
 * node shape. It is a blueprint, not a pre-materialized execution; concrete
 * item executions and reduction behavior belong to the durable executor.
 */
export type ObjectiveControlFanoutNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "fanout";
  source: string;
  itemTemplate: ObjectiveControlNode;
  concurrency: number | null;
  aggregation?: WorkflowFanoutAggregation | undefined;
};
export type ObjectiveControlIfNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "if";
  condition: ObjectiveControlCondition;
  then: ObjectiveControlNode[];
  else?: ObjectiveControlNode[] | undefined;
};
export type ObjectiveControlWhileNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "while";
  condition: ObjectiveControlCondition;
  steps: ObjectiveControlNode[];
  /** Required here: a dynamic objective may not create an unbounded loop. */
  maxIterations: number;
};
export type ObjectiveControlTimerNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "timer";
} & ObjectiveControlTimerSpec;
export type ObjectiveControlSignalNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "signal";
} & ObjectiveControlSignalSpec;
/** A durable checkpoint node only records data to be captured; it never
 * contains a callback or a filesystem instruction. */
export type ObjectiveControlCheckpointNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "checkpoint";
  reason: string;
  context?: Record<string, z.infer<typeof JsonValueSchema>> | undefined;
};
/** An artifact node is an inline JSON publication intent. Bytes and paths are
 * deliberately absent from this protocol. */
export type ObjectiveControlArtifactNode = z.infer<typeof ObjectiveControlNodeBaseSchema> & {
  type: "artifact";
  kind: string;
  name: string;
  mediaType: string;
  content: z.infer<typeof JsonValueSchema>;
};
export type ObjectiveControlNode =
  | ObjectiveControlAgentNode
  | ObjectiveControlSetNode
  | ObjectiveControlEvaluateNode
  | ObjectiveControlSequenceNode
  | ObjectiveControlParallelNode
  | ObjectiveControlFanoutNode
  | ObjectiveControlIfNode
  | ObjectiveControlWhileNode
  | ObjectiveControlTimerNode
  | ObjectiveControlSignalNode
  | ObjectiveControlCheckpointNode
  | ObjectiveControlArtifactNode;

/**
 * Visit every node in a control tree, optionally including dynamic fan-out
 * templates. Templates are blueprints rather than materialized executions,
 * so callers that validate policy/budget should opt in explicitly while
 * execution/snapshot callers can retain the default concrete-only walk.
 */
export type ObjectiveControlNodeVisit = Readonly<{
  node: ObjectiveControlNode;
  path: readonly (string | number)[];
  depth: number;
  isFanoutTemplate: boolean;
}>;

export function walkObjectiveControlNodes(
  root: ObjectiveControlNode,
  options: { includeFanoutTemplates?: boolean } = {},
): ObjectiveControlNodeVisit[] {
  const visits: ObjectiveControlNodeVisit[] = [];
  const walk = (
    node: ObjectiveControlNode,
    path: readonly (string | number)[],
    depth: number,
    isFanoutTemplate: boolean,
  ): void => {
    visits.push({ node, path, depth, isFanoutTemplate });
    if (node.type === "sequence" || node.type === "parallel" || node.type === "while") {
      node.steps.forEach((child, index) => walk(child, [...path, "steps", index], depth + 1, isFanoutTemplate));
    } else if (node.type === "if") {
      node.then.forEach((child, index) => walk(child, [...path, "then", index], depth + 1, isFanoutTemplate));
      node.else?.forEach((child, index) => walk(child, [...path, "else", index], depth + 1, isFanoutTemplate));
    } else if (node.type === "fanout" && options.includeFanoutTemplates) {
      walk(node.itemTemplate, [...path, "itemTemplate"], depth + 1, true);
    }
  };
  walk(root, ["root"], 1, false);
  return visits;
}

const ObjectiveControlNodeSchema: z.ZodType<ObjectiveControlNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("agent"),
      objective: z.string().min(1).max(20_000),
      model: z.string().min(1).default("auto"),
      harness: z.enum(["auto", "codex", "claude", "cursor", "opencode", "pi", "acp"]).default("auto"),
      permissions: z.enum(["read-only", "full-access"]).optional(),
      outputSchema: z.record(z.string(), JsonValueSchema).default({}),
      inputs: z.array(JsonValueSchema).max(128).default([]),
      routing: ObjectiveControlRoutingSchema.optional(),
      workspace: ObjectiveControlWorkspaceSchema.optional(),
      capabilities: z.array(IdSchema).max(256).optional(),
      capabilityExecution: CapabilityExecutionBindingSchema.optional(),
      requiresApproval: z.boolean().default(false),
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("set"),
      value: JsonValueSchema,
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("evaluate"),
      metric: z.string().min(1).max(500).optional(),
      path: z.string().min(1).max(1_000),
      operator: ObjectiveControlEvaluationOperatorSchema.optional(),
      op: ObjectiveControlEvaluationOperatorSchema.optional(),
      target: JsonValueSchema.optional(),
      default: JsonValueSchema.optional(),
    }).superRefine((node, context) => {
      if (node.operator === undefined && node.op === undefined) {
        context.addIssue({ code: "custom", path: ["operator"], message: "Evaluation node requires an operator." });
      }
      if (node.operator !== undefined && node.op !== undefined && node.operator !== node.op) {
        context.addIssue({ code: "custom", path: ["operator"], message: "Evaluation node operator and op must agree." });
      }
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("sequence"),
      steps: z.array(ObjectiveControlNodeSchema).min(1).max(256),
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("parallel"),
      steps: z.array(ObjectiveControlNodeSchema).min(1).max(256),
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("fanout"),
      source: z.string().min(1).max(1_000),
      itemTemplate: ObjectiveControlNodeSchema,
      concurrency: z.number().int().positive().nullable().default(null),
      aggregation: WorkflowFanoutAggregationSchema.optional(),
    }).strict(),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("if"),
      condition: ObjectiveControlConditionSchema,
      then: z.array(ObjectiveControlNodeSchema).min(1).max(256),
      else: z.array(ObjectiveControlNodeSchema).max(256).optional(),
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("while"),
      condition: ObjectiveControlConditionSchema,
      steps: z.array(ObjectiveControlNodeSchema).min(1).max(256),
      maxIterations: z.number().int().positive(),
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("timer"),
      ...ObjectiveControlTimerSpecSchema.shape,
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("signal"),
      ...ObjectiveControlSignalSpecSchema.shape,
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("checkpoint"),
      reason: z.string().min(1).max(2_000),
      context: z.record(z.string(), JsonValueSchema).optional(),
    }),
    ObjectiveControlNodeBaseSchema.extend({
      type: z.literal("artifact"),
      kind: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._:-]*$/u),
      name: z.string().min(1).max(500),
      mediaType: z.string().min(1).max(200),
      content: JsonValueSchema,
    }),
  ]),
);

export { ObjectiveControlNodeSchema };
export const ControlNodeSchema = ObjectiveControlNodeSchema;

function addControlPlanGraphIssues(
  plan: { root: ObjectiveControlNode; limits: ObjectiveControlLimits },
  context: z.RefinementCtx,
): void {
  const nodes = new Map<string, { node: ObjectiveControlNode; path: (string | number)[]; depth: number }>();
  const visits = walkObjectiveControlNodes(plan.root, { includeFanoutTemplates: true });
  for (const visit of visits) {
    const { node, path, depth } = visit;
    // Fan-out templates are scoped blueprints. Their ids must not collide
    // with executable nodes in the surrounding plan, but their structure and
    // policy cost still count toward immutable plan limits below.
    if (!visit.isFanoutTemplate) {
      if (nodes.has(node.id)) {
        context.addIssue({
          code: "custom",
          path: [...path, "id"],
          message: `Duplicate objective control node id: ${node.id}`,
        });
      } else {
        nodes.set(node.id, { node, path: [...path], depth });
      }
    }
    if (plan.limits.maxDepth !== null && depth > plan.limits.maxDepth) {
      context.addIssue({
        code: "custom",
        path: [...path],
        message: `Objective control plan exceeds maxDepth ${plan.limits.maxDepth} at ${node.id}`,
      });
    }
    if (node.type === "while" && plan.limits.maxLoopIterations !== null && node.maxIterations > plan.limits.maxLoopIterations) {
      context.addIssue({
        code: "custom",
        path: [...path, "maxIterations"],
        message: `Loop ${node.id} exceeds maxLoopIterations ${plan.limits.maxLoopIterations}`,
      });
    }
  }

  if (plan.limits.maxNodes !== null && visits.length > plan.limits.maxNodes) {
    context.addIssue({
      code: "custom",
      path: ["root"],
      message: `Objective control plan has ${visits.length} nodes; maxNodes is ${plan.limits.maxNodes}`,
    });
  }

  for (const { node, path } of nodes.values()) {
    for (const [index, dependencyId] of node.dependsOn.entries()) {
      if (!nodes.has(dependencyId)) {
        context.addIssue({
          code: "custom",
          path: [...path, "dependsOn", index],
          message: `Control node ${node.id} depends on unknown node ${dependencyId}`,
        });
      }
    }
  }

  // Dependencies are references rather than executable edges. Still reject a
  // cycle so a reducer can always produce a finite deterministic frontier.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    const current = nodes.get(nodeId);
    if (!current) return;
    if (visiting.has(nodeId)) {
      context.addIssue({
        code: "custom",
        path: [...current.path, "dependsOn"],
        message: `Objective control dependency cycle detected through ${nodeId}`,
      });
      return;
    }
    visiting.add(nodeId);
    for (const dependencyId of current.node.dependsOn) visit(dependencyId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodes.keys()) visit(nodeId);
}

/** The immutable content of one control plan revision. */
export const ObjectiveControlPlanSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    source: ObjectiveControlSourceSchema,
    root: ObjectiveControlNodeSchema,
    /** Optional immutable objective-values binding inherited by this strategy. */
    valueCharterRevision: z.number().int().positive().max(1_000_000_000).optional(),
    valueCharterHash: z.string().min(8).max(256).optional(),
    limits: ObjectiveControlLimitsSchema.default({
      maxNodes: null,
      maxDepth: null,
      maxLoopIterations: null,
      maxConcurrentAgents: null,
    }),
  })
  .strict()
  .superRefine(addControlPlanGraphIssues);
export type ObjectiveControlPlan = z.infer<typeof ObjectiveControlPlanSchema>;
export const ControlPlanSchema = ObjectiveControlPlanSchema;
export type ControlPlan = ObjectiveControlPlan;

/** Durable revision record. Revisions are append-only; source is never mutable. */
export const ObjectiveControlPlanRevisionSchema = z
  .object({
    version: z.literal(1),
    planId: IdSchema,
    objectiveId: IdSchema,
    runId: IdSchema,
    revision: z.number().int().nonnegative(),
    source: ObjectiveControlSourceSchema,
    plan: ObjectiveControlPlanSchema,
    /** The strategy revision is fenced to the objective charter when present. */
    valueCharterRevision: z.number().int().positive().max(1_000_000_000).optional(),
    valueCharterHash: z.string().min(8).max(256).optional(),
    hash: z.string().min(8).max(256),
    createdBy: ObjectiveControlActorSchema,
    requestKey: z.string().min(8),
    createdAt: IsoDateSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.plan.id !== record.planId) {
      context.addIssue({ code: "custom", path: ["plan", "id"], message: "Plan id must match planId" });
    }
    if (objectiveControlStableJson(record.plan.source) !== objectiveControlStableJson(record.source)) {
      context.addIssue({ code: "custom", path: ["source"], message: "Revision source must match the plan source exactly" });
    }
    if (record.valueCharterRevision !== undefined && record.plan.valueCharterRevision !== undefined && record.valueCharterRevision !== record.plan.valueCharterRevision) {
      context.addIssue({ code: "custom", path: ["valueCharterRevision"], message: "Revision charter revision must match the plan charter revision" });
    }
    if (record.valueCharterHash !== undefined && record.plan.valueCharterHash !== undefined && record.valueCharterHash !== record.plan.valueCharterHash) {
      context.addIssue({ code: "custom", path: ["valueCharterHash"], message: "Revision charter hash must match the plan charter hash" });
    }
  })
  .transform((record) => ({
    ...record,
    ...(record.valueCharterRevision === undefined && record.plan.valueCharterRevision === undefined
      ? {}
      : { valueCharterRevision: record.valueCharterRevision ?? record.plan.valueCharterRevision }),
    ...(record.valueCharterHash === undefined && record.plan.valueCharterHash === undefined
      ? {}
      : { valueCharterHash: record.valueCharterHash ?? record.plan.valueCharterHash }),
  }));
export type ObjectiveControlPlanRevision = z.infer<typeof ObjectiveControlPlanRevisionSchema>;
export const ObjectiveControlPlanRecordSchema = ObjectiveControlPlanRevisionSchema;
export type ObjectiveControlPlanRecord = ObjectiveControlPlanRevision;

export const ObjectiveControlNodeStateSchema = z.enum([
  "queued",
  "waiting",
  "running",
  "completed",
  "failed",
  "skipped",
  "blocked",
  "cancelled",
  "expired",
]);
export type ObjectiveControlNodeState = z.infer<typeof ObjectiveControlNodeStateSchema>;

export const ObjectiveControlBranchSchema = z.enum(["then", "else"]);
export type ObjectiveControlBranch = z.infer<typeof ObjectiveControlBranchSchema>;

export const ObjectiveControlExitReasonSchema = z.enum([
  "condition-false",
  "bound-reached",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "blocked",
  "manual",
]);
export type ObjectiveControlExitReason = z.infer<typeof ObjectiveControlExitReasonSchema>;

/**
 * A node id is stable across the plan, while an iteration key is stable for
 * one execution of that node. Keeping both is essential for loops: the same
 * agent leaf can be executed many times and every attempt must remain
 * addressable after a daemon restart.
 */
export const ObjectiveControlExecutionKeySchema = z
  .object({
    nodeId: NodeIdSchema,
    /** `root` for the first execution; nested loop scopes are slash-delimited. */
    iterationKey: z.string().min(1).max(2_000),
  })
  .strict();
export type ObjectiveControlExecutionKey = z.infer<typeof ObjectiveControlExecutionKeySchema>;

export function objectiveControlExecutionId(key: ObjectiveControlExecutionKey): string {
  return `${key.nodeId}@${key.iterationKey}`;
}

/**
 * One item in a deterministic fan-out materialization.  The item value is
 * retained in the durable control projection so a daemon restart can rebuild
 * the same child work order without re-reading a mutable external source.
 * `execution` is included here (rather than inferred by consumers) because
 * it is the idempotency boundary for the item attempt.
 */
export const ObjectiveControlFanoutItemSchema = z
  .object({
    index: z.number().int().nonnegative(),
    key: z.string().min(1).max(512),
    value: JsonValueSchema,
    itemHash: z.string().min(8).max(256),
    execution: ObjectiveControlExecutionKeySchema,
  })
  .strict();
export type ObjectiveControlFanoutItem = z.infer<typeof ObjectiveControlFanoutItemSchema>;

/** The immutable source expansion receipt for one fan-out execution. */
export const ObjectiveControlFanoutMaterializationSchema = z
  .object({
    version: z.literal(1),
    materializationId: IdSchema,
    fanoutExecution: ObjectiveControlExecutionKeySchema,
    sourcePath: z.string().min(1).max(1_000),
    sourceHash: z.string().min(8).max(256),
    items: z.array(ObjectiveControlFanoutItemSchema).max(4_096),
    aggregation: WorkflowFanoutAggregationSchema.optional(),
  })
  .strict()
  .superRefine((materialization, context) => {
    const keys = new Set<string>();
    const indexes = new Set<number>();
    for (const [index, item] of materialization.items.entries()) {
      if (keys.has(item.key)) {
        context.addIssue({ code: "custom", path: ["items", index, "key"], message: `Duplicate fan-out item key ${item.key}` });
      }
      if (indexes.has(item.index)) {
        context.addIssue({ code: "custom", path: ["items", index, "index"], message: `Duplicate fan-out item index ${item.index}` });
      }
      keys.add(item.key);
      indexes.add(item.index);
      if (item.execution.nodeId === materialization.fanoutExecution.nodeId) {
        context.addIssue({ code: "custom", path: ["items", index, "execution"], message: "Fan-out item execution must not reuse the fan-out node id" });
      }
    }
  });
export type ObjectiveControlFanoutMaterialization = z.infer<typeof ObjectiveControlFanoutMaterializationSchema>;

/**
 * Stable child path used by objective-level fan-out executors.  Encoding the
 * key makes the path unambiguous while keeping the parent execution in the
 * identity, so duplicate keys cannot accidentally alias work in another
 * nested fan-out scope.
 */
export function objectiveControlFanoutItemExecutionKey(
  fanoutExecution: ObjectiveControlExecutionKey,
  itemNodeId: string,
  itemKey: string,
): ObjectiveControlExecutionKey {
  const parsedFanoutExecution = ObjectiveControlExecutionKeySchema.parse(fanoutExecution);
  const parsedNodeId = NodeIdSchema.parse(itemNodeId);
  const parsedItemKey = z.string().min(1).max(512).parse(itemKey);
  return ObjectiveControlExecutionKeySchema.parse({
    nodeId: parsedNodeId,
    iterationKey: `${parsedFanoutExecution.iterationKey}/${parsedFanoutExecution.nodeId}/item/${encodeURIComponent(parsedItemKey)}`,
  });
}

/** Metadata copied onto each durable child execution created by a fan-out. */
export const ObjectiveControlFanoutExecutionMetadataSchema = z
  .object({
    materializationId: IdSchema,
    fanoutExecution: ObjectiveControlExecutionKeySchema,
    sourcePath: z.string().min(1).max(1_000),
    sourceHash: z.string().min(8).max(256),
    itemIndex: z.number().int().nonnegative(),
    itemKey: z.string().min(1).max(512),
    itemHash: z.string().min(8).max(256),
  })
  .strict();
export type ObjectiveControlFanoutExecutionMetadata = z.infer<typeof ObjectiveControlFanoutExecutionMetadataSchema>;

export const ObjectiveControlContextRefSchema = z
  .object({
    kind: z.enum(["node-output", "artifact", "event", "objective-context"]),
    id: IdSchema,
    path: z.string().min(1).max(1_000).optional(),
    hash: z.string().min(8).max(256).optional(),
  })
  .strict();
export type ObjectiveControlContextRef = z.infer<typeof ObjectiveControlContextRefSchema>;

/** Immutable source value used while planning a dynamic fan-out. */
export const ObjectiveControlFanoutValueSchema = z
  .object({
    key: z.string().min(1).max(512),
    index: z.number().int().nonnegative(),
    value: JsonValueSchema,
  })
  .strict();
export type ObjectiveControlFanoutValue = z.infer<typeof ObjectiveControlFanoutValueSchema>;

/**
 * Durable scope attached to an execution materialized from a fan-out item.
 * Keeping the source value and its stable key in the snapshot means a
 * restarted daemon can reconstruct the exact work-order inputs without
 * re-reading a mutable external collection.
 */
export const ObjectiveControlFanoutScopeSchema = z
  .object({
    fanoutExecution: ObjectiveControlExecutionKeySchema,
    itemKey: z.string().min(1).max(512),
    itemIndex: z.number().int().nonnegative(),
    item: JsonValueSchema,
    templateNodeId: NodeIdSchema,
  })
  .strict();
export type ObjectiveControlFanoutScope = z.infer<typeof ObjectiveControlFanoutScopeSchema>;

/** Durable state for one concrete node execution, not an aggregate node id. */
export const ObjectiveControlExecutionRecordSchema = z
  .object({
    key: ObjectiveControlExecutionKeySchema,
    state: ObjectiveControlNodeStateSchema,
    attemptId: IdSchema.nullable(),
    agentId: IdSchema.nullable().default(null),
    output: JsonValueSchema.nullable().default(null),
    error: z.string().max(20_000).nullable().default(null),
    startedAt: IsoDateSchema.nullable().default(null),
    finishedAt: IsoDateSchema.nullable().default(null),
    contextRefs: z.array(ObjectiveControlContextRefSchema).max(256).default([]),
    /** Present on executions materialized from a dynamic fan-out item. */
    fanoutScope: ObjectiveControlFanoutScopeSchema.optional(),
    /** Present only for a child execution materialized by a fan-out node. */
    fanout: ObjectiveControlFanoutExecutionMetadataSchema.optional(),
    /** Present only for timer/signal nodes; identity is execution-scoped. */
    suspension: ObjectiveControlSuspensionRecordSchema.nullable().default(null).optional(),
  })
  .strict();
export type ObjectiveControlExecutionRecord = z.infer<typeof ObjectiveControlExecutionRecordSchema>;

/** Append-only lineage retained when a strategy removes a subtree containing
 * an execution or active native attempt. */
export const ObjectiveControlCancellationRecordSchema = z.object({
  version: z.literal(1),
  execution: ObjectiveControlExecutionKeySchema,
  attemptId: IdSchema.nullable(),
  agentId: IdSchema.nullable().default(null),
  intentId: IdSchema.nullable().default(null),
  reason: z.string().min(1).max(2_000),
  cancelledAt: IsoDateSchema,
  sourceMutationId: IdSchema,
}).strict();
export type ObjectiveControlCancellationRecord = z.infer<typeof ObjectiveControlCancellationRecordSchema>;

/** Complete durable projection of a plan at one event high-water mark. */
export const ObjectiveControlPlanSnapshotSchema = z
  .object({
    version: z.literal(1),
    planId: IdSchema,
    objectiveId: IdSchema,
    runId: IdSchema,
    planRevision: z.number().int().nonnegative(),
    /** Optional source echo for clients that carry the immutable identity. */
    source: ObjectiveControlSourceSchema.optional(),
    sequence: z.number().int().positive(),
    eventCursor: z.number().int().nonnegative(),
    /** Keys are objectiveControlExecutionId values, not bare node ids. */
    nodeStates: z.record(z.string().min(1).max(2_048), ObjectiveControlNodeStateSchema).default({}),
    frontier: z.array(ObjectiveControlExecutionKeySchema).max(512).default([]),
    branches: z.record(z.string().min(1).max(2_048), ObjectiveControlBranchSchema).default({}),
    /** Loop counters are execution-scoped; bare node ids are unsafe for nested loops. */
    loopIterations: z.record(z.string().min(1).max(2_048), z.number().int().nonnegative()).default({}),
    exitReasons: z.record(z.string().min(1).max(2_048), ObjectiveControlExitReasonSchema).default({}),
    attemptIds: z.record(z.string().min(1).max(2_048), IdSchema.nullable()).default({}),
    executions: z.array(ObjectiveControlExecutionRecordSchema).max(1_024).default([]),
    /** Tombstones for removed executions; these preserve active-attempt
     * lineage even though the candidate plan no longer contains their node. */
    cancellations: z.array(ObjectiveControlCancellationRecordSchema).max(1_024).optional(),
    /** Immutable durable input/context used by data-only conditions/evaluations. */
    // Optional on the wire so snapshots written by pre-evaluation daemons keep
    // their original shape; new admissions always persist an explicit object.
    context: z.record(z.string(), JsonValueSchema).optional(),
    contextRefs: z.array(ObjectiveControlContextRefSchema).max(1_024).default([]),
    reason: z.string().min(1).max(2_000),
    createdAt: IsoDateSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const executionIds = new Set<string>();
    for (const [index, execution] of snapshot.executions.entries()) {
      const executionId = objectiveControlExecutionId(execution.key);
      if (executionIds.has(executionId)) {
        context.addIssue({
          code: "custom",
          path: ["executions", index, "key"],
          message: `Duplicate control execution key ${executionId}`,
        });
      }
      executionIds.add(executionId);
    }
    for (const [executionId, state] of Object.entries(snapshot.nodeStates)) {
      const execution = snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === executionId);
      if (execution && execution.state !== state) {
        context.addIssue({
          code: "custom",
          path: ["nodeStates", executionId],
          message: `Node state disagrees with durable execution record ${executionId}`,
        });
      }
    }
  });
export type ObjectiveControlPlanSnapshot = z.infer<typeof ObjectiveControlPlanSnapshotSchema>;
export const ObjectiveControlSnapshotSchema = ObjectiveControlPlanSnapshotSchema;
export type ObjectiveControlSnapshot = ObjectiveControlPlanSnapshot;

type ObjectiveControlSnapshotPlan = ObjectiveControlPlan | ObjectiveControlPlanRevision;

function isObjectiveControlPlanRevision(value: ObjectiveControlSnapshotPlan): value is ObjectiveControlPlanRevision {
  return typeof value === "object" && value !== null && "plan" in value;
}

function isObjectiveControlTerminalState(state: ObjectiveControlNodeState): boolean {
  return state === "completed" || state === "failed" || state === "skipped" || state === "blocked" || state === "cancelled" || state === "expired";
}

function objectiveControlNodeMap(plan: ObjectiveControlPlan): Map<string, ObjectiveControlNode> {
  const nodes = new Map<string, ObjectiveControlNode>();
  const visit = (node: ObjectiveControlNode): void => {
    // ObjectiveControlPlanSchema already enforces this, but retaining the
    // defensive check keeps this validator safe if its caller passes a value
    // assembled from a typed object rather than a parsed payload.
    if (nodes.has(node.id)) throw new Error(`Objective control plan contains duplicate node ${node.id}`);
    nodes.set(node.id, node);
    if (node.type === "sequence" || node.type === "parallel" || node.type === "while") {
      node.steps.forEach(visit);
    } else if (node.type === "if") {
      node.then.forEach(visit);
      node.else?.forEach(visit);
    }
  };
  visit(plan.root);
  return nodes;
}

function requireObjectiveControlSnapshotExecution(
  mapName: string,
  executionId: string,
  executions: Map<string, ObjectiveControlExecutionRecord>,
): ObjectiveControlExecutionRecord {
  const execution = executions.get(executionId);
  if (!execution) {
    throw new Error(`Objective control snapshot ${mapName} references orphan execution ${executionId}`);
  }
  return execution;
}

/**
 * Validate a durable control projection against the immutable plan that owns
 * it. This is deliberately pure: it parses and inspects only its arguments,
 * and never reads or mutates storage, reducer, or runtime state.
 *
 * A revision envelope may be supplied instead of a bare plan. In that form
 * the snapshot is also fenced to the revision's plan/objective/run identity;
 * the revision schema checks that its source is the same as the plan source.
 * A bare plan has no durable revision number to compare, so its plan id (and
 * an explicitly echoed snapshot source, when present) are the applicable
 * identity checks.
 */
export function validateObjectiveControlSnapshotAgainstPlan(
  plan: ObjectiveControlSnapshotPlan,
  snapshot: ObjectiveControlPlanSnapshot,
): void {
  const revision = isObjectiveControlPlanRevision(plan)
    ? ObjectiveControlPlanRevisionSchema.parse(plan)
    : null;
  const parsedPlan = revision?.plan ?? ObjectiveControlPlanSchema.parse(plan);
  const parsedSnapshot = ObjectiveControlPlanSnapshotSchema.parse(snapshot);

  if (parsedSnapshot.planId !== parsedPlan.id) {
    throw new Error(`Objective control snapshot plan id ${parsedSnapshot.planId} does not match plan ${parsedPlan.id}`);
  }
  if (revision) {
    if (parsedSnapshot.planRevision !== revision.revision) {
      throw new Error(`Objective control snapshot revision ${parsedSnapshot.planRevision} does not match plan revision ${revision.revision}`);
    }
    if (parsedSnapshot.objectiveId !== revision.objectiveId || parsedSnapshot.runId !== revision.runId) {
      throw new Error(`Objective control snapshot identity does not match plan revision ${revision.revision}`);
    }
    if (
      parsedSnapshot.source !== undefined
      && objectiveControlStableJson(parsedSnapshot.source) !== objectiveControlStableJson(revision.source)
    ) {
      throw new Error("Objective control snapshot source does not match its plan revision source");
    }
  } else if (
    parsedSnapshot.source !== undefined
    && objectiveControlStableJson(parsedSnapshot.source) !== objectiveControlStableJson(parsedPlan.source)
  ) {
    throw new Error("Objective control snapshot source does not match its plan source");
  }

  const nodes = objectiveControlNodeMap(parsedPlan);
  const executions = new Map<string, ObjectiveControlExecutionRecord>();
  for (const execution of parsedSnapshot.executions) {
    const executionId = objectiveControlExecutionId(execution.key);
    if (executions.has(executionId)) {
      throw new Error(`Objective control snapshot contains duplicate execution id ${executionId}`);
    }
    if (!nodes.has(execution.key.nodeId)) {
      throw new Error(`Objective control snapshot execution ${executionId} references unknown plan node ${execution.key.nodeId}`);
    }
    executions.set(executionId, execution);
    if (execution.suspension) {
      const suspension = execution.suspension;
      if (
        suspension.objectiveId !== parsedSnapshot.objectiveId
        || suspension.runId !== parsedSnapshot.runId
        || suspension.nodeId !== execution.key.nodeId
        || suspension.execution.nodeId !== execution.key.nodeId
        || suspension.execution.iterationKey !== execution.key.iterationKey
        || (suspension.status === "waiting" && execution.state !== "waiting")
        || (suspension.status === "expired" && execution.state !== "expired")
        || (suspension.status === "cancelled" && execution.state !== "cancelled")
        || ((suspension.status === "delivered" || suspension.status === "ready") && execution.state !== "completed" && execution.state !== "running")
      ) {
        throw new Error(`Objective control suspension identity/state disagrees with execution ${executionId}`);
      }
      const node = nodes.get(execution.key.nodeId);
      if (node?.type !== suspension.kind) {
        throw new Error(`Objective control suspension ${executionId} does not match plan node type`);
      }
      if (suspension.kind === "signal" && (node.type !== "signal" || suspension.signalKey !== node.signalKey)) {
        throw new Error(`Objective control signal suspension ${executionId} has a different signal key`);
      }
    }
  }

  // nodeStates is the compact state mirror of every detailed execution. Keep
  // this bidirectional: unknown keys and missing mirrors are both orphaned or
  // stale durable state.
  for (const [executionId, state] of Object.entries(parsedSnapshot.nodeStates)) {
    const execution = requireObjectiveControlSnapshotExecution("nodeStates", executionId, executions);
    if (execution.state !== state) {
      throw new Error(`Objective control snapshot nodeStates disagrees with execution ${executionId}`);
    }
  }
  for (const [executionId, execution] of executions) {
    if (!(executionId in parsedSnapshot.nodeStates)) {
      throw new Error(`Objective control snapshot execution ${executionId} has no nodeStates entry`);
    }
  }

  for (const [executionId] of Object.entries(parsedSnapshot.branches)) {
    const execution = requireObjectiveControlSnapshotExecution("branches", executionId, executions);
    const node = nodes.get(execution.key.nodeId)!;
    if (node.type !== "if") {
      throw new Error(`Objective control snapshot branches key ${executionId} does not refer to an if execution`);
    }
  }

  for (const [executionId, iterations] of Object.entries(parsedSnapshot.loopIterations)) {
    const execution = requireObjectiveControlSnapshotExecution("loopIterations", executionId, executions);
    const node = nodes.get(execution.key.nodeId)!;
    if (node.type !== "while") {
      throw new Error(`Objective control snapshot loopIterations key ${executionId} does not refer to a while execution`);
    }
    if (iterations > node.maxIterations) {
      throw new Error(`Objective control snapshot loopIterations ${iterations} exceeds loop ${node.id} bound ${node.maxIterations}`);
    }
  }

  for (const [executionId, attemptId] of Object.entries(parsedSnapshot.attemptIds)) {
    const execution = requireObjectiveControlSnapshotExecution("attemptIds", executionId, executions);
    const node = nodes.get(execution.key.nodeId)!;
    // Reducer snapshots retain nullable attempt entries for every execution,
    // but a concrete attempt id belongs only to an agent leaf.
    if (attemptId !== null && node.type !== "agent") {
      throw new Error(`Objective control snapshot attemptIds key ${executionId} does not refer to an agent execution`);
    }
  }

  for (const [executionId, reason] of Object.entries(parsedSnapshot.exitReasons)) {
    const execution = requireObjectiveControlSnapshotExecution("exitReasons", executionId, executions);
    const node = nodes.get(execution.key.nodeId)!;
    if (!isObjectiveControlTerminalState(execution.state)) {
      throw new Error(`Objective control snapshot exitReasons key ${executionId} refers to nonterminal execution`);
    }
    if (reason === "condition-false" && node.type !== "if" && node.type !== "while") {
      throw new Error(`Objective control snapshot exitReasons key ${executionId} has a condition exit on ${node.type}`);
    }
    if (reason === "bound-reached" && node.type !== "while") {
      throw new Error(`Objective control snapshot exitReasons key ${executionId} has a loop-bound exit on ${node.type}`);
    }
  }

  // A node-output reference is an execution-scoped durable pointer; unlike
  // artifacts/events, it must not outlive the execution detail it addresses.
  for (const reference of [
    ...parsedSnapshot.contextRefs,
    ...parsedSnapshot.executions.flatMap((execution) => execution.contextRefs),
  ]) {
    if (reference.kind === "node-output") {
      requireObjectiveControlSnapshotExecution("contextRefs", reference.id, executions);
    }
  }

  const frontierIds = new Set<string>();
  for (const executionKey of parsedSnapshot.frontier) {
    const executionId = objectiveControlExecutionId(executionKey);
    if (frontierIds.has(executionId)) {
      throw new Error(`Objective control snapshot frontier contains duplicate execution ${executionId}`);
    }
    frontierIds.add(executionId);
    const execution = requireObjectiveControlSnapshotExecution("frontier", executionId, executions);
    if (isObjectiveControlTerminalState(execution.state)) {
      throw new Error(`Objective control snapshot frontier contains terminal execution ${executionId}`);
    }
  }
}

export const ObjectiveControlEvidenceSchema = z
  .object({
    eventCursor: z.number().int().nonnegative(),
    eventIds: z.array(IdSchema).max(256).default([]),
    summary: z.string().max(2_000).optional(),
  })
  .strict();
export type ObjectiveControlEvidence = z.infer<typeof ObjectiveControlEvidenceSchema>;

const ObjectiveControlFanoutIntentIdentitySchema = {
  intentId: IdSchema,
  planId: IdSchema,
  objectiveId: IdSchema,
  runId: IdSchema,
  planRevision: z.number().int().nonnegative(),
  expectedSequence: z.number().int().positive(),
  execution: ObjectiveControlExecutionKeySchema,
  nodeId: NodeIdSchema,
};

/** Wire contract emitted when the durable executor expands or joins a map. */
export const ObjectiveControlFanoutIntentSchema = z
  .object({
    ...ObjectiveControlFanoutIntentIdentitySchema,
    kind: z.literal("fanout"),
    node: ObjectiveControlNodeSchema,
    operation: z.enum(["materialize", "join"]),
    materialization: ObjectiveControlFanoutMaterializationSchema,
    children: z.array(ObjectiveControlExecutionKeySchema).max(4_096).default([]),
  })
  .strict()
  .superRefine((intent, context) => {
    if (intent.node.type !== "fanout") {
      context.addIssue({ code: "custom", path: ["node", "type"], message: "Fan-out intent requires a fanout node" });
    }
    if (intent.nodeId !== intent.execution.nodeId) {
      context.addIssue({ code: "custom", path: ["nodeId"], message: "Fan-out intent nodeId must match execution.nodeId" });
    }
    if (intent.materialization.fanoutExecution.nodeId !== intent.execution.nodeId
      || intent.materialization.fanoutExecution.iterationKey !== intent.execution.iterationKey) {
      context.addIssue({ code: "custom", path: ["materialization", "fanoutExecution"], message: "Fan-out materialization must belong to the intent execution" });
    }
    const materializedChildren = intent.materialization.items.map((item) => objectiveControlExecutionId(item.execution));
    const children = intent.children.map(objectiveControlExecutionId);
    if (intent.operation === "join" && objectiveControlStableJson(materializedChildren) !== objectiveControlStableJson(children)) {
      context.addIssue({ code: "custom", path: ["children"], message: "Fan-out join children must match materialized item executions" });
    }
  });
export type ObjectiveControlFanoutProtocolIntent = z.infer<typeof ObjectiveControlFanoutIntentSchema>;

/** Wire receipt for durable fan-out expansion/reduction. */
export const ObjectiveControlFanoutAcknowledgementSchema = z
  .object({
    kind: z.literal("fanout"),
    intentId: IdSchema,
    requestKey: z.string().min(8).max(2_048),
    operation: z.enum(["materialize", "join"]),
    materializationId: IdSchema,
    materialization: ObjectiveControlFanoutMaterializationSchema.optional(),
    eventCursor: z.number().int().nonnegative().optional(),
    reason: z.string().max(2_000).optional(),
    evidence: ObjectiveControlEvidenceSchema.optional(),
    now: IsoDateSchema.optional(),
    state: z.enum(["running", "completed", "failed", "cancelled"]).optional(),
    output: JsonValueSchema.nullable().optional(),
    error: z.string().max(20_000).nullable().optional(),
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    if (acknowledgement.operation === "materialize") {
      if (!acknowledgement.materialization) {
        context.addIssue({ code: "custom", path: ["materialization"], message: "Fan-out materialization acknowledgement requires the immutable materialization receipt" });
      } else if (acknowledgement.materialization.materializationId !== acknowledgement.materializationId) {
        context.addIssue({ code: "custom", path: ["materializationId"], message: "Fan-out acknowledgement materialization id does not match its receipt" });
      }
    }
  });
export type ObjectiveControlFanoutAcknowledgement = z.infer<typeof ObjectiveControlFanoutAcknowledgementSchema>;

const ObjectiveControlMutationBaseSchema = {
  version: z.literal(1),
  mutationId: IdSchema,
  planId: IdSchema,
  objectiveId: IdSchema,
  runId: IdSchema,
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().min(1).max(2_000),
  evidence: ObjectiveControlEvidenceSchema,
  /** Structured citations keep charter-aware reasons auditable without code. */
  charterCitations: ObjectiveValueCharterMutationCitationSchema.optional(),
  valueCharterRevision: z.number().int().positive().max(1_000_000_000).optional(),
  valueCharterHash: z.string().min(8).max(256).optional(),
  requestKey: z.string().min(8),
  actor: ObjectiveControlActorSchema,
};

/** Removing live work is an explicit, auditable cancellation command.  The
 * reducer records the command and preserves every affected attempt lineage;
 * a caller cannot silently make a running attempt disappear. */
export const ObjectiveControlCancellationIntentSchema = z.object({
  type: z.literal("cancel-active-attempts"),
  reason: z.string().min(1).max(2_000),
  preserveLineage: z.literal(true),
}).strict();
export type ObjectiveControlCancellationIntent = z.infer<typeof ObjectiveControlCancellationIntentSchema>;

type ObjectiveControlMutationBase = {
  version: 1;
  mutationId: string;
  planId: string;
  objectiveId: string;
  runId: string;
  expectedRevision: number;
  reason: string;
  evidence: ObjectiveControlEvidence;
  charterCitations?: ObjectiveValueCharterMutationCitation | undefined;
  valueCharterRevision?: number | undefined;
  valueCharterHash?: string | undefined;
  requestKey: string;
  actor: ObjectiveControlActor;
};

export type ObjectiveControlInsertNodeMutation = ObjectiveControlMutationBase & {
  type: "insert-node";
  parentId: NodeId;
  slot: "steps" | "then" | "else";
  position?: number | undefined;
  node: ObjectiveControlNode;
};
export type ObjectiveControlReplaceNodeMutation = ObjectiveControlMutationBase & {
  type: "replace-node";
  nodeId: NodeId;
  node: ObjectiveControlNode;
};
export type ObjectiveControlSetLoopBoundMutation = ObjectiveControlMutationBase & {
  type: "set-loop-bound";
  nodeId: NodeId;
  maxIterations: number;
};
export type ObjectiveControlRemoveSubtreeMutation = ObjectiveControlMutationBase & {
  type: "remove-subtree";
  nodeId: NodeId;
  cancellationIntent: ObjectiveControlCancellationIntent;
};
export type ObjectiveControlRewireDependenciesMutation = ObjectiveControlMutationBase & {
  type: "rewire-dependencies";
  nodeId: NodeId;
  dependsOn: NodeId[];
};
export type ObjectiveControlInsertBranchMutation = ObjectiveControlMutationBase & {
  type: "insert-branch";
  branchNodeId: NodeId;
  branch: ObjectiveControlBranch;
  position?: number | undefined;
  node: ObjectiveControlNode;
};
export type ObjectiveControlReplaceBranchMutation = ObjectiveControlMutationBase & {
  type: "replace-branch";
  branchNodeId: NodeId;
  branch: ObjectiveControlBranch;
  nodeId?: NodeId | undefined;
  node: ObjectiveControlNode;
};
export type ObjectiveControlTypedInsertMutation = ObjectiveControlMutationBase & {
  type: "insert-evaluate" | "insert-evaluator" | "insert-timer" | "insert-signal" | "insert-checkpoint" | "insert-artifact";
  parentId: NodeId;
  slot: "steps" | "then" | "else";
  position?: number | undefined;
  node: ObjectiveControlNode;
};
export type ObjectiveControlMutation =
  | ObjectiveControlInsertNodeMutation
  | ObjectiveControlReplaceNodeMutation
  | ObjectiveControlSetLoopBoundMutation
  | ObjectiveControlRemoveSubtreeMutation
  | ObjectiveControlRewireDependenciesMutation
  | ObjectiveControlInsertBranchMutation
  | ObjectiveControlReplaceBranchMutation
  | ObjectiveControlTypedInsertMutation;

export const ObjectiveControlMutationSchema: z.ZodType<ObjectiveControlMutation> = z
  .discriminatedUnion("type", [
    z
      .object({
        ...ObjectiveControlMutationBaseSchema,
        type: z.literal("insert-node"),
        /** Root insertion is intentionally not supported; replace-node(root) is unambiguous. */
        parentId: NodeIdSchema,
        slot: z.enum(["steps", "then", "else"]),
        position: z.number().int().nonnegative().optional(),
        node: ObjectiveControlNodeSchema,
      })
      .strict(),
    z
      .object({
        ...ObjectiveControlMutationBaseSchema,
        type: z.literal("replace-node"),
        nodeId: NodeIdSchema,
        node: ObjectiveControlNodeSchema,
      })
      .strict()
      .superRefine((mutation, context) => {
        if (mutation.node.id !== mutation.nodeId) {
          context.addIssue({
            code: "custom",
            path: ["node", "id"],
            message: "A replace-node mutation must preserve the target node id",
          });
        }
      }),
    z
      .object({
        ...ObjectiveControlMutationBaseSchema,
        type: z.literal("set-loop-bound"),
        nodeId: NodeIdSchema,
        maxIterations: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        ...ObjectiveControlMutationBaseSchema,
        type: z.literal("remove-subtree"),
        nodeId: NodeIdSchema,
        cancellationIntent: ObjectiveControlCancellationIntentSchema,
      })
      .strict(),
    z
      .object({
        ...ObjectiveControlMutationBaseSchema,
        type: z.literal("rewire-dependencies"),
        nodeId: NodeIdSchema,
        dependsOn: z.array(NodeIdSchema).max(256),
      })
      .strict()
      .superRefine((mutation, context) => {
        const seen = new Set<string>();
        for (const [index, dependency] of mutation.dependsOn.entries()) {
          if (seen.has(dependency)) context.addIssue({ code: "custom", path: ["dependsOn", index], message: `Duplicate dependency ${dependency}` });
          if (dependency === mutation.nodeId) context.addIssue({ code: "custom", path: ["dependsOn", index], message: "A node cannot depend on itself" });
          seen.add(dependency);
        }
      }),
    z
      .object({
        ...ObjectiveControlMutationBaseSchema,
        type: z.literal("insert-branch"),
        branchNodeId: NodeIdSchema,
        branch: ObjectiveControlBranchSchema,
        position: z.number().int().nonnegative().optional(),
        node: ObjectiveControlNodeSchema,
      })
      .strict(),
    z
      .object({
        ...ObjectiveControlMutationBaseSchema,
        type: z.literal("replace-branch"),
        branchNodeId: NodeIdSchema,
        branch: ObjectiveControlBranchSchema,
        nodeId: NodeIdSchema.optional(),
        node: ObjectiveControlNodeSchema,
      })
      .strict(),
    ...(["insert-evaluate", "insert-evaluator", "insert-timer", "insert-signal", "insert-checkpoint", "insert-artifact"] as const).map((type) =>
      z.object({
        ...ObjectiveControlMutationBaseSchema,
        type: z.literal(type),
        parentId: NodeIdSchema,
        slot: z.enum(["steps", "then", "else"]),
        position: z.number().int().nonnegative().optional(),
        node: ObjectiveControlNodeSchema,
      }).strict().superRefine((mutation, context) => {
        const expected = type === "insert-evaluator" || type === "insert-evaluate" ? "evaluate" : type.slice("insert-".length);
        if (mutation.node.type !== expected) context.addIssue({ code: "custom", path: ["node", "type"], message: `${type} requires a ${expected} node` });
      }),
    ),
  ]) as z.ZodType<ObjectiveControlMutation>;
export type ObjectiveControlMutationInput = ObjectiveControlMutation;
export const ControlMutationSchema = ObjectiveControlMutationSchema;
export type ControlMutation = ObjectiveControlMutation;

/**
 * Wire input accepted by the daemon control-plan API.  The durable identity
 * fields intentionally do not appear here: plan/objective/run identity,
 * mutation id, request key, and actor are all bound by the daemon from the
 * authenticated route and Idempotency-Key header.
 */
const ObjectiveControlMutationRequestBaseSchema = {
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().min(1).max(2_000),
  evidence: ObjectiveControlEvidenceSchema.default({ eventCursor: 0, eventIds: [] }),
  charterCitations: ObjectiveValueCharterMutationCitationSchema.optional(),
};

export const ObjectiveControlMutationRequestSchema = z.discriminatedUnion("type", [
  z.object({
    ...ObjectiveControlMutationRequestBaseSchema,
    type: z.literal("insert-node"),
    parentId: NodeIdSchema,
    slot: z.enum(["steps", "then", "else"]),
    position: z.number().int().nonnegative().optional(),
    node: ObjectiveControlNodeSchema,
  }).strict(),
  z.object({
    ...ObjectiveControlMutationRequestBaseSchema,
    type: z.literal("replace-node"),
    nodeId: NodeIdSchema,
    node: ObjectiveControlNodeSchema,
  }).strict().superRefine((mutation, context) => {
    if (mutation.node.id !== mutation.nodeId) {
      context.addIssue({
        code: "custom",
        path: ["node", "id"],
        message: "A replace-node mutation must preserve the target node id",
      });
    }
  }),
  z.object({
    ...ObjectiveControlMutationRequestBaseSchema,
    type: z.literal("set-loop-bound"),
    nodeId: NodeIdSchema,
    maxIterations: z.number().int().positive(),
  }).strict(),
  z.object({
    ...ObjectiveControlMutationRequestBaseSchema,
    type: z.literal("remove-subtree"),
    nodeId: NodeIdSchema,
    cancellationIntent: ObjectiveControlCancellationIntentSchema,
  }).strict(),
  z.object({
    ...ObjectiveControlMutationRequestBaseSchema,
    type: z.literal("rewire-dependencies"),
    nodeId: NodeIdSchema,
    dependsOn: z.array(NodeIdSchema).max(256),
  }).strict().superRefine((mutation, context) => {
    const seen = new Set<string>();
    for (const [index, dependency] of mutation.dependsOn.entries()) {
      if (seen.has(dependency)) context.addIssue({ code: "custom", path: ["dependsOn", index], message: `Duplicate dependency ${dependency}` });
      if (dependency === mutation.nodeId) context.addIssue({ code: "custom", path: ["dependsOn", index], message: "A node cannot depend on itself" });
      seen.add(dependency);
    }
  }),
  z.object({
    ...ObjectiveControlMutationRequestBaseSchema,
    type: z.literal("insert-branch"),
    branchNodeId: NodeIdSchema,
    branch: ObjectiveControlBranchSchema,
    position: z.number().int().nonnegative().optional(),
    node: ObjectiveControlNodeSchema,
  }).strict(),
  z.object({
    ...ObjectiveControlMutationRequestBaseSchema,
    type: z.literal("replace-branch"),
    branchNodeId: NodeIdSchema,
    branch: ObjectiveControlBranchSchema,
    nodeId: NodeIdSchema.optional(),
    node: ObjectiveControlNodeSchema,
  }).strict(),
  ...(["insert-evaluate", "insert-evaluator", "insert-timer", "insert-signal", "insert-checkpoint", "insert-artifact"] as const).map((type) =>
    z.object({
      ...ObjectiveControlMutationRequestBaseSchema,
      type: z.literal(type),
      parentId: NodeIdSchema,
      slot: z.enum(["steps", "then", "else"]),
      position: z.number().int().nonnegative().optional(),
      node: ObjectiveControlNodeSchema,
    }).strict().superRefine((mutation, context) => {
      const expected = type === "insert-evaluator" || type === "insert-evaluate" ? "evaluate" : type.slice("insert-".length);
      if (mutation.node.type !== expected) context.addIssue({ code: "custom", path: ["node", "type"], message: `${type} requires a ${expected} node` });
    }),
  ),
]);
export type ObjectiveControlMutationRequest = z.infer<typeof ObjectiveControlMutationRequestSchema>;
export const ControlMutationRequestSchema = ObjectiveControlMutationRequestSchema;
export type ControlMutationRequest = ObjectiveControlMutationRequest;

function findObjectiveControlNode(
  root: ObjectiveControlNode,
  nodeId: string,
): ObjectiveControlNode | null {
  if (root.id === nodeId) return root;
  if (root.type === "sequence" || root.type === "parallel" || root.type === "while") {
    for (const child of root.steps) {
      const found = findObjectiveControlNode(child, nodeId);
      if (found) return found;
    }
  } else if (root.type === "if") {
    for (const child of root.then) {
      const found = findObjectiveControlNode(child, nodeId);
      if (found) return found;
    }
    for (const child of root.else ?? []) {
      const found = findObjectiveControlNode(child, nodeId);
      if (found) return found;
    }
  }
  return null;
}

function collectObjectiveControlNodeIds(root: ObjectiveControlNode, ids = new Set<string>()): Set<string> {
  ids.add(root.id);
  if (root.type === "sequence" || root.type === "parallel" || root.type === "while") {
    for (const child of root.steps) collectObjectiveControlNodeIds(child, ids);
  } else if (root.type === "if") {
    for (const child of root.then) collectObjectiveControlNodeIds(child, ids);
    for (const child of root.else ?? []) collectObjectiveControlNodeIds(child, ids);
  }
  return ids;
}

function collectObjectiveControlNodes(root: ObjectiveControlNode, nodes = new Map<string, ObjectiveControlNode>()): Map<string, ObjectiveControlNode> {
  nodes.set(root.id, root);
  if (root.type === "sequence" || root.type === "parallel" || root.type === "while") root.steps.forEach((child) => collectObjectiveControlNodes(child, nodes));
  else if (root.type === "if") {
    root.then.forEach((child) => collectObjectiveControlNodes(child, nodes));
    root.else?.forEach((child) => collectObjectiveControlNodes(child, nodes));
  }
  return nodes;
}

function replaceBranchChild(
  current: ObjectiveControlNode,
  branchNodeId: string,
  branch: ObjectiveControlBranch,
  targetNodeId: string,
  replacement: ObjectiveControlNode,
): { node: ObjectiveControlNode; replaced: boolean } {
  if (current.id === branchNodeId) {
    if (current.type !== "if") throw new Error(`Branch replacement requires an if node, not ${current.type}`);
    const children = branch === "then" ? current.then : current.else ?? [];
    const index = children.findIndex((child) => child.id === targetNodeId);
    if (index < 0) return { node: current, replaced: false };
    const nextChildren = [...children];
    nextChildren[index] = replacement;
    return {
      node: branch === "then" ? { ...current, then: nextChildren } : { ...current, else: nextChildren },
      replaced: true,
    };
  }
  const children = current.type === "if" ? [...current.then, ...(current.else ?? [])]
    : current.type === "sequence" || current.type === "parallel" || current.type === "while" ? current.steps : [];
  for (const child of children) {
    const result = replaceBranchChild(child, branchNodeId, branch, targetNodeId, replacement);
    if (result.replaced) {
      if (current.type === "if") {
        const then = current.then.map((entry) => entry.id === child.id ? result.node : entry);
        const elseSteps = current.else?.map((entry) => entry.id === child.id ? result.node : entry);
        return { node: { ...current, then, ...(current.else === undefined ? {} : { else: elseSteps }) }, replaced: true };
      }
      if (current.type !== "sequence" && current.type !== "parallel" && current.type !== "while") return { node: current, replaced: false };
      return { node: { ...current, steps: current.steps.map((entry: ObjectiveControlNode) => entry.id === child.id ? result.node : entry) }, replaced: true };
    }
  }
  return { node: current, replaced: false };
}

function rewireObjectiveControlNode(current: ObjectiveControlNode, nodeId: string, dependsOn: string[]): { node: ObjectiveControlNode; changed: boolean } {
  if (current.id === nodeId) return { node: { ...current, dependsOn }, changed: true } as { node: ObjectiveControlNode; changed: boolean };
  if (current.type === "sequence" || current.type === "parallel" || current.type === "while") {
    let changed = false;
    const steps = current.steps.map((child) => {
      const result = rewireObjectiveControlNode(child, nodeId, dependsOn);
      changed ||= result.changed;
      return result.node;
    });
    return { node: changed ? { ...current, steps } : current, changed };
  }
  if (current.type === "if") {
    let changed = false;
    const then = current.then.map((child) => {
      const result = rewireObjectiveControlNode(child, nodeId, dependsOn);
      changed ||= result.changed;
      return result.node;
    });
    const elseSteps = current.else?.map((child) => {
      const result = rewireObjectiveControlNode(child, nodeId, dependsOn);
      changed ||= result.changed;
      return result.node;
    });
    return { node: changed ? { ...current, then, ...(current.else === undefined ? {} : { else: elseSteps }) } : current, changed };
  }
  return { node: current, changed: false };
}

function removeObjectiveControlSubtree(current: ObjectiveControlNode, nodeId: string): { node: ObjectiveControlNode; removed: ObjectiveControlNode | null } {
  const removeFrom = (children: ObjectiveControlNode[]): { children: ObjectiveControlNode[]; removed: ObjectiveControlNode | null } => {
    const index = children.findIndex((child) => child.id === nodeId);
    if (index >= 0) {
      const removed = children[index]!;
      return { children: children.filter((_child, childIndex) => childIndex !== index), removed };
    }
    for (const [childIndex, child] of children.entries()) {
      const result = removeObjectiveControlSubtree(child, nodeId);
      if (!result.removed) continue;
      const next = [...children];
      next[childIndex] = result.node;
      return { children: next, removed: result.removed };
    }
    return { children, removed: null };
  };
  if (current.type === "sequence" || current.type === "parallel" || current.type === "while") {
    const result = removeFrom(current.steps);
    return result.removed ? { node: { ...current, steps: result.children }, removed: result.removed } : { node: current, removed: null };
  }
  if (current.type === "if") {
    const thenResult = removeFrom(current.then);
    if (thenResult.removed) return { node: { ...current, then: thenResult.children }, removed: thenResult.removed };
    const elseResult = removeFrom(current.else ?? []);
    if (elseResult.removed) return { node: { ...current, else: elseResult.children }, removed: elseResult.removed };
  }
  return { node: current, removed: null };
}

/**
 * Validate a typed mutation against the current immutable plan before the
 * storage layer performs its revision CAS. Schema parsing catches malformed
 * payloads; this second boundary catches references that require the plan.
 */
export function validateObjectiveControlMutationTarget(
  mutation: ObjectiveControlMutation,
  plan: ObjectiveControlPlan,
): void {
  parseObjectiveControlPlan(plan);
  if (mutation.planId !== plan.id) throw new Error(`Mutation targets plan ${mutation.planId}, not ${plan.id}`);

  if (mutation.type === "insert-node") {
    const parent = findObjectiveControlNode(plan.root, mutation.parentId);
    if (!parent) throw new Error(`Insert parent ${mutation.parentId} does not exist in plan ${plan.id}`);
    const validSlot =
      (mutation.slot === "steps" && (parent.type === "sequence" || parent.type === "parallel" || parent.type === "while"))
      || (mutation.slot === "then" && parent.type === "if")
      || (mutation.slot === "else" && parent.type === "if");
    if (!validSlot) throw new Error(`Cannot insert into ${mutation.slot} on ${parent.type} node ${parent.id}`);
    const currentChildren = mutation.slot === "steps"
      ? (parent.type === "sequence" || parent.type === "parallel" || parent.type === "while" ? parent.steps : [])
      : parent.type === "if" ? (parent[mutation.slot] ?? []) : [];
    if (mutation.position !== undefined && mutation.position > currentChildren.length) {
      throw new Error(`Insert position ${mutation.position} is outside ${mutation.slot} of ${parent.id}`);
    }
    const ids = collectObjectiveControlNodeIds(plan.root);
    if (ids.has(mutation.node.id)) throw new Error(`Insert node ${mutation.node.id} already exists in plan ${plan.id}`);
    // Dependencies may point at another node in the inserted subtree.  The
    // candidate plan parse in applyObjectiveControlMutation performs the full
    // recursive graph/dependency/limit validation; include all new ids here so
    // this target preflight does not reject a valid nested subtree early.
    const insertedIds = collectObjectiveControlNodeIds(mutation.node);
    const availableIds = new Set([...ids, ...insertedIds]);
    for (const dependencyId of mutation.node.dependsOn) {
      if (!availableIds.has(dependencyId)) {
        throw new Error(`Insert node ${mutation.node.id} depends on unknown node ${dependencyId}`);
      }
    }
    return;
  }

  if (mutation.type === "remove-subtree") {
    if (mutation.nodeId === plan.root.id) throw new Error("The control-plan root cannot be removed; replace it explicitly instead.");
    const target = findObjectiveControlNode(plan.root, mutation.nodeId);
    if (!target) throw new Error(`Mutation target ${mutation.nodeId} does not exist in plan ${plan.id}`);
    return;
  }

  if (mutation.type === "insert-branch" || mutation.type === "replace-branch") {
    const branchParent = findObjectiveControlNode(plan.root, mutation.branchNodeId);
    if (!branchParent || branchParent.type !== "if") throw new Error(`Branch mutation target ${mutation.branchNodeId} is not an if node`);
    const children = mutation.branch === "then" ? branchParent.then : branchParent.else ?? [];
    if (mutation.type === "insert-branch") {
      if (mutation.position !== undefined && mutation.position > children.length) throw new Error(`Branch insertion position ${mutation.position} is outside ${mutation.branch} of ${branchParent.id}`);
      const ids = collectObjectiveControlNodeIds(plan.root);
      if (ids.has(mutation.node.id)) throw new Error(`Insert node ${mutation.node.id} already exists in plan ${plan.id}`);
      return;
    }
    const targetId = mutation.nodeId ?? mutation.node.id;
    if (!children.some((child) => child.id === targetId)) throw new Error(`Branch ${mutation.branchNodeId} has no child ${targetId}`);
    if (mutation.node.id !== targetId) throw new Error("A branch replacement must preserve the replaced node id");
    return;
  }
  if (mutation.type === "insert-evaluate" || mutation.type === "insert-evaluator" || mutation.type === "insert-timer" || mutation.type === "insert-signal" || mutation.type === "insert-checkpoint" || mutation.type === "insert-artifact") {
    const expected = mutation.type === "insert-evaluator" || mutation.type === "insert-evaluate" ? "evaluate" : mutation.type.slice("insert-".length);
    if (mutation.node.type !== expected) throw new Error(`${mutation.type} requires a ${expected} node`);
    const generic = { ...mutation, type: "insert-node" as const } as ObjectiveControlInsertNodeMutation;
    validateObjectiveControlMutationTarget(generic, plan);
    return;
  }
  if (mutation.type === "rewire-dependencies") {
    const target = findObjectiveControlNode(plan.root, mutation.nodeId);
    if (!target) throw new Error(`Mutation target ${mutation.nodeId} does not exist in plan ${plan.id}`);
    const ids = collectObjectiveControlNodeIds(plan.root);
    for (const dependencyId of mutation.dependsOn) if (!ids.has(dependencyId)) throw new Error(`Control node ${mutation.nodeId} depends on unknown node ${dependencyId}`);
    return;
  }

  if (mutation.type !== "replace-node" && mutation.type !== "set-loop-bound") throw new Error(`Unsupported objective control mutation ${mutation.type}`);
  const targetId = mutation.nodeId;
  const target = findObjectiveControlNode(plan.root, targetId);
  if (!target) throw new Error(`Mutation target ${targetId} does not exist in plan ${plan.id}`);
  if (mutation.type === "set-loop-bound" && target.type !== "while") {
    throw new Error(`Loop bound can only be changed on a while node, not ${target.type} node ${target.id}`);
  }
  if (mutation.type === "set-loop-bound" && plan.limits.maxLoopIterations !== null && mutation.maxIterations > plan.limits.maxLoopIterations) {
    throw new Error(`Loop bound ${mutation.maxIterations} exceeds maxLoopIterations ${plan.limits.maxLoopIterations}`);
  }
}

function insertObjectiveControlNode(
  current: ObjectiveControlNode,
  parentId: string,
  slot: "steps" | "then" | "else",
  position: number | undefined,
  inserted: ObjectiveControlNode,
): ObjectiveControlNode {
  if (current.id === parentId) {
    const insertAt = position ?? (
      slot === "steps"
        ? (current.type === "sequence" || current.type === "parallel" || current.type === "while" ? current.steps.length : 0)
        : current.type === "if" ? (current[slot]?.length ?? 0) : 0
    );
    if (slot === "steps" && (current.type === "sequence" || current.type === "parallel" || current.type === "while")) {
      const steps = [...current.steps];
      steps.splice(insertAt, 0, inserted);
      return { ...current, steps };
    }
    if (current.type === "if" && (slot === "then" || slot === "else")) {
      const children = [...(current[slot] ?? [])];
      children.splice(insertAt, 0, inserted);
      return slot === "then" ? { ...current, then: children } : { ...current, else: children };
    }
    // validateObjectiveControlMutationTarget catches this before traversal;
    // retaining a defensive error keeps this helper safe if called directly.
    throw new Error(`Cannot insert into ${slot} on ${current.type} node ${current.id}`);
  }

  if (current.type === "sequence" || current.type === "parallel" || current.type === "while") {
    let changed = false;
    const steps = current.steps.map((child) => {
      const next = insertObjectiveControlNode(child, parentId, slot, position, inserted);
      changed ||= next !== child;
      return next;
    });
    return changed ? { ...current, steps } : current;
  }
  if (current.type === "if") {
    let changed = false;
    const then = current.then.map((child) => {
      const next = insertObjectiveControlNode(child, parentId, slot, position, inserted);
      changed ||= next !== child;
      return next;
    });
    const existingElse = current.else;
    const elseSteps = existingElse?.map((child) => {
      const next = insertObjectiveControlNode(child, parentId, slot, position, inserted);
      changed ||= next !== child;
      return next;
    });
    if (!changed) return current;
    return {
      ...current,
      then,
      ...(existingElse === undefined ? {} : { else: elseSteps }),
    };
  }
  return current;
}

function replaceObjectiveControlNode(
  current: ObjectiveControlNode,
  nodeId: string,
  replacement: ObjectiveControlNode,
): ObjectiveControlNode {
  if (current.id === nodeId) return replacement;
  if (current.type === "sequence" || current.type === "parallel" || current.type === "while") {
    let changed = false;
    const steps = current.steps.map((child) => {
      const next = replaceObjectiveControlNode(child, nodeId, replacement);
      changed ||= next !== child;
      return next;
    });
    return changed ? { ...current, steps } : current;
  }
  if (current.type === "if") {
    let changed = false;
    const then = current.then.map((child) => {
      const next = replaceObjectiveControlNode(child, nodeId, replacement);
      changed ||= next !== child;
      return next;
    });
    const existingElse = current.else;
    const elseSteps = existingElse?.map((child) => {
      const next = replaceObjectiveControlNode(child, nodeId, replacement);
      changed ||= next !== child;
      return next;
    });
    if (!changed) return current;
    return {
      ...current,
      then,
      ...(existingElse === undefined ? {} : { else: elseSteps }),
    };
  }
  return current;
}

function setObjectiveControlLoopBound(
  current: ObjectiveControlNode,
  nodeId: string,
  maxIterations: number,
): ObjectiveControlNode {
  if (current.id === nodeId) {
    if (current.type !== "while") throw new Error(`Loop bound can only be changed on a while node, not ${current.type}`);
    return { ...current, maxIterations };
  }
  if (current.type === "sequence" || current.type === "parallel" || current.type === "while") {
    let changed = false;
    const steps = current.steps.map((child) => {
      const next = setObjectiveControlLoopBound(child, nodeId, maxIterations);
      changed ||= next !== child;
      return next;
    });
    return changed ? { ...current, steps } : current;
  }
  if (current.type === "if") {
    let changed = false;
    const then = current.then.map((child) => {
      const next = setObjectiveControlLoopBound(child, nodeId, maxIterations);
      changed ||= next !== child;
      return next;
    });
    const existingElse = current.else;
    const elseSteps = existingElse?.map((child) => {
      const next = setObjectiveControlLoopBound(child, nodeId, maxIterations);
      changed ||= next !== child;
      return next;
    });
    if (!changed) return current;
    return {
      ...current,
      then,
      ...(existingElse === undefined ? {} : { else: elseSteps }),
    };
  }
  return current;
}

/**
 * Apply a validated control mutation without side effects. Storage can use
 * this function as the deterministic candidate-plan calculation in its CAS
 * transaction, then persist the returned plan and mutation receipt together.
 */
export function applyObjectiveControlMutation(
  plan: ObjectiveControlPlan,
  mutation: ObjectiveControlMutation,
): ObjectiveControlPlan {
  const currentPlan = parseObjectiveControlPlan(plan);
  const currentMutation = parseObjectiveControlMutation(mutation);
  validateObjectiveControlMutationTarget(currentMutation, currentPlan);

  let root = currentPlan.root;
  if (currentMutation.type === "insert-node" || currentMutation.type === "insert-evaluate" || currentMutation.type === "insert-evaluator" || currentMutation.type === "insert-timer" || currentMutation.type === "insert-signal" || currentMutation.type === "insert-checkpoint" || currentMutation.type === "insert-artifact") {
    const insertMutation = currentMutation as ObjectiveControlInsertNodeMutation;
    root = insertObjectiveControlNode(
      root,
      insertMutation.parentId,
      insertMutation.slot,
      insertMutation.position,
      insertMutation.node,
    );
  } else if (currentMutation.type === "replace-node") {
    root = replaceObjectiveControlNode(root, currentMutation.nodeId, currentMutation.node);
  } else if (currentMutation.type === "set-loop-bound") {
    root = setObjectiveControlLoopBound(root, currentMutation.nodeId, currentMutation.maxIterations);
  } else if (currentMutation.type === "remove-subtree") {
    const removed = removeObjectiveControlSubtree(root, currentMutation.nodeId);
    if (!removed.removed) throw new Error(`Mutation target ${currentMutation.nodeId} does not exist in plan ${currentPlan.id}`);
    root = removed.node;
  } else if (currentMutation.type === "rewire-dependencies") {
    const rewired = rewireObjectiveControlNode(root, currentMutation.nodeId, currentMutation.dependsOn);
    if (!rewired.changed) throw new Error(`Mutation target ${currentMutation.nodeId} does not exist in plan ${currentPlan.id}`);
    root = rewired.node;
  } else if (currentMutation.type === "insert-branch") {
    root = insertObjectiveControlNode(root, currentMutation.branchNodeId, currentMutation.branch, currentMutation.position, currentMutation.node);
  } else if (currentMutation.type === "replace-branch") {
    const targetNodeId = currentMutation.nodeId ?? currentMutation.node.id;
    const replaced = replaceBranchChild(root, currentMutation.branchNodeId, currentMutation.branch, targetNodeId, currentMutation.node);
    if (!replaced.replaced) throw new Error(`Branch ${currentMutation.branchNodeId} has no child ${targetNodeId}`);
    root = replaced.node;
  }

  // Reparse all structural and graph invariants. The plan-level fields are
  // copied from the immutable current plan and are never mutation inputs.
  return ObjectiveControlPlanSchema.parse({ ...currentPlan, root });
}

function descendantsByNodeId(plan: ObjectiveControlPlan, removed: Set<string>): void {
  // This helper intentionally walks the tree rather than trusting sourcePath;
  // source paths are descriptive and are allowed to change after insertion.
  const visit = (node: ObjectiveControlNode): void => {
    if (removed.has(node.id)) collectObjectiveControlNodeIds(node, removed);
    if (node.type === "sequence" || node.type === "parallel" || node.type === "while") node.steps.forEach(visit);
    else if (node.type === "if") {
      node.then.forEach(visit);
      node.else?.forEach(visit);
    }
  };
  visit(plan.root);
}

function controlExecutionRecord(
  snapshot: ObjectiveControlPlanSnapshot,
  execution: ObjectiveControlExecutionKey,
): ObjectiveControlExecutionRecord | undefined {
  const id = objectiveControlExecutionId(execution);
  return snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === id);
}

function controlChildKey(parent: ObjectiveControlExecutionKey, childId: string): ObjectiveControlExecutionKey {
  return { nodeId: childId, iterationKey: `${parent.iterationKey}/${parent.nodeId}/${childId}` };
}

function controlBranchChildKey(parent: ObjectiveControlExecutionKey, branch: ObjectiveControlBranch, childId: string): ObjectiveControlExecutionKey {
  return { nodeId: childId, iterationKey: `${parent.iterationKey}/${parent.nodeId}/${branch}/${childId}` };
}

function controlLoopChildKey(parent: ObjectiveControlExecutionKey, iteration: number, childId: string): ObjectiveControlExecutionKey {
  return { nodeId: childId, iterationKey: `${parent.iterationKey}/${parent.nodeId}/iteration-${iteration}/${childId}` };
}

function controlCurrentLoopIteration(
  node: ObjectiveControlWhileNode,
  execution: ObjectiveControlExecutionKey,
  snapshot: ObjectiveControlPlanSnapshot,
): number {
  const executionId = objectiveControlExecutionId(execution);
  let current = snapshot.loopIterations[executionId] ?? 0;
  const prefix = `${execution.iterationKey}/${execution.nodeId}/iteration-`;
  for (const entry of snapshot.executions) {
    if (!entry.key.iterationKey.startsWith(prefix)) continue;
    const parsed = Number(entry.key.iterationKey.slice(prefix.length).split("/", 1)[0]);
    if (Number.isInteger(parsed) && parsed > current) current = parsed;
  }
  if (current === 0 && snapshot.loopIterations[node.id] !== undefined) {
    const hasHistory = snapshot.executions.some((entry) => entry.key.iterationKey.startsWith(prefix));
    if (hasHistory) current = snapshot.loopIterations[node.id]!;
  }
  return current;
}

function controlChildrenFor(
  node: ObjectiveControlNode,
  execution: ObjectiveControlExecutionKey,
  snapshot: ObjectiveControlPlanSnapshot,
): ObjectiveControlExecutionKey[] {
  if (node.type === "sequence" || node.type === "parallel") return node.steps.map((child) => controlChildKey(execution, child.id));
  if (node.type === "if") {
    const branch = snapshot.branches[objectiveControlExecutionId(execution)];
    if (!branch) return [];
    return (branch === "then" ? node.then : node.else ?? []).map((child) => controlBranchChildKey(execution, branch, child.id));
  }
  if (node.type === "while") {
    const iteration = controlCurrentLoopIteration(node, execution, snapshot);
    return iteration <= 0 ? [] : node.steps.map((child) => controlLoopChildKey(execution, iteration, child.id));
  }
  return [];
}

function controlFirstMissingOrUnfinished(
  node: ObjectiveControlSequenceNode | ObjectiveControlIfNode | ObjectiveControlWhileNode,
  execution: ObjectiveControlExecutionKey,
  snapshot: ObjectiveControlPlanSnapshot,
): ObjectiveControlExecutionKey | null {
  for (const child of controlChildrenFor(node, execution, snapshot)) {
    const record = controlExecutionRecord(snapshot, child);
    if (!record || !isObjectiveControlTerminalState(record.state)) return child;
  }
  return null;
}

function controlEnsureExecutions(
  snapshot: ObjectiveControlPlanSnapshot,
  children: ObjectiveControlExecutionKey[],
): ObjectiveControlPlanSnapshot {
  let current = snapshot;
  for (const child of children) {
    if (controlExecutionRecord(current, child)) continue;
    const id = objectiveControlExecutionId(child);
    const record: ObjectiveControlExecutionRecord = {
      key: child,
      state: "queued",
      attemptId: null,
      agentId: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      contextRefs: [],
    };
    current = {
      ...current,
      executions: [...current.executions, record],
      nodeStates: { ...current.nodeStates, [id]: "queued" },
      attemptIds: { ...current.attemptIds, [id]: null },
    };
  }
  return current;
}

function controlAddFrontier(
  frontier: ObjectiveControlExecutionKey[],
  entries: ObjectiveControlExecutionKey[],
): ObjectiveControlExecutionKey[] {
  const seen = new Set(frontier.map(objectiveControlExecutionId));
  return [...frontier, ...entries.filter((entry) => {
    const id = objectiveControlExecutionId(entry);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  })];
}

function controlRemoveFrontier(
  frontier: ObjectiveControlExecutionKey[],
  execution: ObjectiveControlExecutionKey,
): ObjectiveControlExecutionKey[] {
  const id = objectiveControlExecutionId(execution);
  return frontier.filter((entry) => objectiveControlExecutionId(entry) !== id);
}

/**
 * Reconcile the executable frontier after a plan revision is committed.
 *
 * A plan revision and its snapshot are written atomically, but the new plan
 * can contain children that did not exist when the previous snapshot was
 * projected.  Leaving those children out of `frontier` is particularly
 * dangerous for an active parallel node: its existing siblings can all
 * settle while the parent waits forever for an execution record that can
 * never be dispatched.  The same shape can occur after removing the only
 * active child from a container.
 *
 * This reducer only materializes work for already-running containers. Queued
 * containers remain represented by their own frontier entry and will expand
 * normally through the regular acknowledgement path. Sequence-like
 * containers get only their first unfinished child; parallel containers get
 * every unfinished child. Dependencies are still evaluated by
 * `nextObjectiveControlIntent`, so a newly materialized child cannot bypass
 * a prerequisite fence.
 */
function reconcileActiveContainerFrontier(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
): ObjectiveControlPlanSnapshot {
  let result = snapshot;
  const nodes = objectiveControlNodeMap(plan);

  // Iterate over a stable copy: ensureExecutions appends records while this
  // pass is running, but newly appended leaf records must not themselves be
  // considered as container parents.
  for (const parentExecution of [...result.executions]) {
    const parentRecord = controlExecutionRecord(result, parentExecution.key);
    if (!parentRecord || parentRecord.state !== "running") continue;
    const node = nodes.get(parentExecution.key.nodeId);
    if (!node || (node.type !== "sequence" && node.type !== "parallel" && node.type !== "if" && node.type !== "while")) continue;

    const children = controlChildrenFor(node, parentExecution.key, result);
    result = controlEnsureExecutions(result, children);

    if (node.type === "parallel") {
      const unfinished = children.filter((child) => {
        const record = controlExecutionRecord(result, child);
        return record !== undefined && !isObjectiveControlTerminalState(record.state);
      });
      if (unfinished.length === 0) {
        result = { ...result, frontier: controlAddFrontier(result.frontier, [parentExecution.key]) };
      } else {
        result = {
          ...result,
          frontier: controlAddFrontier(controlRemoveFrontier(result.frontier, parentExecution.key), unfinished),
        };
      }
      continue;
    }

    const next = controlFirstMissingOrUnfinished(node, parentExecution.key, result);
    if (!next) {
      // With no unfinished child the parent must be revisited so the regular
      // reducer can issue its join/condition intent and propagate completion.
      result = { ...result, frontier: controlAddFrontier(result.frontier, [parentExecution.key]) };
      continue;
    }

    // A sequence-like parent cannot launch an inserted child while another
    // sibling is already running, even when the insertion is before that
    // sibling. It will be re-evaluated by settleParent when the active child
    // completes. If the next child is itself active, adding it back is
    // harmless and repairs a frontier lost during a crash or removal.
    const nextId = objectiveControlExecutionId(next);
    const activeSibling = children.some((child) => {
      if (objectiveControlExecutionId(child) === nextId) return false;
      const record = controlExecutionRecord(result, child);
      return record !== undefined && !isObjectiveControlTerminalState(record.state);
    });
    if (!activeSibling) {
      result = {
        ...result,
        frontier: controlAddFrontier(controlRemoveFrontier(result.frontier, parentExecution.key), [next]),
      };
    }
  }
  return result;
}

/**
 * Reduce the execution projection for a structural mutation.  Removed
 * running executions are represented by append-only cancellation tombstones;
 * they are never silently dropped, and their attempt IDs remain auditable
 * after a daemon restart.  Non-running removed executions can safely leave
 * the active projection because their immutable plan revision is retained in
 * the revision history.
 */
export function applyObjectiveControlMutationToSnapshot(
  currentPlan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  mutation: ObjectiveControlMutation,
  nextPlan: ObjectiveControlPlan,
  now: string,
): ObjectiveControlPlanSnapshot {
  const parsedSnapshot = ObjectiveControlPlanSnapshotSchema.parse(snapshot);
  const parsedMutation = ObjectiveControlMutationSchema.parse(mutation);
  let result = parsedSnapshot;
  if (parsedMutation.type === "remove-subtree") {
    const currentIds = collectObjectiveControlNodeIds(currentPlan.root);
    const nextIds = collectObjectiveControlNodeIds(nextPlan.root);
    const removedIds = new Set([...currentIds].filter((id) => !nextIds.has(id)));
    descendantsByNodeId(currentPlan, removedIds);
    const removedExecutions = parsedSnapshot.executions.filter((execution) => removedIds.has(execution.key.nodeId));
    const active = removedExecutions.filter((execution) =>
      execution.attemptId !== null && (execution.state === "running" || execution.state === "waiting" || execution.state === "queued"),
    );
    const cancellations = active.map((execution) => ({
      version: 1 as const,
      execution: execution.key,
      attemptId: execution.attemptId,
      agentId: execution.agentId,
      intentId: `objective-control-cancel:${parsedMutation.mutationId}:${objectiveControlExecutionId(execution.key)}`,
      reason: parsedMutation.cancellationIntent.reason,
      cancelledAt: now,
      sourceMutationId: parsedMutation.mutationId,
    }));
    const removedExecutionIds = new Set(removedExecutions.map((execution) => objectiveControlExecutionId(execution.key)));
    const filterRecord = <T,>(entries: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(entries).filter(([id]) => !removedExecutionIds.has(id)));
    result = {
      ...result,
      executions: result.executions.filter((execution) => !removedIds.has(execution.key.nodeId)),
      frontier: result.frontier.filter((execution) => !removedIds.has(execution.nodeId)),
      nodeStates: filterRecord(result.nodeStates),
      branches: filterRecord(result.branches),
      loopIterations: filterRecord(result.loopIterations),
      exitReasons: filterRecord(result.exitReasons),
      attemptIds: filterRecord(result.attemptIds),
      ...(cancellations.length > 0 ? { cancellations: [...(result.cancellations ?? []), ...cancellations] } : {}),
    };
  }

  // The same reconciliation is needed for insertion, replacement, rewiring,
  // and removal. For a no-op mutation this is idempotent and only repairs a
  // frontier that was already inconsistent with its running container.
  result = reconcileActiveContainerFrontier(nextPlan, result);
  return ObjectiveControlPlanSnapshotSchema.parse({ ...result, reason: parsedMutation.reason, createdAt: now });
}

/**
 * Parse helpers are intentionally the public boundary. They make all schema
 * defaults deterministic and ensure graph validation is not accidentally
 * skipped by callers using an `unknown` payload.
 */
export function parseObjectiveControlPlan(value: unknown): ObjectiveControlPlan {
  return ObjectiveControlPlanSchema.parse(value);
}

export function parseObjectiveControlPlanRevision(value: unknown): ObjectiveControlPlanRevision {
  return ObjectiveControlPlanRevisionSchema.parse(value);
}

export function parseObjectiveControlSnapshot(value: unknown): ObjectiveControlPlanSnapshot {
  return ObjectiveControlPlanSnapshotSchema.parse(value);
}

export function parseObjectiveControlMutation(value: unknown): ObjectiveControlMutation {
  return ObjectiveControlMutationSchema.parse(value);
}

export function isObjectiveControlPlan(value: unknown): value is ObjectiveControlPlan {
  return ObjectiveControlPlanSchema.safeParse(value).success;
}

/** Stable canonical JSON for persistence keys, tests, and reducer receipts. */
export function objectiveControlStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => objectiveControlStableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${objectiveControlStableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const ObjectiveControlImpactEdgeSchema = z.object({ from: NodeIdSchema, to: NodeIdSchema }).strict();
export const ObjectiveControlMutationImpactSchema = z.object({
  version: z.literal(1),
  nodesAdded: z.array(NodeIdSchema),
  nodesRemoved: z.array(NodeIdSchema),
  nodesChanged: z.array(NodeIdSchema),
  edgesAdded: z.array(ObjectiveControlImpactEdgeSchema),
  edgesRemoved: z.array(ObjectiveControlImpactEdgeSchema),
  frontierAffected: z.array(z.string().min(1).max(2_048)),
  activeAttemptsCancelled: z.array(IdSchema),
  activeAttemptsOrphaned: z.array(IdSchema),
  authority: z.object({
    permission: z.enum(["read-only", "full-access"]),
    sideEffectClass: z.enum(["read", "local", "external", "irreversible"]),
  }).strict(),
  sideEffectClass: z.enum(["read", "local", "external", "irreversible"]),
  approvalRequired: z.boolean(),
  workspaceChange: z.object({
    changed: z.boolean(),
    pathsAdded: z.array(z.string().min(1)),
    pathsRemoved: z.array(z.string().min(1)),
  }).strict(),
  capabilitiesAdded: z.array(IdSchema),
  capabilitiesRemoved: z.array(IdSchema),
  budgetImpact: z.object({
    modelCallsDelta: z.number().int(),
    toolCallsDelta: z.number().int(),
    loopIterationsDelta: z.number().int(),
    maxConcurrentAgentsBefore: z.number().int().nonnegative(),
    maxConcurrentAgentsAfter: z.number().int().nonnegative(),
  }).strict(),
  concurrencyImpact: z.object({ before: z.number().int().nonnegative(), after: z.number().int().nonnegative(), delta: z.number().int() }).strict(),
  loopImpact: z.object({
    boundsChanged: z.array(z.object({ nodeId: NodeIdSchema, before: z.number().int().positive(), after: z.number().int().positive() }).strict()),
  }).strict(),
  evidence: ObjectiveControlEvidenceSchema,
  supportingEvidence: ObjectiveControlEvidenceSchema,
}).strict();
export type ObjectiveControlMutationImpact = z.infer<typeof ObjectiveControlMutationImpactSchema>;

export const ObjectiveControlCandidatePolicyContextSchema = z.object({
  effectivePermission: z.enum(["read-only", "full-access"]).optional(),
  allowedCapabilities: z.array(IdSchema).optional(),
  workspace: z.object({ path: z.string().min(1) }).passthrough().nullable().optional(),
  sideEffectClassCeiling: z.enum(["read", "local", "external", "irreversible"]).optional(),
  budget: z.object({
    maxModelCalls: z.number().int().nonnegative().nullable().optional(),
    maxConcurrentAgents: z.number().int().nonnegative().nullable().optional(),
    maxLoopIterations: z.number().int().nonnegative().nullable().optional(),
  }).passthrough().optional(),
  consumed: z.object({ modelCalls: z.number().int().nonnegative().default(0), loopIterations: z.number().int().nonnegative().default(0) }).passthrough().optional(),
}).passthrough();
export type ObjectiveControlCandidatePolicyContext = z.infer<typeof ObjectiveControlCandidatePolicyContextSchema>;

export const ObjectiveControlMutationPreviewSchema = z.object({
  version: z.literal(1),
  mutationId: IdSchema,
  planId: IdSchema,
  objectiveId: IdSchema,
  runId: IdSchema,
  expectedRevision: z.number().int().nonnegative(),
  candidatePlan: ObjectiveControlPlanSchema,
  impact: ObjectiveControlMutationImpactSchema,
  valid: z.boolean(),
  errors: z.array(z.string().max(2_000)),
}).strict();
export type ObjectiveControlMutationPreview = z.infer<typeof ObjectiveControlMutationPreviewSchema>;

function flatNodes(plan: ObjectiveControlPlan): Map<string, ObjectiveControlNode> {
  return collectObjectiveControlNodes(plan.root);
}

function flatEdges(plan: ObjectiveControlPlan): Set<string> {
  const edges = new Set<string>();
  for (const node of flatNodes(plan).values()) for (const dependency of node.dependsOn) edges.add(`${node.id}\u0000${dependency}`);
  return edges;
}

function nodeAuthority(plan: ObjectiveControlPlan): { permission: "read-only" | "full-access"; sideEffectClass: "read" | "local" | "external" | "irreversible" } {
  let permission: "read-only" | "full-access" = "read-only";
  let sideEffectClass: "read" | "local" | "external" | "irreversible" = "read";
  for (const node of flatNodes(plan).values()) {
    if (node.type === "agent" && node.permissions === "full-access") permission = "full-access";
    if (node.type === "agent") sideEffectClass = permission === "full-access" ? "local" : sideEffectClass;
    if (node.type === "artifact" || node.type === "checkpoint") sideEffectClass = sideEffectClass === "read" ? "local" : sideEffectClass;
  }
  return { permission, sideEffectClass };
}

function nodeWorkspacePaths(plan: ObjectiveControlPlan): Set<string> {
  return new Set([...flatNodes(plan).values()].flatMap((node) => node.type === "agent" && node.workspace ? [node.workspace.path] : []));
}

function nodeCapabilities(plan: ObjectiveControlPlan): Set<string> {
  return new Set([...flatNodes(plan).values()].flatMap((node) => node.type === "agent" ? node.capabilities ?? [] : []));
}

function countAgents(plan: ObjectiveControlPlan): number {
  return [...flatNodes(plan).values()].filter((node) => node.type === "agent").length;
}

function maxConcurrentAgents(plan: ObjectiveControlPlan): number {
  const walk = (node: ObjectiveControlNode): number => {
    if (node.type === "parallel") return node.steps.reduce((sum, child) => sum + walk(child), 0);
    if (node.type === "sequence" || node.type === "while") return Math.max(0, ...node.steps.map(walk));
    if (node.type === "if") return Math.max(0, ...node.then.concat(node.else ?? []).map(walk));
    return node.type === "agent" ? 1 : 0;
  };
  return walk(plan.root);
}

function candidatePolicyErrors(plan: ObjectiveControlPlan, policy?: ObjectiveControlCandidatePolicyContext): string[] {
  if (!policy) return [];
  const errors: string[] = [];
  const rank = { read: 0, local: 1, external: 2, irreversible: 3 } as const;
  const authority = nodeAuthority(plan);
  if (policy.effectivePermission === "read-only" && authority.permission === "full-access") errors.push("Candidate requests full-access above the objective permission ceiling.");
  if (policy.sideEffectClassCeiling && rank[authority.sideEffectClass] > rank[policy.sideEffectClassCeiling]) errors.push("Candidate side-effect class exceeds the objective policy ceiling.");
  const allowed = new Set(policy.allowedCapabilities ?? []);
  for (const capability of nodeCapabilities(plan)) if (!allowed.has(capability)) errors.push(`Candidate requests unavailable capability ${capability}.`);
  if (policy.workspace?.path) {
    const root = policy.workspace.path.endsWith("/") ? policy.workspace.path : `${policy.workspace.path}/`;
    for (const path of nodeWorkspacePaths(plan)) if (path !== policy.workspace.path && !path.startsWith(root)) errors.push(`Candidate workspace ${path} escapes the objective workspace.`);
  }
  if (policy.budget?.maxModelCalls !== undefined && policy.budget.maxModelCalls !== null && (policy.consumed?.modelCalls ?? 0) + countAgents(plan) > policy.budget.maxModelCalls) errors.push("Candidate exceeds the objective model-call budget.");
  if (policy.budget?.maxConcurrentAgents !== undefined && policy.budget.maxConcurrentAgents !== null && maxConcurrentAgents(plan) > policy.budget.maxConcurrentAgents) errors.push("Candidate exceeds the objective concurrency budget.");
  const loops = [...flatNodes(plan).values()].filter((node): node is ObjectiveControlWhileNode => node.type === "while");
  if (policy.budget?.maxLoopIterations !== undefined && policy.budget.maxLoopIterations !== null && loops.some((node) => node.maxIterations > policy.budget!.maxLoopIterations!)) errors.push("Candidate exceeds the objective loop budget.");
  return errors;
}

/** Compute a deterministic, side-effect-free diff and policy verdict. */
export function previewObjectiveControlMutation(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  mutation: ObjectiveControlMutation,
  options: { policy?: ObjectiveControlCandidatePolicyContext } = {},
): ObjectiveControlMutationPreview {
  const parsedMutation = ObjectiveControlMutationSchema.parse(mutation);
  const currentPlan = ObjectiveControlPlanSchema.parse(plan);
  const currentSnapshot = ObjectiveControlPlanSnapshotSchema.parse(snapshot);
  const candidatePlan = applyObjectiveControlMutation(currentPlan, parsedMutation);
  const beforeNodes = flatNodes(currentPlan);
  const afterNodes = flatNodes(candidatePlan);
  const beforeEdges = flatEdges(currentPlan);
  const afterEdges = flatEdges(candidatePlan);
  const nodesAdded = [...afterNodes.keys()].filter((id) => !beforeNodes.has(id));
  const nodesRemoved = [...beforeNodes.keys()].filter((id) => !afterNodes.has(id));
  const nodesChanged = [...afterNodes.keys()].filter((id) => beforeNodes.has(id) && objectiveControlStableJson(beforeNodes.get(id)) !== objectiveControlStableJson(afterNodes.get(id)));
  const edgesAdded = [...afterEdges].filter((edge) => !beforeEdges.has(edge)).map((edge) => { const [from, to] = edge.split("\u0000"); return { from: from!, to: to! }; });
  const edgesRemoved = [...beforeEdges].filter((edge) => !afterEdges.has(edge)).map((edge) => { const [from, to] = edge.split("\u0000"); return { from: from!, to: to! }; });
  const removedIds = new Set(nodesRemoved);
  const activeAttemptsCancelled = currentSnapshot.executions.filter((execution) => removedIds.has(execution.key.nodeId) && execution.attemptId !== null && ["queued", "running", "waiting"].includes(execution.state)).map((execution) => execution.attemptId!).sort();
  const activeAttemptsOrphaned = currentSnapshot.executions.filter((execution) => removedIds.has(execution.key.nodeId) && execution.attemptId === null && ["queued", "running", "waiting"].includes(execution.state)).map((execution) => objectiveControlExecutionId(execution.key)).sort();
  const beforePaths = nodeWorkspacePaths(currentPlan);
  const afterPaths = nodeWorkspacePaths(candidatePlan);
  const beforeCapabilities = nodeCapabilities(currentPlan);
  const afterCapabilities = nodeCapabilities(candidatePlan);
  const beforeLoops = new Map([...beforeNodes.values()].filter((node): node is ObjectiveControlWhileNode => node.type === "while").map((node) => [node.id, node.maxIterations]));
  const boundsChanged = [...afterNodes.values()].filter((node): node is ObjectiveControlWhileNode => node.type === "while" && beforeLoops.has(node.id) && beforeLoops.get(node.id) !== node.maxIterations).map((node) => ({ nodeId: node.id, before: beforeLoops.get(node.id)!, after: node.maxIterations }));
  const candidateAuthority = nodeAuthority(candidatePlan);
  const approvalRequired = activeAttemptsCancelled.length > 0 || [...afterNodes.values()].some((node) => node.type === "agent" && node.requiresApproval);
  const impact: ObjectiveControlMutationImpact = ObjectiveControlMutationImpactSchema.parse({
    version: 1,
    nodesAdded: nodesAdded.sort(),
    nodesRemoved: nodesRemoved.sort(),
    nodesChanged: nodesChanged.sort(),
    edgesAdded: edgesAdded.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    edgesRemoved: edgesRemoved.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    frontierAffected: currentSnapshot.frontier.filter((entry) => {
      const directlyChanged = nodesChanged.includes(entry.nodeId) || removedIds.has(entry.nodeId);
      const parentChanged = (parsedMutation.type === "insert-node" || parsedMutation.type === "insert-branch" || parsedMutation.type === "insert-evaluate" || parsedMutation.type === "insert-evaluator" || parsedMutation.type === "insert-timer" || parsedMutation.type === "insert-signal" || parsedMutation.type === "insert-checkpoint" || parsedMutation.type === "insert-artifact")
        ? (parsedMutation.type === "insert-branch" ? parsedMutation.branchNodeId : parsedMutation.parentId) === entry.nodeId
        : (parsedMutation.type === "rewire-dependencies" || parsedMutation.type === "set-loop-bound") && parsedMutation.nodeId === entry.nodeId;
      return directlyChanged || parentChanged;
    }).map(objectiveControlExecutionId).sort(),
    activeAttemptsCancelled,
    activeAttemptsOrphaned,
    authority: candidateAuthority,
    sideEffectClass: candidateAuthority.sideEffectClass,
    approvalRequired,
    workspaceChange: { changed: [...beforePaths].some((path) => !afterPaths.has(path)) || [...afterPaths].some((path) => !beforePaths.has(path)), pathsAdded: [...afterPaths].filter((path) => !beforePaths.has(path)).sort(), pathsRemoved: [...beforePaths].filter((path) => !afterPaths.has(path)).sort() },
    capabilitiesAdded: [...afterCapabilities].filter((capability) => !beforeCapabilities.has(capability)).sort(),
    capabilitiesRemoved: [...beforeCapabilities].filter((capability) => !afterCapabilities.has(capability)).sort(),
    budgetImpact: { modelCallsDelta: countAgents(candidatePlan) - countAgents(currentPlan), toolCallsDelta: 0, loopIterationsDelta: [...afterNodes.values()].filter((node) => node.type === "while").reduce((sum, node) => sum + node.maxIterations, 0) - [...beforeNodes.values()].filter((node) => node.type === "while").reduce((sum, node) => sum + node.maxIterations, 0), maxConcurrentAgentsBefore: maxConcurrentAgents(currentPlan), maxConcurrentAgentsAfter: maxConcurrentAgents(candidatePlan) },
    concurrencyImpact: { before: maxConcurrentAgents(currentPlan), after: maxConcurrentAgents(candidatePlan), delta: maxConcurrentAgents(candidatePlan) - maxConcurrentAgents(currentPlan) },
    loopImpact: { boundsChanged },
    evidence: parsedMutation.evidence,
    supportingEvidence: parsedMutation.evidence,
  });
  const errors = candidatePolicyErrors(candidatePlan, options.policy);
  return ObjectiveControlMutationPreviewSchema.parse({ version: 1, mutationId: parsedMutation.mutationId, planId: parsedMutation.planId, objectiveId: parsedMutation.objectiveId, runId: parsedMutation.runId, expectedRevision: parsedMutation.expectedRevision, candidatePlan, impact, valid: errors.length === 0, errors });
}
