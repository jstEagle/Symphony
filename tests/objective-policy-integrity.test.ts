import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRecordSchema,
  ObjectivePolicySnapshotSchema,
  ObjectiveRunRecordSchema,
  ObjectiveTaskSchema,
  objectivePolicyHash,
  type ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { createStore, type SymphonyStore } from "../packages/storage/src/index.js";
import { ObjectiveRuntime } from "../packages/workflow/src/objective-runtime.js";
import { ObjectiveStoreRepository } from "../packages/workflow/src/objective-store-repository.js";
import { ObjectiveSupervisionRunner } from "../packages/workflow/src/objective-supervision-runner.js";

const now = "2026-09-01T00:00:00.000Z";
const stores: SymphonyStore[] = [];
const temporary: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeStore(): SymphonyStore {
  const directory = mkdtempSync(join(tmpdir(), "symphony-objective-policy-integrity-"));
  temporary.push(directory);
  const store = createStore(join(directory, "state.sqlite"));
  stores.push(store);
  return store;
}

function makeRun(): ObjectiveRunRecord {
  const policyContent = {
    version: 1 as const,
    policyVersion: 1,
    policyHash: "pending-hash",
    runId: "integrity-run",
    objectiveId: "integrity-objective",
    workflowId: "integrity-workflow",
    workflowRevision: 1,
    workflowHash: "integrity-workflow-hash",
    actor: { type: "system" as const, id: "integrity-test" },
    effectivePermission: "read-only" as const,
    allowedCapabilities: ["observe"],
    workspace: { path: "/tmp/integrity-objective", dirtyPolicy: "local-only" as const },
    budget: { maxTotalTokens: 100, maxModelCalls: 2 },
    sideEffectClassCeiling: "read" as const,
    approvalPolicy: { mode: "never" as const },
    expiresAt: null,
    createdAt: now,
  };
  const normalizedPolicy = ObjectivePolicySnapshotSchema.parse(policyContent);
  const policy = ObjectivePolicySnapshotSchema.parse({
    ...normalizedPolicy,
    policyHash: objectivePolicyHash(normalizedPolicy),
  });
  return ObjectiveRunRecordSchema.parse({
    version: 1,
    runId: policy.runId,
    objectiveId: policy.objectiveId,
    workflowId: policy.workflowId,
    workflowRevision: policy.workflowRevision,
    workflowHash: policy.workflowHash,
    conductorAgentId: "integrity-conductor",
    policy,
    policyHash: policy.policyHash,
    pauseReason: null,
    spec: { id: policy.objectiveId, statement: "Keep policy identity intact.", criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 1 },
    state: "executing",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [{
      task: ObjectiveTaskSchema.parse({ id: "inspect", objective: "Inspect safely", workspace: policy.workspace }),
      state: "queued",
      attemptId: null,
      agentId: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    }],
    context: {},
    output: null,
    error: null,
    requestKey: "integrity-run-request",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  });
}

function tamperPersistedRun(store: SymphonyStore, mutate: (run: ObjectiveRunRecord) => ObjectiveRunRecord): void {
  const run = store.getObjectiveRun("integrity-run");
  if (!run) throw new Error("integrity fixture run missing");
  store.database.prepare("UPDATE objective_runs SET record_json = ? WHERE run_id = ?").run(JSON.stringify(mutate(run)), run.runId);
}

describe("objective policy identity", () => {
  it("rejects changed permission or budget with a stale or forged hash on save", () => {
    const store = makeStore();
    const run = makeRun();
    expect(store.saveObjectiveRun(run)).toBe(true);

    expect(() => store.saveObjectiveRun({
      ...run,
      policy: { ...run.policy!, effectivePermission: "full-access" },
    })).toThrow(/policy snapshot does not match run identity/);
    expect(() => store.saveObjectiveRun({
      ...run,
      policy: { ...run.policy!, budget: { ...run.policy!.budget, maxTotalTokens: 10 }, policyHash: "f".repeat(64) },
      policyHash: "f".repeat(64),
    })).toThrow(/policy snapshot does not match run identity/);
  });

  it.each([
    ["permission", (policy: ObjectiveRunRecord["policy"]) => ({ ...policy!, effectivePermission: "full-access" as const })],
    ["budget", (policy: ObjectiveRunRecord["policy"]) => ({ ...policy!, budget: { ...policy!.budget, maxTotalTokens: 1 } })],
    ["forged hash", (policy: ObjectiveRunRecord["policy"]) => ({ ...policy!, policyHash: "f".repeat(64) })],
  ])("rejects %s tampering when loading after a restart", (_label, mutate) => {
    const store = makeStore();
    expect(store.saveObjectiveRun(makeRun())).toBe(true);
    tamperPersistedRun(store, (run) => ({
      ...run,
      policy: mutate(run.policy),
      ...(String(_label) === "forged hash" ? { policyHash: "f".repeat(64) } : {}),
    }));
    expect(() => store.getObjectiveRun("integrity-run")).toThrow(/policy snapshot does not match run identity/);
  });

  it("applies a requested read-only policy before validating tasks", () => {
    const store = makeStore();
    const runtime = new ObjectiveRuntime(new ObjectiveStoreRepository(store), { now: () => now });
    expect(() => runtime.create({
      runId: "readonly-run",
      objectiveId: "readonly-objective",
      workflowId: "readonly-workflow",
      workflowRevision: 1,
      workflowHash: "readonly-workflow-hash",
      policy: { effectivePermission: "read-only", sideEffectClassCeiling: "read" },
      spec: { id: "readonly-objective", statement: "Read only", criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 1 },
      tasks: [{ id: "write", objective: "Write a file", permissions: "full-access" }],
      requestKey: "readonly-create-request",
    }, { actor: { type: "system", id: "readonly-test" }, permissionCeiling: "full-access" })).toThrow(/authority above/);
  });

  it("recovery holds a tampered policy before native work is created", async () => {
    const store = makeStore();
    const run = makeRun();
    expect(store.saveObjectiveRun(run)).toBe(true);
    tamperPersistedRun(store, (current) => ({
      ...current,
      policy: { ...current.policy!, budget: { ...current.policy!.budget, maxTotalTokens: 1 } },
    }));
    const repository = new ObjectiveStoreRepository(store);
    const runtime = new ObjectiveRuntime(repository, { now: () => now });
    store.saveAgent(AgentRecordSchema.parse({
      id: "integrity-conductor",
      logicalAgentId: "integrity-conductor",
      workflowId: run.workflowId,
      runId: run.runId,
      parentAgentId: null,
      depth: 0,
      objective: "Coordinate",
      missionHash: run.workflowHash,
      requestedHarness: "auto",
      requestedModel: "auto",
      harness: null,
      model: null,
      permissions: "full-access",
      status: "running",
      nativeSessionId: null,
      nativeRunId: null,
      workspacePath: run.policy!.workspace!.path,
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
    }));
    let creates = 0;
    const runner = new ObjectiveSupervisionRunner(runtime, repository, { create: async () => { creates += 1; throw new Error("must not create"); } } as never, store, {
      authority: { actor: { type: "system", id: "recovery-test" }, permissionCeiling: "full-access" },
    });
    await expect(runner.step(run.runId)).rejects.toThrow(/policy snapshot does not match run identity/);
    expect(creates).toBe(0);
  });
});
