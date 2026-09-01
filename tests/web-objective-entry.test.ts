import { describe, expect, it } from "vitest";
import {
  buildFirstPlan,
  buildObjectiveCreateRequest,
  buildObjectivePolicy,
  ObjectiveEntryValidationError,
  normalizeConductorAgentId,
  objectiveExecutionAvailability,
  parseCriterionValue,
  standaloneWorkflowIdentity,
} from "../apps/web/src/lib/symphony/objective-entry.js";
import { ObjectivePolicyRequestSchema, WorkspaceSpecSchema } from "../packages/protocol/src/index.js";

const baseDraft = {
  objectiveId: "objective-release",
  workflowId: "workflow-build",
  workflowRevision: 3,
  workflowHash: "workflow-hash",
  workspacePath: "/work/release",
  mission: "Ship the release with evidence.",
  criteria: [{ description: "Tests pass", path: "checks.tests", op: "equals" as const, value: "true", required: true }],
  permission: "full-access" as const,
  maxReplans: "4",
  approvalPolicy: "on-replan" as const,
  firstPlan: "Inspect the current state\nImplement the change\nVerify the result",
};

describe("objective entry payload", () => {
  it("builds strict mission, criteria, task, workspace, and permission fields", () => {
    const request = buildObjectiveCreateRequest(baseDraft);

    expect(request).toMatchObject({
      objectiveId: "objective-release",
      workflowId: "workflow-build",
      workflowRevision: 3,
      workflowHash: "workflow-hash",
      spec: {
        id: "objective-release",
        statement: "Ship the release with evidence.",
        approvalPolicy: { mode: "on-replan" },
        maxReplans: 4,
      },
    });
    expect(request.spec.criteria).toEqual([{
      id: "criterion-tests-pass-1",
      description: "Tests pass",
      path: "checks.tests",
      op: "equals",
      value: true,
      required: true,
    }]);
    expect(request.tasks).toHaveLength(3);
    expect(request.tasks?.[1]).toMatchObject({
      id: "task-2",
      dependsOn: [],
      permissions: "full-access",
      workspace: { path: "/work/release", dirtyPolicy: "local-only" },
    });
    // The durable policy is nested under the daemon's admission contract.
    expect(request).not.toHaveProperty("budget");
    expect(request).not.toHaveProperty("context.budget");
    expect(request.policy?.budget).toMatchObject({ maxCostUsd: null, maxTotalTokens: null, maxModelCalls: null });
  });

  it("keeps an omitted first plan omitted while retaining the objective spec", () => {
    const request = buildObjectiveCreateRequest({ ...baseDraft, firstPlan: "" });
    expect(request).not.toHaveProperty("tasks");
    expect(request.spec.statement).toBe(baseDraft.mission);
  });

  it("creates a durable standalone identity when no workflow is registered", () => {
    const request = buildObjectiveCreateRequest({ ...baseDraft, workflowId: "", workflowRevision: undefined, workflowHash: "" });
    expect(request).toMatchObject(standaloneWorkflowIdentity(baseDraft.objectiveId));
  });

  it("attaches only the active conductor identity", () => {
    const request = buildObjectiveCreateRequest({ ...baseDraft, conductorAgentId: "agent-conductor" });
    expect(request.conductorAgentId).toBe("agent-conductor");
    expect(buildObjectiveCreateRequest({ ...baseDraft, conductorAgentId: " " })).not.toHaveProperty("conductorAgentId");
  });

  it("distinguishes a standalone workflow identity from executable dispatch", () => {
    expect(normalizeConductorAgentId("  agent-conductor  ")).toBe("agent-conductor");
    expect(normalizeConductorAgentId(" ")).toBeNull();
    expect(objectiveExecutionAvailability(null)).toEqual({
      executable: false,
      message: "An active conductor chat is required before this objective can dispatch work.",
    });
    expect(objectiveExecutionAvailability("agent-conductor")).toMatchObject({ executable: true });
  });

  it("trims blank plan lines and caps the task graph at the protocol limit", () => {
    const plan = Array.from({ length: 140 }, (_, index) => index % 2 ? "" : `Task ${index}`).join("\n");
    const tasks = buildFirstPlan(plan, "/work/release", "read-only");
    expect(tasks).toHaveLength(70);
    expect(tasks.at(-1)).toMatchObject({ permissions: "read-only", workspace: { path: "/work/release" } });
  });

  it("parses JSON criterion values and leaves plain text values readable", () => {
    expect(parseCriterionValue("true")).toBe(true);
    expect(parseCriterionValue("42")).toBe(42);
    expect(parseCriterionValue("{\"branch\":\"main\"}")).toEqual({ branch: "main" });
    expect(parseCriterionValue("green")).toBe("green");
  });

  it("rejects missing mission and invalid replan bounds", () => {
    expect(() => buildObjectiveCreateRequest({ ...baseDraft, mission: " " })).toThrowError(ObjectiveEntryValidationError);
    expect(() => buildObjectiveCreateRequest({ ...baseDraft, maxReplans: "129" })).toThrow(/between 0 and 128/);
  });

  it("builds an explicit durable policy envelope with unlimited ceilings", () => {
    const request = buildObjectiveCreateRequest({
      ...baseDraft,
      workspaceDirtyPolicy: "require-clean",
      maxCostUsd: "2.50",
      maxTotalTokens: "10000",
      maxModelCalls: "12",
      maxToolCalls: "40",
      maxWallTimeSeconds: "900",
      maxOutputBytes: "500000",
      maxConcurrentAgents: "3",
      allowedCapabilities: "read, observe\nread",
      sideEffectClassCeiling: "local",
      expiresAt: "2026-09-02T03:04",
      approvalTimeoutSeconds: "60",
    });

    expect(request.workspace).toEqual({ path: "/work/release", dirtyPolicy: "require-clean" });
    expect(request.tasks?.[0]?.workspace).toEqual({ path: "/work/release", dirtyPolicy: "require-clean" });
    expect(request.policy).toMatchObject({
      effectivePermission: "full-access",
      allowedCapabilities: ["read", "observe"],
      sideEffectClassCeiling: "local",
      approvalPolicy: { mode: "on-replan", timeoutSeconds: 60 },
      expiresAt: new Date("2026-09-02T03:04").toISOString(),
      budget: {
        maxCostUsd: 2.5,
        maxTotalTokens: 10000,
        maxModelCalls: 12,
        maxToolCalls: 40,
        maxWallTimeSeconds: 900,
        maxOutputBytes: 500000,
        maxConcurrentAgents: 3,
      },
    });
    expect(request.policy?.budget).toMatchObject({
      maxInputTokens: null,
      maxOutputTokens: null,
      maxStorageBytes: null,
      maxLoopIterations: null,
      maxDepth: null,
    });
    expect(ObjectivePolicyRequestSchema.parse(request.policy)).toEqual(request.policy);
    expect(WorkspaceSpecSchema.parse(request.workspace)).toEqual(request.workspace);

    const unlimited = buildObjectivePolicy({ ...baseDraft, approvalTimeoutSeconds: "Unlimited" });
    expect(unlimited.budget).toMatchObject({ maxCostUsd: null, maxTotalTokens: null, maxConcurrentAgents: null });
    expect(unlimited.approvalPolicy).toEqual({ mode: "on-replan" });
    expect(unlimited.expiresAt).toBeNull();
  });

  it("rejects blank and invalid quantitative ceilings before a request is sent", () => {
    expect(() => buildObjectiveCreateRequest({ ...baseDraft, maxCostUsd: " " })).toThrow(/Cost ceiling/);
    expect(() => buildObjectiveCreateRequest({ ...baseDraft, maxTotalTokens: "1.5" })).toThrow(/whole number/);
    expect(() => buildObjectiveCreateRequest({ ...baseDraft, maxToolCalls: "-1" })).toThrow(/non-negative/);
    expect(() => buildObjectiveCreateRequest({ ...baseDraft, approvalTimeoutSeconds: "0" })).toThrow(/positive/);
    expect(() => buildObjectiveCreateRequest({ ...baseDraft, expiresAt: "not-a-date" })).toThrow(/valid date/);
  });
});
