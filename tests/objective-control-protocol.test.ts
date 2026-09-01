import { describe, expect, it } from "vitest";
import {
  ObjectiveControlMutationSchema,
  ObjectiveControlMutationRequestSchema,
  ObjectiveControlPlanRevisionSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlPlanSnapshotSchema,
  ObjectiveControlSourceSchema,
  applyObjectiveControlMutation,
  objectiveControlExecutionId,
  objectiveControlStableJson,
  parseObjectiveControlPlan,
  validateObjectiveControlMutationTarget,
  walkObjectiveControlNodes,
} from "../packages/protocol/src/objective-control.js";

const source = {
  kind: "conductor-authored" as const,
  authorAgentId: "conductor-1",
  sessionId: "session-1",
};

function identity(id: string, sourcePath = id) {
  return { id, sourceNodeId: id, sourcePath, dependsOn: [] as string[] };
}

function agent(id: string, sourcePath = id) {
  return {
    ...identity(id, sourcePath),
    type: "agent" as const,
    objective: `Execute ${id}`,
    model: "auto",
    harness: "auto" as const,
    outputSchema: { type: "object" },
    inputs: [],
    requiresApproval: false,
  };
}

function plan(root: Record<string, unknown>, limits: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    id: "plan-1",
    source,
    root,
    limits: {
      maxNodes: null,
      maxDepth: null,
      maxLoopIterations: null,
      maxConcurrentAgents: null,
      ...limits,
    },
  };
}

describe("objective control-plan protocol", () => {
  it("keeps wire strategy mutations typed and identity-free", () => {
    const request = ObjectiveControlMutationRequestSchema.parse({
      type: "set-loop-bound",
      expectedRevision: 2,
      nodeId: "repeat",
      maxIterations: 4,
      reason: "Permit one additional bounded iteration.",
      evidence: { eventCursor: 42, eventIds: [] },
    });
    expect(request).toMatchObject({ type: "set-loop-bound", expectedRevision: 2, nodeId: "repeat" });
    expect(() => ObjectiveControlMutationRequestSchema.parse({
      ...request,
      mutationId: "caller-supplied",
    })).toThrow();
    expect(() => ObjectiveControlMutationRequestSchema.parse({
      ...request,
      type: "insert-node",
      parentId: "root",
      slot: "steps",
      node: { id: "new-node" },
    })).toThrow();
  });

  it("parses a valid nested plan with all control forms", () => {
    const parsed = parseObjectiveControlPlan(plan({
      ...identity("root"),
      type: "sequence",
      steps: [
        agent("prepare", "steps.0"),
        {
          ...identity("branch", "steps.1"),
          type: "if" as const,
          condition: { path: "prepare.ok", op: "eq" as const, value: true },
          then: [
            {
              ...identity("parallel", "steps.1.then.0"),
              type: "parallel" as const,
              steps: [agent("left", "steps.1.then.0.steps.0"), agent("right", "steps.1.then.0.steps.1")],
            },
          ],
          else: [{ ...identity("fallback", "steps.1.else.0"), type: "set" as const, value: { ok: false } }],
        },
        {
          ...identity("repeat", "steps.2"),
          type: "while" as const,
          condition: { path: "repeat.done", op: "neq" as const, value: true },
          maxIterations: 3,
          steps: [agent("iteration", "steps.2.steps.0")],
        },
      ],
    }));

    expect(parsed.root.type).toBe("sequence");
    expect(parsed.root.steps).toHaveLength(3);
    expect(parsed.root.steps[2]).toMatchObject({ type: "while", maxIterations: 3 });
  });

  it("rejects malformed data and keeps the union data-only and strict", () => {
    expect(() => ObjectiveControlSourceSchema.parse({
      kind: "conductor-authored",
      authorAgentId: "conductor-1",
      sessionId: null,
      execute: "() => process.exit()",
    })).toThrow();
    expect(() => ObjectiveControlPlanSchema.parse(plan({
      ...identity("root"),
      type: "while",
      condition: { path: "ok", op: "exists" },
      steps: [agent("child")],
      // A bounded while must say how many iterations it can run.
    }))).toThrow(/maxIterations|required/);
    expect(() => ObjectiveControlPlanSchema.parse(plan({
      ...identity("root"),
      type: "sequence",
      steps: [agent("child", "steps.0")],
      arbitraryCode: { language: "javascript" },
    }))).toThrow();
  });

  it("rejects duplicate ids, invalid references, dependency cycles, and limits", () => {
    expect(() => ObjectiveControlPlanSchema.parse(plan({
      ...identity("root"),
      type: "sequence",
      steps: [agent("same", "steps.0"), agent("same", "steps.1")],
    }))).toThrow(/Duplicate objective control node id/);

    expect(() => ObjectiveControlPlanSchema.parse(plan({
      ...identity("root"),
      type: "sequence",
      steps: [{ ...agent("child", "steps.0"), dependsOn: ["missing"] }],
    }))).toThrow(/unknown node/);

    expect(() => ObjectiveControlPlanSchema.parse(plan({
      ...identity("root"),
      type: "sequence",
      steps: [
        { ...agent("a", "steps.0"), dependsOn: ["b"] },
        { ...agent("b", "steps.1"), dependsOn: ["a"] },
      ],
    }))).toThrow(/dependency cycle/);

    expect(() => ObjectiveControlPlanSchema.parse(plan({
      ...identity("root"),
      type: "sequence",
      steps: [agent("one", "steps.0"), agent("two", "steps.1")],
    }, { maxNodes: 2 }))).toThrow(/maxNodes/);

    expect(() => ObjectiveControlPlanSchema.parse(plan({
      ...identity("root"),
      type: "sequence",
      steps: [{ ...identity("nested", "steps.0"), type: "sequence" as const, steps: [agent("leaf", "steps.0.steps.0")] }],
    }, { maxDepth: 2 }))).toThrow(/maxDepth/);

    expect(() => ObjectiveControlPlanSchema.parse(plan({
      ...identity("repeat"),
      type: "while",
      condition: { path: "again", op: "exists" },
      maxIterations: 4,
      steps: [agent("body", "steps.0")],
    }, { maxLoopIterations: 3 }))).toThrow(/maxLoopIterations/);
  });

  it("counts and exposes fanout templates for policy traversal", () => {
    const parsed = ObjectiveControlPlanSchema.parse(plan({
      ...identity("root"),
      type: "sequence",
      steps: [{
        ...identity("map", "steps.0"),
        type: "fanout" as const,
        source: "files",
        concurrency: null,
        itemTemplate: agent("item", "steps.0.itemTemplate"),
      }],
    }));
    const visits = walkObjectiveControlNodes(parsed.root, { includeFanoutTemplates: true });
    expect(visits.map((visit) => visit.node.id)).toEqual(["root", "map", "item"]);
    expect(visits.map((visit) => visit.isFanoutTemplate)).toEqual([false, false, true]);
    expect(() => ObjectiveControlPlanSchema.parse(plan(parsed.root, { maxNodes: 2 }))).toThrow(/maxNodes/);
  });

  it("preserves deterministic source paths and distinct loop execution identities", () => {
    const first = {
      nodeId: "iteration",
      iterationKey: "root/repeat:1",
    } as const;
    const second = {
      nodeId: "iteration",
      iterationKey: "root/repeat:2",
    } as const;
    const outerLoop = {
      nodeId: "outer",
      iterationKey: "root/outer:1",
    } as const;
    const innerLoop = {
      nodeId: "inner",
      iterationKey: "root/outer:1/inner:1",
    } as const;
    expect(objectiveControlExecutionId(first)).not.toBe(objectiveControlExecutionId(second));
    const snapshot = ObjectiveControlPlanSnapshotSchema.parse({
      version: 1,
      planId: "plan-1",
      objectiveId: "objective-1",
      runId: "run-1",
      planRevision: 0,
      sequence: 2,
      eventCursor: 9,
      nodeStates: {
        [objectiveControlExecutionId(first)]: "completed",
        [objectiveControlExecutionId(second)]: "failed",
      },
      frontier: [second],
      branches: {},
      loopIterations: {
        [objectiveControlExecutionId(outerLoop)]: 1,
        [objectiveControlExecutionId(innerLoop)]: 3,
      },
      exitReasons: { [objectiveControlExecutionId(second)]: "failed" },
      attemptIds: {
        [objectiveControlExecutionId(first)]: "attempt-1",
        [objectiveControlExecutionId(second)]: "attempt-2",
      },
      executions: [
        { key: first, state: "completed", attemptId: "attempt-1" },
        { key: second, state: "failed", attemptId: "attempt-2" },
      ],
      contextRefs: [],
      reason: "loop progressed",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(snapshot.executions).toHaveLength(2);
    expect(snapshot.attemptIds[objectiveControlExecutionId(second)]).toBe("attempt-2");
    expect(snapshot.loopIterations[objectiveControlExecutionId(outerLoop)]).toBe(1);
    expect(snapshot.loopIterations[objectiveControlExecutionId(innerLoop)]).toBe(3);
    expect(objectiveControlStableJson({ b: 2, a: 1 })).toBe(objectiveControlStableJson({ a: 1, b: 2 }));
  });

  it("validates typed CAS mutations and immutable revision source identity", () => {
    const mutation = ObjectiveControlMutationSchema.parse({
      version: 1,
      mutationId: "mutation-1",
      planId: "plan-1",
      objectiveId: "objective-1",
      runId: "run-1",
      expectedRevision: 0,
      type: "insert-node",
      parentId: "root",
      slot: "steps",
      position: 1,
      node: agent("inserted", "steps.1"),
      reason: "Add the missing execution branch.",
      evidence: { eventCursor: 10, eventIds: ["event-10"] },
      requestKey: "request-mutation-1",
      actor: { type: "agent", id: "conductor-1" },
    });
    expect(mutation.type).toBe("insert-node");
    expect(() => ObjectiveControlMutationSchema.parse({
      ...mutation,
      type: "set-loop-bound",
      nodeId: "inserted",
      maxIterations: 0,
      parentId: undefined,
      slot: undefined,
      position: undefined,
      node: undefined,
    })).toThrow();

    const validPlan = plan({ ...identity("root"), type: "set", value: true });
    const record = ObjectiveControlPlanRevisionSchema.parse({
      version: 1,
      planId: "plan-1",
      objectiveId: "objective-1",
      runId: "run-1",
      revision: 0,
      source,
      plan: validPlan,
      hash: "plan-hash-1",
      createdBy: { type: "agent", id: "conductor-1" },
      requestKey: "request-plan-1",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(record.revision).toBe(0);
    expect(() => ObjectiveControlPlanRevisionSchema.parse({
      ...record,
      source: { ...source, authorAgentId: "other-agent" },
    })).toThrow(/source/i);
  });

  it("makes if insertion targets explicit and rejects invalid parent-slot pairs", () => {
    const branchPlan = parseObjectiveControlPlan(plan({
      ...identity("root"),
      type: "if",
      condition: { path: "ready", op: "exists" },
      then: [agent("existing-then", "root.then.0")],
      else: [agent("existing-else", "root.else.0")],
    }));
    const insert = (slot: "then" | "else") => ObjectiveControlMutationSchema.parse({
      version: 1,
      mutationId: `mutation-${slot}`,
      planId: "plan-1",
      objectiveId: "objective-1",
      runId: "run-1",
      expectedRevision: 0,
      type: "insert-node",
      parentId: "root",
      slot,
      node: agent(`branch-${slot}`, `root.${slot}.0`),
      reason: `Insert into ${slot}.`,
      evidence: { eventCursor: 11, eventIds: [] },
      requestKey: `request-${slot}-1`,
      actor: { type: "agent", id: "conductor-1" },
    });
    const thenMutation = insert("then");
    const elseMutation = insert("else");
    expect(thenMutation.slot).toBe("then");
    expect(elseMutation.slot).toBe("else");
    expect(() => validateObjectiveControlMutationTarget(thenMutation, branchPlan)).not.toThrow();
    expect(() => validateObjectiveControlMutationTarget(elseMutation, branchPlan)).not.toThrow();
    const thenResult = applyObjectiveControlMutation(branchPlan, thenMutation);
    const elseResult = applyObjectiveControlMutation(branchPlan, elseMutation);
    expect(thenResult.root).toMatchObject({ type: "if", then: [{ id: "existing-then" }, { id: "branch-then" }] });
    expect(elseResult.root).toMatchObject({ type: "if", else: [{ id: "existing-else" }, { id: "branch-else" }] });
    expect(thenResult.source).toEqual(branchPlan.source);
    expect(() => applyObjectiveControlMutation(thenResult, thenMutation)).toThrow(/already exists/);
    expect(() => applyObjectiveControlMutation(branchPlan, {
      ...thenMutation,
      node: { ...thenMutation.node, id: "ref-node", sourceNodeId: "ref-node", dependsOn: ["missing"] },
    })).toThrow(/unknown node/);
    expect(() => validateObjectiveControlMutationTarget({ ...thenMutation, parentId: "branch-then" }, branchPlan)).toThrow(/parent/);
    expect(() => validateObjectiveControlMutationTarget({ ...thenMutation, slot: "steps" }, branchPlan)).toThrow(/steps|if/);

    expect(() => ObjectiveControlMutationSchema.parse({
      ...thenMutation,
      slot: "root",
    })).toThrow();

    const whilePlan = parseObjectiveControlPlan(plan({
      ...identity("repeat"),
      type: "while",
      condition: { path: "again", op: "exists" },
      maxIterations: 2,
      steps: [agent("loop-body", "repeat.steps.0")],
    }, { maxLoopIterations: 3 }));
    const loopMutation = ObjectiveControlMutationSchema.parse({
      version: 1,
      mutationId: "mutation-loop",
      planId: "plan-1",
      objectiveId: "objective-1",
      runId: "run-1",
      expectedRevision: 0,
      type: "set-loop-bound",
      nodeId: "repeat",
      maxIterations: 3,
      reason: "Allow one more bounded iteration.",
      evidence: { eventCursor: 12, eventIds: [] },
      requestKey: "request-loop-1",
      actor: { type: "agent", id: "conductor-1" },
    });
    const boundedResult = applyObjectiveControlMutation(whilePlan, loopMutation);
    expect(boundedResult.root).toMatchObject({ type: "while", maxIterations: 3 });
    expect(boundedResult.source).toEqual(whilePlan.source);
    expect(() => applyObjectiveControlMutation(whilePlan, { ...loopMutation, maxIterations: 4 })).toThrow(/maxLoopIterations/);
    expect(() => applyObjectiveControlMutation(branchPlan, { ...loopMutation, nodeId: "existing-then" })).toThrow(/while/);

    const replacement = ObjectiveControlMutationSchema.parse({
      version: 1,
      planId: "plan-1",
      objectiveId: "objective-1",
      runId: "run-1",
      expectedRevision: 0,
      mutationId: "mutation-replace",
      type: "replace-node",
      nodeId: "existing-then",
      node: { ...agent("existing-then", "root.then.0"), label: "replaced" },
      reason: "Replace the existing branch node.",
      evidence: { eventCursor: 13, eventIds: [] },
      requestKey: "request-replace-1",
      actor: { type: "agent", id: "conductor-1" },
    });
    const replacedResult = applyObjectiveControlMutation(branchPlan, replacement);
    expect(replacedResult.root).toMatchObject({ type: "if", then: [{ id: "existing-then", label: "replaced" }] });
    expect(() => applyObjectiveControlMutation(branchPlan, {
      ...replacement,
      node: { ...replacement.node, id: "different" },
    })).toThrow(/target node id/);
  });
});
