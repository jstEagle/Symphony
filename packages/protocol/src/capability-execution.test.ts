import { describe, expect, it } from "vitest";
import {
  CapabilityVersionRecordSchema,
  capabilityStableJson,
  resolveCapabilityParameterDefaults,
} from "./capability-library.js";
import {
  CapabilityExecutionAdmissionError,
  capabilityExecutionAdmissionHash,
  capabilityVersionContentHash,
  createCapabilityExecutionAdmission,
  isCapabilityExecutionAdmissionHashValid,
  renderCapabilityTemplate,
} from "./capability-execution.js";

const createdAt = "2026-09-01T00:00:00.000Z";

function activeCapability() {
  const content = {
    schemaVersion: 1 as const,
    capabilityId: "document.summarise",
    version: 2,
    state: "active" as const,
    status: "active" as const,
    definition: {
      name: "Document summary",
      parameters: {
        type: "object" as const,
        properties: {
          document: { type: "string" as const, minLength: 1 },
          format: { type: "string" as const, default: "short", enum: ["short", "long"] },
        },
        required: ["document"],
        additionalProperties: false,
      },
      triggers: [{ id: "manual", kind: "manual", configuration: {}, enabled: true }],
      defaults: { harness: "fixture", model: "fixture-model", permission: "read-only" },
      compatibility: { harnesses: ["fixture"], models: ["fixture-model"], permissions: ["read-only"], features: ["streaming"] },
    },
    provenance: { source: "test", revision: "git:abc", actor: "tester", metadata: { checked: true } },
    hash: "0".repeat(64),
    createdAt,
    updatedAt: createdAt,
    activatedAt: createdAt,
    deprecatedAt: null,
  };
  return CapabilityVersionRecordSchema.parse({ ...content, hash: capabilityVersionContentHash(content) });
}

describe("capability execution admission", () => {
  it("materializes typed defaults and rejects constraint violations without coercion", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, default: "Ada", minLength: 2 },
        count: { type: "integer" as const, minimum: 1, maximum: 3 },
      },
      required: ["name"],
      additionalProperties: false,
    };
    expect(resolveCapabilityParameterDefaults(schema, { count: 2 })).toEqual({ parameters: { name: "Ada", count: 2 }, errors: [] });
    expect(resolveCapabilityParameterDefaults(schema, { count: "2" }).errors).toContain("$.count must be an integer");
    expect(resolveCapabilityParameterDefaults(schema, { name: "A", count: 4 }).errors.join(" ")).toContain("less than or equal to 3");
  });

  it("admits only an activated, hash-valid version and binds exact provenance/triggers/runtime defaults", () => {
    const capability = activeCapability();
    const admission = createCapabilityExecutionAdmission({
      capability,
      parameters: { document: "hello" },
      objectiveId: "objective-1",
      runId: "run-1",
      workflowId: "workflow-1",
      workflowRevision: 4,
      workflowHash: "workflow-hash-1",
      requestKey: "capability-admission-1",
      createdAt,
      nodeId: "summarise",
      target: { features: ["streaming"] },
      taskInput: { objective: "{{parameters.document}}", model: "{{runtimeDefaults.model}}", raw: "{{params.format}}" },
      planInput: { capability: "{{capability.capabilityId}}", run: "{{execution.runId}}" },
    });
    expect(admission).toMatchObject({
      capabilityId: "document.summarise",
      version: 2,
      contentHash: capability.hash,
      provenance: capability.provenance,
      triggers: capability.definition.triggers,
      runtimeDefaults: { harness: "fixture", model: "fixture-model", permission: "read-only" },
      parameters: { document: "hello", format: "short" },
      taskInput: { objective: "hello", model: "fixture-model", raw: "short" },
      planInput: { capability: "document.summarise", run: "run-1" },
    });
    expect(Object.isFrozen(admission)).toBe(true);
    expect(isCapabilityExecutionAdmissionHashValid(admission)).toBe(true);
    expect(admission.admissionHash).toBe(capabilityExecutionAdmissionHash(admission));
  });

  it("is deterministic across reconstruction and never evaluates template expressions", () => {
    const capability = activeCapability();
    const input = {
      capability,
      parameters: { document: "hello" },
      objectiveId: "objective-1",
      runId: "run-1",
      workflowId: "workflow-1",
      workflowRevision: 4,
      workflowHash: "workflow-hash-1",
      requestKey: "capability-admission-2",
      createdAt,
      target: { features: ["streaming"] },
      taskInput: { text: "{{parameters.document}}", expression: "{{ parameters.document.toUpperCase() }}", missing: "{{unknown.value}}" },
    } as const;
    const first = createCapabilityExecutionAdmission(input);
    const second = createCapabilityExecutionAdmission({ ...input, capability: { ...capability, definition: { ...capability.definition, triggers: [...capability.definition.triggers] } } });
    expect(second).toEqual(first);
    expect(first.taskInput).toEqual({ text: "hello", expression: null, missing: null });
    const tampered = { ...first, taskInput: { changed: true } };
    expect(isCapabilityExecutionAdmissionHashValid(tampered)).toBe(false);
    expect(capabilityStableJson(first.parameters)).toBe(capabilityStableJson(second.parameters));
  });

  it("fails closed for draft, stale hash, incompatible runtime, and invalid parameters", () => {
    const capability = activeCapability();
    expect(() => createCapabilityExecutionAdmission({
      capability: { ...capability, state: "draft", status: "draft" },
      parameters: { document: "hello" }, objectiveId: "objective-1", runId: "run-1", workflowId: "workflow-1", workflowRevision: 1, workflowHash: "workflow-hash-1", requestKey: "capability-admission-3", createdAt,
      target: { features: ["streaming"] },
    })).toThrow(CapabilityExecutionAdmissionError);
    expect(() => createCapabilityExecutionAdmission({
      capability: { ...capability, hash: "f".repeat(64) },
      parameters: { document: "hello" }, objectiveId: "objective-1", runId: "run-1", workflowId: "workflow-1", workflowRevision: 1, workflowHash: "workflow-hash-1", requestKey: "capability-admission-4", createdAt,
      target: { harness: "other", features: [] },
    })).toThrow(/not active|hash is invalid|not compatible|unavailable/);
    expect(() => createCapabilityExecutionAdmission({
      capability,
      parameters: { document: 4 }, objectiveId: "objective-1", runId: "run-1", workflowId: "workflow-1", workflowRevision: 1, workflowHash: "workflow-hash-1", requestKey: "capability-admission-5", createdAt,
      target: { features: ["streaming"] },
    })).toThrow(/Invalid parameters/);
  });

  it("renders whole-token JSON values as values and embedded values as deterministic text", () => {
    const rendered = renderCapabilityTemplate({ whole: "{{parameters.document}}", embedded: "doc={{parameters.document}}" }, {
      parameters: { document: "memo" }, runtimeDefaults: {}, capability: {
        capabilityId: "test", version: 1, contentHash: "0".repeat(64), provenance: { source: "test", metadata: {} }, triggers: [], runtimeDefaults: {}, parameters: { document: "memo" },
      }, execution: { admissionId: "admission", objectiveId: "objective", runId: "run", workflowId: "workflow", workflowRevision: 1, workflowHash: "hash", nodeId: null },
    });
    expect(rendered).toEqual({ whole: "memo", embedded: "doc=memo" });
  });
});
