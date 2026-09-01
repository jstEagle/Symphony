import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CapabilityResultFeedbackRecord,
  withCapabilityResultFeedbackHash,
} from "@symphony/protocol";
import { CapabilityResultFeedbackRepository, ObjectiveAttentionRegistry, createStore, type SymphonyStore } from "@symphony/storage";
import { loadConfig, writeDefaultConfig } from "@symphony/config";
import { ObjectiveFeedbackRuntime } from "./objective-feedback-runtime.js";
import { ObjectiveRuntime } from "./objective-runtime.js";
import { ObjectiveStoreRepository } from "./objective-store-repository.js";

const authority = { actor: { type: "system" as const, id: "feedback-runtime-test" }, permissionCeiling: "full-access" as const };
const roots: string[] = [];
const stores: SymphonyStore[] = [];

function task(id: string) {
  return {
    id,
    objective: `Complete ${id}`,
    dependsOn: [],
    outputSchema: {},
    model: "fixture",
    harness: "auto" as const,
    inputs: [],
    requiresApproval: false,
  };
}

function fixture(specOverrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "symphony-feedback-runtime-"));
  roots.push(root);
  writeDefaultConfig(root);
  const loaded = loadConfig({ rootDirectory: root });
  const store = createStore(loaded.dataDirectory);
  stores.push(store);
  const repository = new ObjectiveStoreRepository(store);
  let sequence = 0;
  const runtime = new ObjectiveRuntime(repository, { id: () => `feedback-runtime-checkpoint-${++sequence}`, now: () => "2026-09-01T00:00:02.000Z" });
  const run = runtime.create({
    runId: "feedback-runtime-run",
    objectiveId: "feedback-runtime-objective",
    workflowId: "feedback-runtime-workflow",
    workflowRevision: 1,
    workflowHash: "feedback-runtime-workflow-hash",
    spec: {
      id: "feedback-runtime-objective",
      statement: "Exercise the accepted capability feedback boundary.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 1,
      ...specOverrides,
    },
    tasks: [task("capability-node")],
    requestKey: "feedback-runtime-create",
  }, authority);
  runtime.checkpoint(run.runId, {
    eventCursor: 1,
    taskUpdates: [{ taskId: "capability-node", state: "running", attemptId: "feedback-attempt-1" }],
    reason: "Seed the durable capability attempt for feedback.",
    requestKey: "feedback-runtime-attempt",
  }, authority);
  const feedbackRepository = new CapabilityResultFeedbackRepository(":memory:");
  const boundary = new ObjectiveFeedbackRuntime({
    feedbackRepository,
    objectiveRepository: repository,
    runtime,
    authority,
    attentionRegistry: new ObjectiveAttentionRegistry(store),
    now: () => "2026-09-01T00:00:02.000Z",
  });
  return { store, repository, runtime, run, feedbackRepository, boundary };
}

function feedback(overrides: Partial<CapabilityResultFeedbackRecord> = {}): CapabilityResultFeedbackRecord {
  return withCapabilityResultFeedbackHash({
    version: 1,
    id: "feedback-runtime-1",
    objectiveId: "feedback-runtime-objective",
    runId: "feedback-runtime-run",
    nodeId: "capability-node",
    attemptId: "feedback-attempt-1",
    capabilityAdmissionId: "admission-feedback-runtime",
    capabilityAdmissionHash: "a".repeat(64),
    agentId: null,
    nativeAgentId: null,
    nativeSessionId: null,
    nativeRunId: null,
    evidenceRefs: [{ kind: "event", id: "feedback-event-1", cursor: 1 }],
    charterCitation: null,
    idempotencyKey: "feedback-runtime-request-1",
    createdAt: "2026-09-01T00:00:01.000Z",
    status: "accepted",
    result: { status: "succeeded", output: { ok: true } },
    summary: null,
    ...overrides,
  });
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    objectiveId: "feedback-runtime-objective",
    runId: "feedback-runtime-run",
    expectedPlanRevision: 0,
    replanCount: 0,
    maxReplans: 1,
    objectiveComplete: false,
    criteriaSatisfied: true,
    charter: null,
    evidence: { eventCursor: 1, eventIds: ["feedback-event-1"], observationIds: [], artifactIds: [], checkpointIds: [], sources: [] },
    approvalPolicy: "never" as const,
    approval: { required: false },
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ObjectiveFeedbackRuntime", () => {
  it("materializes a finish decision as one durable terminal checkpoint", () => {
    const fixtureState = fixture();
    const input = feedback({ result: { status: "succeeded", output: { ok: true } } });
    fixtureState.feedbackRepository.saveFeedback(input);

    const first = fixtureState.boundary.processAccepted(input, context({ objectiveComplete: true }));
    const replay = fixtureState.boundary.processAccepted(input, context({ objectiveComplete: true }));

    expect(first.reduced.kind).toBe("finish");
    expect(first.applied).toBe("finish");
    expect(first.run.state).toBe("succeeded");
    expect(first.run.tasks[0]).toMatchObject({ state: "completed", output: { ok: true } });
    expect(fixtureState.repository.getObjectiveActionReceipt(`${input.id}:finish`)).toMatchObject({ kind: "objective.checkpoint.commit" });
    expect(replay.applied).toBe("replayed");
    expect(replay.run).toEqual(first.run);
    expect(fixtureState.feedbackRepository.listEvaluations()).toHaveLength(1);
    expect(fixtureState.feedbackRepository.listDecisions()).toHaveLength(1);
  });

  it("materializes completion approval and replays it without reopening the request", () => {
    const fixtureState = fixture({ approvalPolicy: { mode: "before-completion" } });
    const input = feedback({ id: "feedback-runtime-completion-approval", idempotencyKey: "feedback-runtime-completion-approval-request", result: { status: "succeeded", output: { ok: true } } });
    fixtureState.feedbackRepository.saveFeedback(input);

    const first = fixtureState.boundary.processAccepted(input, context({
      objectiveComplete: true,
      approvalPolicy: "before-completion",
    }));
    const approvalId = first.run.pendingApprovalId;
    const replay = fixtureState.boundary.processAccepted(input, context({
      objectiveComplete: true,
      approvalPolicy: "before-completion",
    }));

    expect(first.reduced.kind).toBe("wait-for-approval");
    expect(first.applied).toBe("wait-for-approval");
    expect(first.run.state).toBe("awaiting-approval");
    expect(approvalId).not.toBeNull();
    expect(fixtureState.repository.getObjectiveApproval(first.run.runId, approvalId as string)).toMatchObject({ kind: "completion", status: "requested" });
    expect(replay.applied).toBe("replayed");
    expect(replay.run).toEqual(first.run);
    expect(fixtureState.repository.getObjectiveActionReceipt(`${input.id}:approval:prepare`)).toMatchObject({ kind: "objective.checkpoint.commit" });
  });

  it("records a failed attempt before opening one idempotent replan approval", () => {
    const fixtureState = fixture();
    const input = feedback({ id: "feedback-runtime-replan-approval", idempotencyKey: "feedback-runtime-replan-approval-request", result: { status: "failed" } });
    fixtureState.feedbackRepository.saveFeedback(input);

    const first = fixtureState.boundary.processAccepted(input, context({ approvalPolicy: "on-replan" }));
    const replay = fixtureState.boundary.processAccepted(input, context({ approvalPolicy: "on-replan" }));

    expect(first.reduced.kind).toBe("wait-for-approval");
    expect(first.applied).toBe("wait-for-approval");
    expect(first.run.state).toBe("awaiting-approval");
    expect(first.run.tasks[0]?.state).toBe("failed");
    expect(fixtureState.repository.getObjectiveApproval(first.run.runId, first.run.pendingApprovalId as string)).toMatchObject({ kind: "plan", status: "requested" });
    expect(replay.applied).toBe("replayed");
    expect(replay.run).toEqual(first.run);
  });

  it("persists one evaluation/decision and replays without a second checkpoint", () => {
    const fixtureState = fixture();
    const input = feedback();
    fixtureState.feedbackRepository.saveFeedback(input);

    const first = fixtureState.boundary.processAccepted(input, context());
    const second = fixtureState.boundary.processAccepted(input, context());

    expect(first.reduced.kind).toBe("continue");
    expect(first.applied).toBe("continue");
    expect(second.applied).toBe("replayed");
    expect(second.reduced.replay.status).toBe("replay");
    expect(second.evaluation.id).toBe(first.evaluation.id);
    expect(second.decision.id).toBe(first.decision.id);
    expect(fixtureState.feedbackRepository.listEvaluations()).toHaveLength(1);
    expect(fixtureState.feedbackRepository.listDecisions()).toHaveLength(1);
    expect(fixtureState.runtime.get(fixtureState.run.runId).latestCheckpointId).not.toBeNull();
  });

  it("fails closed to durable attention for an accepted result without explicit outcome", () => {
    const fixtureState = fixture();
    const input = feedback({ result: { ok: true } });
    fixtureState.feedbackRepository.saveFeedback(input);

    const result = fixtureState.boundary.processAccepted(input, context());

    expect(result.reduced).toMatchObject({ kind: "attention", code: "unknown-result" });
    expect(result.attention).toMatchObject({ runId: fixtureState.run.runId, status: "open" });
    expect(fixtureState.runtime.get(fixtureState.run.runId).tasks[0]?.state).toBe("running");
  });

  it("does not treat evidence beyond the supplied high-water mark as success", () => {
    const fixtureState = fixture();
    const input = feedback({ evidenceRefs: [{ kind: "event", id: "future-event", cursor: 99 }] });
    fixtureState.feedbackRepository.saveFeedback(input);

    const result = fixtureState.boundary.processAccepted(input, context({ evidence: { eventCursor: 1, eventIds: [], observationIds: [], artifactIds: [], checkpointIds: [], sources: [] } }));

    expect(result.reduced).toMatchObject({ kind: "attention", code: "unknown-result" });
    expect(fixtureState.runtime.get(fixtureState.run.runId).tasks[0]?.state).toBe("running");
  });

  it("uses one deterministic plan CAS request for a failed accepted result", () => {
    const fixtureState = fixture();
    const input = feedback({ result: { status: "failed" }, id: "feedback-runtime-failed", idempotencyKey: "feedback-runtime-failed-request" });
    fixtureState.feedbackRepository.saveFeedback(input);

    const first = fixtureState.boundary.processAccepted(input, context(), { replanTasks: [task("replacement")] });
    const replay = fixtureState.boundary.processAccepted(input, context(), { replanTasks: [task("replacement")] });

    expect(first.reduced.kind).toBe("replan");
    expect(first.applied).toBe("replan");
    expect(replay.applied).toBe("replayed");
    expect(fixtureState.runtime.get(fixtureState.run.runId).activePlanRevision).toBe(1);
    expect(fixtureState.feedbackRepository.listEvaluations()).toHaveLength(1);
    expect(fixtureState.feedbackRepository.listDecisions()).toHaveLength(1);
  });
});
