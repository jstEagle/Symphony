import { z } from "zod";

/**
 * Protocol contracts for the optional capability/workflow library.
 *
 * These contracts intentionally use caller-defined strings for harnesses,
 * models, permissions, trigger kinds, and compatibility features. The
 * library is a versioned registry and does not prescribe roles or a routing
 * strategy; a daemon may choose to ignore it entirely.
 */

export const CapabilityIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const CapabilityVersionSchema = z.number().int().positive();
export const CapabilityStateSchema = z.enum(["draft", "active", "deprecated"]);
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

const JsonValueSchema = z.json();
export { JsonValueSchema as CapabilityJsonValueSchema };
export type CapabilityJsonValue = z.infer<typeof JsonValueSchema>;

const ParameterTypeSchema = z.enum(["string", "number", "integer", "boolean", "object", "array", "null"]);

export type CapabilityParameterNode = {
  title?: string | undefined;
  description?: string | undefined;
  type?: z.infer<typeof ParameterTypeSchema> | undefined;
  /** Declarative value used when a caller omits this property. */
  default?: CapabilityJsonValue | undefined;
  enum?: CapabilityJsonValue[] | undefined;
  const?: CapabilityJsonValue | undefined;
  properties?: Record<string, CapabilityParameterNode> | undefined;
  required?: string[] | undefined;
  items?: CapabilityParameterNode | undefined;
  additionalProperties?: boolean | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  pattern?: string | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
};

const CapabilityParameterNodeSchema: z.ZodType<CapabilityParameterNode> = z.lazy(() => z.object({
  title: z.string().max(500).optional(),
  description: z.string().max(2_000).optional(),
  type: ParameterTypeSchema.optional(),
  default: JsonValueSchema.optional(),
  enum: z.array(JsonValueSchema).max(256).optional(),
  const: JsonValueSchema.optional(),
  properties: z.record(z.string().min(1).max(256), CapabilityParameterNodeSchema).optional(),
  required: z.array(z.string().min(1).max(256)).max(256).optional(),
  items: CapabilityParameterNodeSchema.optional(),
  additionalProperties: z.boolean().optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  minLength: z.number().int().nonnegative().max(1_000_000).optional(),
  maxLength: z.number().int().nonnegative().max(1_000_000).optional(),
  pattern: z.string().max(2_000).optional(),
  minItems: z.number().int().nonnegative().max(1_000_000).optional(),
  maxItems: z.number().int().nonnegative().max(1_000_000).optional(),
}).strict());

/** A JSON-Schema-like, data-only parameter contract. */
export const CapabilityParameterSchema = z
  .object({
    type: z.literal("object").default("object"),
    properties: z.record(z.string().min(1).max(256), CapabilityParameterNodeSchema).default({}),
    required: z.array(z.string().min(1).max(256)).max(256).default([]),
    additionalProperties: z.boolean().default(false),
    title: z.string().max(500).optional(),
    description: z.string().max(2_000).optional(),
  })
  .strict()
  .superRefine((schema, context) => {
    const seen = new Set<string>();
    for (const [index, name] of schema.required.entries()) {
      if (seen.has(name)) context.addIssue({ code: "custom", path: ["required", index], message: `Duplicate required parameter: ${name}` });
      if (!(name in schema.properties)) context.addIssue({ code: "custom", path: ["required", index], message: `Required parameter is not declared: ${name}` });
      seen.add(name);
    }

    validateParameterNodeConstraints(schema, ["parameters"], context);
  });
export type CapabilityParameterSchema = z.infer<typeof CapabilityParameterSchema>;

/** Optional event/schedule binding. `kind` and `configuration` are caller-defined. */
export const CapabilityTriggerBindingSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.string().min(1).max(256),
    configuration: JsonValueSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CapabilityTriggerBinding = z.infer<typeof CapabilityTriggerBindingSchema>;

/**
 * The daemon-owned inputs admitted when a capability version is activated.
 * This is lifecycle state, not part of the immutable capability definition:
 * callers may choose concrete parameters and trigger configuration for an
 * activation while the version content/hash remains unchanged.
 */
export const CapabilityActivationSchema = z
  .object({
    parameters: JsonValueSchema,
    triggers: z.array(CapabilityTriggerBindingSchema).max(256),
    defaults: z.object({
      harness: z.string().min(1).max(256).optional(),
      model: z.string().min(1).max(512).optional(),
      permission: z.string().min(1).max(256).optional(),
      permissions: z.string().min(1).max(256).optional(),
    }).strict(),
  })
  .strict();
export type CapabilityActivation = z.infer<typeof CapabilityActivationSchema>;

export const CapabilityExecutionDefaultsSchema = z
  .object({
    harness: z.string().min(1).max(256).optional(),
    model: z.string().min(1).max(512).optional(),
    permission: z.string().min(1).max(256).optional(),
    /** Plural alias mirrors existing task contracts; both fields are caller-defined strings. */
    permissions: z.string().min(1).max(256).optional(),
  })
  .strict();
export type CapabilityExecutionDefaults = z.infer<typeof CapabilityExecutionDefaultsSchema>;

/** Compatibility constraints are optional and entirely declarative. */
export const CapabilityCompatibilitySchema = z
  .object({
    harnesses: z.array(z.string().min(1).max(256)).max(256).optional(),
    models: z.array(z.string().min(1).max(512)).max(256).optional(),
    permissions: z.array(z.string().min(1).max(256)).max(256).optional(),
    features: z.array(z.string().min(1).max(256)).max(256).optional(),
  })
  .strict();
export type CapabilityCompatibility = z.infer<typeof CapabilityCompatibilitySchema>;

/** Provenance is retained as data so imported/generated definitions remain auditable. */
export const CapabilityProvenanceSchema = z
  .object({
    source: z.string().min(1).max(256),
    revision: z.string().min(1).max(512).optional(),
    uri: z.string().min(1).max(4_096).optional(),
    actor: z.string().min(1).max(256).optional(),
    metadata: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict();
export type CapabilityProvenance = z.infer<typeof CapabilityProvenanceSchema>;

export const CapabilityDefinitionSchema = z
  .object({
    name: z.string().min(1).max(500).optional(),
    description: z.string().max(20_000).optional(),
    parameters: CapabilityParameterSchema,
    triggers: z.array(CapabilityTriggerBindingSchema).max(256).default([]),
    defaults: CapabilityExecutionDefaultsSchema.optional(),
    compatibility: CapabilityCompatibilitySchema.optional(),
    strategy: JsonValueSchema.optional(),
    /** Optional caller-defined workflow/plan payload; no execution shape is imposed. */
    workflow: JsonValueSchema.optional(),
  })
  .strict();
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;

export const CapabilityVersionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    capabilityId: CapabilityIdSchema,
    version: CapabilityVersionSchema,
    state: CapabilityStateSchema,
    /** Compatibility alias for consumers that use status terminology. */
    status: CapabilityStateSchema.optional(),
    definition: CapabilityDefinitionSchema,
    /** Last daemon-admitted activation inputs, when this version is active. */
    activation: CapabilityActivationSchema.optional(),
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
    provenance: CapabilityProvenanceSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    activatedAt: z.iso.datetime({ offset: true }).nullable(),
    deprecatedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.status !== undefined && record.status !== record.state) {
      context.addIssue({ code: "custom", path: ["status"], message: "status must match state" });
    }
  });
export type CapabilityVersionRecord = z.infer<typeof CapabilityVersionRecordSchema>;

export const CapabilityVersionDraftSchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    version: CapabilityVersionSchema.optional(),
    definition: CapabilityDefinitionSchema,
    provenance: CapabilityProvenanceSchema,
  })
  .strict();
export type CapabilityVersionDraft = z.infer<typeof CapabilityVersionDraftSchema>;

export const CapabilityCompatibilityTargetSchema = z
  .object({
    harness: z.string().min(1).max(256).optional(),
    model: z.string().min(1).max(512).optional(),
    permission: z.string().min(1).max(256).optional(),
    /** Plural alias accepted by callers that use task-contract terminology. */
    permissions: z.string().min(1).max(256).optional(),
    features: z.array(z.string().min(1).max(256)).max(256).default([]),
  })
  .strict();
export type CapabilityCompatibilityTarget = z.infer<typeof CapabilityCompatibilityTargetSchema>;

export const CapabilityCompatibilityResultSchema = z
  .object({
    compatible: z.boolean(),
    reasons: z.array(z.string()),
    resolved: CapabilityExecutionDefaultsSchema,
  })
  .strict();
export type CapabilityCompatibilityResult = z.infer<typeof CapabilityCompatibilityResultSchema>;

export type CapabilityParameterResolution = Readonly<{
  /** Materialized, detached data. It is undefined only for a malformed root. */
  parameters: unknown;
  errors: string[];
}>;

function validateParameterNodeConstraints(
  node: CapabilityParameterNode,
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  if (node.minimum !== undefined && node.maximum !== undefined && node.minimum > node.maximum) {
    context.addIssue({ code: "custom", path: [...path, "maximum"], message: "maximum must be greater than or equal to minimum" });
  }
  if (node.minLength !== undefined && node.maxLength !== undefined && node.minLength > node.maxLength) {
    context.addIssue({ code: "custom", path: [...path, "maxLength"], message: "maxLength must be greater than or equal to minLength" });
  }
  if (node.minItems !== undefined && node.maxItems !== undefined && node.minItems > node.maxItems) {
    context.addIssue({ code: "custom", path: [...path, "maxItems"], message: "maxItems must be greater than or equal to minItems" });
  }
  if (node.properties) {
    for (const [name, child] of Object.entries(node.properties)) validateParameterNodeConstraints(child, [...path, "properties", name], context);
  }
  if (node.items) validateParameterNodeConstraints(node.items, [...path, "items"], context);
}

/**
 * Validate a parameter value against the data-only schema. It is deliberately
 * small, deterministic, and independent of a particular validator package.
 */
export function validateCapabilityParameters(schemaInput: CapabilityParameterSchema, value: unknown): string[] {
  const schema = CapabilityParameterSchema.parse(schemaInput);
  const errors: string[] = [];
  validateNode(schema, value, "$", errors);
  return errors;

  function validateNode(node: CapabilityParameterNode, candidate: unknown, path: string, output: string[]): void {
    if (node.type === "object") {
      if (!isRecord(candidate)) { output.push(`${path} must be an object`); return; }
      for (const required of node.required ?? []) if (!(required in candidate)) output.push(`${path}.${required} is required`);
      for (const [key, nested] of Object.entries(candidate)) {
        const child = node.properties?.[key];
        if (!child) {
          if (node.additionalProperties === false) output.push(`${path}.${key} is not allowed`);
          continue;
        }
        validateNode(child, nested, `${path}.${key}`, output);
      }
    } else if (node.type === "array") {
      if (!Array.isArray(candidate)) { output.push(`${path} must be an array`); return; }
      if (node.minItems !== undefined && candidate.length < node.minItems) output.push(`${path} must contain at least ${node.minItems} items`);
      if (node.maxItems !== undefined && candidate.length > node.maxItems) output.push(`${path} must contain at most ${node.maxItems} items`);
      if (node.items) candidate.forEach((item, index) => validateNode(node.items as CapabilityParameterNode, item, `${path}[${index}]`, output));
    } else if (node.type === "string" && typeof candidate !== "string") output.push(`${path} must be a string`);
    else if (node.type === "string") {
      const candidateString = typeof candidate === "string" ? candidate : "";
      if (node.minLength !== undefined && candidateString.length < node.minLength) output.push(`${path} must contain at least ${node.minLength} characters`);
      if (node.maxLength !== undefined && candidateString.length > node.maxLength) output.push(`${path} must contain at most ${node.maxLength} characters`);
      if (node.pattern !== undefined) {
        let matches = false;
        try { matches = new RegExp(node.pattern, "u").test(candidateString); }
        catch { output.push(`${path} has an invalid pattern constraint`); }
        if (!matches) output.push(`${path} does not match the required pattern`);
      }
    }
    else if (node.type === "number") {
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) output.push(`${path} must be a number`);
      else {
        if (node.minimum !== undefined && candidate < node.minimum) output.push(`${path} must be greater than or equal to ${node.minimum}`);
        if (node.maximum !== undefined && candidate > node.maximum) output.push(`${path} must be less than or equal to ${node.maximum}`);
      }
    }
    else if (node.type === "integer") {
      if (typeof candidate !== "number" || !Number.isInteger(candidate)) output.push(`${path} must be an integer`);
      else {
        if (node.minimum !== undefined && candidate < node.minimum) output.push(`${path} must be greater than or equal to ${node.minimum}`);
        if (node.maximum !== undefined && candidate > node.maximum) output.push(`${path} must be less than or equal to ${node.maximum}`);
      }
    }
    else if (node.type === "boolean" && typeof candidate !== "boolean") output.push(`${path} must be a boolean`);
    else if (node.type === "null" && candidate !== null) output.push(`${path} must be null`);
    if (node.enum && !node.enum.some((allowed) => stableJson(allowed) === stableJson(candidate))) output.push(`${path} is not an allowed value`);
    if ("const" in node && stableJson(node.const) !== stableJson(candidate)) output.push(`${path} must equal the declared constant`);
  }
}

/**
 * Apply only declarative parameter defaults. This intentionally does not
 * coerce values, call functions, evaluate expressions, or inspect prototypes.
 * Validation is run after materialization so defaults obey the same contract
 * as caller-supplied values.
 */
export function resolveCapabilityParameterDefaults(
  schemaInput: CapabilityParameterSchema,
  value: unknown,
): CapabilityParameterResolution {
  const schema = CapabilityParameterSchema.parse(schemaInput);
  const errors: string[] = [];
  const materialized = materializeNode(schema, value, "$", errors);
  errors.push(...validateCapabilityParameters(schema, materialized));
  return { parameters: materialized, errors: [...new Set(errors)] };

  function materializeNode(node: CapabilityParameterNode, candidate: unknown, path: string, output: string[]): unknown {
    let resolved = candidate;
    if (resolved === undefined && node.default !== undefined) resolved = cloneJson(node.default);
    if (node.type === "object" && resolved === undefined) resolved = {};
    if (node.type === "object" && isRecord(resolved)) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        if (key in resolved) result[key] = materializeNode(child, resolved[key], `${path}.${key}`, output);
        else if (child.default !== undefined) result[key] = materializeNode(child, undefined, `${path}.${key}`, output);
      }
      for (const [key, item] of Object.entries(resolved)) {
        if (!(key in result)) result[key] = item;
      }
      return result;
    }
    if (node.type === "array" && Array.isArray(resolved) && node.items) {
      return resolved.map((item, index) => materializeNode(node.items!, item, `${path}[${index}]`, output));
    }
    return resolved;
  }
}

function cloneJson(value: CapabilityJsonValue): CapabilityJsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Stable JSON used by all layers for hashes and idempotency fingerprints. */
export function capabilityStableJson(value: unknown): string {
  return stableJson(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
