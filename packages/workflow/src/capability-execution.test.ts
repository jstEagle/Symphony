import { describe, expect, it } from "vitest";
import {
  CapabilityVersionRecordSchema,
  ObjectiveControlNodeSchema,
  ObjectiveTaskSchema,
  capabilityVersionContentHash,
  type ObjectiveControlAgentNode,
} from "@symphony/protocol";
import {
  admitCapabilityControlAgentNode,
  admitCapabilityObjectiveTask,
  createCapabilityWorkflowExecution,
  parseCapabilityWorkflowExecution,
} from "./capability-execution.js";

const createdAt = "2026-09-01T00:00:00.000Z";

function capability() {
  const content = {
    schemaVersion: 1 as const,
    capabilityId: "research.extract",
    version: 1,
    state: "active" as const,
    status: "active" as const,
    definition: {
      name: "Extract",
      parameters: {
        type: "object" as const,
        properties: { query: { type: "string" as const }, format: { type: "string" as const, default: "brief" } },
        required: ["query"],
        additionalProperties: false,
      },
      triggers: [{ id: "manual", kind: "manual", configuration: {}, enabled: true }],
      defaults: { harness: "fixture", model: "fixture-model", permission: "read-only" },
    },
    provenance: { source: "workflow-test", metadata: {} },
    hash: "0".repeat(64),
    createdAt,
    updatedAt: createdAt,
    activatedAt: createdAt,
    deprecatedAt: null,
  };
  return CapabilityVersionRecordSchema.parse({ ...content, hash: capabilityVersionContentHash(content) });
}

function admissionFields() {
  return {
    capability: capability(),
    parameters: { query: "distributed systems" },
    objectiveId: "objective-1",
    runId: "run-1",
    workflowId: "workflow-1",
    workflowRevision: 1,
    workflowHash: "workflow-hash-1",
    requestKey: "capability-workflow-1",
    createdAt,
  } as const;
}

describe("workflow capability execution bridge", () => {
  it("keeps capability use optional and renders a caller-owned task/plan", () => {
    const result = createCapabilityWorkflowExecution({
      ...admissionFields(),
      task: { objective: "Research {{parameters.query}}", format: "{{params.format}}" },
      plan: { run: "{{execution.runId}}", strategy: "caller-defined" },
    });
    expect(result.task).toEqual({ objective: "Research distributed systems", format: "brief" });
    expect(result.plan).toEqual({ run: "run-1", strategy: "caller-defined" });
    expect(result.admission.capabilityId).toBe("research.extract");
    expect(parseCapabilityWorkflowExecution(result)).toEqual(result);
  });

  it("attaches exact capability identity to typed objective tasks without selecting a role", () => {
    const task = ObjectiveTaskSchema.parse({
      id: "extract",
      objective: "Extract {{parameters.query}}",
      outputSchema: {},
      model: "auto",
      harness: "auto",
      inputs: [],
      requiresApproval: false,
    });
    const result = admitCapabilityObjectiveTask({ ...admissionFields(), task });
    expect(result.task.objective).toBe("Extract distributed systems");
    expect(result.task.capabilities).toEqual(["research.extract"]);
    expect(result.task.capabilityExecution).toMatchObject({
      capabilityId: "research.extract",
      version: 1,
      contentHash: result.admission.contentHash,
      parameters: { query: "distributed systems", format: "brief" },
    });
    expect(result.task.model).toBe("auto");
    expect(result.task.harness).toBe("auto");
  });

  it("attaches a binding to a caller-authored control agent and rejects non-agent nodes", () => {
    const node = ObjectiveControlNodeSchema.parse({
      id: "extract",
      sourceNodeId: "extract",
      sourcePath: "steps.0",
      dependsOn: [],
      type: "agent",
      objective: "Extract {{parameters.query}}",
      model: "auto",
      harness: "auto",
      outputSchema: {},
      inputs: [],
      requiresApproval: false,
    });
    const result = admitCapabilityControlAgentNode({ ...admissionFields(), node: node as ObjectiveControlAgentNode });
    expect(result.node.objective).toBe("Extract distributed systems");
    expect(result.node.capabilityExecution?.contentHash).toBe(result.admission.contentHash);
    expect(result.node.capabilities).toEqual(["research.extract"]);
    expect(() => admitCapabilityControlAgentNode({ ...admissionFields(), node: { ...node, type: "set" } as never })).toThrow();
  });
});
