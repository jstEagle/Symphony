import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ObjectiveBudgetDebitRecordSchema,
  ObjectiveBudgetLedgerRecordSchema,
  ObjectiveBudgetReservationRecordSchema,
  ObjectivePolicySnapshotSchema,
  ObjectiveRunRecordSchema,
  objectivePolicyHash,
  type ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const now = "2026-09-01T00:00:00.000Z";

const policyBase = ObjectivePolicySnapshotSchema.parse({
  version: 1,
  policyVersion: 1,
  policyHash: "pending-hash",
  runId: "budget-run-1",
  objectiveId: "budget-objective-1",
  workflowId: "budget-workflow-1",
  workflowRevision: 1,
  workflowHash: "budget-workflow-hash-1",
  actor: { type: "user", id: "user-1" },
  effectivePermission: "read-only",
  allowedCapabilities: ["read", "observe"],
  workspace: { path: "/tmp/symphony-budget", dirtyPolicy: "local-only" },
  budget: { maxCostUsd: 2, maxTotalTokens: 100, maxToolCalls: 10 },
  sideEffectClassCeiling: "read",
  approvalPolicy: { mode: "never" },
  expiresAt: null,
  createdAt: now,
});
const policyHash = objectivePolicyHash(policyBase);

function makeStore(prefix = "symphony-policy-budget-"): SymphonyStore {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return new SymphonyStore(join(directory, "state.sqlite"));
}

function makeRun(withPolicy = true): ObjectiveRunRecord {
  const policy = ObjectivePolicySnapshotSchema.parse({ ...policyBase, policyHash });
  return ObjectiveRunRecordSchema.parse({
    version: 1,
    runId: "budget-run-1",
    objectiveId: "budget-objective-1",
    workflowId: "budget-workflow-1",
    workflowRevision: 1,
    workflowHash: "budget-workflow-hash-1",
    conductorAgentId: null,
    ...(withPolicy ? { policy, policyHash: policy.policyHash, pauseReason: null } : {}),
    spec: {
      id: "budget-objective-1",
      statement: "Account for this objective exactly once.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 1,
    },
    state: "executing",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [],
    context: {},
    output: null,
    error: null,
    requestKey: "budget-run-request-1",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  });
}

function makeLedger() {
  return ObjectiveBudgetLedgerRecordSchema.parse({
    version: 1,
    runId: "budget-run-1",
    objectiveId: "budget-objective-1",
    policyHash,
    limits: { maxCostUsd: 2, maxTotalTokens: 100, maxToolCalls: 10 },
    reserved: {},
    consumed: {},
    status: "active",
    pauseReason: null,
    revision: 0,
    requestKey: "budget-ledger-request-1",
    createdAt: now,
    updatedAt: now,
  });
}

function makeReservation(id: string, key: string, amount = { costUsd: 1, totalTokens: 20, toolCalls: 1 }) {
  return ObjectiveBudgetReservationRecordSchema.parse({
    version: 1,
    id,
    runId: "budget-run-1",
    objectiveId: "budget-objective-1",
    policyHash,
    reservationKey: key,
    attemptId: `${id}-attempt`,
    agentId: `${id}-agent`,
    amount,
    state: "reserved",
    requestKey: `${key}-request`,
    createdAt: now,
    updatedAt: now,
  });
}

describe("Objective policy and budget foundation", () => {
  it("keeps the policy snapshot strict, versioned, and explicitly unbounded", () => {
    const policy = ObjectivePolicySnapshotSchema.parse({
      version: 1,
      policyVersion: 2,
      policyHash: "policy-hash-bounded-1",
      runId: "run-1",
      objectiveId: "objective-1",
      workflowId: "workflow-1",
      workflowRevision: 1,
      workflowHash: "workflow-hash-1",
      actor: { type: "agent", id: "conductor-1" },
      effectivePermission: "full-access",
      allowedCapabilities: [],
      workspace: { path: "/tmp/workspace", dirtyPolicy: "local-only" },
      budget: { maxConcurrentAgents: null, maxDepth: null },
      sideEffectClassCeiling: "local",
      approvalPolicy: { mode: "on-replan" },
      expiresAt: null,
      createdAt: now,
    });
    expect(policy.budget).toMatchObject({ maxConcurrentAgents: null, maxDepth: null, maxCostUsd: null });
    expect(() => ObjectivePolicySnapshotSchema.parse({ ...policy, forged: true })).toThrow();
    expect(() => ObjectivePolicySnapshotSchema.parse({ ...policy, policyVersion: 0 })).toThrow();
    expect(() => ObjectivePolicySnapshotSchema.parse({
      ...policy,
      budget: { ...policy.budget, maxCostUsd: -1 },
    })).toThrow();
  });

  it("does not grant a legacy run an implicit policy or zero budget", () => {
    const store = makeStore();
    const legacy = makeRun(false);
    expect(store.saveObjectiveRun(legacy)).toBe(true);
    expect(store.getObjectiveRun(legacy.runId)).toEqual(legacy);
    expect(store.getObjectiveBudgetLedger(legacy.runId)).toBeNull();
    expect(() => store.saveObjectiveBudgetLedger(makeLedger())).toThrow(/no verified policy snapshot/);
    store.close();
  });

  it("persists reservations with deterministic replay keys and ledger CAS", () => {
    const store = makeStore();
    const run = makeRun();
    expect(store.saveObjectiveRun(run)).toBe(true);
    const ledger = makeLedger();
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 12").get()).toEqual({ version: 12 });
    expect(store.saveObjectiveBudgetLedger(ledger)).toBe(true);
    expect(store.saveObjectiveBudgetLedger(ledger)).toBe(false);
    expect(store.saveObjectiveBudgetReservation(makeReservation("reservation-1", "attempt-1"))).toBe(true);
    expect(store.saveObjectiveBudgetReservation(makeReservation("reservation-1", "attempt-1"))).toBe(false);
    expect(() => store.saveObjectiveBudgetReservation({ ...makeReservation("reservation-2", "attempt-1"), requestKey: "attempt-1-request-2" })).toThrow(/idempotency conflict/);
    expect(store.getObjectiveBudgetLedger(run.runId)).toMatchObject({ revision: 1, reserved: { costUsd: 1, totalTokens: 20 } });
    expect(store.saveObjectiveBudgetReservation(makeReservation("reservation-2", "attempt-2"), { expectedLedgerRevision: 0 })).toBe(false);
    expect(store.saveObjectiveBudgetReservation(makeReservation("reservation-2", "attempt-2"), { expectedLedgerRevision: 1 })).toBe(true);
    expect(store.getObjectiveBudgetLedger(run.runId)).toMatchObject({ revision: 2, reserved: { costUsd: 2, totalTokens: 40 } });
    const path = store.path;
    store.close();
    const reopened = new SymphonyStore(path);
    expect(reopened.listObjectiveBudgetReservations({ runId: run.runId })).toHaveLength(2);
    const reopenedLedger = reopened.getObjectiveBudgetLedger(run.runId);
    expect(reopenedLedger).toMatchObject({ revision: 2 });
    expect(reopened.updateObjectiveBudgetLedger({
      ...reopenedLedger!,
      revision: 1,
      updatedAt: "2026-09-01T00:00:01.000Z",
    }, { expectedRevision: 0 })).toBe(false);
    const released = { ...makeReservation("reservation-2", "attempt-2"), state: "released" as const, revision: 1, releasedAt: "2026-09-01T00:00:02.000Z", updatedAt: "2026-09-01T00:00:02.000Z" };
    expect(reopened.releaseObjectiveBudgetReservation(released, { expectedRevision: 0, expectedLedgerRevision: 2 })).toBe(true);
    expect(reopened.getObjectiveBudgetLedger(run.runId)).toMatchObject({ revision: 3, reserved: { costUsd: 1, totalTokens: 20 } });
    reopened.close();
  });

  it("debits known usage exactly once, settles reservations, and survives reopen", () => {
    const store = makeStore();
    const run = makeRun();
    expect(store.saveObjectiveRun(run)).toBe(true);
    expect(store.saveObjectiveBudgetLedger(makeLedger())).toBe(true);
    const reservation = makeReservation("reservation-1", "attempt-1");
    expect(store.reserveObjectiveBudget(reservation)).toBe(true);
    const debit = ObjectiveBudgetDebitRecordSchema.parse({
      version: 1,
      id: "debit-1",
      runId: run.runId,
      objectiveId: run.objectiveId,
      policyHash,
      usageEventKey: "driver-event-1",
      reservationId: reservation.id,
      usage: { costUsd: 0.75, inputTokens: 5, outputTokens: 5, totalTokens: 10, toolCalls: 1 },
      basis: "provider-reported",
      requestKey: "debit-request-1",
      createdAt: "2026-09-01T00:00:01.000Z",
    });
    expect(store.recordObjectiveBudgetDebit(debit)).toBe(true);
    expect(store.recordObjectiveBudgetDebit(debit)).toBe(false);
    expect(store.getObjectiveBudgetLedger(run.runId)).toMatchObject({
      revision: 2,
      consumed: { costUsd: 0.75, totalTokens: 10 },
      reserved: { costUsd: 0, totalTokens: 0 },
    });
    expect(store.getObjectiveBudgetReservation(run.runId, reservation.id)).toMatchObject({ state: "consumed", revision: 1 });
    expect(() => store.recordObjectiveBudgetDebit({ ...debit, id: "debit-forged", usageEventKey: "driver-event-1", requestKey: "debit-request-forged" })).toThrow(/idempotency conflict/);
    expect(() => ObjectiveBudgetDebitRecordSchema.parse({ ...debit, id: "unknown-usage", usageKnown: false, usageEventKey: "unknown-event", requestKey: "unknown-request" })).toThrow(/Unknown usage/);
    const path = store.path;
    store.close();
    const reopened = new SymphonyStore(path);
    expect(reopened.getObjectiveBudgetDebitByUsageEventKey(run.runId, debit.usageEventKey)).toEqual(debit);
    expect(reopened.getObjectiveBudgetLedger(run.runId)).toMatchObject({ revision: 2, consumed: { costUsd: 0.75 } });
    reopened.close();
  });
});
