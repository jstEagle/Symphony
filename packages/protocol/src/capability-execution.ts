import { z } from "zod";
import {
  CapabilityCompatibilityTargetSchema,
  CapabilityExecutionDefaultsSchema,
  CapabilityIdSchema,
  CapabilityProvenanceSchema,
  CapabilityVersionRecordSchema,
  capabilityStableJson,
  resolveCapabilityParameterDefaults,
  type CapabilityCompatibilityTarget,
  type CapabilityExecutionDefaults,
  type CapabilityJsonValue,
  type CapabilityVersionRecord,
} from "./capability-library.js";
import { sha256 } from "./hash.js";

const JsonValueSchema = z.json();
const IdSchema = z.string().min(1).max(2_048);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IsoDateSchema = z.iso.datetime({ offset: true });

/** The exact capability content that was admitted for one execution. */
export const CapabilityExecutionBindingSchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    version: z.number().int().positive(),
    contentHash: HashSchema,
    provenance: CapabilityProvenanceSchema,
    triggers: z.array(z.object({
      id: z.string().min(1).max(256),
      kind: z.string().min(1).max(256),
      configuration: JsonValueSchema,
      enabled: z.boolean(),
    }).strict()).max(256),
    runtimeDefaults: CapabilityExecutionDefaultsSchema,
    parameters: JsonValueSchema,
  })
  .strict();
export type CapabilityExecutionBinding = z.infer<typeof CapabilityExecutionBindingSchema>;

/**
 * Immutable, replayable identity for one capability-backed objective action.
 * The task and plan fields are intentionally JSON values: callers choose the
 * workflow vocabulary and topology, while this envelope records the exact
 * capability inputs and runtime resolution used by that topology.
 */
export const CapabilityExecutionAdmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    admissionId: IdSchema,
    objectiveId: IdSchema,
    runId: IdSchema,
    workflowId: IdSchema,
    workflowRevision: z.number().int().positive(),
    workflowHash: z.string().min(8).max(256),
    nodeId: IdSchema.nullable(),
    capabilityId: CapabilityIdSchema,
    version: z.number().int().positive(),
    contentHash: HashSchema,
    provenance: CapabilityProvenanceSchema,
    triggers: z.array(z.object({
      id: z.string().min(1).max(256),
      kind: z.string().min(1).max(256),
      configuration: JsonValueSchema,
      enabled: z.boolean(),
    }).strict()).max(256),
    runtimeDefaults: CapabilityExecutionDefaultsSchema,
    parameters: JsonValueSchema,
    taskInput: JsonValueSchema.nullable(),
    planInput: JsonValueSchema.nullable(),
    requestKey: z.string().min(8).max(512),
    createdAt: IsoDateSchema,
    admissionHash: HashSchema,
  })
  .strict();
export type CapabilityExecutionAdmission = z.infer<typeof CapabilityExecutionAdmissionSchema>;

export type CapabilityExecutionAdmissionInput = Readonly<{
  capability: CapabilityVersionRecord;
  parameters: unknown;
  objectiveId: string;
  runId: string;
  workflowId: string;
  workflowRevision: number;
  workflowHash: string;
  requestKey: string;
  createdAt: string;
  admissionId?: string;
  nodeId?: string | null;
  target?: CapabilityExecutionTarget;
  /** Runtime-provided defaults are narrower than, and take precedence over, library defaults. */
  runtimeDefaults?: CapabilityExecutionDefaults;
  taskInput?: CapabilityJsonValue | null;
  planInput?: CapabilityJsonValue | null;
}>;

export type CapabilityExecutionTarget = Omit<Partial<CapabilityCompatibilityTarget>, "features"> & Readonly<{
  features?: readonly string[];
}>;

export class CapabilityExecutionAdmissionError extends Error {
  readonly code = "invalid-capability-execution" as const;

  constructor(readonly issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "CapabilityExecutionAdmissionError";
  }
}

/**
 * Resolve runtime selectors without selecting a role, harness, or model on a
 * caller's behalf. Explicit target values win, then runtime defaults, then
 * the activated capability's declared defaults.
 */
export function resolveCapabilityExecutionDefaults(
  recordInput: CapabilityVersionRecord,
  targetInput: CapabilityExecutionTarget = {},
  runtimeInput: CapabilityExecutionDefaults = {},
): CapabilityExecutionDefaults {
  const record = CapabilityVersionRecordSchema.parse(recordInput);
  const target = CapabilityCompatibilityTargetSchema.parse({ ...targetInput, features: targetInput.features ?? [] });
  const runtime = CapabilityExecutionDefaultsSchema.parse(runtimeInput);
  const declared = CapabilityExecutionDefaultsSchema.parse(record.definition.defaults ?? {});
  const permission = target.permission
    ?? target.permissions
    ?? runtime.permission
    ?? runtime.permissions
    ?? declared.permission
    ?? declared.permissions;
  return CapabilityExecutionDefaultsSchema.parse({
    ...(target.harness ?? runtime.harness ?? declared.harness ? { harness: target.harness ?? runtime.harness ?? declared.harness } : {}),
    ...(target.model ?? runtime.model ?? declared.model ? { model: target.model ?? runtime.model ?? declared.model } : {}),
    ...(permission ? { permission } : {}),
  });
}

function compatibilityIssues(
  record: CapabilityVersionRecord,
  targetInput: CapabilityExecutionTarget = {},
  runtimeDefaults: CapabilityExecutionDefaults,
): string[] {
  const target = CapabilityCompatibilityTargetSchema.parse({ ...targetInput, features: targetInput.features ?? [] });
  const compatibility = record.definition.compatibility;
  const issues: string[] = [];
  if (compatibility?.harnesses && runtimeDefaults.harness && !compatibility.harnesses.includes(runtimeDefaults.harness)) {
    issues.push(`Harness is not compatible: ${runtimeDefaults.harness}`);
  }
  if (compatibility?.models && runtimeDefaults.model && !compatibility.models.includes(runtimeDefaults.model)) {
    issues.push(`Model is not compatible: ${runtimeDefaults.model}`);
  }
  if (compatibility?.permissions && runtimeDefaults.permission && !compatibility.permissions.includes(runtimeDefaults.permission)) {
    issues.push(`Permission is not compatible: ${runtimeDefaults.permission}`);
  }
  for (const feature of compatibility?.features ?? []) {
    if (!target.features.includes(feature)) issues.push(`Required feature is unavailable: ${feature}`);
  }
  return issues;
}

/** Canonical content hash for a capability version record. */
export function capabilityVersionContentHash(recordInput: CapabilityVersionRecord): string {
  const record = CapabilityVersionRecordSchema.parse(recordInput);
  return sha256(capabilityStableJson({
    capabilityId: record.capabilityId,
    definition: record.definition,
    provenance: record.provenance,
  }));
}

export function isCapabilityVersionContentHashValid(recordInput: CapabilityVersionRecord): boolean {
  const record = CapabilityVersionRecordSchema.parse(recordInput);
  return record.hash === capabilityVersionContentHash(record);
}

export type CapabilityTemplateContext = Readonly<{
  parameters: CapabilityJsonValue;
  runtimeDefaults: CapabilityExecutionDefaults;
  capability: CapabilityExecutionBinding;
  execution: Readonly<{
    admissionId: string;
    objectiveId: string;
    runId: string;
    workflowId: string;
    workflowRevision: number;
    workflowHash: string;
    nodeId: string | null;
  }>;
}>;

/**
 * Render JSON templates using path lookup only. A token is never interpreted
 * as JavaScript, a shell expression, a JSONPath query, or a function call.
 * Missing values resolve to null, which keeps replays stable and explicit.
 */
export function renderCapabilityTemplate(value: CapabilityJsonValue, context: CapabilityTemplateContext): CapabilityJsonValue {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/u);
    if (whole) return cloneJson(resolveTemplatePath(whole[1]!, context) ?? null);
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_match, path: string) => {
      const resolved = resolveTemplatePath(path, context);
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved ?? null);
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderCapabilityTemplate(item, context));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderCapabilityTemplate(item, context)]));
  }
  return value;
}

function resolveTemplatePath(rawPath: string, context: CapabilityTemplateContext): CapabilityJsonValue | undefined {
  const path = rawPath.trim();
  if (!/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+|\[\d+\])*$/u.test(path)) return undefined;
  const parts = path.replace(/^\$\.?/u, "").split(/\.|\[|\]/u).filter(Boolean);
  if (parts.length === 0) return undefined;
  const first = parts[0]!;
  const root = first === "params" ? "parameters" : first === "runtime" ? "runtimeDefaults" : first;
  const knownRoot = root === "parameters" || root === "runtimeDefaults" || root === "capability" || root === "execution";
  const source: unknown = root === "parameters" ? context.parameters
    : root === "runtimeDefaults" ? context.runtimeDefaults
      : root === "capability" ? context.capability
        : root === "execution" ? context.execution
          : context.parameters;
  const lookup = knownRoot ? parts.slice(1) : parts;
  if (!knownRoot && (source === null || typeof source !== "object")) return undefined;
  let current: unknown = source;
  for (const part of lookup) {
    if (Array.isArray(current)) current = /^\d+$/u.test(part) ? current[Number(part)] : undefined;
    else if (current !== null && typeof current === "object") current = (current as Record<string, unknown>)[part];
    else return undefined;
  }
  return isJsonValue(current) ? current : undefined;
}

function isJsonValue(value: unknown): value is CapabilityJsonValue {
  return JsonValueSchema.safeParse(value).success;
}

function cloneJson(value: CapabilityJsonValue): CapabilityJsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function admissionContent(admission: Omit<CapabilityExecutionAdmission, "admissionHash">): Omit<CapabilityExecutionAdmission, "admissionHash"> {
  return admission;
}

/** Admit one activated version into an immutable objective/workflow envelope. */
export function createCapabilityExecutionAdmission(
  input: CapabilityExecutionAdmissionInput,
): CapabilityExecutionAdmission {
  const record = CapabilityVersionRecordSchema.parse(input.capability);
  const identity = {
    objectiveId: input.objectiveId,
    runId: input.runId,
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    workflowHash: input.workflowHash,
    requestKey: input.requestKey,
    createdAt: input.createdAt,
  };
  const parsedIdentity = z.object({
    objectiveId: IdSchema,
    runId: IdSchema,
    workflowId: IdSchema,
    workflowRevision: z.number().int().positive(),
    workflowHash: z.string().min(8).max(256),
    requestKey: z.string().min(8).max(512),
    createdAt: IsoDateSchema,
  }).strict().parse(identity);
  const issues: string[] = [];
  if (record.state !== "active") issues.push(`Capability ${record.capabilityId}@${record.version} is not active.`);
  if (!isCapabilityVersionContentHashValid(record)) issues.push(`Capability ${record.capabilityId}@${record.version} content hash is invalid.`);

  const parameterResolution = resolveCapabilityParameterDefaults(record.definition.parameters, input.parameters);
  issues.push(...parameterResolution.errors.map((error) => `Invalid parameters: ${error}`));
  const target = CapabilityCompatibilityTargetSchema.parse({ ...(input.target ?? {}), features: input.target?.features ?? [] });
  const runtimeDefaults = resolveCapabilityExecutionDefaults(record, target, input.runtimeDefaults ?? {});
  issues.push(...compatibilityIssues(record, target, runtimeDefaults));
  if (issues.length > 0) throw new CapabilityExecutionAdmissionError([...new Set(issues)]);

  const parameters = cloneJson(JsonValueSchema.parse(parameterResolution.parameters) as CapabilityJsonValue);
  const binding: CapabilityExecutionBinding = {
    capabilityId: record.capabilityId,
    version: record.version,
    contentHash: record.hash,
    provenance: record.provenance,
    triggers: record.definition.triggers,
    runtimeDefaults,
    parameters,
  };
  const admissionId = input.admissionId ?? `capability-execution:${parsedIdentity.runId}:${input.nodeId ?? record.capabilityId}:v${record.version}`;
  const execution = {
    admissionId,
    objectiveId: parsedIdentity.objectiveId,
    runId: parsedIdentity.runId,
    workflowId: parsedIdentity.workflowId,
    workflowRevision: parsedIdentity.workflowRevision,
    workflowHash: parsedIdentity.workflowHash,
    nodeId: input.nodeId ?? null,
  } as const;
  const templateContext: CapabilityTemplateContext = { parameters, runtimeDefaults, capability: binding, execution };
  const content = admissionContent({
    schemaVersion: 1,
    admissionId,
    objectiveId: parsedIdentity.objectiveId,
    runId: parsedIdentity.runId,
    workflowId: parsedIdentity.workflowId,
    workflowRevision: parsedIdentity.workflowRevision,
    workflowHash: parsedIdentity.workflowHash,
    nodeId: input.nodeId ?? null,
    capabilityId: record.capabilityId,
    version: record.version,
    contentHash: record.hash,
    provenance: record.provenance,
    triggers: record.definition.triggers,
    runtimeDefaults,
    parameters,
    taskInput: input.taskInput === undefined || input.taskInput === null ? null : renderCapabilityTemplate(input.taskInput, templateContext),
    planInput: input.planInput === undefined || input.planInput === null ? null : renderCapabilityTemplate(input.planInput, templateContext),
    requestKey: parsedIdentity.requestKey,
    createdAt: parsedIdentity.createdAt,
  });
  const admission = CapabilityExecutionAdmissionSchema.parse({
    ...content,
    admissionHash: sha256(capabilityStableJson(content)),
  });
  return deepFreeze(admission);
}

/** Recompute the identity hash without trusting the embedded hash field. */
export function capabilityExecutionAdmissionHash(admissionInput: CapabilityExecutionAdmission): string {
  const admission = CapabilityExecutionAdmissionSchema.parse(admissionInput);
  const { admissionHash: _ignored, ...content } = admission;
  return sha256(capabilityStableJson(content));
}

export function isCapabilityExecutionAdmissionHashValid(admissionInput: CapabilityExecutionAdmission): boolean {
  const admission = CapabilityExecutionAdmissionSchema.parse(admissionInput);
  return admission.admissionHash === capabilityExecutionAdmissionHash(admission);
}

/** Extract the immutable capability portion for storage on a task/node. */
export function capabilityExecutionBindingFromAdmission(
  admissionInput: CapabilityExecutionAdmission,
): CapabilityExecutionBinding {
  const admission = CapabilityExecutionAdmissionSchema.parse(admissionInput);
  return deepFreeze(CapabilityExecutionBindingSchema.parse({
    capabilityId: admission.capabilityId,
    version: admission.version,
    contentHash: admission.contentHash,
    provenance: admission.provenance,
    triggers: admission.triggers,
    runtimeDefaults: admission.runtimeDefaults,
    parameters: admission.parameters,
  }));
}

/** Compatibility aliases make the bridge discoverable to workflow callers. */
export const admitCapabilityExecution = createCapabilityExecutionAdmission;
export const bindCapabilityExecution = createCapabilityExecutionAdmission;
export const renderCapabilityInputs = renderCapabilityTemplate;
