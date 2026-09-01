import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import {
  ObjectiveArtifactRecordSchema,
  ObjectivePolicySnapshotSchema,
  ObjectiveRunRecordSchema,
  objectiveArtifactContentHash,
  objectiveArtifactContentSize,
  objectivePolicyHash,
  type ObjectiveArtifactRecord,
  type ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];
const timestamp = "2026-09-01T00:00:00.000Z";

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

function runRecord(): ObjectiveRunRecord {
  const policyInput = ObjectivePolicySnapshotSchema.parse({
    version: 1,
    policyVersion: 1,
    policyHash: "pending-policy-hash",
    runId: "ledger-expansion-run",
    objectiveId: "ledger-expansion-objective",
    workflowId: "ledger-expansion-workflow",
    workflowRevision: 1,
    workflowHash: "ledger-expansion-workflow-hash",
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
  return ObjectiveRunRecordSchema.parse({
    version: 1,
    runId: "ledger-expansion-run",
    objectiveId: "ledger-expansion-objective",
    objectiveRevision: 1,
    workflowId: "ledger-expansion-workflow",
    workflowRevision: 1,
    workflowHash: "ledger-expansion-workflow-hash",
    conductorAgentId: null,
    policy,
    policyHash: policy.policyHash,
    spec: { id: "ledger-expansion-objective", statement: "Exercise generic objective command receipts." },
    state: "executing",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [],
    context: {},
    output: null,
    error: null,
    requestKey: "ledger-expansion-run-request",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
  });
}

function artifact(run: ObjectiveRunRecord, id: string): ObjectiveArtifactRecord {
  const content = { artifact: id, durable: true };
  return ObjectiveArtifactRecordSchema.parse({
    version: 1,
    id,
    objectiveId: run.objectiveId,
    runId: run.runId,
    planRevision: 0,
    taskId: null,
    producerAgentId: null,
    attemptId: null,
    controlNodeId: null,
    kind: "evidence",
    name: `${id}.json`,
    mediaType: "application/json",
    content,
    hash: objectiveArtifactContentHash(content),
    sizeBytes: objectiveArtifactContentSize(content),
    evidence: { eventCursor: 0, eventIds: [], observationIds: [] },
    lineage: [],
    supersedes: null,
    reviewState: "pending",
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    publishedBy: { type: "user", id: "local-user" },
    publishedAt: timestamp,
  });
}

function writeConfig(root: string, port: number): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
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

describe("objective command ledger expansion", () => {
  it("binds the consequential objective operation set to immutable replay records", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-command-ledger-expansion-"));
    temporary.push(root);
    const store = new SymphonyStore(join(root, "state.sqlite"));
    const operations = [
      "objective.signal.deliver",
      "objective.attention.resolve",
      "objective.artifact.review",
      "objective.checkpoint.resume",
      "objective.checkpoint.retry",
      "objective.checkpoint.fork",
      "objective.handoff.accept",
    ];
    for (const [index, operation] of operations.entries()) {
      const input = {
        requestKey: `ledger-expansion-${index}`,
        operation,
        fingerprint: `${index.toString(16).padStart(2, "0")}${"a".repeat(62)}`,
        actor: { type: "user" as const, id: "local-user" },
        objectiveId: "ledger-expansion-objective",
        runId: "ledger-expansion-run",
      };
      const first = store.executeObjectiveCommand(input, () => ({
        status: "committed" as const,
        result: { operation, committed: true },
      }));
      expect(first.status).toBe("committed");
      expect(store.getObjectiveCommandLedger(input.requestKey)?.operation).toBe(operation);
      expect(store.executeObjectiveCommand(input, () => {
        throw new Error("an exact retry must not execute the mutation");
      }).status).toBe("replayed");
      expect(store.executeObjectiveCommand({ ...input, fingerprint: `${index.toString(16).padStart(2, "0")}${"b".repeat(62)}` }, () => ({
        status: "committed" as const,
        result: null,
      })).status).toBe("conflict");
    }
    store.close();
  });

  it("records artifact review in the generic ledger and rereads a committed receipt after SSE failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-command-ledger-artifact-"));
    temporary.push(root);
    const port = await availablePort();
    writeConfig(root, port);
    const seeded = new SymphonyStore(join(root, ".symphony", "symphony.sqlite"));
    const run = runRecord();
    seeded.saveObjectiveRun(run);
    const firstArtifact = artifact(run, "ledger-artifact-1");
    const secondArtifact = artifact(run, "ledger-artifact-2");
    seeded.publishObjectiveArtifact(firstArtifact, { requestKey: "ledger-publish-1", fingerprint: "publish-fingerprint-1" });
    seeded.publishObjectiveArtifact(secondArtifact, { requestKey: "ledger-publish-2", fingerprint: "publish-fingerprint-2" });
    seeded.close();
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const base = `http://127.0.0.1:${port}`;
      const body = { state: "verified", reason: "The evidence is reproducible." };
      const first = await fetch(`${base}/v1/objectives/${run.runId}/artifacts/${firstArtifact.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "ledger-review-1" },
        body: JSON.stringify(body),
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ status: "committed", artifact: { id: firstArtifact.id } });
      expect(daemon.store.getObjectiveCommandLedger("ledger-review-1")).toMatchObject({
        operation: "objective.artifact.review",
        outcome: { status: "committed" },
      });

      const replay = await fetch(`${base}/v1/objectives/${run.runId}/artifacts/${firstArtifact.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "ledger-review-1" },
        body: JSON.stringify(body),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status: "replayed", replayed: true, artifact: { id: firstArtifact.id } });

      daemon.store.onEvent(() => {
        throw new Error("simulated SSE listener failure");
      });
      const uncertainTransport = await fetch(`${base}/v1/objectives/${run.runId}/artifacts/${secondArtifact.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "ledger-review-2" },
        body: JSON.stringify(body),
      });
      expect(uncertainTransport.status).toBe(200);
      expect(await uncertainTransport.json()).toMatchObject({ status: "replayed", artifact: { id: secondArtifact.id } });
      expect(daemon.store.getObjectiveCommandLedger("ledger-review-2")?.outcome.status).toBe("committed");

      const conflict = await fetch(`${base}/v1/objectives/${run.runId}/artifacts/${secondArtifact.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "ledger-review-2" },
        body: JSON.stringify({ ...body, reason: "Different evidence." }),
      });
      expect(conflict.status).toBe(409);
    } finally {
      await daemon.close();
    }
  });
});
