import { describe, expect, it } from "vitest";
import {
  ObjectiveControlMutationSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlPlanSnapshotSchema,
  applyObjectiveControlMutation,
  applyObjectiveControlMutationToSnapshot,
  previewObjectiveControlMutation,
} from "../packages/protocol/src/objective-control.js";

const base = (id: string, sourcePath = id) => ({ id, sourceNodeId: id, sourcePath, dependsOn: [] as string[] });
const agent = (id: string, sourcePath = id) => ({
  ...base(id, sourcePath), type: "agent" as const, objective: id, model: "fixture", harness: "auto" as const,
  outputSchema: {}, inputs: [], requiresApproval: false,
});
const plan = ObjectiveControlPlanSchema.parse({
  version: 1,
  id: "rewrite-plan",
  source: { kind: "conductor-authored", authorAgentId: "conductor", sessionId: null },
  root: { ...base("root"), type: "sequence" as const, steps: [agent("live", "steps.0"), agent("keep", "steps.1")] },
  limits: { maxNodes: null, maxDepth: null, maxLoopIterations: null, maxConcurrentAgents: null },
});

function mutation(input: Record<string, unknown>) {
  return ObjectiveControlMutationSchema.parse({
    version: 1, mutationId: "rewrite-mutation-1", planId: plan.id, objectiveId: "objective", runId: "run", expectedRevision: 0,
    reason: "bounded strategy rewrite", evidence: { eventCursor: 7, eventIds: ["event-7"] }, requestKey: "rewrite-request-1",
    actor: { type: "agent", id: "conductor" }, ...input,
  });
}

describe("policy-safe strategy rewrites", () => {
  it("keeps removed active attempts in explicit cancellation lineage", () => {
    const remove = mutation({
      type: "remove-subtree", nodeId: "live",
      cancellationIntent: { type: "cancel-active-attempts", reason: "live branch is obsolete", preserveLineage: true },
    });
    const candidate = applyObjectiveControlMutation(plan, remove);
    const snapshot = ObjectiveControlPlanSnapshotSchema.parse({
      version: 1, planId: plan.id, objectiveId: "objective", runId: "run", planRevision: 0, sequence: 1, eventCursor: 7,
      nodeStates: { "live@root": "running", "keep@root": "queued" }, frontier: [{ nodeId: "live", iterationKey: "root" }], branches: {}, loopIterations: {}, exitReasons: {},
      attemptIds: { "live@root": "attempt-live", "keep@root": null },
      executions: [
        { key: { nodeId: "live", iterationKey: "root" }, state: "running", attemptId: "attempt-live", agentId: "native-live" },
        { key: { nodeId: "keep", iterationKey: "root" }, state: "queued", attemptId: null },
      ], contextRefs: [], reason: "running", createdAt: "2026-09-01T00:00:00.000Z",
    });
    const reduced = applyObjectiveControlMutationToSnapshot(plan, snapshot, remove, candidate, "2026-09-01T00:00:01.000Z");
    expect(reduced.executions.map((entry) => entry.key.nodeId)).toEqual(["keep"]);
    expect(reduced.cancellations).toMatchObject([{ attemptId: "attempt-live", agentId: "native-live", sourceMutationId: "rewrite-mutation-1" }]);
  });

  it("previews branch and dependency rewrites with deterministic impact", () => {
    const insert = mutation({
      type: "insert-branch", branchNodeId: "root", branch: "then", node: { ...agent("inserted"), sourcePath: "root.then.0" },
    });
    expect(() => applyObjectiveControlMutation(plan, insert)).toThrow(/if node/);
    const rewire = mutation({ type: "rewire-dependencies", nodeId: "keep", dependsOn: ["live"] });
    const candidate = applyObjectiveControlMutation(plan, rewire);
    const snapshot = ObjectiveControlPlanSnapshotSchema.parse({
      version: 1, planId: plan.id, objectiveId: "objective", runId: "run", planRevision: 0, sequence: 1, eventCursor: 7,
      nodeStates: { "root@root": "queued" }, frontier: [{ nodeId: "root", iterationKey: "root" }], branches: {}, loopIterations: {}, exitReasons: {}, attemptIds: { "root@root": null },
      executions: [{ key: { nodeId: "root", iterationKey: "root" }, state: "queued", attemptId: null }], contextRefs: [], reason: "queued", createdAt: "2026-09-01T00:00:00.000Z",
    });
    const preview = previewObjectiveControlMutation(plan, snapshot, rewire);
    expect(preview.valid).toBe(true);
    expect(preview.impact.edgesAdded).toEqual([{ from: "keep", to: "live" }]);
    expect(candidate.root.type).toBe("sequence");
  });

  it("rejects executable-source fields in typed insertion nodes", () => {
    expect(() => ObjectiveControlMutationSchema.parse({
      ...mutation({ type: "insert-artifact", parentId: "root", slot: "steps", node: {
        ...base("artifact"), type: "artifact", kind: "evidence", name: "proof", mediaType: "application/json", content: {}, execute: "process.exit(1)",
      } }),
    })).toThrow();
  });
});
