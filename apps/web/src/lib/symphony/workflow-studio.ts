import type { JsonValue, WorkflowRevisionRecord } from "./contracts";

export type WorkflowStepType = "agent" | "sequence" | "parallel" | "fanout" | "if" | "while" | "set" | "evaluate" | "timer" | "signal";

export type WorkflowBranch = Readonly<{
  label: "then" | "else";
  steps: WorkflowVisualNode[];
}>;

export type WorkflowVisualNode = Readonly<{
  id: string;
  type: WorkflowStepType;
  label: string;
  detail: string;
  dependsOn: string[];
  depth: number;
  steps: WorkflowVisualNode[];
  branches: WorkflowBranch[];
}>;

export type WorkflowVisualModel = Readonly<{
  id: string;
  name: string;
  revision: number;
  hash: string;
  mission: string;
  steps: WorkflowVisualNode[];
}>;

export type WorkflowJsonValidation = Readonly<{
  valid: boolean;
  errors: string[];
  value?: JsonValue;
}>;

const STEP_TYPES = new Set<WorkflowStepType>(["agent", "sequence", "parallel", "fanout", "if", "while", "set", "evaluate", "timer", "signal"]);
const ROOT_KEYS = new Set(["id", "name", "mission", "workspace", "inputSchema", "output", "steps", "triggers"]);
const MISSION_KEYS = new Set(["statement", "keyResults"]);
const WORKSPACE_KEYS = new Set(["path", "remoteRepository", "startingRef", "dirtyPolicy"]);
const STEP_KEYS: Record<WorkflowStepType, ReadonlySet<string>> = {
  agent: new Set(["id", "type", "dependsOn", "objective", "model", "harness", "permissions", "outputSchema", "routing", "workspace"]),
  sequence: new Set(["id", "type", "dependsOn", "steps"]),
  parallel: new Set(["id", "type", "dependsOn", "steps"]),
  fanout: new Set(["id", "type", "dependsOn", "source", "itemTemplate", "concurrency", "aggregation"]),
  while: new Set(["id", "type", "dependsOn", "condition", "steps", "maxIterations"]),
  if: new Set(["id", "type", "dependsOn", "condition", "then", "else"]),
  set: new Set(["id", "type", "dependsOn", "value"]),
  evaluate: new Set(["id", "type", "dependsOn", "metric", "path", "operator", "op", "target", "default"]),
  timer: new Set(["id", "type", "dependsOn", "durationMs", "expiresAfterMs"]),
  signal: new Set(["id", "type", "dependsOn", "signalKey", "expiresAfterMs", "payloadSchema"]),
};
const CONDITION_KEYS = new Set(["path", "op", "value", "default"]);

export function buildWorkflowVisualModel(record: WorkflowRevisionRecord): WorkflowVisualModel {
  const definition = asRecord(record.definition);
  const mission = asRecord(definition?.mission);
  const steps = asArray(definition?.steps);
  return {
    id: record.id,
    name: asString(definition?.name) ?? record.id,
    revision: record.revision,
    hash: record.hash,
    mission: asString(mission?.statement) ?? "No mission statement recorded.",
    steps: steps.map((step) => visualNode(step, 0)).filter((node): node is WorkflowVisualNode => node !== null),
  };
}

export function validateWorkflowJson(source: string): WorkflowJsonValidation {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    return { valid: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : "could not parse the document."}`] };
  }

  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ["Workflow definition must be a JSON object."] };
  }
  validateKeys(value, ROOT_KEYS, "$", errors);
  requireString(value, "id", "$", errors);
  requireString(value, "name", "$", errors);
  const mission = requireRecord(value, "mission", "$", errors);
  if (mission) {
    validateKeys(mission, MISSION_KEYS, "$.mission", errors);
    requireString(mission, "statement", "$.mission", errors);
    if (mission.keyResults !== undefined && (!Array.isArray(mission.keyResults) || mission.keyResults.some((item) => typeof item !== "string"))) {
      errors.push("$.mission.keyResults must be an array of strings.");
    }
  }
  const workspace = requireRecord(value, "workspace", "$", errors);
  if (workspace) {
    validateKeys(workspace, WORKSPACE_KEYS, "$.workspace", errors);
    requireString(workspace, "path", "$.workspace", errors);
    if (workspace.remoteRepository !== undefined && typeof workspace.remoteRepository !== "string") errors.push("$.workspace.remoteRepository must be a string URL.");
    if (workspace.startingRef !== undefined && typeof workspace.startingRef !== "string") errors.push("$.workspace.startingRef must be a string.");
    if (workspace.dirtyPolicy !== undefined && !["local-only", "require-clean", "explicit-checkpoint"].includes(String(workspace.dirtyPolicy))) errors.push("$.workspace.dirtyPolicy is not supported.");
  }
  if (value.inputSchema !== undefined && !isRecord(value.inputSchema)) errors.push("$.inputSchema must be a JSON object.");
  if (value.output !== undefined && typeof value.output !== "string") errors.push("$.output must be a string path.");
  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push("$.steps must contain at least one step.");
  } else {
    const ids = new Set<string>();
    const dependencies = new Map<string, { path: string; ids: string[] }>();
    validateSteps(steps, "$.steps", errors, ids, dependencies);
    validateDependencies(dependencies, ids, errors);
  }
  if (value.triggers !== undefined) validateTriggers(value.triggers, errors);
  if (errors.length) return { valid: false, errors };
  return { valid: true, errors: [], value: value as JsonValue };
}

function validateSteps(
  value: unknown[],
  path: string,
  errors: string[],
  ids: Set<string>,
  dependencies: Map<string, { path: string; ids: string[] }>,
): void {
  value.forEach((raw, index) => {
    const stepPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${stepPath} must be an object.`);
      return;
    }
    const id = raw.id;
    const type = raw.type;
    if (typeof id !== "string" || !id.trim()) errors.push(`${stepPath}.id must be a non-empty string.`);
    else if (ids.has(id)) errors.push(`${stepPath}.id duplicates ${id}.`);
    else ids.add(id);
    if (typeof type !== "string" || !STEP_TYPES.has(type as WorkflowStepType)) {
      errors.push(`${stepPath}.type must be one of agent, sequence, parallel, fanout, if, while, set, evaluate, timer, signal.`);
      return;
    }
    const stepType = type as WorkflowStepType;
    validateKeys(raw, STEP_KEYS[stepType], stepPath, errors);
    const dependencyIds = validateStepDependencies(raw, stepPath, errors);
    if (typeof id === "string" && id.trim()) dependencies.set(id, { path: `${stepPath}.dependsOn`, ids: dependencyIds });
    if (stepType === "agent") {
      requireString(raw, "objective", stepPath, errors);
      if (!isRecord(raw.outputSchema)) errors.push(`${stepPath}.outputSchema must be an object.`);
    }
    if (stepType === "set" && raw.value === undefined) errors.push(`${stepPath}.value is required.`);
    if (stepType === "evaluate") validateEvaluation(raw, stepPath, errors);
    if (stepType === "timer") {
      if (typeof raw.durationMs !== "number" || !Number.isInteger(raw.durationMs) || raw.durationMs <= 0) errors.push(`${stepPath}.durationMs must be a positive integer.`);
      if (raw.expiresAfterMs !== undefined && raw.expiresAfterMs !== null && (typeof raw.expiresAfterMs !== "number" || !Number.isInteger(raw.expiresAfterMs) || raw.expiresAfterMs <= 0)) errors.push(`${stepPath}.expiresAfterMs must be a positive integer or null.`);
      if (typeof raw.durationMs === "number" && typeof raw.expiresAfterMs === "number" && raw.expiresAfterMs < raw.durationMs) errors.push(`${stepPath}.expiresAfterMs must be at or after durationMs.`);
    }
    if (stepType === "signal") {
      if (typeof raw.signalKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(raw.signalKey)) errors.push(`${stepPath}.signalKey must be a stable signal key.`);
      if (raw.expiresAfterMs !== undefined && raw.expiresAfterMs !== null && (typeof raw.expiresAfterMs !== "number" || !Number.isInteger(raw.expiresAfterMs) || raw.expiresAfterMs <= 0)) errors.push(`${stepPath}.expiresAfterMs must be a positive integer or null.`);
      if (raw.payloadSchema !== undefined && !isRecord(raw.payloadSchema)) errors.push(`${stepPath}.payloadSchema must be an object.`);
    }
    if (stepType === "fanout") {
      requireString(raw, "source", stepPath, errors);
      if (!isRecord(raw.itemTemplate)) errors.push(`${stepPath}.itemTemplate must be an object.`);
      else validateSteps([raw.itemTemplate], `${stepPath}.itemTemplate`, errors, new Set(), new Map());
      if (raw.concurrency !== undefined && raw.concurrency !== null && (typeof raw.concurrency !== "number" || !Number.isInteger(raw.concurrency) || raw.concurrency <= 0)) errors.push(`${stepPath}.concurrency must be a positive integer or null.`);
      if (raw.aggregation !== undefined) {
        if (!isRecord(raw.aggregation)) errors.push(`${stepPath}.aggregation must be an object.`);
        else {
          validateKeys(raw.aggregation, new Set(["mode", "keyPath"]), `${stepPath}.aggregation`, errors);
          if (!["array", "object", "merge"].includes(String(raw.aggregation.mode))) errors.push(`${stepPath}.aggregation.mode must be array, object, or merge.`);
          if (raw.aggregation.keyPath !== undefined && typeof raw.aggregation.keyPath !== "string") errors.push(`${stepPath}.aggregation.keyPath must be a string.`);
        }
      }
    }
    if (stepType === "sequence" || stepType === "parallel" || stepType === "while") {
      const nested = raw.steps;
      if (!Array.isArray(nested) || nested.length === 0) errors.push(`${stepPath}.steps must contain at least one step.`);
      else validateSteps(nested, `${stepPath}.steps`, errors, ids, dependencies);
      if (stepType === "while") validateCondition(raw.condition, `${stepPath}.condition`, errors);
    }
    if (stepType === "if") {
      validateCondition(raw.condition, `${stepPath}.condition`, errors);
      if (!Array.isArray(raw.then) || raw.then.length === 0) errors.push(`${stepPath}.then must contain at least one step.`);
      else validateSteps(raw.then, `${stepPath}.then`, errors, ids, dependencies);
      if (raw.else !== undefined) {
        if (!Array.isArray(raw.else)) errors.push(`${stepPath}.else must be an array of steps.`);
        else validateSteps(raw.else, `${stepPath}.else`, errors, ids, dependencies);
      }
    }
  });
}

function validateStepDependencies(record: Record<string, unknown>, path: string, errors: string[]): string[] {
  if (record.dependsOn === undefined) return [];
  if (!Array.isArray(record.dependsOn)) {
    errors.push(`${path}.dependsOn must be an array of step IDs.`);
    return [];
  }
  if (record.dependsOn.length > 256) errors.push(`${path}.dependsOn must contain at most 256 step IDs.`);
  const dependencies: string[] = [];
  const seen = new Set<string>();
  record.dependsOn.forEach((dependency, index) => {
    if (typeof dependency !== "string" || !dependency.trim() || !/^[a-zA-Z0-9_.-]+$/u.test(dependency)) {
      errors.push(`${path}.dependsOn[${index}] must be a stable step ID.`);
      return;
    }
    if (seen.has(dependency)) errors.push(`${path}.dependsOn[${index}] duplicates ${dependency}.`);
    seen.add(dependency);
    dependencies.push(dependency);
  });
  return dependencies;
}

function validateDependencies(
  dependencies: Map<string, { path: string; ids: string[] }>,
  ids: Set<string>,
  errors: string[],
): void {
  for (const [stepId, dependency] of dependencies.entries()) {
    dependency.ids.forEach((dependencyId, index) => {
      if (dependencyId === stepId) errors.push(`${dependency.path}[${index}] cannot reference ${stepId} itself.`);
      else if (!ids.has(dependencyId)) errors.push(`${dependency.path}[${index}] references unknown step ${dependencyId}.`);
    });
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) {
      const path = dependencies.get(stepId)?.path ?? "$.steps";
      errors.push(`${path} participates in a dependency cycle through ${stepId}.`);
      return;
    }
    visiting.add(stepId);
    for (const dependencyId of dependencies.get(stepId)?.ids ?? []) if (ids.has(dependencyId)) visit(dependencyId);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const stepId of dependencies.keys()) visit(stepId);
}

function validateCondition(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  validateKeys(value, CONDITION_KEYS, path, errors);
  requireString(value, "path", path, errors);
  if (!new Set(["exists", "eq", "neq", "gt", "gte", "lt", "lte"]).has(String(value.op))) errors.push(`${path}.op is not supported.`);
}

function validateEvaluation(value: Record<string, unknown>, path: string, errors: string[]): void {
  requireString(value, "path", path, errors);
  const operator = typeof value.operator === "string" ? value.operator : undefined;
  const op = typeof value.op === "string" ? value.op : undefined;
  if (!operator && !op) errors.push(`${path}.operator is required.`);
  if (operator && op && operator !== op) errors.push(`${path}.operator and ${path}.op must agree.`);
  const supported = new Set(["exists", "eq", "neq", "gt", "gte", "lt", "lte"]);
  if (operator && !supported.has(operator)) errors.push(`${path}.operator is not supported.`);
  if (op && !supported.has(op)) errors.push(`${path}.op is not supported.`);
}

function validateTriggers(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("$.triggers must be an array.");
    return;
  }
  value.forEach((trigger, index) => {
    const path = `$.triggers[${index}]`;
    if (!isRecord(trigger)) {
      errors.push(`${path} must be an object.`);
      return;
    }
    const type = trigger.type;
    if (type === "manual") {
      validateKeys(trigger, new Set(["id", "type"]), path, errors);
      requireString(trigger, "id", path, errors);
    } else if (type === "cron") {
      validateKeys(trigger, new Set(["id", "type", "expression", "timezone", "input"]), path, errors);
      requireString(trigger, "id", path, errors);
      requireString(trigger, "expression", path, errors);
      if (trigger.timezone !== undefined && typeof trigger.timezone !== "string") errors.push(`${path}.timezone must be a string.`);
    } else errors.push(`${path}.type must be manual or cron.`);
  });
}

function visualNode(value: unknown, depth: number): WorkflowVisualNode | null {
  const step = asRecord(value);
  const id = asString(step?.id);
  const type = asString(step?.type) as WorkflowStepType | undefined;
  if (!step || !id || !type || !STEP_TYPES.has(type)) return null;
  const children = (type === "sequence" || type === "parallel" || type === "while")
    ? asArray(step.steps).map((item) => visualNode(item, depth + 1)).filter((item): item is WorkflowVisualNode => item !== null)
    : type === "fanout"
      ? [visualNode(step.itemTemplate, depth + 1)].filter((item): item is WorkflowVisualNode => item !== null)
    : [];
  const branches: WorkflowBranch[] = type === "if"
    ? ([
        { label: "then" as const, steps: asArray(step.then).map((item) => visualNode(item, depth + 1)).filter((item): item is WorkflowVisualNode => item !== null) },
        ...(step.else === undefined ? [] : [{ label: "else" as const, steps: asArray(step.else).map((item) => visualNode(item, depth + 1)).filter((item): item is WorkflowVisualNode => item !== null) }]),
      ])
    : [];
  return {
    id,
    type,
    label: stepLabel(type),
    detail: stepDetail(step, type, children.length, branches),
    dependsOn: asArray(step.dependsOn).filter((dependency): dependency is string => typeof dependency === "string"),
    depth,
    steps: children,
    branches,
  };
}

function stepLabel(type: WorkflowStepType): string {
  return type === "agent" ? "Agent" : type[0]?.toUpperCase() + type.slice(1);
}

function stepDetail(step: Record<string, unknown>, type: WorkflowStepType, childCount: number, branches: WorkflowBranch[]): string {
  if (type === "agent") return asString(step.objective) ?? "No objective";
  if (type === "set") return `Set ${JSON.stringify(step.value)}`;
  if (type === "evaluate") {
    const metric = asString(step.metric) ?? asString(step.path) ?? "Evaluation";
    const path = asString(step.path) ?? "path unavailable";
    const operator = asString(step.operator) ?? asString(step.op) ?? "operator unavailable";
    return `${metric} · ${path} ${operator}${step.target === undefined ? "" : ` ${JSON.stringify(step.target)}`}`;
  }
  if (type === "timer") {
    const duration = typeof step.durationMs === "number" ? `${Math.round(step.durationMs / 1_000)}s` : "duration unavailable";
    return `Wait ${duration} · daemon-owned due time${step.expiresAfterMs === null ? " · no expiry" : step.expiresAfterMs === undefined ? "" : ` · expires after ${Math.round(Number(step.expiresAfterMs) / 1_000)}s`}`;
  }
  if (type === "signal") return `Wait for ${asString(step.signalKey) ?? "external signal"} · daemon-owned subscription`;
  if (type === "fanout") {
    const source = asString(step.source) ?? "source unavailable";
    const concurrency = step.concurrency === null ? "unlimited" : typeof step.concurrency === "number" ? String(step.concurrency) : "unlimited";
    const aggregation = asString(asRecord(step.aggregation)?.mode) ?? "array";
    return `Map ${source} · ${aggregation} results · ${concurrency} concurrent`;
  }
  if (type === "if" || type === "while") {
    const condition = asRecord(step.condition);
    const expression = [asString(condition?.path), asString(condition?.op), condition?.value === undefined ? undefined : JSON.stringify(condition.value)].filter(Boolean).join(" ");
    return `${expression || "Condition"}${type === "while" ? ` · ${childCount} nested step${childCount === 1 ? "" : "s"} · max ${asString(step.maxIterations) ?? (typeof step.maxIterations === "number" ? step.maxIterations : "config")} iterations` : ` · ${branches.length} branch${branches.length === 1 ? "" : "es"}`}`;
  }
  return `${childCount} nested step${childCount === 1 ? "" : "s"}`;
}

function validateKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, errors: string[]): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) errors.push(`${path}.${key} is not supported.`);
}

function requireString(record: Record<string, unknown>, key: string, path: string, errors: string[]): string | undefined {
  if (typeof record[key] !== "string" || !record[key].trim()) {
    errors.push(`${path}.${key} must be a non-empty string.`);
    return undefined;
  }
  return record[key] as string;
}

function requireRecord(record: Record<string, unknown>, key: string, path: string, errors: string[]): Record<string, unknown> | undefined {
  if (!isRecord(record[key])) {
    errors.push(`${path}.${key} must be an object.`);
    return undefined;
  }
  return record[key] as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
