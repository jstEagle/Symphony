import { describe, expect, it } from "vitest";
import type { JsonValue, WorkflowRevisionRecord } from "./contracts";
import { buildWorkflowVisualModel, validateWorkflowJson } from "./workflow-studio";

const definition = {
  id: "release-check",
  name: "Release check",
  mission: { statement: "Ship a verified release", keyResults: ["Tests are green"] },
  workspace: { path: "/workspace", dirtyPolicy: "local-only" },
  steps: [
    {
      id: "prepare",
      type: "sequence",
      steps: [
        { id: "set-context", type: "set", value: { release: true } },
        {
          id: "quality-gate",
          type: "if",
          condition: { path: "steps.tests.score", op: "gte", value: 8 },
          then: [{ id: "publish", type: "agent", objective: "Publish the release", outputSchema: { type: "object" } }],
          else: [{ id: "repair", type: "agent", objective: "Repair the release", outputSchema: { type: "object" } }],
        },
      ],
    },
    {
      id: "review-loop",
      type: "while",
      condition: { path: "steps.review.approved", op: "neq", value: true },
      maxIterations: 3,
      steps: [{ id: "review", type: "agent", objective: "Review the release", outputSchema: { type: "object" } }],
    },
  ],
};

const record: WorkflowRevisionRecord = {
  id: "release-check",
  revision: 4,
  mission: { ...definition.mission, id: "release-check", revision: 4, hash: "a".repeat(64) } as unknown as JsonValue,
  definition: definition as unknown as JsonValue,
  ir: { definition: definition as unknown as JsonValue, revision: 4, hash: "a".repeat(64), mission: definition.mission as unknown as JsonValue, stepIds: [] } as unknown as JsonValue,
  hash: "a".repeat(64),
  createdAt: "2026-09-01T00:00:00.000Z",
};

describe("workflow studio view model", () => {
  it("preserves nested containers and makes if branches and while loops addressable", () => {
    const model = buildWorkflowVisualModel(record);
    expect(model.name).toBe("Release check");
    expect(model.steps.map((step) => step.type)).toEqual(["sequence", "while"]);
    expect(model.steps[0]?.steps[1]?.branches.map((branch) => branch.label)).toEqual(["then", "else"]);
    expect(model.steps[1]?.detail).toContain("max 3 iterations");
    expect(model.steps[1]?.steps[0]?.id).toBe("review");
  });

  it("rejects malformed JSON and unknown keys before registration", () => {
    expect(validateWorkflowJson("{not-json").valid).toBe(false);
    const result = validateWorkflowJson(JSON.stringify({ ...definition, unsafe: true }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("$.unsafe is not supported.");
  });

  it("rejects duplicate nested step ids and missing agent output schemas", () => {
    const result = validateWorkflowJson(JSON.stringify({
      ...definition,
      steps: [
        { id: "same", type: "agent", objective: "One" },
        { id: "same", type: "agent", objective: "Two", outputSchema: {} },
      ],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("duplicates same"))).toBe(true);
    expect(result.errors.some((error) => error.includes("outputSchema"))).toBe(true);
  });

  it("returns a JSON value only when the entire definition is valid", () => {
    const result = validateWorkflowJson(JSON.stringify(definition));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual(definition);
  });

  it("validates and renders deterministic evaluation steps without inventing a percentage", () => {
    const evaluationDefinition = {
      ...definition,
      steps: [{ id: "quality", type: "evaluate", metric: "Release quality", path: "release.score", operator: "gte", target: 8 }],
    };
    const result = validateWorkflowJson(JSON.stringify(evaluationDefinition));
    expect(result.valid).toBe(true);
    const evaluationRecord = { ...record, definition: evaluationDefinition as unknown as JsonValue };
    const model = buildWorkflowVisualModel(evaluationRecord);
    expect(model.steps[0]).toMatchObject({ type: "evaluate", detail: "Release quality · release.score gte 8" });
    expect(model.steps[0]?.detail).not.toContain("%");
  });
});
