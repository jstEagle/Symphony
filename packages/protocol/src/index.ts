import { z } from "zod";

import { ObjectiveAttentionRecordSchema } from "./objective-attention.js";
import { ObjectiveArtifactRecordSchema, ObjectiveArtifactReviewRecordSchema } from "./objective-artifact.js";
import { ObjectiveControlPlanRevisionSchema, ObjectiveControlPlanSnapshotSchema } from "./objective-control.js";
import { ObjectiveAggregateFrontierProjectionSchema, ObjectiveAggregateRunlineProjectionSchema } from "./objective-frontier.js";
import { CapabilityExecutionBindingSchema } from "./capability-execution.js";
import {
  CapabilityResultDecisionRecordSchema,
  CapabilityResultEvaluationRecordSchema,
  CapabilityResultFeedbackRecordSchema,
} from "./capability-result-feedback.js";
import { ObjectiveValueCharterSchema } from "./objective-values.js";
import { WorkspaceManifestSchema } from "./workspace-manifest.js";
import { WorkerEventClassSchema, WorkerEventRawProvenanceSchema } from "./worker-event.js";

export * from "./objective-control.js";
export * from "./objective-artifact.js";
export * from "./objective-attention.js";
export * from "./objective-suspension.js";
export * from "./objective-frontier.js";
export * from "./objective-values.js";
export * from "./objective-handoff.js";
export * from "./capability-library.js";
export * from "./capability-execution.js";
export * from "./session-diagnostics.js";
export * from "./workspace-manifest.js";
export * from "./agent-message.js";
export * from "./worker-event.js";
export * from "./capability-result-feedback.js";

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

/**
 * A caller's request to append future steps to one running workflow plan.
 *
 * The authenticated author is deliberately not part of this input contract;
 * the daemon derives it from the request capability before creating a durable
 * mutation record. Keep this schema strict so callers cannot smuggle an
 * identity field into a request that the workflow layer might accidentally
 * trust later.
 */
export const WorkflowPlanMutationInputSchema = z
  .object({
    version: z.literal(1),
    runId: IdSchema,
    expectedPlanRevision: z.number().int().nonnegative(),
    operation: z.literal("append"),
    steps: z.array(JsonValueSchema).min(1).max(128),
    reason: z.string().min(1).max(2_000).optional(),
  })
  .strict();
export type WorkflowPlanMutationInput = z.infer<typeof WorkflowPlanMutationInputSchema>;

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

/** A bounded, machine-evaluable statement of what an objective must achieve. */
export const ObjectiveCriterionSchema = z
  .object({
    id: IdSchema,
    description: z.string().min(1).max(2_000),
    path: z.string().min(1).max(500),
    op: z.enum(["exists", "equals", "not-equals", "contains", "matches", "gt", "gte", "lt", "lte"]),
    value: JsonValueSchema.optional(),
    default: JsonValueSchema.optional(),
    required: z.boolean().default(true),
  })
  .strict();
export type ObjectiveCriterion = z.infer<typeof ObjectiveCriterionSchema>;

export const ObjectiveApprovalPolicySchema = z
  .object({
    mode: z.enum(["never", "on-replan", "before-completion"]),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict();
export type ObjectiveApprovalPolicy = z.infer<typeof ObjectiveApprovalPolicySchema>;

/** Immutable objective intent captured by an objective run. */
export const ObjectiveSpecSchema = z
  .object({
    id: IdSchema,
    statement: z.string().min(1).max(20_000),
    criteria: z.array(ObjectiveCriterionSchema).max(12).default([]),
    /** Optional immutable user/agent values charter; absent preserves legacy objectives. */
    valueCharter: ObjectiveValueCharterSchema.optional(),
    approvalPolicy: ObjectiveApprovalPolicySchema.default({ mode: "never" }),
    maxReplans: z.number().int().nonnegative().max(128).default(8),
  })
  .strict()
  .superRefine((spec, context) => {
    const seen = new Set<string>();
    for (const [index, criterion] of spec.criteria.entries()) {
      if (seen.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "id"],
          message: `Duplicate objective criterion id: ${criterion.id}`,
        });
      }
      seen.add(criterion.id);
    }
  });
export type ObjectiveSpec = z.infer<typeof ObjectiveSpecSchema>;

/** Evidence high-water and references used to justify a plan or evaluation. */
export const ObjectiveEvidenceSchema = z
  .object({
    eventCursor: z.number().int().nonnegative(),
    eventIds: z.array(IdSchema).max(128).default([]),
    observationIds: z.array(IdSchema).max(128).default([]),
    summary: z.string().max(2_000).optional(),
  })
  .strict();
export type ObjectiveEvidence = z.infer<typeof ObjectiveEvidenceSchema>;

/** A single executable node in a mutable objective plan. */
export const ObjectiveTaskSchema = z
  .object({
    id: IdSchema,
    objective: z.string().min(1).max(20_000),
    dependsOn: z.array(IdSchema).max(128).default([]),
    outputSchema: z.record(z.string(), JsonValueSchema).default({}),
    model: z.string().min(1).default("auto"),
    harness: HarnessSchema.default("auto"),
    // Permission is intentionally unresolved here; the runtime derives it
    // from the objective/run authority envelope and parent ceiling.
    permissions: PermissionSchema.optional(),
    inputs: z.array(AgentInputSchema).max(128).default([]),
    routing: RoutingIntentSchema.optional(),
    workspace: WorkspaceSpecSchema.optional(),
    capabilities: z.array(IdSchema).max(256).optional(),
    /** Exact activated capability input, when this task opts into one. */
    capabilityExecution: CapabilityExecutionBindingSchema.optional(),
    requiresApproval: z.boolean().default(false),
  })
  .strict()
  .superRefine((task, context) => {
    const seen = new Set<string>();
    for (const [index, dependencyId] of task.dependsOn.entries()) {
      if (seen.has(dependencyId)) {
        context.addIssue({
          code: "custom",
          path: ["dependsOn", index],
          message: `Duplicate dependency ${dependencyId} for objective task ${task.id}`,
        });
      }
      if (dependencyId === task.id) {
        context.addIssue({
          code: "custom",
          path: ["dependsOn", index],
          message: `Objective task ${task.id} cannot depend on itself`,
        });
      }
      seen.add(dependencyId);
    }
  });
export type ObjectiveTask = z.infer<typeof ObjectiveTaskSchema>;

export const ObjectiveTaskStateSchema = z.enum([
  "queued",
  "waiting-approval",
  "running",
  "completed",
  "failed",
  "superseded",
  "blocked",
]);
export type ObjectiveTaskState = z.infer<typeof ObjectiveTaskStateSchema>;

/** Durable projection of one task definition and its latest attempt. */
export const ObjectiveTaskRecordSchema = z
  .object({
    task: ObjectiveTaskSchema,
    state: ObjectiveTaskStateSchema,
    attemptId: IdSchema.nullable(),
    agentId: IdSchema.nullable(),
    output: JsonValueSchema.nullable(),
    error: z.string().nullable(),
    startedAt: IsoDateSchema.nullable(),
    finishedAt: IsoDateSchema.nullable(),
  })
  .strict();
export type ObjectiveTaskRecord = z.infer<typeof ObjectiveTaskRecordSchema>;

export const ObjectiveCriterionResultSchema = z
  .object({
    criterionId: IdSchema,
    passed: z.boolean(),
    actual: JsonValueSchema,
    expected: JsonValueSchema,
    evidenceEventIds: z.array(IdSchema).max(128).default([]),
    evaluatedAt: IsoDateSchema,
  })
  .strict();
export type ObjectiveCriterionResult = z.infer<typeof ObjectiveCriterionResultSchema>;

/** The authenticated principal responsible for a durable objective action. */
export const ObjectiveActorSchema = z
  .object({
    type: z.enum(["user", "agent", "system"]),
    id: IdSchema,
  })
  .strict();
export type ObjectiveActor = z.infer<typeof ObjectiveActorSchema>;

/**
 * The durable outcome of an objective command.  `unknown` is deliberately a
 * first-class terminal state: if a command reaches an external boundary and
 * the process cannot establish whether it committed, a retry must not guess.
 * The client can reread the command record and let a reconciler resolve it.
 */
export const ObjectiveCommandLedgerOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("committed"),
    result: JsonValueSchema,
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    result: JsonValueSchema,
    reason: z.string().min(1).max(4_000),
  }).strict(),
  z.object({
    status: z.literal("unknown"),
    result: z.null(),
    reason: z.string().min(1).max(4_000),
  }).strict(),
]);
export type ObjectiveCommandLedgerOutcome = z.infer<typeof ObjectiveCommandLedgerOutcomeSchema>;

/**
 * Append-only request identity and immutable command outcome.  This is
 * separate from the older provider command receipt table so objective
 * mutations can carry their objective/run authority and a canonical request
 * fingerprint without relying on provider-specific result shapes.
 */
export const ObjectiveCommandLedgerRecordSchema = z.object({
  version: z.literal(1),
  requestKey: z.string().min(8).max(512),
  operation: z.string().min(1).max(200),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  actor: ObjectiveActorSchema,
  objectiveId: IdSchema.nullable(),
  runId: IdSchema.nullable(),
  outcome: ObjectiveCommandLedgerOutcomeSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
}).strict();
export type ObjectiveCommandLedgerRecord = z.infer<typeof ObjectiveCommandLedgerRecordSchema>;

export const ObjectiveSideEffectClassSchema = z.enum(["read", "local", "external", "irreversible"]);
export type ObjectiveSideEffectClass = z.infer<typeof ObjectiveSideEffectClassSchema>;

/**
 * The scalar counters used by an objective budget. A zero value means that
 * the run has consumed none of that resource; a null limit means unlimited.
 * Unknown provider usage must not be represented by zero -- callers should
 * reject or pause until they can produce a known debit.
 */
export const ObjectiveBudgetUsageSchema = z
  .object({
    costUsd: z.number().finite().nonnegative().default(0),
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    // If omitted, totalTokens is deterministically derived from input and
    // output rather than being silently treated as zero.
    totalTokens: z.number().int().nonnegative().optional(),
    modelCalls: z.number().int().nonnegative().default(0),
    toolCalls: z.number().int().nonnegative().default(0),
    wallTimeSeconds: z.number().finite().nonnegative().default(0),
    outputBytes: z.number().int().nonnegative().default(0),
    storageBytes: z.number().int().nonnegative().default(0),
    loopIterations: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.totalTokens !== undefined && usage.totalTokens < usage.inputTokens + usage.outputTokens) {
      context.addIssue({
        code: "custom",
        path: ["totalTokens"],
        message: "totalTokens must be at least inputTokens + outputTokens",
      });
    }
  })
  .transform((usage) => ({
    ...usage,
    totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
  }));
export type ObjectiveBudgetUsage = z.infer<typeof ObjectiveBudgetUsageSchema>;

/** Run-scoped ceilings. Null is the explicit, durable representation of no limit. */
export const ObjectiveBudgetLimitsSchema = z
  .object({
    maxCostUsd: z.number().finite().nonnegative().nullable().default(null),
    maxInputTokens: z.number().int().nonnegative().nullable().default(null),
    maxOutputTokens: z.number().int().nonnegative().nullable().default(null),
    maxTotalTokens: z.number().int().nonnegative().nullable().default(null),
    maxModelCalls: z.number().int().nonnegative().nullable().default(null),
    maxToolCalls: z.number().int().nonnegative().nullable().default(null),
    maxWallTimeSeconds: z.number().finite().nonnegative().nullable().default(null),
    maxOutputBytes: z.number().int().nonnegative().nullable().default(null),
    maxStorageBytes: z.number().int().nonnegative().nullable().default(null),
    maxLoopIterations: z.number().int().nonnegative().nullable().default(null),
    maxConcurrentAgents: z.number().int().nonnegative().nullable().default(null),
    maxDepth: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export type ObjectiveBudgetLimits = z.infer<typeof ObjectiveBudgetLimitsSchema>;

/**
 * The policy values an objective admission may request. Identity, workspace,
 * and the resulting hash are daemon-owned and therefore intentionally absent.
 * Every optional value is intersected with the authenticated caller's grant
 * and the current global safety ceiling before it becomes durable policy.
 */
export const ObjectivePolicyRequestSchema = z
  .object({
    effectivePermission: PermissionSchema.optional(),
    allowedCapabilities: z.array(IdSchema).max(256).optional(),
    budget: ObjectiveBudgetLimitsSchema.optional(),
    sideEffectClassCeiling: ObjectiveSideEffectClassSchema.optional(),
    approvalPolicy: ObjectiveApprovalPolicySchema.optional(),
    expiresAt: IsoDateSchema.nullable().optional(),
  })
  .strict();
export type ObjectivePolicyRequest = z.infer<typeof ObjectivePolicyRequestSchema>;

/** A daemon/configuration ceiling used while deriving an admission snapshot. */
export const ObjectivePolicyCeilingSchema = ObjectivePolicyRequestSchema;
export type ObjectivePolicyCeiling = ObjectivePolicyRequest;

export const ObjectiveBudgetStatusSchema = z.enum(["active", "paused", "exhausted", "settled"]);
export type ObjectiveBudgetStatus = z.infer<typeof ObjectiveBudgetStatusSchema>;

export const ObjectivePauseReasonSchema = z.enum([
  "budget-exhausted",
  "budget-unknown-usage",
  "approval-required",
  "manual",
  "dependency-blocked",
  "harness-unavailable",
  "outcome-unknown",
  "crash-recovery",
  "policy-expired",
]);
export type ObjectivePauseReason = z.infer<typeof ObjectivePauseReasonSchema>;

/**
 * Immutable authority/budget envelope captured at objective admission. Child
 * work may narrow this envelope but must never mutate or widen it. The hash
 * is supplied by the authority that created the snapshot and is carried on
 * every run/approval/accounting record that relies on it.
 */
export const ObjectivePolicySnapshotSchema = z
  .object({
    version: z.literal(1),
    policyVersion: z.number().int().positive(),
    policyHash: z.string().min(8).max(256),
    runId: IdSchema,
    objectiveId: IdSchema,
    workflowId: IdSchema,
    workflowRevision: z.number().int().positive(),
    workflowHash: z.string().min(8),
    actor: ObjectiveActorSchema,
    effectivePermission: PermissionSchema,
    allowedCapabilities: z.array(IdSchema).max(256),
    // A local objective may be admitted without a filesystem grant. Agent
    // callers are required to supply an inherited grant at the daemon edge.
    workspace: WorkspaceSpecSchema.nullable(),
    budget: ObjectiveBudgetLimitsSchema,
    sideEffectClassCeiling: ObjectiveSideEffectClassSchema,
    approvalPolicy: ObjectiveApprovalPolicySchema,
    expiresAt: IsoDateSchema.nullable(),
    createdAt: IsoDateSchema,
  })
  .strict();
export type ObjectivePolicySnapshot = z.infer<typeof ObjectivePolicySnapshotSchema>;

/**
 * Return a deterministic JSON representation with object keys sorted at every
 * level. Policy hashes are identity data, so callers must not rely on the
 * insertion order of a parsed or reconstructed object.
 */
export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 over the canonical objective policy content. The embedded
 * `policyHash` is always excluded, including when a caller passes a complete
 * snapshot, so this function is safe to use for both admission and
 * verification. This implementation is deliberately runtime-neutral: the
 * protocol package is also consumed by the browser and must not depend on
 * Node's `crypto` module.
 */
export function objectivePolicyHash(
  policy: ObjectivePolicySnapshot | Omit<ObjectivePolicySnapshot, "policyHash">,
): string {
  const { policyHash: _ignored, ...content } = policy as ObjectivePolicySnapshot;
  return sha256(stableJsonStringify(content));
}

/** Verify the immutable identity carried by an objective policy snapshot. */
export function isObjectivePolicyHashValid(policy: ObjectivePolicySnapshot): boolean {
  return objectivePolicyHash(policy) === policy.policyHash;
}

export const ObjectiveRunStateSchema = z.enum([
  "planning",
  "executing",
  "evaluating",
  "awaiting-approval",
  "replanning",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ObjectiveRunState = z.infer<typeof ObjectiveRunStateSchema>;

function addObjectiveTaskGraphIssues(
  tasks: readonly ObjectiveTaskRecord[],
  context: z.RefinementCtx,
): void {
  const taskIds = new Set<string>();
  const taskIndexes = new Map<string, number>();
  for (const [index, task] of tasks.entries()) {
    if (taskIds.has(task.task.id)) {
      context.addIssue({
        code: "custom",
        path: ["tasks", index, "task", "id"],
        message: `Duplicate objective task id: ${task.task.id}`,
      });
    } else {
      taskIndexes.set(task.task.id, index);
    }
    taskIds.add(task.task.id);
  }

  for (const [index, task] of tasks.entries()) {
    const dependencies = new Set<string>();
    for (const [dependencyIndex, dependencyId] of task.task.dependsOn.entries()) {
      if (dependencies.has(dependencyId)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "task", "dependsOn", dependencyIndex],
          message: `Duplicate dependency ${dependencyId} for objective task ${task.task.id}`,
        });
      }
      if (dependencyId === task.task.id) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "task", "dependsOn", dependencyIndex],
          message: `Objective task ${task.task.id} cannot depend on itself`,
        });
      }
      if (!taskIds.has(dependencyId)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "task", "dependsOn", dependencyIndex],
          message: `Objective task ${task.task.id} depends on unknown task ${dependencyId}`,
        });
      }
      dependencies.add(dependencyId);
    }
  }

  // The task count and dependency list are both bounded by their schemas, so
  // this DFS has a finite maximum depth and cannot spin on malformed input.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) return;
    visiting.add(taskId);
    const task = tasks[taskIndexes.get(taskId) ?? -1];
    if (task) {
      for (const [dependencyIndex, dependencyId] of task.task.dependsOn.entries()) {
        if (!taskIds.has(dependencyId)) continue;
        if (visiting.has(dependencyId)) {
          context.addIssue({
            code: "custom",
            path: ["tasks", taskIndexes.get(taskId) ?? 0, "task", "dependsOn", dependencyIndex],
            message: `Objective task dependency cycle detected through ${dependencyId}`,
          });
          continue;
        }
        visit(dependencyId);
      }
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of taskIds) visit(taskId);
}

export const ObjectiveRunRecordSchema = z
  .object({
    version: z.literal(1),
    runId: IdSchema,
    objectiveId: IdSchema,
    /** Immutable objective mission revision inherited by this run. Omitted on legacy records. */
    objectiveRevision: z.number().int().positive().optional(),
    workflowId: IdSchema,
    workflowRevision: z.number().int().positive(),
    workflowHash: z.string().min(8),
    conductorAgentId: IdSchema.nullable(),
    // These fields were added after version 1. Missing values are preserved
    // as absent for old records: storage must never infer a policy, access
    // grant, or zero budget from legacy history.
    policy: ObjectivePolicySnapshotSchema.nullable().optional(),
    policyHash: z.string().min(8).max(256).nullable().optional(),
    /** Content-addressed charter binding captured at objective admission. */
    valueCharterRevision: z.number().int().positive().max(1_000_000_000).optional(),
    valueCharterHash: z.string().min(8).max(256).optional(),
    pauseReason: z.string().min(1).max(2_000).nullable().optional(),
    spec: ObjectiveSpecSchema,
    state: ObjectiveRunStateSchema,
    activePlanRevision: z.number().int().nonnegative(),
    latestCheckpointId: IdSchema.nullable(),
    pendingApprovalId: IdSchema.nullable(),
    replanCount: z.number().int().nonnegative(),
    tasks: z.array(ObjectiveTaskRecordSchema).max(128).default([]),
    context: z.record(z.string(), JsonValueSchema).default({}),
    output: JsonValueSchema.nullable(),
    error: z.string().nullable(),
    requestKey: z.string().min(8),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
    startedAt: IsoDateSchema.nullable(),
    finishedAt: IsoDateSchema.nullable(),
  })
  .strict()
  .superRefine((run, context) => addObjectiveTaskGraphIssues(run.tasks, context));
export type ObjectiveRunRecord = z.infer<typeof ObjectiveRunRecordSchema>;

/** Durable aggregate for one objective's reserved and consumed resources. */
export const ObjectiveBudgetLedgerRecordSchema = z
  .object({
    version: z.literal(1),
    runId: IdSchema,
    objectiveId: IdSchema,
    policyHash: z.string().min(8).max(256),
    limits: ObjectiveBudgetLimitsSchema,
    reserved: ObjectiveBudgetUsageSchema,
    consumed: ObjectiveBudgetUsageSchema,
    status: ObjectiveBudgetStatusSchema,
    pauseReason: z.string().min(1).max(2_000).nullable(),
    revision: z.number().int().nonnegative(),
    requestKey: z.string().min(8),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  })
  .strict();
export type ObjectiveBudgetLedgerRecord = z.infer<typeof ObjectiveBudgetLedgerRecordSchema>;
export const ObjectiveBudgetLedgerSchema = ObjectiveBudgetLedgerRecordSchema;
export type ObjectiveBudgetLedger = ObjectiveBudgetLedgerRecord;

export const ObjectiveBudgetReservationStateSchema = z.enum(["reserved", "released", "consumed", "cancelled"]);
export type ObjectiveBudgetReservationState = z.infer<typeof ObjectiveBudgetReservationStateSchema>;

/** A deterministic hold placed before an attempt starts. */
export const ObjectiveBudgetReservationRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    runId: IdSchema,
    objectiveId: IdSchema,
    policyHash: z.string().min(8).max(256),
    reservationKey: IdSchema,
    attemptId: IdSchema.nullable(),
    agentId: IdSchema.nullable(),
    amount: ObjectiveBudgetUsageSchema,
    state: ObjectiveBudgetReservationStateSchema,
    revision: z.number().int().nonnegative().default(0),
    requestKey: z.string().min(8),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
    releasedAt: IsoDateSchema.nullable().default(null),
  })
  .strict();
export type ObjectiveBudgetReservationRecord = z.infer<typeof ObjectiveBudgetReservationRecordSchema>;
export const ObjectiveBudgetReservationSchema = ObjectiveBudgetReservationRecordSchema;
export type ObjectiveBudgetReservation = ObjectiveBudgetReservationRecord;

export const ObjectiveBudgetDebitBasisSchema = z.enum([
  "provider-reported",
  "harness-reported",
  "token-priced-estimate",
  "reconstructed-estimate",
]);
export type ObjectiveBudgetDebitBasis = z.infer<typeof ObjectiveBudgetDebitBasisSchema>;

/**
 * An immutable, exactly-once usage debit. `usageEventKey` must be stable when
 * a native event is replayed; unknown usage is explicit and cannot be debited
 * as a fabricated zero.
 */
export const ObjectiveBudgetDebitRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    runId: IdSchema,
    objectiveId: IdSchema,
    policyHash: z.string().min(8).max(256),
    usageEventKey: IdSchema,
    reservationId: IdSchema.nullable().default(null),
    usage: ObjectiveBudgetUsageSchema,
    usageKnown: z.boolean().default(true),
    basis: ObjectiveBudgetDebitBasisSchema,
    requestKey: z.string().min(8),
    createdAt: IsoDateSchema,
  })
  .strict()
  .superRefine((debit, context) => {
    if (!debit.usageKnown) {
      context.addIssue({
        code: "custom",
        path: ["usageKnown"],
        message: "Unknown usage must be reconciled before creating a budget debit",
      });
    }
  });
export type ObjectiveBudgetDebitRecord = z.infer<typeof ObjectiveBudgetDebitRecordSchema>;
export const ObjectiveBudgetDebitSchema = ObjectiveBudgetDebitRecordSchema;
export type ObjectiveBudgetDebit = ObjectiveBudgetDebitRecord;

export const ObjectiveCheckpointRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    runId: IdSchema,
    objectiveId: IdSchema,
    // Optional for legacy checkpoints that predate admission policy. New
    // policy-backed checkpoints carry the immutable run hash.
    policyHash: z.string().min(8).max(256).nullable().optional(),
    sequence: z.number().int().positive(),
    planRevision: z.number().int().nonnegative(),
    eventCursor: z.number().int().nonnegative(),
    context: z.record(z.string(), JsonValueSchema).default({}),
    taskStates: z.record(z.string(), ObjectiveTaskStateSchema).default({}),
    criteria: z.array(ObjectiveCriterionResultSchema).max(12).default([]),
    contextHash: z.string().min(8),
    reason: z.string().min(1).max(2_000),
    createdBy: ObjectiveActorSchema,
    requestKey: z.string().min(8),
    createdAt: IsoDateSchema,
    /**
     * Portable recovery evidence is additive.  These fields are optional on
     * the compatibility schema because retained v1 rows must stay readable;
     * the daemon's new checkpoint writer always supplies the complete set.
     */
    objectiveRevision: z.number().int().positive().optional(),
    workflowRevision: z.number().int().positive().optional(),
    workflowHash: z.string().min(8).optional(),
    controlPlanRevision: z.number().int().nonnegative().nullable().optional(),
    controlPlanHash: z.string().min(8).nullable().optional(),
    flatExecution: z.object({
      state: ObjectiveRunStateSchema,
      context: z.record(z.string(), JsonValueSchema),
      tasks: z.array(ObjectiveTaskRecordSchema).max(128),
      outputs: z.record(z.string(), JsonValueSchema),
    }).strict().optional(),
    treeExecution: ObjectiveControlPlanSnapshotSchema.nullable().optional(),
    outputs: z.record(z.string(), JsonValueSchema).optional(),
    /** High-water marks are monotonic within one run/checkpoint lineage. */
    attemptHighWater: z.number().int().nonnegative().optional(),
    eventHighWater: z.number().int().nonnegative().optional(),
    artifactHashes: z.array(z.union([
      z.string().regex(/^[a-f0-9]{64}$/iu),
      z.object({ id: IdSchema, hash: z.string().regex(/^[a-f0-9]{64}$/iu) }).strict(),
    ])).max(2_000).optional(),
    workspaceEvidence: z.object({
      canonicalGrant: WorkspaceSpecSchema.nullable(),
      git: z.object({
        repo: z.string().nullable(),
        repository: z.string().nullable().optional(),
        ref: z.string().nullable(),
        commit: z.string().nullable(),
        dirty: z.boolean().nullable(),
        patchHash: z.string().regex(/^[a-f0-9]{64}$/iu).nullable(),
        worktree: z.string().nullable(),
      }).strict(),
      /** Null means the daemon could not prove a clean/dirty answer. */
      dirty: z.boolean().nullable(),
      patchHash: z.string().regex(/^[a-f0-9]{64}$/iu).nullable(),
      worktree: z.string().nullable(),
      /** Optional content-addressed workspace boundary (additive to v1 evidence). */
      workspaceManifest: WorkspaceManifestSchema.nullable().optional(),
    }).strict().nullable().optional(),
    /** Optional top-level binding for callers that persist the manifest separately from legacy evidence. */
    workspaceManifest: WorkspaceManifestSchema.nullable().optional(),
    nativeSessions: z.array(z.object({
      agentId: IdSchema,
      attemptId: IdSchema.nullable(),
      nativeSessionId: IdSchema.nullable(),
      nativeRunId: IdSchema.nullable(),
      continuity: z.enum(["proven", "unknown", "unsupported"]),
      continuityCapabilities: z.array(z.string().min(1).max(128)).max(64),
      evidence: z.array(IdSchema).max(256).default([]),
    }).strict()).max(256).optional(),
    continuity: z.object({
      status: z.enum(["proven", "unknown", "unsupported"]),
      capabilities: z.array(z.string().min(1).max(128)).max(128),
      reason: z.string().max(2_000).nullable(),
    }).strict().optional(),
    unresolvedExternalOperations: z.array(z.object({
      operationId: IdSchema,
      idempotencyKey: IdSchema,
      requestHash: z.string().min(8).max(256).nullable(),
      receipt: JsonValueSchema.nullable(),
      status: z.enum(["unresolved", "unknown", "settled"]),
    }).strict()).max(256).optional(),
    /** Alias kept for callers that use side-effect terminology. */
    unresolvedExternalSideEffects: z.array(z.object({
      operationId: IdSchema,
      idempotencyKey: IdSchema,
      requestHash: z.string().min(8).max(256).nullable(),
      receipt: JsonValueSchema.nullable(),
      status: z.enum(["unresolved", "unknown", "settled"]),
    }).strict()).max(256).optional(),
    policySnapshotHash: z.string().min(8).max(256).nullable().optional(),
    configSnapshotHash: z.string().min(8).max(256).nullable().optional(),
    provenance: z.object({
      source: z.enum(["daemon", "workflow", "driver", "user", "recovery"]),
      actor: ObjectiveActorSchema,
      capturedAt: IsoDateSchema,
      evidenceEventIds: z.array(IdSchema).max(512).default([]),
      parentCheckpointId: IdSchema.nullable(),
      baseCheckpointId: IdSchema.nullable(),
    }).strict().optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const seen = new Set<string>();
    for (const [index, result] of checkpoint.criteria.entries()) {
      if (seen.has(result.criterionId)) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "criterionId"],
          message: `Duplicate objective criterion result id: ${result.criterionId}`,
        });
      }
      seen.add(result.criterionId);
    }
  });
export type ObjectiveCheckpointRecord = z.infer<typeof ObjectiveCheckpointRecordSchema>;

/**
 * New checkpoints are required to be portable records. This refinement is
 * intentionally separate from ObjectiveCheckpointRecordSchema so a daemon
 * restart can still read historical v1 rows that predate portable evidence.
 */
export const ObjectivePortableCheckpointRecordSchema = ObjectiveCheckpointRecordSchema.superRefine((record, context) => {
  const required: Array<keyof ObjectiveCheckpointRecord> = [
    "objectiveRevision",
    "workflowRevision",
    "workflowHash",
    "controlPlanRevision",
    "controlPlanHash",
    "flatExecution",
    "treeExecution",
    "outputs",
    "attemptHighWater",
    "eventHighWater",
    "artifactHashes",
    "workspaceEvidence",
    "nativeSessions",
    "continuity",
    "unresolvedExternalOperations",
    "policySnapshotHash",
    "configSnapshotHash",
    "provenance",
  ];
  for (const key of required) {
    if (record[key] === undefined) {
      context.addIssue({ code: "custom", path: [key], message: `Portable checkpoint requires ${String(key)}` });
    }
  }
  if (record.eventHighWater !== undefined && record.eventHighWater < record.eventCursor) {
    context.addIssue({ code: "custom", path: ["eventHighWater"], message: "eventHighWater cannot be behind eventCursor" });
  }
  if (record.attemptHighWater !== undefined && record.attemptHighWater < 0) {
    context.addIssue({ code: "custom", path: ["attemptHighWater"], message: "attemptHighWater must be non-negative" });
  }
  if (record.continuity?.status === "proven" && record.continuity.capabilities.length === 0) {
    context.addIssue({ code: "custom", path: ["continuity", "capabilities"], message: "Proven continuity requires at least one capability" });
  }
  if (record.continuity?.status === "proven" && (record.nativeSessions ?? []).length === 0) {
    context.addIssue({ code: "custom", path: ["nativeSessions"], message: "Proven continuity requires at least one native session" });
  }
  for (const [index, session] of (record.nativeSessions ?? []).entries()) {
    if (session.continuity === "proven" && session.nativeSessionId === null) {
      context.addIssue({ code: "custom", path: ["nativeSessions", index, "nativeSessionId"], message: "A proven native session must retain its native session id" });
    }
  }
});
export type ObjectivePortableCheckpointRecord = z.infer<typeof ObjectivePortableCheckpointRecordSchema>;

export const ObjectiveCheckpointResumeCommandSchema = z.object({
  version: z.literal(1).default(1),
  runId: IdSchema,
  checkpointId: IdSchema,
  expectedSequence: z.number().int().positive().optional(),
  attemptId: IdSchema.nullable().optional(),
}).strict();
export type ObjectiveCheckpointResumeCommand = z.infer<typeof ObjectiveCheckpointResumeCommandSchema>;

export const ObjectiveCheckpointRetryCommandSchema = z.object({
  version: z.literal(1).default(1),
  runId: IdSchema,
  checkpointId: IdSchema,
  activity: z.object({
    kind: z.enum(["task", "control"]),
    id: IdSchema,
    attemptId: IdSchema.nullable().optional(),
  }).strict(),
  expectedSequence: z.number().int().positive().optional(),
}).strict();
export type ObjectiveCheckpointRetryCommand = z.infer<typeof ObjectiveCheckpointRetryCommandSchema>;

export const ObjectiveCheckpointForkCommandSchema = z.object({
  version: z.literal(1).default(1),
  runId: IdSchema,
  checkpointId: IdSchema,
  newRunId: IdSchema.optional(),
  occurrenceKey: z.string().min(1).max(512).optional(),
  reason: z.string().min(1).max(2_000),
}).strict();
export type ObjectiveCheckpointForkCommand = z.infer<typeof ObjectiveCheckpointForkCommandSchema>;

export const ObjectiveCheckpointCommandSchema = z.discriminatedUnion("operation", [
  ObjectiveCheckpointResumeCommandSchema.extend({ operation: z.literal("resume") }),
  ObjectiveCheckpointRetryCommandSchema.extend({ operation: z.literal("retry") }),
  ObjectiveCheckpointForkCommandSchema.extend({ operation: z.literal("fork") }),
]);
export type ObjectiveCheckpointCommand = z.infer<typeof ObjectiveCheckpointCommandSchema>;

// Naming aliases keep the wire contract discoverable for callers that name
// the action before the checkpoint while retaining one canonical schema.
export const ObjectiveResumeCheckpointCommandSchema = ObjectiveCheckpointResumeCommandSchema;
export const ObjectiveRetryCheckpointCommandSchema = ObjectiveCheckpointRetryCommandSchema;
export const ObjectiveForkCheckpointCommandSchema = ObjectiveCheckpointForkCommandSchema;
export type ObjectiveResumeCheckpointCommand = ObjectiveCheckpointResumeCommand;
export type ObjectiveRetryCheckpointCommand = ObjectiveCheckpointRetryCommand;
export type ObjectiveForkCheckpointCommand = ObjectiveCheckpointForkCommand;

const ObjectiveApprovalIdentityFields = {
  operationId: IdSchema,
  requestHash: z.string().min(8).max(256),
  policyHash: z.string().min(8).max(256),
  sideEffectClass: ObjectiveSideEffectClassSchema,
  canonicalTarget: z.string().min(1).max(2_000),
  capability: z.string().min(1).nullable().default(null),
  expiresAt: IsoDateSchema.nullable().default(null),
};

/** Immutable identity bound to an approval and checked again on replay. */
export const ObjectiveApprovalIdentitySchema = z
  .object(ObjectiveApprovalIdentityFields)
  .strict()
  .superRefine((identity, context) => {
    if ((identity.sideEffectClass === "external" || identity.sideEffectClass === "irreversible") && identity.expiresAt === null) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: `Approval expiry is required for ${identity.sideEffectClass} operations`,
      });
    }
  });
export type ObjectiveApprovalIdentity = z.infer<typeof ObjectiveApprovalIdentitySchema>;

export const ObjectiveApprovalRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    runId: IdSchema,
    objectiveId: IdSchema,
    planRevision: z.number().int().nonnegative(),
    // Control-node approvals are durable run-scoped gates. They are separate
    // from flat task approvals so the runner can bind the request to one
    // reducer intent/execution/attempt before acknowledging it.
    kind: z.enum(["plan", "task", "control", "completion"]),
    taskId: IdSchema.nullable().default(null),
    question: z.string().min(1).max(2_000),
    scope: z.record(z.string(), JsonValueSchema).default({}),
    ...ObjectiveApprovalIdentityFields,
    requestedBy: ObjectiveActorSchema,
    status: z.enum(["requested", "approved", "rejected", "expired", "cancelled"]),
    decision: JsonValueSchema.nullable().default(null),
    decidedBy: ObjectiveActorSchema.nullable().default(null),
    requestedAt: IsoDateSchema,
    resolvedAt: IsoDateSchema.nullable().default(null),
    requestKey: z.string().min(8),
  })
  .strict()
  .superRefine((approval, context) => {
    if ((approval.sideEffectClass === "external" || approval.sideEffectClass === "irreversible") && approval.expiresAt === null) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: `Approval expiry is required for ${approval.sideEffectClass} operations`,
      });
    }
    if (approval.kind === "task" && approval.taskId === null) {
      context.addIssue({
        code: "custom",
        path: ["taskId"],
        message: "Task approvals must identify a task",
      });
    }
    if (approval.kind !== "task" && approval.taskId !== null) {
      context.addIssue({
        code: "custom",
        path: ["taskId"],
        message: "Only task approvals may identify a task",
      });
    }
  });
export type ObjectiveApprovalRecord = z.infer<typeof ObjectiveApprovalRecordSchema>;

export const AgentWorkOrderSchema = z.object({
  id: IdSchema.optional(),
  workflowId: IdSchema,
  runId: IdSchema,
  parentAgentId: IdSchema.nullable().default(null),
  depth: z.number().int().nonnegative(),
  mission: WorkflowMissionSchema,
  objective: z.string().min(1).max(20_000),
  /** Optional immutable values charter inherited by a conductor or planner. */
  valueCharter: ObjectiveValueCharterSchema.optional(),
  valueCharterRevision: z.number().int().positive().max(1_000_000_000).optional(),
  valueCharterHash: z.string().min(8).max(256).optional(),
  model: z.string().min(1).default("auto"),
  harness: HarnessSchema.default("auto"),
  permissions: PermissionSchema.default("full-access"),
  /** Effective capability ceiling carried into native execution. */
  capabilities: z.array(IdSchema).max(256).optional(),
  /** Effective side-effect ceiling carried into native execution. */
  sideEffectClassCeiling: ObjectiveSideEffectClassSchema.optional(),
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
  /** Objective attempt currently associated with this agent/session. */
  objectiveAttemptId: IdSchema.nullable().optional(),
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

/**
 * Durable identity for a message crossing the native harness boundary.
 *
 * The message text remains the second `sendMessage` argument for compatibility
 * with existing drivers. This envelope is persisted by the runtime before the
 * call and lets adapters make retries idempotent without trusting a receipt
 * generated after the provider boundary has already been crossed.
 */
export const DriverMessageRequestSchema = z
  .object({
    attemptId: IdSchema,
    requestId: IdSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/iu),
  })
  .strict();
export type DriverMessageRequest = z.infer<typeof DriverMessageRequestSchema>;

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
  // A hosted controller can disappear after the native process has been
  // durably attached. Keep its retirement request separate from `error` so a
  // later daemon can distinguish an orphan that must be terminated from live
  // work that is safe to adopt and continue.
  retirementRequestedAt: IsoDateSchema.nullable().default(null),
  retirementReason: z.enum(["controller-lost"]).nullable().default(null),
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
  /**
   * How long a detached host must retain a native process while a successor
   * daemon performs bounded recovery. Omitted callers retain the host's
   * conservative standalone default.
   */
  controllerGraceMs?: number;
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
  /** Persist a fail-closed retirement intent when a hosted controller is lost. */
  requestProcessRetirement?(
    leaseId: string,
    request: { reason: "controller-lost"; error?: string | null },
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
  sendMessage(session: DriverSession, message: string, request?: DriverMessageRequest): Promise<{
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
      objectiveAttemptId: IdSchema.optional(),
      nativeTurnId: IdSchema.optional(),
      /** Canonical worker-event metadata retained alongside the legacy event. */
      eventId: IdSchema.optional(),
      eventClass: WorkerEventClassSchema.optional(),
      dedupeKey: IdSchema.optional(),
      replayKey: IdSchema.optional(),
      leaseId: IdSchema.optional(),
      workerCursor: z.number().int().nonnegative().optional(),
      rawProvenance: WorkerEventRawProvenanceSchema.optional(),
    })
    .optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/**
 * The durable outcome of an objective as a whole.  This is intentionally
 * different from ObjectiveRunState: one objective can have several runs and
 * a failed or superseded run does not, by itself, settle the objective.
 */
export const ObjectiveAggregateStateSchema = z.enum([
  "active",
  "waiting",
  "achieved",
  "abandoned",
  "superseded",
]);
export type ObjectiveAggregateState = z.infer<typeof ObjectiveAggregateStateSchema>;
/** Short alias retained for integrations that call this the objective state. */
export const ObjectiveStateSchema = ObjectiveAggregateStateSchema;
export type ObjectiveState = ObjectiveAggregateState;

/** Immutable objective intent history, independent of any conversation. */
export const ObjectiveRevisionRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    objectiveId: IdSchema,
    revision: z.number().int().positive(),
    spec: ObjectiveSpecSchema,
    valueCharterRevision: z.number().int().positive().max(1_000_000_000).optional(),
    valueCharterHash: z.string().min(8).max(256).optional(),
    workspace: WorkspaceSpecSchema.nullable(),
    createdBy: ObjectiveActorSchema,
    requestKey: z.string().min(8),
    createdAt: IsoDateSchema,
  })
  .strict();
export type ObjectiveRevisionRecord = z.infer<typeof ObjectiveRevisionRecordSchema>;
export const ObjectiveRevisionSchema = ObjectiveRevisionRecordSchema;
export type ObjectiveRevision = ObjectiveRevisionRecord;

/**
 * One objective execution occurrence.  A run is the execution state; this
 * record is the durable causal/history edge that explains why it exists.
 * Nullable relationship fields make manual roots and legacy imports explicit.
 */
export const ObjectiveRunOccurrenceKindSchema = z.enum([
  "manual",
  "recurring",
  "fork",
  "retry",
  "supersede",
]);
export type ObjectiveRunOccurrenceKind = z.infer<typeof ObjectiveRunOccurrenceKindSchema>;

export const ObjectiveOccurrenceOutcomeStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "abandoned",
  "superseded",
]);
export type ObjectiveOccurrenceOutcomeState = z.infer<typeof ObjectiveOccurrenceOutcomeStateSchema>;

export const ObjectiveRunOccurrenceRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    objectiveId: IdSchema,
    runId: IdSchema,
    objectiveRevision: z.number().int().positive(),
    kind: ObjectiveRunOccurrenceKindSchema,
    occurrenceKey: z.string().min(1).max(512).nullable(),
    triggerId: IdSchema.nullable(),
    parentOccurrenceId: IdSchema.nullable(),
    parentRunId: IdSchema.nullable(),
    forkedFromOccurrenceId: IdSchema.nullable(),
    forkedFromRunId: IdSchema.nullable(),
    supersedesOccurrenceId: IdSchema.nullable(),
    supersedesRunId: IdSchema.nullable(),
    input: JsonValueSchema,
    outcome: ObjectiveOccurrenceOutcomeStateSchema,
    output: JsonValueSchema.nullable(),
    error: z.string().nullable(),
    scheduledAt: IsoDateSchema.nullable(),
    startedAt: IsoDateSchema.nullable(),
    finishedAt: IsoDateSchema.nullable(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  })
  .strict();
export type ObjectiveRunOccurrenceRecord = z.infer<typeof ObjectiveRunOccurrenceRecordSchema>;
export const ObjectiveOccurrenceRecordSchema = ObjectiveRunOccurrenceRecordSchema;
export type ObjectiveOccurrenceRecord = ObjectiveRunOccurrenceRecord;

/** Standalone request fragment used when creating a run under an objective. */
export const ObjectiveRunOccurrenceInputSchema = z
  .object({
    kind: ObjectiveRunOccurrenceKindSchema.default("manual"),
    occurrenceKey: z.string().min(1).max(512).nullable().optional(),
    triggerId: IdSchema.nullable().optional(),
    parentOccurrenceId: IdSchema.nullable().optional(),
    parentRunId: IdSchema.nullable().optional(),
    forkedFromOccurrenceId: IdSchema.nullable().optional(),
    forkedFromRunId: IdSchema.nullable().optional(),
    supersedesOccurrenceId: IdSchema.nullable().optional(),
    supersedesRunId: IdSchema.nullable().optional(),
    input: JsonValueSchema.optional(),
    scheduledAt: IsoDateSchema.nullable().optional(),
  })
  .strict();
export type ObjectiveRunOccurrenceInput = z.infer<typeof ObjectiveRunOccurrenceInputSchema>;

/** Durable objective identity and the currently selected immutable revision. */
export const ObjectiveAggregateRecordSchema = z
  .object({
    version: z.literal(1),
    id: IdSchema,
    objectiveId: IdSchema,
    activeRevision: z.number().int().positive(),
    /** Current immutable mission projection; revisions remain the history. */
    spec: ObjectiveSpecSchema.optional(),
    statement: z.string().min(1).max(20_000).optional(),
    criteria: z.array(ObjectiveCriterionSchema).max(12).optional(),
    policy: ObjectivePolicyRequestSchema.nullable().optional(),
    state: ObjectiveAggregateStateSchema,
    latestRunId: IdSchema.nullable(),
    latestOutcome: ObjectiveOccurrenceOutcomeStateSchema.nullable(),
    workspace: WorkspaceSpecSchema.nullable(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  })
  .strict();
export type ObjectiveAggregateRecord = z.infer<typeof ObjectiveAggregateRecordSchema>;
export const ObjectiveRecordSchema = ObjectiveAggregateRecordSchema;
export type ObjectiveRecord = ObjectiveAggregateRecord;

/**
 * One read-model boundary for the objective workspace.  The daemon obtains it
 * from one SQLite snapshot and clients do not need to join run/attention/
 * artifact endpoints themselves.
 */
export const ObjectiveAggregateSnapshotSchema = z
  .object({
    version: z.literal(1),
    eventCursor: z.number().int().nonnegative(),
    objective: ObjectiveAggregateRecordSchema,
    revisions: z.array(ObjectiveRevisionRecordSchema),
    revisionHistory: z.array(ObjectiveRevisionRecordSchema).optional(),
    occurrences: z.array(ObjectiveRunOccurrenceRecordSchema),
    runs: z.array(ObjectiveRunRecordSchema),
    currentRuns: z.array(ObjectiveRunRecordSchema),
    plan: z.object({
      heads: z.array(JsonValueSchema),
      revisions: z.array(JsonValueSchema),
      snapshots: z.array(JsonValueSchema),
      head: JsonValueSchema.nullable().optional(),
      controlSnapshot: JsonValueSchema.nullable().optional(),
    }).strict(),
    frontier: z.array(JsonValueSchema),
    /** Atomic authoritative read models; omitted only for pre-projector snapshots. */
    frontierProjection: ObjectiveAggregateFrontierProjectionSchema.optional(),
    runline: ObjectiveAggregateRunlineProjectionSchema.optional(),
    attempts: z.array(JsonValueSchema).default([]),
    frontierSeed: z.array(JsonValueSchema).optional(),
    approvals: z.array(ObjectiveApprovalRecordSchema),
    attentions: z.array(ObjectiveAttentionRecordSchema),
    artifacts: z.array(ObjectiveArtifactRecordSchema),
    artifactReviews: z.array(ObjectiveArtifactReviewRecordSchema),
    checkpoints: z.array(ObjectiveCheckpointRecordSchema),
    budgets: z.object({
      ledgers: z.array(JsonValueSchema),
      reservations: z.array(JsonValueSchema),
      debits: z.array(JsonValueSchema),
    }).strict(),
    mutations: z.object({
      control: z.array(JsonValueSchema),
      plans: z.array(JsonValueSchema),
    }).strict(),
    /** Immutable capability-result feedback linked to this objective. */
    capabilityResultFeedback: z.object({
      objectiveId: IdSchema,
      feedback: z.array(CapabilityResultFeedbackRecordSchema),
      evaluations: z.array(CapabilityResultEvaluationRecordSchema),
      decisions: z.array(CapabilityResultDecisionRecordSchema),
    }).strict().optional(),
    suspensions: z.array(JsonValueSchema).default([]),
    events: z.array(EventEnvelopeSchema).default([]),
  })
  .strict();
export type ObjectiveAggregateSnapshot = z.infer<typeof ObjectiveAggregateSnapshotSchema>;
export const ObjectiveSnapshotSchema = ObjectiveAggregateSnapshotSchema;
export type ObjectiveSnapshot = ObjectiveAggregateSnapshot;

export const UsageEventSchema = z.object({
  id: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  agentId: IdSchema.nullable(),
  /** Durable objective attribution; null is retained for legacy/non-objective usage. */
  objectiveAttemptId: IdSchema.nullable().optional(),
  /** Provider/native turn or model-call identity when the harness exposes one. */
  nativeTurnId: IdSchema.nullable().optional(),
  /** Native event identity used to make replayed usage exactly-once. */
  nativeEventId: IdSchema.nullable().optional(),
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
  /** Global durable decision inbox projection; clients may filter by objective. */
  attentions: z.array(ObjectiveAttentionRecordSchema).default([]),
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

// The small synchronous implementation below keeps canonical identity
// verification available to both Node and browser consumers of protocol.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = bytes.length + 1 + 8 + ((64 - ((bytes.length + 1 + 8) % 64)) % 64);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  padded[padded.length - 8] = (high >>> 24) & 0xff;
  padded[padded.length - 7] = (high >>> 16) & 0xff;
  padded[padded.length - 6] = (high >>> 8) & 0xff;
  padded[padded.length - 5] = high & 0xff;
  padded[padded.length - 4] = (low >>> 24) & 0xff;
  padded[padded.length - 3] = (low >>> 16) & 0xff;
  padded[padded.length - 2] = (low >>> 8) & 0xff;
  padded[padded.length - 1] = low & 0xff;

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotateRight = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = (
        (padded[position]! << 24)
        | (padded[position + 1]! << 16)
        | (padded[position + 2]! << 8)
        | padded[position + 3]!
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const prior = words[index - 15]!;
      const secondPrior = words[index - 2]!;
      const sigma0 = rotateRight(prior, 7) ^ rotateRight(prior, 18) ^ (prior >>> 3);
      const sigma1 = rotateRight(secondPrior, 17) ^ rotateRight(secondPrior, 19) ^ (secondPrior >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choice + SHA256_K[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** Runtime-neutral SHA-256 helper for protocol modules that hash canonical JSON. */
export function objectiveSha256(value: string): string {
  return sha256(value);
}
