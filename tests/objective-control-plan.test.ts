import { describe, expect, it } from "vitest";
import { WorkflowCompiler, type WorkflowDefinition } from "../packages/workflow/src/index.js";
import {
  applyObjectiveControlAcknowledgement,
  compileObjectiveControlPlan,
  createObjectiveControlSnapshot,
  evaluateObjectiveControlNode,
  nextObjectiveControlIntent,
  ObjectiveControlAcknowledgementSchema,
  objectiveControlPlanHash,
  pinObjectiveControlPlan,
  type ObjectiveControlAcknowledgement,
} from "../packages/workflow/src/objective-control-plan.js";
import { objectiveControlExecutionId, type JsonValue, type ObjectiveControlPlanSnapshot } from "@symphony/protocol";

const now = "2026-09-01T00:00:00.000Z";

function agent(id: string, objective = `Run ${id}`) {
  return {
    id,
    type: "agent" as const,
    objective,
    model: "fixture",
    harness: "codex" as const,
    outputSchema: { type: "object" },
  };
}

function definition(steps: WorkflowDefinition["steps"]): WorkflowDefinition {
  return {
    id: "control-plan-fixture",
    name: "Control plan fixture",
    mission: { statement: "Exercise the durable control tree.", keyResults: [] },
    workspace: { path: "/tmp/control-plan-fixture" },
    inputSchema: { type: "object" },
    output: "steps",
    steps,
    triggers: [{ id: "manual", type: "manual" }],
  };
}

function fixture(steps: WorkflowDefinition["steps"], context: Record<string, JsonValue> = {}) {
  const ir = new WorkflowCompiler().compile(definition(steps), 3);
  const plan = compileObjectiveControlPlan(ir, { planId: "plan-control-fixture" });
  const snapshot = createObjectiveControlSnapshot(plan, {
    objectiveId: "objective-control-fixture",
    runId: "run-control-fixture",
    planRevision: 0,
    context,
    createdAt: now,
  });
  return { plan, snapshot };
}

let requestNumber = 0;
function ack(
  plan: ReturnType<typeof compileObjectiveControlPlan>,
  snapshot: ObjectiveControlPlanSnapshot,
  fields: Partial<ObjectiveControlAcknowledgement> = {},
): ObjectiveControlPlanSnapshot {
  const intent = nextObjectiveControlIntent(plan, snapshot);
  const acknowledgement: ObjectiveControlAcknowledgement = {
    kind: intent.kind,
    intentId: intent.intentId,
    requestKey: `control-ack-${++requestNumber}`,
    now,
    ...(intent.kind === "agent" && intent.operation !== "approval" ? { attemptId: intent.attemptId } : {}),
    ...(intent.kind === "evaluate" ? {
      actual: intent.actual,
      target: intent.target,
      operator: intent.operator,
      pass: intent.pass,
      output: intent.output,
    } : {}),
    ...fields,
  };
  return applyObjectiveControlAcknowledgement(plan, snapshot, acknowledgement);
}

function completeAgent(
  plan: ReturnType<typeof compileObjectiveControlPlan>,
  snapshot: ObjectiveControlPlanSnapshot,
  output: Record<string, unknown> = { ok: true },
): ObjectiveControlPlanSnapshot {
  const intent = nextObjectiveControlIntent(plan, snapshot);
  expect(intent.kind).toBe("agent");
  return ack(plan, snapshot, { state: "completed", output: output as JsonValue, agentId: `native-${intent.execution.nodeId}` });
}

function finish(plan: ReturnType<typeof compileObjectiveControlPlan>, snapshot: ObjectiveControlPlanSnapshot): ObjectiveControlPlanSnapshot {
  let current = snapshot;
  for (let count = 0; count < 64; count += 1) {
    const intent = nextObjectiveControlIntent(plan, current);
    if (intent.kind === "complete") return ack(plan, current);
    if (intent.kind === "agent") current = completeAgent(plan, current);
    else if (intent.kind === "if") current = ack(plan, current, { condition: intent.conditionValue ?? false });
    else if (intent.kind === "while") current = ack(plan, current, { condition: intent.conditionValue ?? false });
    else current = ack(plan, current);
  }
  throw new Error("control fixture did not settle");
}

describe("objective control plan compiler and reducer", () => {
  it("materializes objective fan-out items durably and reduces them in source order", () => {
    const { plan, snapshot: initial } = fixture([
      {
        id: "map-items",
        type: "fanout",
        source: "items",
        concurrency: 1,
        aggregation: { mode: "array" },
        itemTemplate: agent("item-worker", "Process {{ item.id }} ({{ itemKey }})."),
      },
    ], { items: [{ id: "a" }, { id: "b" }] });
    let snapshot = ack(plan, initial);
    let intent = nextObjectiveControlIntent(plan, snapshot);
    expect(intent.kind).toBe("fanout");
    if (intent.kind !== "fanout") return;
    expect(intent.operation).toBe("materialize");
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "fanout",
      intentId: intent.intentId,
      requestKey: "fanout-materialize-1",
      sourceHash: intent.sourceHash,
      fanoutItems: intent.items,
      now,
    });
    expect(snapshot.executions.filter((entry) => entry.fanoutScope)).toHaveLength(2);
    expect(snapshot.frontier).toHaveLength(1);

    intent = nextObjectiveControlIntent(plan, snapshot);
    expect(intent.kind).toBe("agent");
    if (intent.kind !== "agent") return;
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "agent",
      intentId: intent.intentId,
      requestKey: "fanout-agent-a",
      attemptId: intent.attemptId,
      state: "completed",
      output: { result: "A" },
      now,
    });
    intent = nextObjectiveControlIntent(plan, snapshot);
    expect(intent.kind).toBe("agent");
    if (intent.kind !== "agent") return;
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "agent",
      intentId: intent.intentId,
      requestKey: "fanout-agent-b",
      attemptId: intent.attemptId,
      state: "completed",
      output: { result: "B" },
      now,
    });
    intent = nextObjectiveControlIntent(plan, snapshot);
    expect(intent.kind).toBe("fanout");
    if (intent.kind !== "fanout") return;
    expect(intent.operation).toBe("join");
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "fanout",
      intentId: intent.intentId,
      requestKey: "fanout-join-1",
      sourceHash: intent.sourceHash,
      fanoutItems: intent.items,
      now,
    });
    expect(snapshot.executions.find((entry) => entry.key.nodeId === "map-items")?.output).toEqual([{ result: "A" }, { result: "B" }]);
  });

  it("fails a fan-out fast and durably cancels sibling items", () => {
    const { plan, snapshot: initial } = fixture([{
      id: "map-items",
      type: "fanout",
      source: "items",
      concurrency: null,
      itemTemplate: agent("item-worker"),
    }], { items: [{ id: "a" }, { id: "b" }] });
    let snapshot = ack(plan, initial);
    let intent = nextObjectiveControlIntent(plan, snapshot);
    if (intent.kind !== "fanout") throw new Error("expected fan-out materialization");
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "fanout", intentId: intent.intentId, requestKey: "fanout-materialize-failure", sourceHash: intent.sourceHash, fanoutItems: intent.items, now,
    });
    intent = nextObjectiveControlIntent(plan, snapshot);
    if (intent.kind !== "agent") throw new Error("expected fan-out item agent");
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "agent", intentId: intent.intentId, requestKey: "fanout-agent-failure", attemptId: intent.attemptId, state: "failed", error: "item failed", now,
    });
    expect(snapshot.executions.filter((entry) => entry.fanoutScope).map((entry) => entry.state).sort()).toEqual(["cancelled", "failed"]);
    expect(snapshot.executions.find((entry) => entry.key.nodeId === "map-items")?.state).toBe("failed");
  });

  it("resolves nested fan-out templates from their durable parent scopes", () => {
    const { plan, snapshot: initial } = fixture([
      {
        id: "outer-map",
        type: "fanout",
        source: "items",
        itemTemplate: {
          id: "inner-map",
          type: "fanout",
          source: "item.children",
          concurrency: 1,
          itemTemplate: agent("leaf-worker", "Process {{ item.id }} from {{ itemKey }}."),
        },
      },
    ], { items: [{ id: "parent", children: [{ id: "child" }] }] });
    let snapshot = ack(plan, initial);
    let intent = nextObjectiveControlIntent(plan, snapshot);
    expect(intent.kind).toBe("fanout");
    if (intent.kind !== "fanout") return;
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "fanout",
      intentId: intent.intentId,
      requestKey: "nested-outer-materialize",
      sourceHash: intent.sourceHash,
      fanoutItems: intent.items,
      now,
    });
    intent = nextObjectiveControlIntent(plan, snapshot);
    expect(intent.kind).toBe("fanout");
    if (intent.kind !== "fanout") return;
    expect(intent.node.id).toBe("inner-map");
    expect(intent.items).toEqual([{ index: 0, key: "child", value: { id: "child" } }]);
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "fanout",
      intentId: intent.intentId,
      requestKey: "nested-inner-materialize",
      sourceHash: intent.sourceHash,
      fanoutItems: intent.items,
      now,
    });
    intent = nextObjectiveControlIntent(plan, snapshot);
    expect(intent.kind).toBe("agent");
    if (intent.kind !== "agent") return;
    expect(intent.node.id).toBe("leaf-worker");
    expect(intent.objective).toBe("Process child from child.");
  });

  it("pins the saved workflow tree without flattening control flow", () => {
    const { plan } = fixture([
      {
        id: "quality",
        type: "while",
        condition: { path: "steps.review.score", op: "lt", value: 8, default: 0 },
        maxIterations: 3,
        steps: [{
          id: "branch",
          type: "if",
          condition: { path: "steps.build.ok", op: "eq", value: true },
          then: [agent("review")],
          else: [{ id: "set-fallback", type: "set", value: { fallback: true } }],
        }],
      },
    ]);
    expect(plan.source).toMatchObject({ kind: "workflow-revision", workflowId: "control-plan-fixture", workflowRevision: 3 });
    expect(plan.root.type).toBe("sequence");
    const loop = plan.root.steps[0];
    expect(loop?.type).toBe("while");
    if (loop?.type !== "while") return;
    expect(loop.steps[0]?.type).toBe("if");
    expect(loop.steps[0]?.sourcePath).toBe("steps.0.steps.0");

    const revision = pinObjectiveControlPlan(plan, {
      objectiveId: "objective-control-fixture",
      runId: "run-control-fixture",
      createdBy: { type: "user", id: "owner" },
      requestKey: "pin-control-plan-1",
      createdAt: now,
    });
    expect(revision.hash).toBe(objectiveControlPlanHash(plan));
    expect(revision.plan.root).toEqual(plan.root);
  });

  it("requires the configured loop bound when a saved loop omits one", () => {
    const workflow = definition([{
      id: "configured-loop",
      type: "while",
      condition: { path: "steps.done", op: "exists", default: false },
      steps: [agent("body")],
    }]);
    const ir = new WorkflowCompiler().compile(workflow, 3);
    expect(() => compileObjectiveControlPlan(ir)).toThrow(/defaultMaxLoopIterations/);
    expect(compileObjectiveControlPlan(ir, { defaultMaxLoopIterations: 4 }).root.steps[0]).toMatchObject({ maxIterations: 4 });
  });

  it("runs sequence and set/agent leaves through a deterministic frontier", () => {
    const { plan, snapshot: initial } = fixture([
      agent("build", "Build the thing."),
      { id: "facts", type: "set", value: { summary: "{{ steps.build.ok }}" } },
      agent("verify", "Verify {{ steps.facts.summary }}."),
    ]);
    let snapshot = ack(plan, initial);
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("agent");
    snapshot = completeAgent(plan, snapshot, { ok: true });
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("set");
    snapshot = ack(plan, snapshot);
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ kind: "agent", objective: "Verify true." });
    snapshot = completeAgent(plan, snapshot, { verified: true });
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("join");
    snapshot = ack(plan, snapshot);
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("complete");
    snapshot = ack(plan, snapshot);
    expect(snapshot.executions.find((entry) => entry.key.nodeId === "root-control")?.state).toBe("completed");
  });

  it("resolves evaluate nodes from durable context and exposes a stable result to conditions", () => {
    const { plan, snapshot: initial } = fixture([
      { id: "score", type: "evaluate", metric: "Release quality", path: "release.score", operator: "gte", target: 8 },
      {
        id: "gate",
        type: "if",
        condition: { path: "steps.score.pass", op: "eq", value: true },
        then: [agent("ship")],
        else: [agent("repair")],
      },
    ], { release: { score: 9 } });

    expect(initial.context).toEqual({ release: { score: 9 } });
    const evaluationNode = plan.root.steps[0];
    if (!evaluationNode || evaluationNode.type !== "evaluate") throw new Error("expected evaluate node");
    expect(evaluateObjectiveControlNode(evaluationNode, initial)).toEqual({
      actual: 9,
      target: 8,
      operator: "gte",
      pass: true,
    });

    let snapshot = ack(plan, initial); // enter root sequence
    const intent = nextObjectiveControlIntent(plan, snapshot);
    expect(intent).toMatchObject({
      kind: "evaluate",
      metric: "Release quality",
      path: "release.score",
      actual: 9,
      target: 8,
      operator: "gte",
      pass: true,
      output: { actual: 9, target: 8, operator: "gte", pass: true },
    });
    if (intent.kind !== "evaluate") throw new Error("expected evaluate intent");
    const evaluationExecution = `${intent.execution.nodeId}@${intent.execution.iterationKey}`;
    snapshot = ack(plan, snapshot);
    expect(snapshot.executions.find((entry) => `${entry.key.nodeId}@${entry.key.iterationKey}` === evaluationExecution)).toMatchObject({
      state: "completed",
      output: { actual: 9, target: 8, operator: "gte", pass: true },
    });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ kind: "if", conditionValue: true });
  });

  it("rejects an evaluation acknowledgement that changes the deterministic result", () => {
    const { plan, snapshot: initial } = fixture([
      { id: "score", type: "evaluate", path: "release.score", operator: "eq", target: 4 },
    ], { release: { score: 3 } });
    const entered = ack(plan, initial);
    const intent = nextObjectiveControlIntent(plan, entered);
    expect(intent.kind).toBe("evaluate");
    expect(() => ack(plan, entered, { pass: true })).toThrow(/does not match the deterministic snapshot result/);
  });

  it("records a false branch and does not execute the then branch", () => {
    const { plan, snapshot: initial } = fixture([{
      id: "choice",
      type: "if",
      condition: { path: "steps.missing", op: "exists" },
      then: [agent("then-agent")],
      else: [{ id: "fallback", type: "set", value: { selected: "else" } }],
    }]);
    let snapshot = ack(plan, initial);
    const intent = nextObjectiveControlIntent(plan, snapshot);
    expect(intent.kind).toBe("if");
    if (intent.kind !== "if") return;
    snapshot = ack(plan, snapshot, { condition: false, evidence: { eventCursor: 2, eventIds: ["condition-2"] } });
    expect(snapshot.branches["choice@root/root-control/choice"]).toBe("else");
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("set");
    snapshot = ack(plan, snapshot);
    expect(snapshot.executions.some((entry) => entry.key.nodeId === "then-agent")).toBe(false);
    expect(snapshot.exitReasons["choice@root/root-control/choice"]).toBe("condition-false");
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("join");
  });

  it("rejects branch evidence that conflicts with the deterministic condition", () => {
    const ifFixture = fixture([{
      id: "choice",
      type: "if",
      condition: { path: "steps.missing", op: "exists", default: true },
      then: [agent("then-agent")],
    }]);
    const ifSnapshot = ack(ifFixture.plan, ifFixture.snapshot);
    const ifIntent = nextObjectiveControlIntent(ifFixture.plan, ifSnapshot);
    expect(ifIntent).toMatchObject({ kind: "if", conditionValue: true });
    expect(() => ack(ifFixture.plan, ifSnapshot, { condition: false })).toThrow(/does not match deterministic value true/);

    const whileFixture = fixture([{
      id: "loop",
      type: "while",
      condition: { path: "steps.missing", op: "exists", default: true },
      maxIterations: 1,
      steps: [agent("body")],
    }]);
    const whileSnapshot = ack(whileFixture.plan, whileFixture.snapshot);
    const whileIntent = nextObjectiveControlIntent(whileFixture.plan, whileSnapshot);
    expect(whileIntent).toMatchObject({ kind: "while", operation: "evaluate", conditionValue: true });
    expect(() => ack(whileFixture.plan, whileSnapshot, { condition: false })).toThrow(/does not match deterministic value true/);
  });

  it("joins parallel children only after every child settles", () => {
    const { plan, snapshot: initial } = fixture([{
      id: "fanout",
      type: "parallel",
      steps: [agent("left"), agent("right")],
    }]);
    let snapshot = ack(plan, initial);
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("parallel");
    snapshot = ack(plan, snapshot);
    expect(snapshot.frontier.map((entry) => entry.nodeId)).toEqual(["left", "right"]);
    snapshot = ack(plan, snapshot, { state: "running", agentId: "native-left" });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ kind: "agent", node: { id: "right" }, operation: "dispatch" });
    snapshot = completeAgent(plan, snapshot, { side: "right" });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ kind: "agent", node: { id: "left" }, operation: "wait" });
    expect(snapshot.frontier.map((entry) => entry.nodeId)).toEqual(["left"]);
    snapshot = completeAgent(plan, snapshot, { side: "left" });
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("join");
    snapshot = ack(plan, snapshot);
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("join");
  });

  it("holds a dependent parallel child until its concrete prerequisite succeeds", () => {
    const { plan, snapshot: initial } = fixture([{
      id: "fanout",
      type: "parallel",
      steps: [agent("prepare"), agent("consume")],
    }]);
    const fanout = plan.root.steps[0];
    if (fanout?.type !== "parallel") throw new Error("fixture did not compile a parallel node");
    fanout.steps[1] = { ...fanout.steps[1], dependsOn: ["prepare"] };

    let snapshot = ack(plan, initial);
    snapshot = ack(plan, snapshot);
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "prepare", operation: "dispatch" });
    snapshot = completeAgent(plan, snapshot, { ready: true });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "consume", operation: "dispatch" });
  });

  it("carries authored workflow dependencies into the daemon control plan", () => {
    const workflow = new WorkflowCompiler().compile(definition([{
      id: "fanout",
      type: "parallel",
      steps: [agent("prepare"), { ...agent("consume"), dependsOn: ["prepare"] }],
    }]), 4);
    const plan = compileObjectiveControlPlan(workflow);
    const fanout = plan.root.steps[0];
    if (fanout?.type !== "parallel") throw new Error("fixture did not compile a parallel node");
    expect(fanout.steps[1]).toMatchObject({ id: "consume", dependsOn: ["prepare"] });
  });

  it("enforces the concurrent-agent limit and persists output context refs", () => {
    const { plan } = fixture([{
      id: "fanout",
      type: "parallel",
      steps: [agent("left"), agent("right")],
    }]);
    plan.limits.maxConcurrentAgents = 1;
    const inputRef = { kind: "objective-context" as const, id: "input:fixture", hash: "input-hash-1" };
    let snapshot = createObjectiveControlSnapshot(plan, {
      objectiveId: "objective-control-fixture",
      runId: "run-control-fixture-limit",
      planRevision: 0,
      createdAt: now,
      contextRefs: [inputRef],
    });
    snapshot = ack(plan, snapshot);
    snapshot = ack(plan, snapshot);
    snapshot = ack(plan, snapshot, { state: "running", agentId: "native-left" });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "left", operation: "wait" });
    snapshot = completeAgent(plan, snapshot, { side: "left" });
    expect(snapshot.contextRefs).toContainEqual(inputRef);
    expect(snapshot.executions.find((entry) => entry.key.nodeId === "left")?.contextRefs).toEqual([
      expect.objectContaining({ kind: "node-output", id: expect.stringContaining("left@") }),
    ]);
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "right", operation: "dispatch" });
  });

  it("cancels outstanding parallel siblings after a failure", () => {
    const { plan, snapshot: initial } = fixture([{
      id: "fanout",
      type: "parallel",
      steps: [agent("left"), agent("right")],
    }]);
    let snapshot = ack(plan, initial);
    snapshot = ack(plan, snapshot);
    snapshot = ack(plan, snapshot, { state: "failed", error: "left failed" });
    expect(snapshot.executions.find((entry) => entry.key.nodeId === "right")).toMatchObject({ state: "failed", error: "Cancelled because a parallel sibling failed." });
    expect(snapshot.exitReasons["right@root/root-control/fanout/fanout/right"]).toBe("cancelled");
    expect(nextObjectiveControlIntent(plan, snapshot).kind).toBe("wait");
  });

  it("requires a durable approval before dispatching an approved agent", () => {
    const { plan: basePlan, snapshot: initial } = fixture([agent("sensitive")]);
    const plan = structuredClone(basePlan);
    const sensitive = plan.root.steps[0];
    if (sensitive?.type !== "agent") throw new Error("fixture did not compile an agent node");
    sensitive.requiresApproval = true;
    let snapshot = ack(plan, initial);
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ kind: "agent", operation: "approval", approvalRequired: true });
    snapshot = ack(plan, snapshot, { approved: true });
    expect(snapshot.contextRefs.some((ref) => ref.id.startsWith("control-approval:sensitive@"))).toBe(true);
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ kind: "agent", operation: "dispatch" });
  });

  it("keeps loop iterations and attempts distinct and stops at the bound", () => {
    const { plan, snapshot: initial } = fixture([{
      id: "repeat",
      type: "while",
      condition: { path: "steps.tick", op: "exists", default: true },
      maxIterations: 2,
      steps: [agent("tick")],
    }]);
    let snapshot = ack(plan, initial);
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ kind: "while", operation: "evaluate", iteration: 0 });
    snapshot = ack(plan, snapshot, { condition: true });
    const first = nextObjectiveControlIntent(plan, snapshot);
    expect(first.kind).toBe("agent");
    const firstExecution = first.execution;
    const firstAttempt = first.attemptId;
    snapshot = completeAgent(plan, snapshot, { pass: 1 });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ kind: "while", operation: "evaluate", iteration: 1 });
    snapshot = ack(plan, snapshot, { condition: true });
    const second = nextObjectiveControlIntent(plan, snapshot);
    expect(second.kind).toBe("agent");
    expect(second.execution).not.toEqual(firstExecution);
    expect(second.attemptId).not.toBe(firstAttempt);
    snapshot = completeAgent(plan, snapshot, { pass: 2 });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ kind: "while", operation: "bound-reached", iteration: 2 });
    snapshot = ack(plan, snapshot);
    expect(snapshot.exitReasons["repeat@root/root-control/repeat"]).toBe("bound-reached");
    expect(snapshot.executions.filter((entry) => entry.key.nodeId === "tick")).toHaveLength(2);
  });

  it("scopes nested loop counters to concrete execution ids", () => {
    const { plan, snapshot: initial } = fixture([{
      id: "outer",
      type: "while",
      condition: { path: "steps.outer-task.count", op: "lt", value: 2, default: 0 },
      maxIterations: 2,
      steps: [{
        id: "inner",
        type: "while",
        condition: { path: "steps.inner-task", op: "exists", default: true },
        maxIterations: 1,
        steps: [agent("inner-task")],
      }, agent("outer-task")],
    }]);

    let snapshot = ack(plan, initial); // root sequence
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "outer", kind: "while", iteration: 0 });
    snapshot = ack(plan, snapshot, { condition: true }); // outer iteration 1

    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "inner", kind: "while", operation: "evaluate", iteration: 0 });
    snapshot = ack(plan, snapshot, { condition: true });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "inner-task", kind: "agent" });
    snapshot = completeAgent(plan, snapshot, { done: true });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "inner", kind: "while", operation: "bound-reached", iteration: 1 });
    snapshot = ack(plan, snapshot);

    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "outer-task", kind: "agent" });
    snapshot = completeAgent(plan, snapshot, { count: 1 });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "outer", kind: "while", operation: "evaluate", iteration: 1 });
    snapshot = ack(plan, snapshot, { condition: true }); // outer iteration 2

    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "inner", kind: "while", operation: "evaluate", iteration: 0 });
    snapshot = ack(plan, snapshot, { condition: true });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "inner-task", kind: "agent" });
    snapshot = completeAgent(plan, snapshot, { done: true });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "inner", kind: "while", operation: "bound-reached", iteration: 1 });
    snapshot = ack(plan, snapshot);
    snapshot = completeAgent(plan, snapshot, { count: 2 });
    expect(nextObjectiveControlIntent(plan, snapshot)).toMatchObject({ nodeId: "outer", kind: "while", operation: "bound-reached", iteration: 2 });
    snapshot = ack(plan, snapshot);

    const innerExecutionIds = snapshot.executions
      .filter((entry) => entry.key.nodeId === "inner")
      .map((entry) => objectiveControlExecutionId(entry.key));
    expect(innerExecutionIds).toHaveLength(2);
    expect(new Set(innerExecutionIds).size).toBe(2);
    expect(Object.keys(snapshot.loopIterations)).toEqual(expect.arrayContaining([
      "outer@root/root-control/outer",
      "inner@root/root-control/outer/outer/iteration-1/inner",
      "inner@root/root-control/outer/outer/iteration-2/inner",
    ]));
    expect(snapshot.loopIterations).not.toHaveProperty("outer");
    expect(snapshot.loopIterations).not.toHaveProperty("inner");
  });

  it("replays the same snapshot as the same intent and idempotently applies duplicate acks", () => {
    const { plan, snapshot: initial } = fixture([agent("one")]);
    const firstIntent = nextObjectiveControlIntent(plan, initial);
    const afterEnter = ack(plan, initial);
    const replayIntent = nextObjectiveControlIntent(plan, initial);
    expect(replayIntent).toEqual(firstIntent);

    const agentIntent = nextObjectiveControlIntent(plan, afterEnter);
    const acknowledgement: ObjectiveControlAcknowledgement = {
      kind: agentIntent.kind,
      intentId: agentIntent.intentId,
      requestKey: "duplicate-replay-1",
      state: "completed",
      attemptId: agentIntent.kind === "agent" ? agentIntent.attemptId : undefined,
      output: { ok: true },
      now,
    };
    expect(() => ObjectiveControlAcknowledgementSchema.parse({ ...acknowledgement, requestKey: "short" })).toThrow();
    expect(() => applyObjectiveControlAcknowledgement(plan, afterEnter, { ...acknowledgement, attemptId: "wrong-attempt" })).toThrow(/does not match dispatched attempt/);
    const applied = applyObjectiveControlAcknowledgement(plan, afterEnter, acknowledgement);
    expect(applyObjectiveControlAcknowledgement(plan, applied, acknowledgement)).toEqual(applied);
    expect(() => applyObjectiveControlAcknowledgement(plan, applied, { ...acknowledgement, output: { ok: false } })).toThrow(/conflicts/);
  });

  it("settles an entire control tree from build through evaluation", () => {
    const { plan, snapshot } = fixture([
      agent("build"),
      { id: "evaluate", type: "if", condition: { path: "steps.build.ok", op: "eq", value: true }, then: [agent("ship")], else: [agent("repair")] },
    ]);
    const settled = finish(plan, snapshot);
    const states = settled.executions.map((entry) => [entry.key.nodeId, entry.state]);
    expect(states).toContainEqual(["build", "completed"]);
    expect(states).toContainEqual(["ship", "completed"]);
    expect(states).not.toContainEqual(["repair", "completed"]);
    expect(settled.executions.find((entry) => entry.key.nodeId === "root-control")?.state).toBe("completed");
  });
});
