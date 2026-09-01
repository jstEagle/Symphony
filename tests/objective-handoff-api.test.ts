import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { SecretStore } from "../packages/config/src/index.js";
import {
  AgentRecordSchema,
  ObjectiveCheckpointRecordSchema,
  ObjectiveHandoffEnvelopeSchema,
  ObjectivePolicySnapshotSchema,
  ObjectiveRunRecordSchema,
  objectiveHandoffHash,
  objectivePolicyHash,
} from "../packages/protocol/src/index.js";
import { createStore } from "../packages/storage/src/index.js";
import { TEST_DAEMON_SECRET } from "./setup.js";

const timestamp = "2026-09-01T00:00:00.000Z";
const configHash = "c".repeat(64);
const temporary: string[] = [];

function testSecretStore(): SecretStore {
  return new SecretStore("dev.symphony.objective-handoff-api", {
    platform: "linux",
    environment: { SYMPHONY_DAEMON_SECRET: TEST_DAEMON_SECRET },
    nativeBackend: null,
  });
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function writeConfig(root: string, port: number): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
    policy: {
      effectivePermission: "full-access",
      allowedCapabilities: [],
      sideEffectClassCeiling: "local",
      approvalPolicy: { mode: "never" },
    },
    agents: { defaultPermissions: "full-access", maxDepth: 3, maxConcurrent: 8 },
    harnesses: {
      codex: { enabled: false },
      claude: { enabled: false },
      cursor: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      acp: [],
    },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    plugins: { watch: false },
  }));
}

function seed(root: string): { runId: string; checkpointId: string } {
  const runId = "handoff-api-run";
  const objectiveId = "handoff-api-objective";
  const workflowId = "handoff-api-workflow";
  const workflowHash = "workflow-hash-1";
  const policyInput = ObjectivePolicySnapshotSchema.parse({
    version: 1,
    policyVersion: 1,
    policyHash: "pending-policy-hash",
    runId,
    objectiveId,
    workflowId,
    workflowRevision: 1,
    workflowHash,
    actor: { type: "user", id: "local-user" },
    effectivePermission: "full-access",
    allowedCapabilities: [],
    workspace: null,
    budget: {},
    sideEffectClassCeiling: "local",
    approvalPolicy: { mode: "never" },
    expiresAt: null,
    createdAt: timestamp,
  });
  const policy = { ...policyInput, policyHash: objectivePolicyHash(policyInput) };
  const run = ObjectiveRunRecordSchema.parse({
    version: 1,
    runId,
    objectiveId,
    objectiveRevision: 1,
    workflowId,
    workflowRevision: 1,
    workflowHash,
    conductorAgentId: "handoff-api-root",
    policy,
    policyHash: policy.policyHash,
    spec: { id: objectiveId, statement: "Test durable handoff authority." },
    state: "planning",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [],
    context: {},
    output: null,
    error: null,
    requestKey: "handoff-api-run-request",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
  });
  const agent = AgentRecordSchema.parse({
    id: "handoff-api-root",
    logicalAgentId: "handoff-api-root",
    workflowId,
    runId,
    parentAgentId: null,
    depth: 0,
    objective: "Test durable handoff authority.",
    missionHash: "mission-hash-1",
    requestedHarness: "codex",
    requestedModel: "fixture-model",
    harness: "codex",
    model: "fixture-model",
    permissions: "full-access",
    status: "completed",
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: root,
    output: { ok: true },
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
  });
  const checkpoint = ObjectiveCheckpointRecordSchema.parse({
    version: 1,
    id: "handoff-api-checkpoint",
    runId,
    objectiveId,
    policyHash: policy.policyHash,
    sequence: 1,
    planRevision: 0,
    eventCursor: 0,
    context: {},
    taskStates: {},
    criteria: [],
    contextHash: "context-hash-1",
    reason: "Durable handoff API boundary.",
    createdBy: { type: "agent", id: agent.id },
    requestKey: "handoff-api-checkpoint-request",
    createdAt: timestamp,
    objectiveRevision: 1,
    workflowRevision: 1,
    workflowHash,
    controlPlanRevision: null,
    controlPlanHash: null,
    flatExecution: { state: "planning", context: {}, tasks: [], outputs: {} },
    treeExecution: null,
    outputs: {},
    attemptHighWater: 0,
    eventHighWater: 0,
    artifactHashes: [],
    workspaceEvidence: {
      canonicalGrant: null,
      git: { repo: null, ref: null, commit: null, dirty: null, patchHash: null, worktree: null },
      dirty: null,
      patchHash: null,
      worktree: null,
    },
    nativeSessions: [],
    continuity: { status: "unknown", capabilities: [], reason: "No native continuity." },
    unresolvedExternalOperations: [],
    unresolvedExternalSideEffects: [],
    policySnapshotHash: policy.policyHash,
    configSnapshotHash: configHash,
    provenance: {
      source: "user",
      actor: { type: "agent", id: agent.id },
      capturedAt: timestamp,
      evidenceEventIds: [],
      parentCheckpointId: null,
      baseCheckpointId: null,
    },
  });
  const store = createStore(join(root, ".symphony"));
  store.saveAgent(agent);
  store.saveObjectiveRun(run);
  expect(store.appendObjectiveCheckpoint(checkpoint)).toBe(true);
  store.close();
  return { runId, checkpointId: checkpoint.id };
}

function headers(daemon: Awaited<ReturnType<typeof startDaemon>>, agentId = "handoff-api-root") {
  return {
    "content-type": "application/json",
    "x-symphony-agent-id": agentId,
    "x-symphony-agent-token": daemon.agents.tokenFor(agentId),
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe("durable objective handoff API", () => {
  it("enforces authority, persists offers across restart, and replays idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-handoff-api-"));
    temporary.push(root);
    const port = await availablePort();
    writeConfig(root, port);
    const { runId, checkpointId } = seed(root);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, secretStore: testSecretStore(), credentialPlatform: "linux" });
    const offer = {
      version: 1,
      checkpointId,
      taskId: null,
      nodeId: null,
      attemptId: null,
      iterationKey: null,
      intent: "Transfer the objective boundary.",
      taskObjective: "Continue from the committed checkpoint.",
      constraints: [],
      acceptanceCriteria: [],
      evidenceEventIds: [],
      observationIds: [],
      artifactIds: [],
      target: {
        harness: "codex",
        model: "auto",
        agentId: null,
        permission: "full-access",
        requiredCapabilities: [],
        sideEffectClassCeiling: "read",
      },
      parentHandoffId: null,
    };
    try {
      const base = `http://127.0.0.1:${port}`;
      const committed = await fetch(`${base}/v1/objectives/${runId}/handoffs`, {
        method: "POST",
        headers: { ...headers(daemon), connection: "close", "idempotency-key": "handoff-offer-1" },
        body: JSON.stringify(offer),
      });
      expect(committed.status).toBe(201);
      const committedBody = await json(committed);
      expect(committedBody.status).toBe("committed");
      expect(committedBody.envelope.evidence.checkpoint.id).toBe(checkpointId);
      const handoffId = committedBody.envelope.id as string;

      const conflict = await fetch(`${base}/v1/objectives/${runId}/handoffs`, {
        method: "POST",
        headers: { ...headers(daemon), connection: "close", "idempotency-key": "handoff-offer-1" },
        body: JSON.stringify({ ...offer, intent: "Different immutable intent." }),
      });
      expect(conflict.status).toBe(409);
      expect((await json(conflict)).error).toContain("already bound to a different request");
      await daemon.close();

      const restarted = await startDaemon({ rootDirectory: root, noPlugins: true, secretStore: testSecretStore(), credentialPlatform: "linux" });
      try {
        const listing = await fetch(`${base}/v1/objectives/${runId}/handoffs`, { headers: { connection: "close" } });
        expect(listing.status).toBe(200);
        expect((await json(listing)).handoffs).toHaveLength(1);
        const replay = await fetch(`${base}/v1/objectives/${runId}/handoffs`, {
          method: "POST",
          headers: { ...headers(restarted), connection: "close", "idempotency-key": "handoff-offer-1" },
          body: JSON.stringify(offer),
        });
        expect(replay.status).toBe(201);
        expect((await json(replay)).status).toBe("replayed");

        const stored = restarted.store.getObjectiveHandoff(handoffId);
        if (!stored) throw new Error("Restarted daemon did not restore the handoff envelope.");
        const conflicting = ObjectiveHandoffEnvelopeSchema.parse({
          ...stored,
          scope: { ...stored.scope, intent: "Different immutable intent." },
          contentHash: objectiveHandoffHash({ ...stored, scope: { ...stored.scope, intent: "Different immutable intent." } }),
        });
        const storageReplay = restarted.store.saveObjectiveHandoff(conflicting, { fingerprint: conflicting.inputHash });
        expect(storageReplay.status).toBe("replayed");
        expect(storageReplay.envelope.contentHash).toBe(stored.contentHash);
        expect(storageReplay.envelope.scope.intent).toBe(stored.scope.intent);

        const accepted = await fetch(`${base}/v1/objectives/${runId}/handoffs/${encodeURIComponent(handoffId)}/accept`, {
          method: "POST",
          headers: { ...headers(restarted), connection: "close", "idempotency-key": "handoff-accept-1" },
          body: JSON.stringify({ envelopeId: handoffId, harness: "codex", model: "auto", permission: "full-access", capabilities: [], continuityStatus: "unknown" }),
        });
        expect(accepted.status).toBe(200);
        const acceptedBody = await json(accepted);
        expect(acceptedBody.execution.mode).toBe("new-attempt");
        const acceptedReplay = await fetch(`${base}/v1/objectives/${runId}/handoffs/${encodeURIComponent(handoffId)}/accept`, {
          method: "POST",
          headers: { ...headers(restarted), connection: "close", "idempotency-key": "handoff-accept-1" },
          body: JSON.stringify({ envelopeId: handoffId, harness: "codex", model: "auto", permission: "full-access", capabilities: [], continuityStatus: "unknown" }),
        });
        expect(acceptedReplay.status).toBe(200);
        expect((await json(acceptedReplay)).status).toBe("replayed");

        const readOnly = await fetch(`${base}/v1/objectives/${runId}/handoffs/${encodeURIComponent(handoffId)}/accept`, {
          method: "POST",
          headers: { "content-type": "application/json", connection: "close", "idempotency-key": "handoff-accept-3" },
          body: JSON.stringify({ envelopeId: handoffId, harness: "codex", model: "auto", permission: "read-only", capabilities: [], continuityStatus: "unknown" }),
        });
        expect(readOnly.status).toBe(403);

        const rejectedOffer = await fetch(`${base}/v1/objectives/${runId}/handoffs`, {
          method: "POST",
          headers: { "content-type": "application/json", connection: "close", "idempotency-key": "handoff-offer-rejected" },
          body: JSON.stringify({ ...offer, intent: "Offer a boundary that may be declined." }),
        });
        expect(rejectedOffer.status).toBe(201);
        const rejectedOfferBody = await json(rejectedOffer);
        const rejectedHandoffId = rejectedOfferBody.envelope.id as string;
        const rejected = await fetch(`${base}/v1/objectives/${runId}/handoffs/${encodeURIComponent(rejectedHandoffId)}/accept`, {
          method: "POST",
          headers: { "content-type": "application/json", connection: "close", "idempotency-key": "handoff-reject-1" },
          body: JSON.stringify({ envelopeId: rejectedHandoffId, decision: "rejected", reason: "The receiving harness is not available." }),
        });
        expect(rejected.status).toBe(200);
        const rejectedBody = await json(rejected);
        expect(rejectedBody.status).toBe("committed");
        expect(rejectedBody.acceptance.status).toBe("rejected");
        expect(rejectedBody.execution).toBeNull();

        const rejectedReplay = await fetch(`${base}/v1/objectives/${runId}/handoffs/${encodeURIComponent(rejectedHandoffId)}/accept`, {
          method: "POST",
          headers: { "content-type": "application/json", connection: "close", "idempotency-key": "handoff-reject-1" },
          body: JSON.stringify({ envelopeId: rejectedHandoffId, decision: "rejected", reason: "The receiving harness is not available." }),
        });
        expect(rejectedReplay.status).toBe(200);
        const rejectedReplayBody = await json(rejectedReplay);
        expect(rejectedReplayBody.status).toBe("replayed");
        expect(rejectedReplayBody.execution).toBeNull();

        const rejectionConflict = await fetch(`${base}/v1/objectives/${runId}/handoffs/${encodeURIComponent(rejectedHandoffId)}/accept`, {
          method: "POST",
          headers: { "content-type": "application/json", connection: "close", "idempotency-key": "handoff-reject-1" },
          body: JSON.stringify({ envelopeId: rejectedHandoffId, decision: "accepted" }),
        });
        expect(rejectionConflict.status).toBe(409);
        expect((await json(rejectionConflict)).error).toContain("already bound to a different request");

        const rejectedDetail = await fetch(`${base}/v1/objectives/${runId}/handoffs/${encodeURIComponent(rejectedHandoffId)}`, { headers: { connection: "close" } });
        expect(rejectedDetail.status).toBe(200);
        const rejectedDetailBody = await json(rejectedDetail);
        expect(rejectedDetailBody.acceptance.status).toBe("rejected");
        expect(rejectedDetailBody.execution).toBeNull();
      } finally {
        await restarted.close();
      }
    } finally {
      if (daemon) await daemon.close().catch(() => undefined);
    }
  });

  it("rejects an authenticated read-only agent before creating a handoff", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-handoff-api-authority-"));
    temporary.push(root);
    const port = await availablePort();
    writeConfig(root, port);
    const seeded = seed(root);
    const store = createStore(join(root, ".symphony"));
    const readOnly = store.getAgent("handoff-api-root");
    if (!readOnly) throw new Error("seed agent missing");
    store.saveAgent({ ...readOnly, id: "handoff-api-readonly", logicalAgentId: "handoff-api-readonly", permissions: "read-only" });
    store.close();
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, secretStore: testSecretStore(), credentialPlatform: "linux" });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/objectives/${seeded.runId}/handoffs`, {
        method: "POST",
        headers: { ...headers(daemon, "handoff-api-readonly"), "idempotency-key": "handoff-readonly" },
        body: JSON.stringify({
          checkpointId: seeded.checkpointId,
          intent: "Should be denied.",
          taskObjective: "Should be denied.",
          target: { harness: "codex", model: "auto", requiredCapabilities: [] },
        }),
      });
      expect(response.status).toBe(403);
    } finally {
      await daemon.close();
    }
  });
});
