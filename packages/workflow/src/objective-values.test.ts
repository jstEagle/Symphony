import { describe, expect, it } from "vitest";
import {
  ObjectiveControlMutationSchema,
  ObjectiveControlPlanSchema,
  ObjectiveSpecSchema,
} from "@symphony/protocol";
import {
  assertObjectiveValueCharterMutationReason,
  bindObjectiveValueCharterToMutation,
  bindObjectiveValueCharterToPlan,
  normalizeObjectiveSpecValueCharter,
  objectiveValueCharterMutationReasonIssues,
} from "./objective-values.js";

const charter = {
  version: 1 as const,
  revision: 2,
  values: [
    { id: "safety", label: "Safety", priority: 1 },
    { id: "speed", label: "Speed", priority: 2 },
  ],
  tradeoffs: [{ id: "safety-over-speed", higherPriorityValueId: "safety", lowerPriorityValueId: "speed", guidance: "Choose verification over haste when uncertain." }],
  antiGoals: [],
  hardConstraints: [],
  evidenceExpectations: [],
};

const plan = ObjectiveControlPlanSchema.parse({
  version: 1,
  id: "plan-1",
  source: { kind: "conductor-authored", authorAgentId: "conductor-1", sessionId: null },
  root: {
    id: "root",
    sourceNodeId: "root",
    sourcePath: "root",
    dependsOn: [],
    type: "sequence",
    steps: [{
      id: "worker",
      sourceNodeId: "worker",
      sourcePath: "root.steps.0",
      dependsOn: [],
      type: "agent",
      objective: "Verify",
      model: "auto",
      harness: "auto",
      outputSchema: {},
      inputs: [],
      requiresApproval: false,
    }],
  },
});

function mutation() {
  return ObjectiveControlMutationSchema.parse({
    version: 1,
    mutationId: "mutation-1",
    planId: "plan-1",
    objectiveId: "objective-1",
    runId: "run-1",
    expectedRevision: 0,
    type: "replace-node",
    nodeId: "root",
    node: plan.root,
    reason: "Keep safety ahead of speed while revising the strategy.",
    evidence: { eventCursor: 4, eventIds: ["event-4"] },
    requestKey: "mutation-request-1",
    actor: { type: "agent", id: "conductor-1" },
    charterCitations: { valueIds: ["safety"], tradeoffIds: ["safety-over-speed"] },
  });
}

describe("objective value workflow kernel", () => {
  it("normalizes a charter on objective admission and binds it to a plan", () => {
    const spec = normalizeObjectiveSpecValueCharter(ObjectiveSpecSchema.parse({ id: "objective-1", statement: "Ship safely", valueCharter: charter }));
    expect(spec.valueCharter?.hash).toMatch(/^[a-f0-9]{64}$/u);
    const boundPlan = bindObjectiveValueCharterToPlan(plan, spec.valueCharter);
    expect(boundPlan).toMatchObject({ valueCharterRevision: 2, valueCharterHash: spec.valueCharter?.hash });
  });

  it("requires known value/tradeoff citations for charter-aware strategy mutations", () => {
    const parsed = mutation();
    expect(objectiveValueCharterMutationReasonIssues(charter, { reason: parsed.reason, charterCitations: undefined })).toHaveLength(1);
    expect(() => assertObjectiveValueCharterMutationReason(charter, parsed)).not.toThrow();
    expect(() => bindObjectiveValueCharterToMutation(parsed, charter)).not.toThrow();
    expect(() => assertObjectiveValueCharterMutationReason(charter, { reason: parsed.reason, charterCitations: { valueIds: ["unknown"], tradeoffIds: [] } })).toThrow(/unknown charter value/iu);
  });
});
