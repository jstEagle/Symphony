import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ObjectiveControlPlanSchema,
  objectiveControlExecutionId,
  type ObjectiveControlPlan,
  type ObjectiveControlPlanSnapshot,
  type ObjectiveControlSignalDeliveryRecord,
  type ObjectiveControlSuspensionRecord,
} from "@symphony/protocol";
import { SymphonyStore } from "@symphony/storage";
import {
  applyObjectiveControlAcknowledgement,
  createObjectiveControlSnapshot,
  nextObjectiveControlIntent,
} from "@symphony/workflow";

const at = (seconds: number): string => new Date(Date.parse("2026-09-01T00:00:00.000Z") + seconds * 1_000).toISOString();

function suspensionPlan(kind: "timer" | "signal"): ObjectiveControlPlan {
  const leaf = kind === "timer"
    ? {
        id: "pause",
        sourceNodeId: "pause",
        sourcePath: "steps.0",
        dependsOn: [],
        label: "Pause",
        type: "timer" as const,
        durationMs: 5_000,
        expiresAfterMs: 10_000,
      }
    : {
        id: "health",
        sourceNodeId: "health",
        sourcePath: "steps.0",
        dependsOn: [],
        label: "Deployment health",
        type: "signal" as const,
        signalKey: "deployment.health",
        expiresAfterMs: 10_000,
        payloadSchema: { status: "string" },
      };
  return ObjectiveControlPlanSchema.parse({
    version: 1,
    id: `suspension-${kind}`,
    source: { kind: "workflow-revision", workflowId: "workflow-suspension", workflowRevision: 1, workflowHash: "suspension-hash" },
    root: {
      id: "root",
      sourceNodeId: "root",
      sourcePath: "root",
      dependsOn: [],
      label: "Suspension",
      type: "sequence",
      steps: [leaf],
    },
    limits: { maxNodes: null, maxDepth: null, maxLoopIterations: null, maxConcurrentAgents: null },
  });
}

function initialSnapshot(plan: ObjectiveControlPlan): ObjectiveControlPlanSnapshot {
  return createObjectiveControlSnapshot(plan, {
    objectiveId: "objective-suspension",
    runId: "run-suspension",
    planRevision: 1,
    createdAt: at(0),
  });
}

function enterLeaf(plan: ObjectiveControlPlan): ObjectiveControlPlanSnapshot {
  const initial = initialSnapshot(plan);
  const intent = nextObjectiveControlIntent(plan, initial, at(0));
  return applyObjectiveControlAcknowledgement(plan, initial, {
    kind: "sequence",
    intentId: intent.intentId,
    requestKey: "suspension-sequence-enter",
    now: at(0),
  });
}

describe("durable objective suspension nodes", () => {
  it("is strict data-only protocol and derives deterministic timer due time", () => {
    const plan = suspensionPlan("timer");
    expect(() => ObjectiveControlPlanSchema.parse({
      ...plan,
      root: { ...plan.root, steps: [{ ...plan.root.steps[0], fn: "setTimeout" }] },
    })).toThrow();

    let snapshot = enterLeaf(plan);
    let intent = nextObjectiveControlIntent(plan, snapshot, at(0));
    expect(intent).toMatchObject({ kind: "timer", operation: "schedule", attemptId: expect.any(String) });
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "timer",
      intentId: intent.intentId,
      requestKey: "suspension-timer-schedule",
      since: at(0),
      dueAt: at(5),
      expiresAt: at(10),
      now: at(0),
    });
    const executionId = objectiveControlExecutionId({ nodeId: "pause", iterationKey: "root/root/pause" });
    expect(snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === executionId)).toMatchObject({
      state: "waiting",
      suspension: { kind: "timer", status: "waiting", dueAt: at(5), expiresAt: at(10) },
    });
    expect(nextObjectiveControlIntent(plan, snapshot, at(1))).toMatchObject({ kind: "timer", operation: "wait", dueAt: at(5) });

    intent = nextObjectiveControlIntent(plan, snapshot, at(5));
    expect(intent).toMatchObject({ kind: "timer", operation: "due" });
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "timer",
      intentId: intent.intentId,
      requestKey: "suspension-timer-due",
      dueAt: at(5),
      now: at(5),
    });
    expect(snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === executionId)).toMatchObject({
      state: "completed",
      suspension: { kind: "timer", status: "delivered", terminalReason: "due" },
    });
  });

  it("creates a stable signal subscription and exactly-once delivery receipt", () => {
    const plan = suspensionPlan("signal");
    let snapshot = enterLeaf(plan);
    let intent = nextObjectiveControlIntent(plan, snapshot, at(0));
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "signal",
      intentId: intent.intentId,
      requestKey: "suspension-signal-subscribe",
      since: at(1),
      expiresAt: at(11),
      signalKey: "deployment.health",
      now: at(1),
    });
    const execution = { nodeId: "health", iterationKey: "root/root/health" };
    const record = snapshot.executions.find((entry) => objectiveControlExecutionId(entry.key) === objectiveControlExecutionId(execution));
    expect(record?.suspension).toMatchObject({
      kind: "signal",
      status: "waiting",
      signalKey: "deployment.health",
      since: at(1),
    });
    const subscriptionKey = record?.suspension?.kind === "signal" ? record.suspension.subscriptionKey : "";
    intent = nextObjectiveControlIntent(plan, snapshot, at(2));
    expect(intent).toMatchObject({ kind: "signal", operation: "wait", signalKey: "deployment.health", subscriptionKey });
    const delivery = {
      kind: "signal" as const,
      intentId: intent.intentId,
      requestKey: "suspension-signal-delivery",
      signalKey: "deployment.health",
      subscriptionKey,
      deliveryId: "provider-event-1",
      attemptId: intent.attemptId,
      payload: { status: "healthy" },
      now: at(2),
    };
    const delivered = applyObjectiveControlAcknowledgement(plan, snapshot, delivery);
    expect(delivered.executions.find((entry) => objectiveControlExecutionId(entry.key) === objectiveControlExecutionId(execution))).toMatchObject({
      state: "completed",
      output: { status: "healthy" },
      suspension: { status: "delivered", deliveryId: "provider-event-1", payload: { status: "healthy" } },
    });
    expect(applyObjectiveControlAcknowledgement(plan, delivered, delivery)).toEqual(delivered);
    expect(() => applyObjectiveControlAcknowledgement(plan, delivered, { ...delivery, payload: { status: "unhealthy" } })).toThrow(/conflicts/iu);
  });

  it("records cancellation and expiry as terminal suspension states", () => {
    const plan = suspensionPlan("signal");
    let snapshot = enterLeaf(plan);
    let intent = nextObjectiveControlIntent(plan, snapshot, at(0));
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "signal", intentId: intent.intentId, requestKey: "suspension-expire-subscribe", since: at(0), expiresAt: at(5), now: at(0),
    });
    intent = nextObjectiveControlIntent(plan, snapshot, at(5));
    expect(intent.operation).toBe("expire");
    snapshot = applyObjectiveControlAcknowledgement(plan, snapshot, {
      kind: "signal", intentId: intent.intentId, requestKey: "suspension-expire", now: at(5),
    });
    expect(snapshot.executions.find((entry) => entry.key.nodeId === "health")).toMatchObject({ state: "expired", suspension: { status: "expired", terminalReason: "expired" } });
  });

  it("persists suspension and signal delivery identities across a store reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "symphony-suspension-store-"));
    const path = join(directory, "state.sqlite");
    const suspension: ObjectiveControlSuspensionRecord = {
      version: 1,
      kind: "signal",
      objectiveId: "objective-suspension",
      runId: "run-suspension",
      nodeId: "health",
      execution: { nodeId: "health", iterationKey: "root/root/health" },
      attemptId: "control-attempt:health:root/root/health",
      since: at(0),
      expiresAt: at(10),
      status: "waiting",
      terminalReason: null,
      settledAt: null,
      signalKey: "deployment.health",
      subscriptionKey: "objective-signal:objective-suspension:run-suspension:health:root/root/health:control-attempt:health:root/root/health:deployment.health",
      deliveryId: null,
      deliveredAt: null,
      payload: null,
    };
    const delivery: ObjectiveControlSignalDeliveryRecord = {
      version: 1,
      id: "signal-delivery-1",
      objectiveId: suspension.objectiveId,
      runId: suspension.runId,
      nodeId: suspension.nodeId,
      execution: suspension.execution,
      attemptId: suspension.attemptId,
      signalKey: suspension.signalKey,
      subscriptionKey: suspension.subscriptionKey,
      deliveryId: "provider-event-1",
      payload: { status: "healthy" },
      deliveredAt: at(1),
      deliveredBy: { type: "system", id: "provider" },
    };
    const store = new SymphonyStore(path);
    expect(store.saveObjectiveControlSuspension(suspension)).toBe(true);
    expect(store.saveObjectiveControlSuspension(suspension)).toBe(false);
    expect(store.listDueObjectiveControlSuspensions(at(1))).toEqual([]);
    expect(store.listDueObjectiveControlSuspensions(at(10))).toHaveLength(1);
    expect(store.saveObjectiveControlSignalDelivery(delivery)).toBe(true);
    expect(store.saveObjectiveControlSignalDelivery(delivery)).toBe(false);
    store.close();
    const reopened = new SymphonyStore(path);
    expect(reopened.getObjectiveControlSuspension("run-suspension", "health@root/root/health")).toEqual(suspension);
    expect(reopened.getObjectiveControlSignalDelivery(delivery.subscriptionKey, delivery.deliveryId)).toEqual(delivery);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
