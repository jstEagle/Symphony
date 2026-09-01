import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ObjectiveArtifactPublishInputSchema,
  ObjectiveArtifactRecordSchema,
  ObjectivePolicySnapshotSchema,
  objectiveArtifactCanonicalContent,
  objectiveArtifactContentHash,
  objectiveArtifactContentSize,
  objectivePolicyHash,
  type ObjectiveArtifactRecord,
  type ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { SymphonyStore } from "../packages/storage/src/index.js";
import { startDaemon } from "../apps/daemon/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const now = "2026-09-01T00:00:00.000Z";

function store(): SymphonyStore {
  const root = mkdtempSync(join(tmpdir(), "symphony-artifacts-"));
  temporary.push(root);
  return new SymphonyStore(join(root, "state.sqlite"));
}

function run(): ObjectiveRunRecord {
  const policyWithoutHash = ObjectivePolicySnapshotSchema.parse({
    version: 1,
    policyVersion: 1,
    policyHash: "pending-policy-hash",
    runId: "run-artifacts",
    objectiveId: "objective-artifacts",
    workflowId: "workflow-artifacts",
    workflowRevision: 1,
    workflowHash: "workflow-hash-artifacts",
    actor: { type: "user", id: "local-user" },
    effectivePermission: "full-access",
    allowedCapabilities: ["objective.artifact.publish"],
    workspace: null,
    budget: { maxOutputBytes: 4_096, maxStorageBytes: 8_192 },
    sideEffectClassCeiling: "read",
    approvalPolicy: { mode: "never" },
    expiresAt: null,
    createdAt: now,
  });
  const policy = { ...policyWithoutHash, policyHash: objectivePolicyHash(policyWithoutHash) };
  return {
    version: 1,
    runId: "run-artifacts",
    objectiveId: "objective-artifacts",
    workflowId: "workflow-artifacts",
    workflowRevision: 1,
    workflowHash: "workflow-hash-artifacts",
    conductorAgentId: null,
    policy,
    policyHash: policy.policyHash,
    spec: { id: "objective-artifacts", statement: "Capture objective evidence." },
    state: "executing",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: [],
    context: {},
    output: null,
    error: null,
    requestKey: "run-artifacts-request",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  };
}

function artifact(runRecord: ObjectiveRunRecord, id: string, content: unknown, supersedes: string | null = null): ObjectiveArtifactRecord {
  return ObjectiveArtifactRecordSchema.parse({
    version: 1,
    id,
    objectiveId: runRecord.objectiveId,
    runId: runRecord.runId,
    planRevision: 0,
    taskId: null,
    producerAgentId: null,
    attemptId: null,
    controlNodeId: null,
    kind: "evidence",
    name: "evidence.json",
    mediaType: "application/json",
    content,
    hash: objectiveArtifactContentHash(content),
    sizeBytes: objectiveArtifactContentSize(content),
    evidence: { eventCursor: 0, eventIds: [], observationIds: [] },
    lineage: supersedes ? [supersedes] : [],
    supersedes,
    reviewState: "pending",
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    publishedBy: { type: "user", id: "local-user" },
    publishedAt: now,
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("objective artifact protocol and storage", () => {
  it("hashes canonical JSON content and keeps caller hashes out of publication input", () => {
    const canonical = objectiveArtifactCanonicalContent({ z: 1, a: [true, { b: "x" }] });
    expect(canonical).toBe('{"a":[true,{"b":"x"}],"z":1}');
    expect(objectiveArtifactContentHash({ z: 1, a: [true, { b: "x" }] })).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(() => ObjectiveArtifactPublishInputSchema.parse({
      planRevision: 0,
      kind: "evidence",
      name: "x",
      mediaType: "application/json",
      content: { ok: true },
      evidence: { eventCursor: 0 },
      hash: "forged",
    })).toThrow();
  });

  it("persists immutable publications and replays exact publish/review receipts", () => {
    const db = store();
    const runRecord = run();
    db.saveObjectiveRun(runRecord);
    const first = artifact(runRecord, "artifact-1", { ok: true });
    expect(db.publishObjectiveArtifact(first, { requestKey: "publish-artifact-1", fingerprint: "fingerprint-1" }).status).toBe("committed");
    expect(db.publishObjectiveArtifact(first, { requestKey: "publish-artifact-1", fingerprint: "fingerprint-1" }).status).toBe("replayed");
    expect(() => db.publishObjectiveArtifact(first, { requestKey: "publish-artifact-1", fingerprint: "different" })).toThrow(/idempotency conflict/);

    const review = {
      version: 1 as const,
      id: "review-1",
      artifactId: first.id,
      objectiveId: runRecord.objectiveId,
      runId: runRecord.runId,
      fromState: "pending" as const,
      state: "verified" as const,
      actor: { type: "user" as const, id: "local-user" },
      reason: "The evidence is reproducible.",
      requestKey: "review-artifact-1",
      createdAt: now,
    };
    expect(db.reviewObjectiveArtifact(review, { fingerprint: "review-fingerprint-1" }).status).toBe("committed");
    expect(db.reviewObjectiveArtifact(review, { fingerprint: "review-fingerprint-1" }).status).toBe("replayed");
    expect(db.getObjectiveArtifact(first.id)?.reviewState).toBe("verified");
    expect(db.listObjectiveArtifactReviews(first.id)).toHaveLength(1);
    expect(() => db.reviewObjectiveArtifact({ ...review, id: "review-stale", requestKey: "review-stale", fromState: "pending" }, { fingerprint: "review-stale-fingerprint" })).toThrow(/stale/);
    const stored = db.database.prepare("SELECT record_json FROM objective_artifacts WHERE id = ?").get(first.id) as { record_json: string };
    expect(JSON.parse(stored.record_json).reviewState).toBe("pending");
    db.close();
  });

  it("automatically records supersession as an append-only review", () => {
    const db = store();
    const runRecord = run();
    db.saveObjectiveRun(runRecord);
    const first = artifact(runRecord, "artifact-old", { version: 1 });
    db.publishObjectiveArtifact(first, { requestKey: "publish-old", fingerprint: "old" });
    const next = artifact(runRecord, "artifact-new", { version: 2 }, first.id);
    const result = db.publishObjectiveArtifact(next, { requestKey: "publish-new", fingerprint: "new" });
    expect(result.superseded).toHaveLength(1);
    expect(db.getObjectiveArtifact(first.id)?.reviewState).toBe("superseded");
    expect(db.getObjectiveArtifact(next.id)?.reviewState).toBe("pending");
    db.close();
  });

  it("publishes through the daemon endpoint with daemon-owned hash and idempotency", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-artifact-api-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const db = new SymphonyStore(join(root, ".symphony", "symphony.sqlite"));
    const runRecord = run();
    db.saveObjectiveRun(runRecord);
    db.close();
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const content = { result: "pass", score: 1 };
      const response = await fetch(`http://127.0.0.1:${port}/v1/objectives/${runRecord.runId}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "api-publish-artifact-1" },
        body: JSON.stringify({ planRevision: 0, kind: "test-result", name: "result.json", mediaType: "application/json", content, evidence: { eventCursor: 0 } }),
      });
      expect(response.status).toBe(201);
      const first = await response.json() as { artifact: ObjectiveArtifactRecord };
      expect(first.artifact.hash).toBe(objectiveArtifactContentHash(content));
      expect(first.artifact.publishedBy).toEqual({ type: "user", id: "local-user" });
      const replay = await fetch(`http://127.0.0.1:${port}/v1/objectives/${runRecord.runId}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "api-publish-artifact-1" },
        body: JSON.stringify({ planRevision: 0, kind: "test-result", name: "result.json", mediaType: "application/json", content, evidence: { eventCursor: 0 } }),
      });
      expect(replay.status).toBe(201);
      expect((await replay.json() as { status: string }).status).toBe("replayed");
      const forged = await fetch(`http://127.0.0.1:${port}/v1/objectives/${runRecord.runId}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "api-publish-artifact-2" },
        body: JSON.stringify({ planRevision: 0, kind: "test-result", name: "result.json", mediaType: "application/json", content, evidence: { eventCursor: 0 }, hash: "forged" }),
      });
      expect(forged.status).toBe(400);
    } finally {
      await daemon.close();
    }
  });
});
