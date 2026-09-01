import { createHash } from "node:crypto";
import {
  CapabilityCompatibilityTargetSchema,
  CapabilityActivationSchema,
  CapabilityDefinitionSchema,
  CapabilityProvenanceSchema,
  CapabilityVersionDraftSchema,
  CapabilityVersionRecordSchema,
  capabilityStableJson,
  type CapabilityCompatibilityResult,
  type CapabilityCompatibilityTarget,
  type CapabilityActivation,
  type CapabilityDefinition,
  type CapabilityExecutionDefaults,
  type CapabilityProvenance,
  type CapabilityState,
  type CapabilityVersionDraft,
  type CapabilityVersionRecord,
  type CapabilityTriggerBinding,
  createCapabilityExecutionAdmission,
  type CapabilityExecutionAdmission,
  type CapabilityExecutionAdmissionInput,
  resolveCapabilityParameterDefaults,
} from "@symphony/protocol";
import {
  CapabilityLibraryRepository,
  type CapabilityLibraryReceipt,
} from "@symphony/storage";

export type CapabilityLibraryCommandResult = Readonly<{
  status: "committed" | "replayed" | "conflict" | "rejected";
  version: CapabilityVersionRecord | null;
  reason?: string;
}>;

export type CreateCapabilityVersionInput = Readonly<CapabilityVersionDraft & {
  requestKey: string;
  now?: string;
}>;

export type CapabilityStateInput = Readonly<{
  capabilityId: string;
  version: number;
  requestKey: string;
  now?: string;
  /** Optional concrete inputs to validate and admit with activation. */
  parameters?: unknown;
  triggers?: readonly CapabilityTriggerBinding[];
  target?: CapabilityCompatibilityTargetInput;
}>;

export type CapabilityExecutionInput = Readonly<{
  parameters: unknown;
  target?: CapabilityCompatibilityTargetInput;
}>;

export type CapabilityLibraryAdmissionInput = Omit<CapabilityExecutionAdmissionInput, "capability"> & Readonly<{
  capabilityId: string;
  version: number;
}>;

export type CapabilityCompatibilityTargetInput = Readonly<{
  harness?: string | undefined;
  model?: string | undefined;
  permission?: string | undefined;
  permissions?: string | undefined;
  features?: string[] | undefined;
}>;

export type CapabilityExecutionResolution = Readonly<{
  compatible: boolean;
  reasons: string[];
  parameters: unknown;
  defaults: CapabilityExecutionDefaults;
  version: CapabilityVersionRecord;
}>;

/**
 * Optional domain service for registering and resolving custom capabilities.
 * No role catalog, workflow shape, model policy, or harness is imposed here.
 */
export class CapabilityLibrary {
  constructor(
    readonly repository: CapabilityLibraryRepository,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  createVersion(input: CreateCapabilityVersionInput): CapabilityLibraryCommandResult {
    const draft = CapabilityVersionDraftSchema.parse({
      capabilityId: input.capabilityId,
      ...(input.version === undefined ? {} : { version: input.version }),
      definition: input.definition,
      provenance: input.provenance,
    });
    const requestKey = requireRequestKey(input.requestKey);
    const now = input.now ?? this.clock();
    const fingerprintValue = makeFingerprint("capability.create", draft);
    return this.repository.durableTransaction(() => {
      const replay = this.replayOrConflict(requestKey, "capability.create", fingerprintValue);
      if (replay) return replay;
      const nextVersion = this.repository.nextVersion(draft.capabilityId);
      if (draft.version !== undefined && draft.version !== nextVersion) {
        return this.conflict(requestKey, "capability.create", fingerprintValue, `Capability versions must be contiguous; expected ${nextVersion}`, now);
      }
      const version = draft.version ?? nextVersion;
      const existing = this.repository.getVersion(draft.capabilityId, version);
      if (existing) return this.conflict(requestKey, "capability.create", fingerprintValue, `Capability version already exists: ${draft.capabilityId}@${version}`, now);
      const definition = CapabilityDefinitionSchema.parse(draft.definition);
      const provenance = CapabilityProvenanceSchema.parse(draft.provenance);
      const hash = hashCapabilityVersion(draft.capabilityId, definition, provenance);
      const record = CapabilityVersionRecordSchema.parse({
        schemaVersion: 1,
        capabilityId: draft.capabilityId,
        version,
        state: "draft",
        status: "draft",
        definition,
        hash,
        provenance,
        createdAt: now,
        updatedAt: now,
        activatedAt: null,
        deprecatedAt: null,
      });
      if (!this.repository.insertVersion(record)) {
        const raced = this.repository.getVersion(record.capabilityId, record.version);
        if (!raced || capabilityStableJson(raced) !== capabilityStableJson(record)) {
          return this.conflict(requestKey, "capability.create", fingerprintValue, `Capability version insert conflict: ${record.capabilityId}@${record.version}`, now);
        }
      }
      const result: CapabilityLibraryCommandResult = { status: "committed", version: record };
      this.saveReceipt(requestKey, "capability.create", fingerprintValue, result, now);
      return result;
    });
  }

  activate(input: CapabilityStateInput): CapabilityLibraryCommandResult {
    return this.transition(input, "active");
  }

  deprecate(input: CapabilityStateInput): CapabilityLibraryCommandResult {
    return this.transition(input, "deprecated");
  }

  get(capabilityId: string, version: number): CapabilityVersionRecord | null {
    return this.repository.getVersion(capabilityId, version);
  }

  list(capabilityId?: string): CapabilityVersionRecord[] {
    return this.repository.listVersions(capabilityId);
  }

  resolve(capabilityId: string): CapabilityVersionRecord | null {
    return this.repository.getActiveVersion(capabilityId);
  }

  checkCompatibility(recordInput: CapabilityVersionRecord, targetInput: CapabilityCompatibilityTargetInput = {}): CapabilityCompatibilityResult {
    return checkCapabilityCompatibility(recordInput, targetInput);
  }

  prepareExecution(capabilityId: string, version: number, input: CapabilityExecutionInput): CapabilityExecutionResolution {
    const record = this.repository.getVersion(capabilityId, version);
    if (!record) throw new Error(`Capability version not found: ${capabilityId}@${version}`);
    const parameterResolution = resolveCapabilityParameterDefaults(record.definition.parameters, input.parameters);
    const parameterErrors = parameterResolution.errors;
    const compatibility = this.checkCompatibility(record, input.target ?? {});
    const reasons = [...parameterErrors.map((error) => `Invalid parameters: ${error}`), ...compatibility.reasons];
    return {
      compatible: reasons.length === 0,
      reasons,
      parameters: parameterResolution.parameters,
      defaults: compatibility.resolved,
      version: record,
    };
  }

  /** Resolve an exact stored version and construct an immutable admission. */
  admitExecution(input: CapabilityLibraryAdmissionInput): CapabilityExecutionAdmission {
    const capability = this.repository.getVersion(input.capabilityId, input.version);
    if (!capability) throw new Error(`Capability version not found: ${input.capabilityId}@${input.version}`);
    const { capabilityId: _capabilityId, version: _version, ...admission } = input;
    return createCapabilityExecutionAdmission({ ...admission, capability });
  }

  private transition(input: CapabilityStateInput, state: Exclude<CapabilityState, "draft">): CapabilityLibraryCommandResult {
    const requestKey = requireRequestKey(input.requestKey);
    const now = input.now ?? this.clock();
    const command = {
      capabilityId: input.capabilityId,
      version: input.version,
      ...(state === "active" && input.parameters !== undefined ? { parameters: input.parameters } : {}),
      ...(state === "active" && input.triggers !== undefined ? { triggers: input.triggers } : {}),
      ...(state === "active" && input.target !== undefined ? { target: input.target } : {}),
    };
    const operation = `capability.${state}`;
    const fingerprintValue = makeFingerprint(operation, command);
    return this.repository.durableTransaction(() => {
      const replay = this.replayOrConflict(requestKey, operation, fingerprintValue);
      if (replay) return replay;
      const current = this.repository.getVersion(input.capabilityId, input.version);
      if (!current) return this.reject(requestKey, operation, fingerprintValue, `Capability version not found: ${input.capabilityId}@${input.version}`, now);
      let activation: CapabilityActivation | undefined;
      if (state === "active" && (input.parameters !== undefined || input.triggers !== undefined || input.target !== undefined)) {
        const prepared = this.prepareExecution(input.capabilityId, input.version, {
          // Preserve an already-admitted activation when the caller is only
          // changing trigger values; otherwise resolve declarative defaults.
          parameters: input.parameters === undefined ? current.activation?.parameters : input.parameters,
          ...(input.target === undefined ? {} : { target: input.target }),
        });
        if (!prepared.compatible) {
          return this.reject(requestKey, operation, fingerprintValue, prepared.reasons.join("; "), now);
        }
        const triggers = input.triggers ?? current.activation?.triggers ?? current.definition.triggers;
        activation = CapabilityActivationSchema.parse({
          parameters: prepared.parameters,
          triggers,
          defaults: prepared.defaults,
        });
      }
      if (state === "active") this.repository.activateVersion(input.capabilityId, input.version, now, activation);
      else this.repository.transitionState(input.capabilityId, input.version, state, now);
      const version = this.repository.getVersion(input.capabilityId, input.version);
      if (!version) return this.reject(requestKey, operation, fingerprintValue, "Capability state transition was not persisted", now);
      const result: CapabilityLibraryCommandResult = { status: "committed", version };
      this.saveReceipt(requestKey, operation, fingerprintValue, result, now);
      return result;
    });
  }

  private replayOrConflict(requestKey: string, operation: string, expectedFingerprint: string): CapabilityLibraryCommandResult | null {
    const receipt = this.repository.getReceipt(requestKey);
    if (!receipt) return null;
    if (receipt.operation !== operation || receipt.fingerprint !== expectedFingerprint) {
      return { status: "conflict", version: null, reason: `Idempotency key already belongs to ${receipt.operation}` };
    }
    return { ...parseCommandResult(receipt), status: "replayed" };
  }

  private saveReceipt(requestKey: string, operation: string, fingerprintValue: string, result: CapabilityLibraryCommandResult, now: string): void {
    if (!this.repository.claimReceipt({ requestKey, operation, fingerprint: fingerprintValue, result, createdAt: now })) {
      const existing = this.repository.getReceipt(requestKey);
      if (!existing || existing.operation !== operation || existing.fingerprint !== fingerprintValue) throw new Error(`Capability idempotency receipt collision: ${requestKey}`);
    }
  }

  private conflict(requestKey: string, operation: string, fingerprintValue: string, reason: string, now: string): CapabilityLibraryCommandResult {
    const result: CapabilityLibraryCommandResult = { status: "conflict", version: null, reason };
    this.saveReceipt(requestKey, operation, fingerprintValue, result, now);
    return result;
  }

  private reject(requestKey: string, operation: string, fingerprintValue: string, reason: string, now: string): CapabilityLibraryCommandResult {
    const result: CapabilityLibraryCommandResult = { status: "rejected", version: null, reason };
    this.saveReceipt(requestKey, operation, fingerprintValue, result, now);
    return result;
  }
}

export const CapabilityWorkflowLibrary = CapabilityLibrary;
export const CapabilityWorkflowRegistry = CapabilityLibrary;

export function checkCapabilityCompatibility(
  recordInput: CapabilityVersionRecord,
  targetInput: CapabilityCompatibilityTargetInput = {},
): CapabilityCompatibilityResult {
  const record = CapabilityVersionRecordSchema.parse(recordInput);
  const target = CapabilityCompatibilityTargetSchema.parse({
    ...targetInput,
    ...(targetInput.permission === undefined && targetInput.permissions !== undefined ? { permission: targetInput.permissions } : {}),
    features: targetInput.features ?? [],
  });
  const compatibility = record.definition.compatibility;
  const defaults = record.definition.defaults ?? {};
  const resolved = {
    ...((target.harness ?? defaults.harness) === undefined ? {} : { harness: target.harness ?? defaults.harness }),
    ...((target.model ?? defaults.model) === undefined ? {} : { model: target.model ?? defaults.model }),
    ...((target.permission ?? defaults.permission ?? defaults.permissions) === undefined
      ? {}
      : { permission: target.permission ?? defaults.permission ?? defaults.permissions }),
  };
  const reasons: string[] = [];
  if (compatibility?.harnesses && target.harness && !compatibility.harnesses.includes(target.harness)) reasons.push(`Harness is not compatible: ${target.harness}`);
  if (compatibility?.models && target.model && !compatibility.models.includes(target.model)) reasons.push(`Model is not compatible: ${target.model}`);
  if (compatibility?.permissions && target.permission && !compatibility.permissions.includes(target.permission)) reasons.push(`Permission is not compatible: ${target.permission}`);
  for (const feature of compatibility?.features ?? []) if (!target.features.includes(feature)) reasons.push(`Required feature is unavailable: ${feature}`);
  return { compatible: reasons.length === 0, reasons, resolved };
}

export function hashCapabilityVersion(capabilityId: string, definition: CapabilityDefinition, provenance: CapabilityProvenance): string {
  return createHash("sha256").update(capabilityStableJson({ capabilityId, definition, provenance })).digest("hex");
}

export function isCapabilityVersionHashValid(record: CapabilityVersionRecord): boolean {
  const parsed = CapabilityVersionRecordSchema.parse(record);
  return parsed.hash === hashCapabilityVersion(parsed.capabilityId, parsed.definition, parsed.provenance);
}

function makeFingerprint(operation: string, value: unknown): string {
  return createHash("sha256").update(capabilityStableJson({ operation, value })).digest("hex");
}

function requireRequestKey(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Capability mutations require a non-empty requestKey");
  return value;
}

function parseCommandResult(receipt: CapabilityLibraryReceipt): CapabilityLibraryCommandResult {
  if (typeof receipt.result !== "object" || receipt.result === null || Array.isArray(receipt.result)) throw new Error("Invalid capability idempotency receipt");
  const result = receipt.result as Record<string, unknown>;
  const status = result.status;
  if (status !== "committed" && status !== "conflict" && status !== "rejected") throw new Error("Invalid capability idempotency result status");
  const version = result.version === null ? null : CapabilityVersionRecordSchema.parse(result.version);
  return {
    status,
    version,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
  };
}
