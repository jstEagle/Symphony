import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ObjectiveBudgetLimitsSchema,
  ObjectiveControlMutationSchema,
  applyObjectiveControlMutation,
  validateObjectiveControlMutationTarget,
  ObjectiveRunRecordSchema,
  ObjectiveTaskSchema,
  type EventEnvelope,
  type JsonValue,
  type ObjectiveApprovalRecord,
  type ObjectiveCheckpointRecord,
  type ObjectiveControlPlan,
  type ObjectiveControlPlanSnapshot,
  type ObjectiveRunRecord,
  type ObjectiveTask,
} from "../../packages/protocol/src/index.js";
import {
  applyObjectiveControlAcknowledgement,
  compileObjectiveControlPlan,
  createObjectiveControlSnapshot,
  nextObjectiveControlIntent,
  type ObjectiveControlAcknowledgement,
} from "../../packages/workflow/src/objective-control-plan.js";
import { ObjectiveRuntime, type ObjectiveActionReceipt, type ObjectiveRepository } from "../../packages/workflow/src/objective-runtime.js";
import {
  buildControlRoomViewModel,
  projectControlRoomObjective,
} from "../../apps/web/src/lib/symphony/objective-control-room.js";
import { objectiveEventQueryPlan } from "../../apps/web/src/lib/symphony/objective-events.js";
import { projectObjectiveRun } from "../../apps/web/src/lib/symphony/objective-project.js";
import { WorkflowCompiler, type WorkflowDefinition, type WorkflowStep } from "../../packages/workflow/src/index.js";

const NOW = "2026-09-01T00:00:00.000Z";
const AUTHORITY = {
  actor: { type: "agent" as const, id: "acceptance-conductor" },
  permissionCeiling: "full-access" as const,
};

type ScenarioExpectation = "pass" | "expected-gap";
type ScenarioDefinition = {
  id: string;
  title: string;
  expected: ScenarioExpectation;
  publicApis: string[];
  gap?: string;
};
type ScenarioResult = ScenarioDefinition & {
  actual: "pass" | "expected-gap" | "fail";
  evidence: string;
};

const manifest = JSON.parse(readFileSync(new URL("../fixtures/objective-control-acceptance.json", import.meta.url), "utf8")) as {
  version: number;
  suite: string;
  scenarios: ScenarioDefinition[];
};

class MemoryObjectiveRepository implements ObjectiveRepository {
  readonly runs = new Map<string, ObjectiveRunRecord>();
  readonly receipts = new Map<string, ObjectiveActionReceipt>();
  readonly checkpoints = new Map<string, ObjectiveCheckpointRecord>();
  readonly approvals = new Map<string, ObjectiveApprovalRecord>();

  getObjectiveRun(runId: string): ObjectiveRunRecord | null { return this.runs.get(runId) ?? null; }
  getObjectiveRunByRequestKey(requestKey: string): ObjectiveRunRecord | null {
    return [...this.runs.values()].find((run) => run.requestKey === requestKey) ?? null;
  }
  saveObjectiveRun(run: ObjectiveRunRecord): void { this.runs.set(run.runId, run); }
  getObjectiveActionReceipt(requestKey: string): ObjectiveActionReceipt | null { return this.receipts.get(requestKey) ?? null; }
  saveObjectiveActionReceipt(receipt: ObjectiveActionReceipt): boolean {
    if (this.receipts.has(receipt.requestKey)) return false;
    this.receipts.set(receipt.requestKey, receipt);
    return true;
  }
  getObjectiveCheckpoint(_runId: string, checkpointId: string): ObjectiveCheckpointRecord | null {
    return this.checkpoints.get(checkpointId) ?? null;
  }
  appendObjectiveCheckpoint(checkpoint: ObjectiveCheckpointRecord): boolean {
    if (this.checkpoints.has(checkpoint.id)) return false;
    this.checkpoints.set(checkpoint.id, checkpoint);
    return true;
  }
  getObjectiveApproval(_runId: string, approvalId: string): ObjectiveApprovalRecord | null {
    return this.approvals.get(approvalId) ?? null;
  }
  saveObjectiveApproval(approval: ObjectiveApprovalRecord): boolean {
    this.approvals.set(approval.id, approval);
    return true;
  }
}

function runtimeFixture() {
  const repository = new MemoryObjectiveRepository();
  let id = 0;
  const runtime = new ObjectiveRuntime(repository, {
    id: () => `acceptance-id-${++id}`,
    now: () => NOW,
  });
  return { repository, runtime };
}

function task(id: string, dependsOn: string[] = [], overrides: Record<string, unknown> = {}): ObjectiveTask {
  return ObjectiveTaskSchema.parse({
    id,
    objective: `Complete ${id}`,
    dependsOn,
    outputSchema: {},
    model: "fixture",
    harness: "auto",
    inputs: [],
    requiresApproval: false,
    ...overrides,
  });
}

function objectiveInput(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    objectiveId: `${runId}-objective`,
    workflowId: `${runId}-workflow`,
    workflowRevision: 1,
    workflowHash: `${runId}-workflow-hash-1234`,
    spec: {
      id: `${runId}-objective`,
      statement: "Exercise the objective control harness.",
      criteria: [],
      approvalPolicy: { mode: "never" as const },
      maxReplans: 1,
    },
    requestKey: `${runId}-create-request`,
    ...overrides,
  };
}

function workflowDefinition(id: string, steps: WorkflowStep[]): WorkflowDefinition {
  return {
    id,
    name: `${id} acceptance workflow`,
    mission: { statement: "Exercise an objective control tree.", keyResults: [] },
    workspace: { path: "/tmp/symphony-objective-acceptance", dirtyPolicy: "local-only" },
    inputSchema: { type: "object" },
    output: "steps",
    steps,
    triggers: [{ id: "manual", type: "manual" }],
  };
}

function controlFixture(id: string, steps: WorkflowStep[], limits: Record<string, unknown> = {}) {
  const ir = new WorkflowCompiler().compile(workflowDefinition(id, steps), 1);
  const plan = compileObjectiveControlPlan(ir, {
    planId: `${id}-plan`,
    limits,
  });
  const snapshot = createObjectiveControlSnapshot(plan, {
    objectiveId: `${id}-objective`,
    runId: `${id}-run`,
    createdAt: NOW,
  });
  return { plan, snapshot };
}

function ack(
  plan: ObjectiveControlPlan,
  snapshot: ObjectiveControlPlanSnapshot,
  fields: Partial<ObjectiveControlAcknowledgement> = {},
): ObjectiveControlPlanSnapshot {
  const intent = nextObjectiveControlIntent(plan, snapshot);
  const acknowledgement = {
    kind: intent.kind,
    intentId: intent.intentId,
    requestKey: `acceptance-ack-${snapshot.sequence}-${intent.nodeId}`,
    now: NOW,
    ...(intent.kind === "agent" ? { attemptId: intent.attemptId } : {}),
    ...fields,
  } satisfies ObjectiveControlAcknowledgement;
  return applyObjectiveControlAcknowledgement(plan, snapshot, acknowledgement);
}

function settleControlPlan(plan: ObjectiveControlPlan, initial: ObjectiveControlPlanSnapshot): ObjectiveControlPlanSnapshot {
  let snapshot = initial;
  for (let step = 0; step < 128; step += 1) {
    const intent = nextObjectiveControlIntent(plan, snapshot);
    if (intent.kind === "complete") return ack(plan, snapshot);
    if (intent.kind === "wait") throw new Error(`Control plan stalled at ${intent.nodeId}.`);
    if (intent.kind === "agent") {
      const output: JsonValue = intent.node.id === "outer-task"
        ? { count: intent.execution.iterationKey.includes("iteration-2") ? 2 : 1 }
        : { ok: true, node: intent.node.id };
      snapshot = ack(plan, snapshot, { state: "completed", output, agentId: `fixture-${intent.node.id}` });
    } else if (intent.kind === "if" || intent.kind === "while") {
      snapshot = ack(plan, snapshot, intent.operation === "evaluate" ? { condition: intent.conditionValue ?? false } : {});
    } else {
      snapshot = ack(plan, snapshot);
    }
  }
  throw new Error("Control plan did not settle within 128 deterministic acknowledgements.");
}

function baseProjectionRun(runId = "projection-run"): ObjectiveRunRecord {
  return ObjectiveRunRecordSchema.parse({
    version: 1,
    ...objectiveInput(runId),
    conductorAgentId: null,
    createdAt: NOW,
    tasks: [
      { task: task("build"), state: "queued", attemptId: null, agentId: null, output: null, error: null, startedAt: null, finishedAt: null },
      { task: task("publish", ["build"]), state: "queued", attemptId: null, agentId: null, output: null, error: null, startedAt: null, finishedAt: null },
    ],
    state: "executing",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    context: {},
    output: null,
    error: null,
    startedAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
  });
}

function event(runId: string, cursor: number, type = "objective.task.dispatched"): EventEnvelope {
  return {
    id: `acceptance-event-${cursor}`,
    cursor,
    type,
    workflowId: `${runId}-workflow`,
    runId,
    agentId: null,
    occurredAt: NOW,
    payload: { runId, summary: "Durable objective evidence." },
    provenance: { source: "workflow" },
  };
}

function acceptanceResults(): ScenarioResult[] {
  const results: ScenarioResult[] = [];
  const run = (id: string, execute: () => string, expected: ScenarioExpectation = "pass"): void => {
    const definition = manifest.scenarios.find((scenario) => scenario.id === id);
    if (!definition) throw new Error(`Acceptance manifest is missing ${id}.`);
    try {
      results.push({ ...definition, actual: expected, evidence: execute() });
    } catch (error) {
      results.push({ ...definition, actual: "fail", evidence: error instanceof Error ? error.message : String(error) });
    }
  };

  run("adaptive-build-evaluate-revise", () => {
    const { runtime } = runtimeFixture();
    const created = runtime.create(objectiveInput("adaptive-run", {
      spec: {
        id: "adaptive-run-objective",
        statement: "Build, evaluate, and revise until verified.",
        criteria: [{ id: "verified", description: "Verification passed", path: "verification.passed", op: "equals", value: true, required: true }],
        approvalPolicy: { mode: "never" },
        maxReplans: 1,
      },
      tasks: [task("build")],
    }), AUTHORITY);
    const evaluated = runtime.checkpoint(created.runId, {
      eventCursor: 1,
      taskUpdates: [{ taskId: "build", state: "completed", output: { artifact: "v1" } }],
      context: { verification: { passed: false } },
      reason: "Build completed; evaluation failed.",
      requestKey: "adaptive-evaluation-checkpoint",
    }, AUTHORITY);
    expect(evaluated.state).toBe("replanning");
    const revised = runtime.commitPlan(evaluated.runId, {
      expectedPlanRevision: 0,
      tasks: [task("revise", ["build"])],
      reason: "Revise after failed evaluation.",
      requestKey: "adaptive-revision-plan",
    }, AUTHORITY);
    expect(revised.activePlanRevision).toBe(1);
    const completed = runtime.checkpoint(revised.runId, {
      eventCursor: 2,
      taskUpdates: [{ taskId: "revise", state: "completed", output: { artifact: "v2" } }],
      context: { verification: { passed: true } },
      reason: "Revision passed evaluation.",
      requestKey: "adaptive-final-checkpoint",
    }, AUTHORITY);
    expect(completed.state).toBe("succeeded");
    return `state=${completed.state}; planRevision=${completed.activePlanRevision}; replans=${completed.replanCount}`;
  });

  run("nested-loops", () => {
    const { plan, snapshot } = controlFixture("nested-loops", [{
      id: "outer",
      type: "while",
      condition: { path: "steps.outer-task.count", op: "lt", value: 2, default: 0 },
      maxIterations: 2,
      steps: [
        {
          id: "inner",
          type: "while",
          condition: { path: "steps.inner-task.done", op: "exists", default: true },
          maxIterations: 1,
          steps: [{ id: "inner-task", type: "agent", objective: "Run the inner pass.", outputSchema: {} }],
        },
        { id: "outer-task", type: "agent", objective: "Run outer pass.", outputSchema: {} },
      ],
    }]);
    const settled = settleControlPlan(plan, snapshot);
    const innerExecutions = settled.executions.filter((entry) => entry.key.nodeId === "inner");
    expect(innerExecutions).toHaveLength(2);
    expect(new Set(innerExecutions.map((entry) => `${entry.key.nodeId}@${entry.key.iterationKey}`)).size).toBe(2);
    expect(Object.keys(settled.loopIterations).filter((key) => key.startsWith("inner@")).length).toBe(2);
    expect(settled.executions.find((entry) => entry.key.nodeId === "root-control")?.state).toBe("completed");
    return `outerIterations=2; innerExecutions=${innerExecutions.length}; root=completed`;
  });

  run("parallel-backpressure", () => {
    const { plan, snapshot } = controlFixture("parallel-backpressure", [{
      id: "fanout",
      type: "parallel",
      steps: [
        { id: "left", type: "agent", objective: "Run left.", outputSchema: {} },
        { id: "right", type: "agent", objective: "Run right.", outputSchema: {} },
      ],
    }], { maxConcurrentAgents: 1 });
    let entered = ack(plan, snapshot);
    const parallelIntent = nextObjectiveControlIntent(plan, entered);
    expect(parallelIntent.kind).toBe("parallel");
    if (parallelIntent.kind !== "parallel") throw new Error("Expected parallel intent.");
    entered = ack(plan, entered);
    const firstDispatch = nextObjectiveControlIntent(plan, entered);
    expect(firstDispatch).toMatchObject({ kind: "agent", operation: "dispatch", node: { id: "left" } });
    entered = ack(plan, entered, { state: "running", output: null, agentId: "fixture-left" });
    const blocked = nextObjectiveControlIntent(plan, entered);
    expect(blocked).toMatchObject({ kind: "agent", operation: "wait", node: { id: "left" } });
    expect(entered.executions.find((execution) => execution.key.nodeId === "right")?.state).toBe("queued");
    entered = ack(plan, entered, { state: "completed", output: { ok: true }, agentId: "fixture-left" });
    const secondDispatch = nextObjectiveControlIntent(plan, entered);
    expect(secondDispatch).toMatchObject({ kind: "agent", operation: "dispatch", node: { id: "right" } });
    expect(plan.limits.maxConcurrentAgents).toBe(1);
    return `limit=${plan.limits.maxConcurrentAgents}; blocked=${blocked.kind}; secondDispatch=${secondDispatch.node.id}`;
  });

  run("approval-interruption-resume", () => {
    const { runtime } = runtimeFixture();
    const created = runtime.create(objectiveInput("approval-run", {
      spec: {
        id: "approval-run-objective",
        statement: "Complete only after approval.",
        criteria: [{ id: "verified", description: "Verification passed", path: "verification.passed", op: "equals", value: true, required: true }],
        approvalPolicy: { mode: "before-completion" },
        maxReplans: 0,
      },
      tasks: [task("ship")],
    }), AUTHORITY);
    const interrupted = runtime.checkpoint(created.runId, {
      eventCursor: 4,
      taskUpdates: [{ taskId: "ship", state: "completed", output: { ready: true } }],
      context: { verification: { passed: true } },
      reason: "All required evidence is present; wait for approval.",
      requestKey: "approval-interrupted-checkpoint",
    }, AUTHORITY);
    expect(interrupted.state).toBe("awaiting-approval");
    expect(interrupted.pendingApprovalId).toBeTruthy();
    const resumed = runtime.resolveApproval(interrupted.runId, interrupted.pendingApprovalId as string, {
      status: "approved",
      decision: { approved: true },
      requestKey: "approval-resume-resolution",
    }, AUTHORITY);
    expect(resumed.state).toBe("succeeded");
    return `interrupted=${interrupted.state}; resumed=${resumed.state}`;
  });

  run("crash-replay-exactly-once", () => {
    const { plan, snapshot } = controlFixture("crash-replay", [{ id: "one", type: "agent", objective: "Run once.", outputSchema: {} }]);
    const entered = ack(plan, snapshot);
    const intent = nextObjectiveControlIntent(plan, entered);
    const acknowledgement: ObjectiveControlAcknowledgement = {
      kind: intent.kind,
      intentId: intent.intentId,
      requestKey: "crash-replay-agent-ack",
      ...(intent.kind === "agent" ? { attemptId: intent.attemptId } : {}),
      state: "completed",
      output: { ok: true },
      now: NOW,
    };
    const applied = applyObjectiveControlAcknowledgement(plan, entered, acknowledgement);
    expect(applyObjectiveControlAcknowledgement(plan, applied, acknowledgement)).toEqual(applied);
    expect(() => applyObjectiveControlAcknowledgement(plan, applied, { ...acknowledgement, output: { ok: false } })).toThrow(/conflicts/);

    const firstRepository = runtimeFixture();
    const input = objectiveInput("replay-run", { tasks: [task("once")] });
    const first = firstRepository.runtime.create(input, AUTHORITY);
    const restarted = new ObjectiveRuntime(firstRepository.repository, { now: () => NOW, id: () => "new-id" });
    expect(restarted.create(input, AUTHORITY)).toEqual(first);
    return "duplicate control ack and objective create replay to one durable result";
  });

  run("dynamic-plan-mutation", () => {
    const { plan } = controlFixture("dynamic-mutation", [{ id: "build", type: "agent", objective: "Build.", outputSchema: {} }]);
    const mutation = ObjectiveControlMutationSchema.parse({
      version: 1,
      mutationId: "dynamic-mutation-1",
      planId: plan.id,
      objectiveId: "dynamic-mutation-objective",
      runId: "dynamic-mutation-run",
      expectedRevision: 0,
      type: "insert-node",
      parentId: "root-control",
      slot: "steps",
      position: 1,
      node: {
        id: "verify",
        sourceNodeId: "verify",
        sourcePath: "steps.1",
        dependsOn: ["build"],
        label: "verify",
        type: "agent",
        objective: "Verify the build.",
        model: "fixture",
        harness: "auto",
        outputSchema: {},
        inputs: [],
        requiresApproval: false,
      },
      reason: "Add verification after build evidence.",
      evidence: { eventCursor: 9, eventIds: ["acceptance-event-9"], summary: "Build evidence is durable." },
      requestKey: "dynamic-mutation-request",
      actor: { type: "agent", id: "acceptance-conductor" },
    });
    expect(mutation.evidence.eventCursor).toBe(9);
    // The mutation target validator is the public pre-CAS boundary. Applying
    // the mutation repeats the checks before producing an immutable next plan.
    expect(() => validateObjectiveControlMutationTarget(mutation, plan)).not.toThrow();
    const next = applyObjectiveControlMutation(plan, mutation);
    expect(next.root.type).toBe("sequence");
    if (next.root.type !== "sequence") throw new Error("Expected sequence root.");
    expect(next.root.steps.map((step) => step.id)).toEqual(["build", "verify"]);
    expect(next.source).toEqual(plan.source);
    if (mutation.type !== "insert-node") throw new Error("Expected insert-node mutation.");
    return `revisionTarget=${mutation.expectedRevision}; inserted=${next.root.steps.at(-1)?.id}; evidenceCursor=${mutation.evidence.eventCursor}`;
  });

  run("dependency-gating", () => {
    const { plan } = controlFixture("dependency-gating", [{
      id: "fanout",
      type: "parallel",
      steps: [{ id: "first", type: "agent", objective: "Run the prerequisite.", outputSchema: {} }],
    }]);
    const mutation = ObjectiveControlMutationSchema.parse({
      version: 1,
      mutationId: "dependency-mutation-1",
      planId: plan.id,
      objectiveId: "dependency-gating-objective",
      runId: "dependency-gating-run",
      expectedRevision: 0,
      type: "insert-node",
      parentId: "fanout",
      slot: "steps",
      position: 1,
      node: {
        id: "second",
        sourceNodeId: "second",
        sourcePath: "steps.0.steps.1",
        dependsOn: ["first"],
        label: "second",
        type: "agent",
        objective: "Run after the prerequisite.",
        model: "fixture",
        harness: "auto",
        outputSchema: {},
        inputs: [],
        requiresApproval: false,
      },
      reason: "Add a dependency-gated verification step.",
      evidence: { eventCursor: 11, eventIds: ["acceptance-event-11"] },
      requestKey: "dependency-mutation-request",
      actor: { type: "agent", id: "acceptance-conductor" },
    });
    validateObjectiveControlMutationTarget(mutation, plan);
    const mutated = applyObjectiveControlMutation(plan, mutation);
    const initial = createObjectiveControlSnapshot(mutated, {
      objectiveId: "dependency-gating-objective",
      runId: "dependency-gating-run",
      createdAt: NOW,
    });
    let current = ack(mutated, initial);
    current = ack(mutated, current);
    const firstDispatch = nextObjectiveControlIntent(mutated, current);
    expect(firstDispatch).toMatchObject({ kind: "agent", operation: "dispatch", node: { id: "first" } });
    current = ack(mutated, current, { state: "completed", output: { ready: true }, agentId: "fixture-first" });
    const secondDispatch = nextObjectiveControlIntent(mutated, current);
    expect(secondDispatch).toMatchObject({ kind: "agent", operation: "dispatch", node: { id: "second" } });
    if (firstDispatch.kind !== "agent" || secondDispatch.kind !== "agent" || mutation.type !== "insert-node") {
      throw new Error("Expected dependency-gated agent dispatches.");
    }
    return `first=${firstDispatch.node.id}; dependency=${mutation.node.dependsOn[0]}; second=${secondDispatch.node.id}`;
  });

  run("requires-approval", () => {
    const { plan } = controlFixture("requires-approval", [{
      id: "secure",
      type: "agent",
      objective: "Run the approved operation.",
      outputSchema: {},
    }]);
    const mutation = ObjectiveControlMutationSchema.parse({
      version: 1,
      mutationId: "approval-mutation-1",
      planId: plan.id,
      objectiveId: "requires-approval-objective",
      runId: "requires-approval-run",
      expectedRevision: 0,
      type: "replace-node",
      nodeId: "secure",
      node: {
        id: "secure",
        sourceNodeId: "secure",
        sourcePath: "steps.0",
        dependsOn: [],
        label: "secure",
        type: "agent",
        objective: "Run the approved operation.",
        model: "fixture",
        harness: "auto",
        outputSchema: {},
        inputs: [],
        requiresApproval: true,
      },
      reason: "Gate the side-effecting operation with explicit approval.",
      evidence: { eventCursor: 12, eventIds: ["acceptance-event-12"] },
      requestKey: "approval-mutation-request",
      actor: { type: "agent", id: "acceptance-conductor" },
    });
    const gatedPlan = applyObjectiveControlMutation(plan, mutation);
    const initial = createObjectiveControlSnapshot(gatedPlan, {
      objectiveId: "requires-approval-objective",
      runId: "requires-approval-run",
      createdAt: NOW,
    });
    let current = ack(gatedPlan, initial);
    const approval = nextObjectiveControlIntent(gatedPlan, current);
    expect(approval).toMatchObject({ kind: "agent", operation: "approval", approvalRequired: true });
    current = ack(gatedPlan, current, { approved: true });
    const dispatch = nextObjectiveControlIntent(gatedPlan, current);
    expect(dispatch).toMatchObject({ kind: "agent", operation: "dispatch", node: { id: "secure" } });
    current = ack(gatedPlan, current, { state: "completed", output: { approved: true }, agentId: "fixture-secure" });
    expect(nextObjectiveControlIntent(gatedPlan, current).kind).toBe("join");
    if (dispatch.kind !== "agent") throw new Error("Expected approved dispatch.");
    return `approval=${approval.kind}; dispatch=${dispatch.operation}; receipt=${current.contextRefs.some((ref) => ref.id.startsWith("control-approval:"))}`;
  });

  run("budget-evidence-completion", () => {
    const limits = ObjectiveBudgetLimitsSchema.parse({ maxModelCalls: 1, maxTotalTokens: 100 });
    expect(limits.maxModelCalls).toBe(1);
    const { runtime } = runtimeFixture();
    const created = runtime.create(objectiveInput("evidence-run", {
      policy: { budget: limits },
      spec: {
        id: "evidence-run-objective",
        statement: "Complete only with required evidence.",
        criteria: [{ id: "tests", description: "Tests pass", path: "checks.tests", op: "equals", value: true, required: true }],
        approvalPolicy: { mode: "never" },
        maxReplans: 0,
      },
      tasks: [task("verify")],
    }), AUTHORITY);
    const rejected = runtime.checkpoint(created.runId, {
      eventCursor: 10,
      taskUpdates: [{ taskId: "verify", state: "completed", output: { testCount: 3 } }],
      context: { checks: { tests: false } },
      reason: "Task completed but criterion evidence is false.",
      requestKey: "evidence-fails-checkpoint",
    }, AUTHORITY);
    expect(rejected.state).toBe("failed");
    expect(rejected.output).toBeNull();
    return `budget.maxModelCalls=${limits.maxModelCalls}; evidence=false; terminal=${rejected.state}`;
  });

  run("frontend-projection", () => {
    const run = baseProjectionRun();
    const current = event(run.runId, 5);
    const foreign = event("foreign-run", 6, "chat.message");
    const projection = projectObjectiveRun({ run, events: [foreign, current] });
    expect(projection.frontier.map((packet) => packet.id)).toEqual(["build"]);
    expect(projection.events.map((item) => item.id)).toEqual([current.id]);
    const card = projectControlRoomObjective(projection);
    expect(card.lane).toBe("working");
    expect(buildControlRoomViewModel([projection]).totals).toMatchObject({ objectives: 1, working: 1, blocked: 0 });
    expect(objectiveEventQueryPlan([current, foreign])).toEqual({ objective: true, runIds: [run.runId], invalidateObjectivePrefix: false });
    return `frontier=${projection.frontier[0]?.id}; scopedEvents=${projection.events.length}; lane=${card.lane}`;
  });

  return results;
}

describe("next-generation objective/control-plan acceptance harness", () => {
  it("has a versioned manifest with the requested scorecard rows", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.suite).toBe("objective-control-harness");
    expect(manifest.scenarios).toHaveLength(10);
    expect(new Set(manifest.scenarios.map((scenario) => scenario.id)).size).toBe(10);
  });

  it("runs every scenario through public APIs and permits only declared expected gaps", () => {
    const results = acceptanceResults();
    expect(results).toHaveLength(manifest.scenarios.length);
    for (const result of results) {
      expect(result.actual, `${result.id}: ${result.evidence}`).toBe(result.expected);
    }
  });

  it("emits a clear scorecard for focused and CI runs", () => {
    const results = acceptanceResults();
    const scorecard = [
      "Objective/control-plan acceptance scorecard",
      ...results.map((result) => `${result.actual === "pass" ? "PASS" : result.actual === "expected-gap" ? "EXPECTED-GAP" : "FAIL"} | ${result.id} | ${result.evidence}`),
    ].join("\n");
    // Keep the output intentionally plain so it remains readable with Vitest's
    // default reporter and can be copied into an evaluation record.
    console.info(`\n${scorecard}\n`);
    expect(results.every((result) => result.actual !== "fail")).toBe(true);
  });
});
