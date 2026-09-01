import {
  CapabilityExecutionAdmissionSchema,
  CapabilityExecutionBindingSchema,
  JsonValueSchema,
  ObjectiveControlNodeSchema,
  ObjectiveTaskSchema,
  admitCapabilityExecution,
  capabilityExecutionBindingFromAdmission,
  capabilityStableJson,
  isCapabilityExecutionAdmissionHashValid,
  type CapabilityExecutionAdmission,
  type CapabilityExecutionAdmissionInput,
  type CapabilityExecutionBinding,
  type CapabilityJsonValue,
  type ObjectiveControlAgentNode,
  type ObjectiveControlNode,
  type ObjectiveTask,
} from "@symphony/protocol";

/**
 * Workflow-facing alias for the protocol admission. The bridge never creates
 * a role or topology: callers provide task/plan JSON and receive those same
 * values rendered against the immutable capability parameters.
 */
export type CapabilityWorkflowExecutionInput = CapabilityExecutionAdmissionInput & Readonly<{
  task?: CapabilityJsonValue | null;
  plan?: CapabilityJsonValue | null;
}>;

export type CapabilityWorkflowExecution = Readonly<{
  admission: CapabilityExecutionAdmission;
  task: CapabilityJsonValue | null;
  plan: CapabilityJsonValue | null;
}>;

/** Build an immutable capability admission for a workflow-owned task/plan. */
export function createCapabilityWorkflowExecution(
  input: CapabilityWorkflowExecutionInput,
): CapabilityWorkflowExecution {
  const admission = admitCapabilityExecution({
    ...input,
    taskInput: input.taskInput ?? input.task ?? null,
    planInput: input.planInput ?? input.plan ?? null,
  });
  return Object.freeze({
    admission,
    task: admission.taskInput,
    plan: admission.planInput,
  });
}

/** Alias used by callers that model a workflow bridge as an admission step. */
export const admitCapabilityWorkflowExecution = createCapabilityWorkflowExecution;

/** Stateless bridge facade suitable for callers that already own a library. */
export class CapabilityExecutionBridge {
  admit(input: CapabilityWorkflowExecutionInput): CapabilityWorkflowExecution {
    return createCapabilityWorkflowExecution(input);
  }

  objectiveTask(input: CapabilityObjectiveTaskAdmissionInput): CapabilityObjectiveTaskAdmission {
    return admitCapabilityObjectiveTask(input);
  }

  controlAgent(input: CapabilityControlAgentAdmissionInput): CapabilityControlAgentAdmission {
    return admitCapabilityControlAgentNode(input);
  }
}

export type CapabilityObjectiveTaskAdmissionInput = Omit<CapabilityExecutionAdmissionInput, "taskInput"> & Readonly<{
  task: ObjectiveTask;
  planInput?: CapabilityJsonValue | null;
}>;

export type CapabilityObjectiveTaskAdmission = Readonly<{
  admission: CapabilityExecutionAdmission;
  task: ObjectiveTask;
}>;

/**
 * Attach one exact capability binding to a caller-authored objective task.
 * Existing task fields remain authoritative; only declarative placeholders,
 * capability metadata, and the capability ID ceiling are added.
 */
export function admitCapabilityObjectiveTask(
  input: CapabilityObjectiveTaskAdmissionInput,
): CapabilityObjectiveTaskAdmission {
  const admission = admitCapabilityExecution({
    ...input,
    taskInput: input.task as unknown as CapabilityJsonValue,
    planInput: input.planInput ?? null,
  });
  const taskValue = admission.taskInput;
  if (taskValue === null || typeof taskValue !== "object" || Array.isArray(taskValue)) {
    throw new Error("Capability objective task admission requires an object task template.");
  }
  const task = ObjectiveTaskSchema.parse({
    ...taskValue,
    capabilities: [...new Set([...(input.task.capabilities ?? []), admission.capabilityId])],
    capabilityExecution: capabilityExecutionBindingFromAdmission(admission),
  });
  return Object.freeze({ admission, task });
}

export type CapabilityControlAgentAdmissionInput = Omit<CapabilityExecutionAdmissionInput, "taskInput"> & Readonly<{
  node: ObjectiveControlAgentNode;
  planInput?: CapabilityJsonValue | null;
}>;

export type CapabilityControlAgentAdmission = Readonly<{
  admission: CapabilityExecutionAdmission;
  node: ObjectiveControlAgentNode;
}>;

/** Attach one exact capability binding to a caller-authored control-plan leaf. */
export function admitCapabilityControlAgentNode(
  input: CapabilityControlAgentAdmissionInput,
): CapabilityControlAgentAdmission {
  const admission = admitCapabilityExecution({
    ...input,
    taskInput: input.node as unknown as CapabilityJsonValue,
    planInput: input.planInput ?? null,
  });
  const nodeValue = admission.taskInput;
  if (nodeValue === null || typeof nodeValue !== "object" || Array.isArray(nodeValue)) {
    throw new Error("Capability control-node admission requires an object node template.");
  }
  const parsed = ObjectiveControlNodeSchema.parse({
    ...nodeValue,
    capabilities: [...new Set([...(input.node.capabilities ?? []), admission.capabilityId])],
    capabilityExecution: capabilityExecutionBindingFromAdmission(admission),
  }) as ObjectiveControlNode;
  if (parsed.type !== "agent") throw new Error("Capability control-node admission requires an agent node.");
  return Object.freeze({ admission, node: parsed });
}

/** Validate a persisted admission after process restart before reuse. */
export function parseCapabilityWorkflowExecution(value: unknown): CapabilityWorkflowExecution {
  const admission = CapabilityExecutionAdmissionSchema.parse(
    typeof value === "object" && value !== null && "admission" in value
      ? (value as { admission: unknown }).admission
      : value,
  );
  const source = typeof value === "object" && value !== null && "admission" in value
    ? value as { task?: unknown; plan?: unknown }
    : { task: admission.taskInput, plan: admission.planInput };
  if (!isCapabilityExecutionAdmissionHashValid(admission)) throw new Error("Capability execution admission hash is invalid.");
  const task = source.task === undefined ? admission.taskInput : JsonValueSchema.nullable().parse(source.task);
  const plan = source.plan === undefined ? admission.planInput : JsonValueSchema.nullable().parse(source.plan);
  if (capabilityStableJson(task) !== capabilityStableJson(admission.taskInput) || capabilityStableJson(plan) !== capabilityStableJson(admission.planInput)) {
    throw new Error("Capability workflow execution inputs do not match the immutable admission.");
  }
  return Object.freeze({ admission, task: task as CapabilityJsonValue | null, plan: plan as CapabilityJsonValue | null });
}

/** Narrow schema helper for callers persisting the binding beside a task. */
export function parseCapabilityExecutionBinding(value: unknown): CapabilityExecutionBinding {
  return CapabilityExecutionBindingSchema.parse(value);
}
