import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ObjectiveHandoffAcceptanceRecordSchema,
  ObjectiveCheckpointRecordSchema,
  ObjectiveHandoffEnvelopeSchema,
  ObjectivePolicySnapshotSchema,
  ObjectiveRunRecordSchema,
  objectiveHandoffAcceptanceHash,
  objectiveHandoffHash,
  objectiveHandoffReferenceHash,
  objectivePolicyHash,
  validateObjectiveHandoffTarget,
} from "../packages/protocol/src/index.js";
import { SymphonyStore } from "../packages/storage/src/index.js";
import { objectiveHandoffExecutionPlan } from "../packages/workflow/src/objective-handoff.js";

const now = "2026-09-01T00:00:00.000Z";
const hash = "a".repeat(64);
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function envelope() {
  const content = {
    version: 1 as const,
    id: "handoff-1",
    objectiveId: "objective-1",
    runId: "run-1",
    objectiveRevision: 1,
    workflowId: "workflow-1",
    workflowRevision: 1,
    workflowHash: "workflow-hash",
    lineage: {
      objectiveId: "objective-1",
      runId: "run-1",
      nodeId: "node-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      iterationKey: null,
      parentHandoffId: null,
      chain: [],
    },
    scope: {
      intent: "Continue the objective from the committed boundary.",
      taskObjective: "Implement the next bounded unit of work.",
      constraints: [],
      acceptanceCriteria: [],
    },
    source: {
      harness: "codex" as const,
      agentId: "agent-1",
      attemptId: "attempt-1",
      nativeSessionId: null,
      nativeRunId: null,
    },
    target: {
      harness: "codex" as const,
      model: "auto",
      agentId: null,
      permission: "read-only" as const,
      requiredCapabilities: [],
      sideEffectClassCeiling: "read" as const,
    },
    evidence: {
      eventCursor: 1,
      eventRefs: [],
      observationRefs: [],
      artifactRefs: [],
      checkpoint: { id: "checkpoint-1", sequence: 1, hash },
    },
    workspace: null,
    continuity: {
      status: "unknown" as const,
      sourceHarness: "codex" as const,
      sourceAgentId: "agent-1",
      nativeSessionId: null,
      nativeRunId: null,
      capabilities: [],
      evidenceEventIds: [],
      hints: ["new-attempt-required"],
    },
    sideEffects: [],
    authority: {
      permission: "read-only" as const,
      requiredCapabilities: [],
      sideEffectClassCeiling: "read" as const,
      policySnapshotHash: hash,
      configSnapshotHash: hash,
    },
    createdAt: now,
    requestKey: "request-1",
    inputHash: hash,
    provenance: {
      source: "daemon" as const,
      actor: { type: "system" as const, id: "daemon" },
      requestKey: "request-1",
      capturedAt: now,
      evidenceEventIds: [],
    },
  };
  return ObjectiveHandoffEnvelopeSchema.parse({ ...content, contentHash: objectiveHandoffHash(content) });
}

describe("portable objective handoffs", () => {
  it("is content-addressed and produces a new-attempt plan by default", () => {
    const source = envelope();
    expect(objectiveHandoffHash(source)).toBe(source.contentHash);
    const acceptanceContent = {
      version: 1 as const,
      id: "acceptance-1",
      envelopeId: source.id,
      objectiveId: source.objectiveId,
      runId: source.runId,
      recipientAgentId: null,
      target: source.target,
      capabilities: [],
      nativeSessionId: null,
      nativeRunId: null,
      continuityStatus: "unknown" as const,
      evidenceEventIds: [],
      status: "accepted" as const,
      reason: null,
      requestKey: "accept-request-1",
      inputHash: hash,
      acceptedAt: now,
      provenance: {
        source: "daemon" as const,
        actor: { type: "system" as const, id: "daemon" },
        requestKey: "accept-request-1",
        capturedAt: now,
        evidenceEventIds: [],
      },
    };
    const acceptance = ObjectiveHandoffAcceptanceRecordSchema.parse({
      ...acceptanceContent,
      contentHash: objectiveHandoffAcceptanceHash(acceptanceContent),
    });
    expect(objectiveHandoffExecutionPlan(source, acceptance)).toMatchObject({
      mode: "new-attempt",
      evidenceCheckpointId: "checkpoint-1",
      harness: "codex",
    });
  });

  it("rejects a proven continuity claim when the recipient harness differs", () => {
    const source = envelope();
    const proven = { ...source, continuity: { ...source.continuity, status: "proven" as const, capabilities: ["native-session-id"] } };
    const result = validateObjectiveHandoffTarget(proven, {
      harness: "claude",
      permission: "read-only",
      requiredCapabilities: [],
      capabilities: [],
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("does not match") });
  });

  it("persists an envelope only when its checkpoint reference is durable", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-handoff-storage-"));
    temporary.push(root);
    const store = new SymphonyStore(join(root, "state.sqlite"));
    const policyInput = ObjectivePolicySnapshotSchema.parse({
      version: 1,
      policyVersion: 1,
      policyHash: "pending-policy-hash",
      runId: "run-1",
      objectiveId: "objective-1",
      workflowId: "workflow-1",
      workflowRevision: 1,
      workflowHash: "workflow-hash",
      actor: { type: "user", id: "local-user" },
      effectivePermission: "read-only",
      allowedCapabilities: [],
      workspace: null,
      budget: {},
      sideEffectClassCeiling: "read",
      approvalPolicy: { mode: "never" },
      expiresAt: null,
      createdAt: now,
    });
    const policy = { ...policyInput, policyHash: objectivePolicyHash(policyInput) };
    const run = ObjectiveRunRecordSchema.parse({
      version: 1,
      runId: "run-1",
      objectiveId: "objective-1",
      objectiveRevision: 1,
      workflowId: "workflow-1",
      workflowRevision: 1,
      workflowHash: "workflow-hash",
      conductorAgentId: null,
      policy,
      policyHash: policy.policyHash,
      spec: { id: "objective-1", statement: "Portable objective" },
      state: "planning",
      activePlanRevision: 0,
      latestCheckpointId: null,
      pendingApprovalId: null,
      replanCount: 0,
      tasks: [],
      context: {},
      output: null,
      error: null,
      requestKey: "run-request-1",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    });
    store.saveObjectiveRun(run);
    const checkpoint = ObjectiveCheckpointRecordSchema.parse({
      version: 1,
      id: "checkpoint-1",
      runId: run.runId,
      objectiveId: run.objectiveId,
      policyHash: policy.policyHash,
      sequence: 1,
      planRevision: 0,
      eventCursor: 0,
      context: {},
      taskStates: {},
      criteria: [],
      contextHash: hash,
      reason: "Saved boundary",
      createdBy: { type: "user", id: "local-user" },
      requestKey: "checkpoint-request-1",
      createdAt: now,
      objectiveRevision: 1,
      workflowRevision: 1,
      workflowHash: run.workflowHash,
      controlPlanRevision: null,
      controlPlanHash: null,
      flatExecution: { state: "planning", context: {}, tasks: [], outputs: {} },
      treeExecution: null,
      outputs: {},
      attemptHighWater: 0,
      eventHighWater: 0,
      artifactHashes: [],
      workspaceEvidence: { canonicalGrant: null, git: { repo: null, ref: null, commit: null, dirty: null, patchHash: null, worktree: null }, dirty: null, patchHash: null, worktree: null },
      nativeSessions: [],
      continuity: { status: "unknown", capabilities: [], reason: "No native continuity" },
      unresolvedExternalOperations: [],
      configSnapshotHash: hash,
      policySnapshotHash: policy.policyHash,
      provenance: { source: "user", actor: { type: "user", id: "local-user" }, capturedAt: now, evidenceEventIds: [], parentCheckpointId: null, baseCheckpointId: null },
    });
    expect(store.appendObjectiveCheckpoint(checkpoint)).toBe(true);
    const source = envelope();
    const durable = ObjectiveHandoffEnvelopeSchema.parse({
      ...source,
      authority: { ...source.authority, policySnapshotHash: policy.policyHash },
      evidence: { ...source.evidence, eventCursor: checkpoint.eventCursor, checkpoint: { id: checkpoint.id, sequence: checkpoint.sequence, hash: objectiveHandoffReferenceHash(checkpoint) } },
    });
    const complete = ObjectiveHandoffEnvelopeSchema.parse({ ...durable, contentHash: objectiveHandoffHash(durable) });
    expect(store.saveObjectiveHandoff(complete, { fingerprint: complete.inputHash }).status).toBe("committed");
    expect(store.getObjectiveHandoff(complete.id)).toEqual(complete);
    expect(store.saveObjectiveHandoff(complete, { fingerprint: complete.inputHash }).status).toBe("replayed");
    store.close();
  });
});
