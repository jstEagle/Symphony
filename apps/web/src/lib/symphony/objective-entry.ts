import type { ObjectiveCreateRequest } from "@/lib/symphony/runtime-client";
import type {
  ObjectiveBudgetLimits,
  ObjectiveCriterion,
  ObjectivePolicyRequest,
  ObjectiveSideEffectClass,
  ObjectiveTask,
  JsonValue,
  WorkspaceSpec,
} from "../../../../../packages/protocol/src/index.js";

export type ObjectivePermission = "read-only" | "full-access";
export type ObjectiveLimitDraft = string | number | null;
export type ObjectiveBudgetDraft = Partial<Record<keyof ObjectiveBudgetLimits, ObjectiveLimitDraft>>;
export type ObjectivePolicyDraft = {
  effectivePermission?: ObjectivePermission;
  budget?: ObjectiveBudgetDraft;
  allowedCapabilities?: readonly string[] | string;
  sideEffectClassCeiling?: ObjectiveSideEffectClass;
  expiresAt?: string | null;
  approvalTimeoutSeconds?: ObjectiveLimitDraft;
};
export type ObjectiveCriterionDraft = {
  description: string;
  path: string;
  op: ObjectiveCriterion["op"];
  value: string;
  required: boolean;
};

export type ObjectiveEntryDraft = {
  objectiveId: string;
  /** Optional for a standalone objective; the runtime gets a stable manual identity. */
  workflowId?: string;
  workflowRevision?: number;
  workflowHash?: string;
  /** Attach only the active conversation's conductor when one is known. */
  conductorAgentId?: string | null;
  workspacePath: string;
  mission: string;
  criteria: readonly ObjectiveCriterionDraft[];
  permission: ObjectivePermission;
  /** Optional nested policy shape for non-UI callers; UI fields below are equivalent. */
  policy?: ObjectivePolicyDraft;
  budget?: ObjectiveBudgetDraft;
  maxCostUsd?: ObjectiveLimitDraft;
  maxTotalTokens?: ObjectiveLimitDraft;
  maxModelCalls?: ObjectiveLimitDraft;
  maxToolCalls?: ObjectiveLimitDraft;
  maxWallTimeSeconds?: ObjectiveLimitDraft;
  maxOutputBytes?: ObjectiveLimitDraft;
  maxConcurrentAgents?: ObjectiveLimitDraft;
  allowedCapabilities?: readonly string[] | string;
  sideEffectClassCeiling?: ObjectiveSideEffectClass;
  expiresAt?: string | null;
  approvalTimeoutSeconds?: ObjectiveLimitDraft;
  workspaceDirtyPolicy?: WorkspaceSpec["dirtyPolicy"];
  maxReplans: string;
  approvalPolicy: "never" | "on-replan" | "before-completion";
  firstPlan: string;
};

export class ObjectiveEntryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectiveEntryValidationError";
  }
}

/** The daemon will not dispatch an objective without an attached conductor. */
export function normalizeConductorAgentId(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

export function objectiveExecutionAvailability(conductorAgentId?: string | null): {
  executable: boolean;
  message: string;
} {
  const conductor = normalizeConductorAgentId(conductorAgentId);
  return conductor
    ? { executable: true, message: `Attached to conductor ${conductor}.` }
    : {
        executable: false,
        message: "An active conductor chat is required before this objective can dispatch work.",
      };
}

/**
 * Turn the compact form representation into the strict runtime payload. This
 * is deliberately pure so the browser form and callers that want to preflight
 * an objective share the same bounds and task normalization.
 */
export function buildObjectiveCreateRequest(draft: ObjectiveEntryDraft): ObjectiveCreateRequest {
  const objectiveId = required(draft.objectiveId, "Objective ID");
  const mission = required(draft.mission, "Mission");
  const standaloneWorkflow = standaloneWorkflowIdentity(objectiveId);
  const workflowId = draft.workflowId?.trim() || standaloneWorkflow.workflowId;
  const workflowRevision = draft.workflowRevision ?? standaloneWorkflow.workflowRevision;
  const workflowHash = draft.workflowHash?.trim() || standaloneWorkflow.workflowHash;
  if (!Number.isSafeInteger(workflowRevision) || workflowRevision < 1) {
    throw new ObjectiveEntryValidationError("Workflow revision must be a positive whole number.");
  }
  const workspacePath = required(draft.workspacePath, "Workspace");
  const maxReplans = boundedInteger(draft.maxReplans, "Max replans", 0, 128);
  const criteria = draft.criteria
    .filter((criterion) => criterion.description.trim() || criterion.path.trim() || criterion.value.trim())
    .map((criterion, index) => {
      const description = required(criterion.description, `Success criterion ${index + 1}`);
      const path = required(criterion.path, `Evidence path for criterion ${index + 1}`);
      const id = criterionId(description, index);
      return {
        id,
        description,
        path,
        op: criterion.op,
        ...(criterion.op !== "exists" && criterion.value.trim()
          ? { value: parseCriterionValue(criterion.value) }
          : {}),
        required: criterion.required,
      } satisfies ObjectiveCriterion;
    });

  const tasks = buildFirstPlan(draft.firstPlan, workspacePath, draft.permission, draft.workspaceDirtyPolicy);
  const policy = buildObjectivePolicy(draft);
  return {
    objectiveId,
    workflowId,
    workflowRevision,
    workflowHash,
    ...(normalizeConductorAgentId(draft.conductorAgentId)
      ? { conductorAgentId: normalizeConductorAgentId(draft.conductorAgentId) as string }
      : {}),
    workspace: { path: workspacePath, dirtyPolicy: draft.workspaceDirtyPolicy ?? "local-only" },
    policy,
    spec: {
      id: objectiveId,
      statement: mission,
      criteria,
      approvalPolicy: { mode: draft.approvalPolicy },
      maxReplans,
    },
    ...(tasks.length ? { tasks } : {}),
  };
}

/** Build the explicit admission envelope used by the daemon's policy authority. */
export function buildObjectivePolicy(draft: ObjectiveEntryDraft): ObjectivePolicyRequest {
  const nested = draft.policy;
  const budgetDraft = { ...(nested?.budget ?? {}), ...(draft.budget ?? {}) };
  const budget = {
    maxCostUsd: parseLimit(firstDefined(draft.maxCostUsd, budgetDraft.maxCostUsd), "Cost ceiling", "decimal"),
    maxTotalTokens: parseLimit(firstDefined(draft.maxTotalTokens, budgetDraft.maxTotalTokens), "Total token ceiling", "integer"),
    maxModelCalls: parseLimit(firstDefined(draft.maxModelCalls, budgetDraft.maxModelCalls), "Model-call ceiling", "integer"),
    maxToolCalls: parseLimit(firstDefined(draft.maxToolCalls, budgetDraft.maxToolCalls), "Tool-call ceiling", "integer"),
    maxWallTimeSeconds: parseLimit(firstDefined(draft.maxWallTimeSeconds, budgetDraft.maxWallTimeSeconds), "Wall-time ceiling", "decimal"),
    maxOutputBytes: parseLimit(firstDefined(draft.maxOutputBytes, budgetDraft.maxOutputBytes), "Output-byte ceiling", "integer"),
    maxConcurrentAgents: parseLimit(firstDefined(draft.maxConcurrentAgents, budgetDraft.maxConcurrentAgents), "Concurrent-agent ceiling", "integer"),
    // Keep every protocol budget key explicit. This prevents a future daemon
    // schema default from silently changing an entry's admission semantics.
    maxInputTokens: parseLimit(budgetDraft.maxInputTokens, "Input-token ceiling", "integer"),
    maxOutputTokens: parseLimit(budgetDraft.maxOutputTokens, "Output-token ceiling", "integer"),
    maxStorageBytes: parseLimit(budgetDraft.maxStorageBytes, "Storage-byte ceiling", "integer"),
    maxLoopIterations: parseLimit(budgetDraft.maxLoopIterations, "Loop-iteration ceiling", "integer"),
    maxDepth: parseLimit(budgetDraft.maxDepth, "Depth ceiling", "integer"),
  } satisfies ObjectiveBudgetLimits;
  const approvalTimeout = parseLimit(
    firstDefined(draft.approvalTimeoutSeconds, nested?.approvalTimeoutSeconds),
    "Approval timeout",
    "integer",
  );
  if (approvalTimeout !== null && approvalTimeout < 1) {
    throw new ObjectiveEntryValidationError("Approval timeout must be a positive whole number or Unlimited.");
  }
  const expiresAt = parseExpiry(firstDefined(draft.expiresAt, nested?.expiresAt));
  const capabilities = parseCapabilities(firstDefined(draft.allowedCapabilities, nested?.allowedCapabilities));
  const sideEffectClassCeiling = draft.sideEffectClassCeiling ?? nested?.sideEffectClassCeiling ?? "read";
  const effectivePermission = draft.permission ?? nested?.effectivePermission ?? "read-only";
  return {
    effectivePermission,
    allowedCapabilities: capabilities,
    budget,
    sideEffectClassCeiling,
    approvalPolicy: {
      mode: draft.approvalPolicy,
      // The protocol's omitted timeout is its explicit unlimited value. Null
      // cannot be sent here because the daemon schema rejects it.
      ...(approvalTimeout === null ? {} : { timeoutSeconds: approvalTimeout }),
    },
    expiresAt,
  };
}

export function parseCriterionValue(value: string): JsonValue {
  const normalized = value.trim();
  if (!normalized) return "";
  try {
    return JSON.parse(normalized) as JsonValue;
  } catch {
    return normalized;
  }
}

export function buildFirstPlan(
  firstPlan: string,
  workspacePath: string,
  permission: ObjectivePermission,
  dirtyPolicy: WorkspaceSpec["dirtyPolicy"] = "local-only",
): ObjectiveTask[] {
  const lines = firstPlan.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 128);
  return lines.map((objective, index) => ({
    id: `task-${index + 1}`,
    objective,
    // Initial entries are independent intents. The conductor owns topology and
    // can add dependencies or replace this plan as evidence arrives.
    dependsOn: [],
    outputSchema: {},
    model: "auto",
    harness: "auto",
    permissions: permission,
    inputs: [],
    workspace: { path: workspacePath, dirtyPolicy },
    requiresApproval: false,
  }));
}

/**
 * The daemon currently pins every objective to a workflow identity. A user
 * should not have to register a workflow just to start a durable objective,
 * so standalone objectives receive a deterministic local identity that is
 * stable across retries and makes the absence of a registered workflow clear.
 */
export function standaloneWorkflowIdentity(objectiveId: string): {
  workflowId: string;
  workflowRevision: 1;
  workflowHash: string;
} {
  const slug = objectiveId.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80) || "objective";
  return {
    workflowId: `manual-${slug}`,
    workflowRevision: 1,
    workflowHash: `manual-workflow-${slug}`,
  };
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ObjectiveEntryValidationError(`${label} is required.`);
  return normalized;
}

function boundedInteger(value: string, label: string, min: number, max: number): number {
  const normalized = required(value, label);
  if (!/^\d+$/u.test(normalized)) throw new ObjectiveEntryValidationError(`${label} must be a whole number.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ObjectiveEntryValidationError(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function parseLimit(value: ObjectiveLimitDraft | undefined, label: string, kind: "integer" | "decimal"): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const normalized = value.trim().toLocaleLowerCase();
    if (normalized === "unlimited" || normalized === "null") return null;
    if (!normalized) throw new ObjectiveEntryValidationError(`${label} must be a number or Unlimited.`);
    const pattern = kind === "integer" ? /^\d+$/u : /^\d+(?:\.\d+)?$/u;
    if (!pattern.test(normalized)) throw new ObjectiveEntryValidationError(`${label} must be a non-negative ${kind === "integer" ? "whole number" : "number"} or Unlimited.`);
    value = Number(normalized);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (kind === "integer" && !Number.isInteger(value)) || !Number.isSafeInteger(Math.trunc(value))) {
    throw new ObjectiveEntryValidationError(`${label} must be a non-negative ${kind === "integer" ? "whole number" : "number"} or Unlimited.`);
  }
  return value;
}

function parseCapabilities(value: readonly string[] | string | undefined): string[] {
  if (value === undefined) return [];
  const entries: readonly string[] = typeof value === "string" ? value.split(/[\n,]/u) : value;
  const capabilities = entries.map((entry) => entry.trim()).filter(Boolean);
  if (capabilities.some((capability) => capability.length > 256)) {
    throw new ObjectiveEntryValidationError("Each capability must be at most 256 characters.");
  }
  return [...new Set(capabilities)];
}

function parseExpiry(value: string | null | undefined): string | null {
  if (value === undefined || value === null || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new ObjectiveEntryValidationError("Objective expiry must be a valid date and time or blank.");
  return new Date(timestamp).toISOString();
}

function criterionId(description: string, index: number): string {
  const slug = description.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40);
  return slug ? `criterion-${slug}-${index + 1}` : `criterion-${index + 1}`;
}
